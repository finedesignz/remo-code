//! Phase 08 — Tauri IPC commands backing the General + Security + Folders
//! pages of the Settings window.
//!
//! These commands are read-only views over the existing on-disk state:
//!   * `supervisor.json` — owned by `supervisor/src/config.ts` (Bun side).
//!   * `last_inventory.json` — written by `hub-client.ts::sendRepoInventory`
//!     after every scan, in the same config dir.
//!
//! IPC contract is intentionally small: each command returns a flat,
//! self-contained struct so the React side never has to re-fetch.

use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::PathBuf;

use crate::sidecar;

// ---------------------------------------------------------------------------
// Path resolution — must mirror `config_cmds.rs::config_path` and the Bun
// side's `defaultConfigDir`. Kept private to this module; if the layout ever
// changes, both files update together.
// ---------------------------------------------------------------------------

fn config_dir() -> Result<PathBuf, String> {
    if cfg!(target_os = "windows") {
        let appdata = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .or_else(|| dirs::config_dir())
            .ok_or_else(|| "APPDATA not set".to_string())?;
        Ok(appdata.join("remo-code"))
    } else if cfg!(target_os = "macos") {
        Ok(dirs::home_dir()
            .ok_or_else(|| "home_dir() failed".to_string())?
            .join("Library/Application Support/remo-code"))
    } else {
        Ok(std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| dirs::home_dir().map(|h| h.join(".config")))
            .ok_or_else(|| "no XDG_CONFIG_HOME and no home".to_string())?
            .join("remo-code"))
    }
}

fn supervisor_json() -> Result<PathBuf, String> { Ok(config_dir()?.join("supervisor.json")) }
fn inventory_json() -> Result<PathBuf, String> { Ok(config_dir()?.join("last_inventory.json")) }

fn read_json_obj(path: &PathBuf) -> Option<serde_json::Map<String, Value>> {
    let txt = fs::read_to_string(path).ok()?;
    let v: Value = serde_json::from_str(&txt).ok()?;
    match v {
        Value::Object(m) => Some(m),
        _ => None,
    }
}

fn host_name() -> String {
    // Cross-platform host name without a `hostname` crate dep.
    if cfg!(target_os = "windows") {
        std::env::var("COMPUTERNAME").unwrap_or_else(|_| "unknown".to_string())
    } else {
        std::env::var("HOSTNAME")
            .ok()
            .or_else(|| {
                // /etc/hostname fallback — fast and dep-free.
                fs::read_to_string("/etc/hostname").ok().map(|s| s.trim().to_string())
            })
            .unwrap_or_else(|| "unknown".to_string())
    }
}

fn mask_api_key(key: &str) -> String {
    let k = key.trim();
    if k.is_empty() { return String::new() }
    if k.len() <= 8 { return "•".repeat(k.len()) }
    let visible_prefix = k.chars().take(6).collect::<String>();
    let visible_suffix = k.chars().rev().take(4).collect::<String>().chars().rev().collect::<String>();
    let hidden = "•".repeat(8);
    format!("{visible_prefix}{hidden}{visible_suffix}")
}

/// Stable per-install identifier. Derived from hostname + the absolute path
/// to supervisor.json. Lowercase hex, 12 chars — enough entropy to be useful
/// in logs without looking like a cryptographic identifier.
fn supervisor_id(host: &str, cfg_path: &str) -> String {
    let combined = format!("{host}|{cfg_path}");
    // Tiny FNV-1a 64-bit. No crypto, no extra dep.
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in combined.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100_0000_01b3);
    }
    format!("sv_{:012x}", h & 0xffff_ffff_ffff)
}

// ---------------------------------------------------------------------------
// Runtime status — General page
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct RuntimeStatus {
    pub hub_url: String,
    pub api_key_set: bool,
    pub api_key_masked: String,
    pub hostname: String,
    pub supervisor_id: String,
    pub config_path: String,
    pub config_exists: bool,
    /// `idle` | `starting` | `running` | `crashed` | `stopped` (lowercased
    /// `sidecar::Status`).
    pub sidecar_status: String,
    pub version: String,
}

#[tauri::command]
pub fn get_runtime_status() -> Result<RuntimeStatus, String> {
    let cfg_path = supervisor_json()?;
    let map = read_json_obj(&cfg_path).unwrap_or_default();
    let api_key = map.get("api_key").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let hub_url = map
        .get("hub_url")
        .and_then(|v| v.as_str())
        .unwrap_or("https://app.remo-code.com")
        .to_string();
    let host = host_name();
    let cfg_path_str = cfg_path.to_string_lossy().to_string();
    let id = supervisor_id(&host, &cfg_path_str);
    let status = format!("{:?}", sidecar::current_status()).to_lowercase();
    Ok(RuntimeStatus {
        hub_url,
        api_key_set: !api_key.is_empty(),
        api_key_masked: mask_api_key(&api_key),
        hostname: host,
        supervisor_id: id,
        config_path: cfg_path_str,
        config_exists: cfg_path.exists(),
        sidecar_status: status,
        version: env!("CARGO_PKG_VERSION").to_string(),
    })
}

// ---------------------------------------------------------------------------
// Inventory — Folders/Repos page
// ---------------------------------------------------------------------------

#[derive(Serialize, Default)]
pub struct InventoryRepo {
    pub local_path: String,
    pub is_git_repo: bool,
    pub is_worktree: bool,
    pub worktree_parent_path: Option<String>,
    pub git_remote: Option<String>,
    pub git_origin_github: Option<GithubOrigin>,
    pub canonical: bool,
}

#[derive(Serialize, Default)]
pub struct GithubOrigin { pub owner: String, pub repo: String }

#[derive(Serialize, Default)]
pub struct InventorySnapshot {
    /// ISO timestamp of when the supervisor last produced this inventory;
    /// null when the file is absent.
    pub scanned_at: Option<String>,
    pub repos: Vec<InventoryRepo>,
    /// Absolute path to `last_inventory.json` (informational; for the UI's
    /// "Refresh failed?" diagnostic).
    pub source_path: String,
    pub source_exists: bool,
}

fn parse_inventory_value(v: &Value) -> InventoryRepo {
    let obj = match v.as_object() { Some(o) => o, None => return InventoryRepo::default() };
    let gh = obj
        .get("git_origin_github")
        .and_then(|x| x.as_object())
        .map(|o| GithubOrigin {
            owner: o.get("owner").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            repo: o.get("repo").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        });
    InventoryRepo {
        local_path: obj.get("local_path").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        is_git_repo: obj.get("is_git_repo").and_then(|x| x.as_bool()).unwrap_or(false),
        is_worktree: obj.get("is_worktree").and_then(|x| x.as_bool()).unwrap_or(false),
        worktree_parent_path: obj.get("worktree_parent_path").and_then(|x| x.as_str()).map(String::from),
        git_remote: obj.get("git_remote").and_then(|x| x.as_str()).map(String::from),
        git_origin_github: gh,
        canonical: obj.get("canonical").and_then(|x| x.as_bool()).unwrap_or(true),
    }
}

#[tauri::command]
pub fn get_inventory() -> Result<InventorySnapshot, String> {
    let p = inventory_json()?;
    let exists = p.exists();
    if !exists {
        return Ok(InventorySnapshot {
            scanned_at: None,
            repos: vec![],
            source_path: p.to_string_lossy().to_string(),
            source_exists: false,
        });
    }
    let map = read_json_obj(&p).ok_or_else(|| "inventory file is not a JSON object".to_string())?;
    let scanned_at = map.get("scanned_at").and_then(|v| v.as_str()).map(String::from);
    let repos = map
        .get("repos")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().map(parse_inventory_value).collect::<Vec<_>>())
        .unwrap_or_default();
    Ok(InventorySnapshot {
        scanned_at,
        repos,
        source_path: p.to_string_lossy().to_string(),
        source_exists: exists,
    })
}

/// Open a URL in the user's default browser. Used by the Security page's
/// "Rotate API Key" button to deep-link into the hub's settings.
#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    let trimmed = url.trim().to_string();
    if !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) {
        return Err("only http(s) URLs are allowed".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &trimmed])
            .spawn()
            .map_err(|e| format!("open failed: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&trimmed)
            .spawn()
            .map_err(|e| format!("open failed: {e}"))?;
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&trimmed)
            .spawn()
            .map_err(|e| format!("open failed: {e}"))?;
    }
    Ok(())
}

/// Stop / start / restart the Bun sidecar from the General page.
#[tauri::command]
pub fn sidecar_control(app: tauri::AppHandle, action: String) -> Result<(), String> {
    match action.as_str() {
        "start" => { sidecar::start(&app); Ok(()) }
        "stop" => { sidecar::stop(&app); Ok(()) }
        "restart" => { sidecar::restart(&app); Ok(()) }
        _ => Err(format!("unknown action: {action}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn masks_long_key() {
        let m = mask_api_key("remo_abcdef1234567890wxyz");
        assert!(m.starts_with("remo_a"));
        assert!(m.ends_with("wxyz"));
        assert!(m.contains('•'));
    }
    #[test]
    fn masks_empty_key() {
        assert_eq!(mask_api_key(""), "");
    }
    #[test]
    fn supervisor_id_stable() {
        let a = supervisor_id("HOST-A", "/tmp/x.json");
        let b = supervisor_id("HOST-A", "/tmp/x.json");
        assert_eq!(a, b);
        assert!(a.starts_with("sv_"));
    }
}
