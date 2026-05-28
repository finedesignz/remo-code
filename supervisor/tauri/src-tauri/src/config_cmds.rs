//! Phase 08 §15 — Tauri commands for the Settings → Folders (Roots) panel.
//!
//! Exposes get_config / add_root / remove_root / set_last_scan / rescan_now to
//! the React UI. The on-disk schema is owned by `supervisor/src/config.ts`
//! (the Bun side); we read/write the same JSON shape verbatim, preserving any
//! keys we don't understand so the Bun loadConfig() can still parse it after a
//! Tauri-side edit.
//!
//! Path resolution mirrors `supervisor/src/config.ts::defaultConfigDir`:
//!   - win32: %APPDATA%\remo-code\supervisor.json
//!   - darwin: ~/Library/Application Support/remo-code/supervisor.json
//!   - linux: $XDG_CONFIG_HOME/remo-code/supervisor.json (or ~/.config)

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::fs;
use std::path::PathBuf;

fn config_path() -> Result<PathBuf, String> {
    let dir = if cfg!(target_os = "windows") {
        let appdata = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .or_else(|| dirs::config_dir())
            .ok_or_else(|| "APPDATA not set".to_string())?;
        appdata.join("remo-code")
    } else if cfg!(target_os = "macos") {
        dirs::home_dir()
            .ok_or_else(|| "home_dir() failed".to_string())?
            .join("Library/Application Support/remo-code")
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| dirs::home_dir().map(|h| h.join(".config")))
            .ok_or_else(|| "no XDG_CONFIG_HOME and no home".to_string())?
            .join("remo-code")
    };
    Ok(dir.join("supervisor.json"))
}

fn read_raw() -> Result<Map<String, Value>, String> {
    let p = config_path()?;
    if !p.exists() {
        return Ok(Map::new());
    }
    let txt = fs::read_to_string(&p).map_err(|e| format!("read failed: {e}"))?;
    let v: Value = serde_json::from_str(&txt).map_err(|e| format!("parse failed: {e}"))?;
    match v {
        Value::Object(m) => Ok(m),
        _ => Err("supervisor.json is not a JSON object".to_string()),
    }
}

fn write_raw(map: &Map<String, Value>) -> Result<(), String> {
    let p = config_path()?;
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {e}"))?;
    }
    let txt = serde_json::to_string_pretty(&Value::Object(map.clone()))
        .map_err(|e| format!("serialize failed: {e}"))?;
    fs::write(&p, txt).map_err(|e| format!("write failed: {e}"))?;
    Ok(())
}

#[derive(Serialize, Deserialize, Default)]
pub struct ScanSettings {
    pub max_depth: u32,
    pub ignore_globs: Vec<String>,
    pub follow_symlinks: bool,
}

#[derive(Serialize, Default)]
pub struct RootsConfig {
    pub roots: Vec<String>,
    pub scan: ScanSettings,
    pub last_scan_at: Option<String>,
    pub config_path: String,
    pub configured: bool,
}

#[tauri::command]
pub fn get_config() -> Result<RootsConfig, String> {
    let p = config_path()?;
    let map = read_raw()?;
    let configured = p.exists();

    let roots = map
        .get("roots")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default();

    let scan_obj = map.get("scan").and_then(|v| v.as_object());
    let scan = ScanSettings {
        max_depth: scan_obj
            .and_then(|o| o.get("max_depth"))
            .and_then(|v| v.as_u64())
            .unwrap_or(2) as u32,
        ignore_globs: scan_obj
            .and_then(|o| o.get("ignore_globs"))
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
            .unwrap_or_else(|| {
                vec![
                    "**/node_modules/**".into(),
                    "**/.next/**".into(),
                    "**/dist/**".into(),
                    "**/target/**".into(),
                ]
            }),
        follow_symlinks: scan_obj
            .and_then(|o| o.get("follow_symlinks"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
    };

    let last_scan_at = map
        .get("last_scan_at")
        .and_then(|v| v.as_str())
        .map(String::from);

    Ok(RootsConfig {
        roots,
        scan,
        last_scan_at,
        config_path: p.to_string_lossy().to_string(),
        configured,
    })
}

fn save_roots(roots: Vec<String>) -> Result<(), String> {
    let mut map = read_raw()?;
    map.insert("roots".to_string(), Value::Array(roots.into_iter().map(Value::String).collect()));
    write_raw(&map)
}

#[tauri::command]
pub fn add_root(path: String) -> Result<RootsConfig, String> {
    let trimmed = path.trim().to_string();
    if trimmed.is_empty() {
        return Err("empty path".to_string());
    }
    // Validate it exists and is a directory; reject otherwise so the UI can show a clear error.
    let pb = PathBuf::from(&trimmed);
    if !pb.exists() {
        return Err(format!("path does not exist: {trimmed}"));
    }
    if !pb.is_dir() {
        return Err(format!("not a directory: {trimmed}"));
    }
    let mut cfg = get_config()?;
    // Dedupe (case-insensitive on Windows; exact-match elsewhere).
    let normalized = trimmed.replace('\\', "/");
    let already = cfg.roots.iter().any(|r| {
        let a = r.replace('\\', "/");
        if cfg!(target_os = "windows") {
            a.eq_ignore_ascii_case(&normalized)
        } else {
            a == normalized
        }
    });
    if !already {
        cfg.roots.push(normalized);
    }
    save_roots(cfg.roots.clone())?;
    get_config()
}

#[tauri::command]
pub fn remove_root(path: String) -> Result<RootsConfig, String> {
    let cfg = get_config()?;
    let norm = path.replace('\\', "/");
    let next: Vec<String> = cfg
        .roots
        .into_iter()
        .filter(|r| {
            let a = r.replace('\\', "/");
            if cfg!(target_os = "windows") {
                !a.eq_ignore_ascii_case(&norm)
            } else {
                a != norm
            }
        })
        .collect();
    save_roots(next)?;
    get_config()
}

/// Single-depth scan: walks each configured root one level deep, treats any
/// child directory containing `.git` as a repo, writes `last_inventory.json`
/// next to `supervisor.json`, and stamps `last_scan_at` to now. Shape of the
/// inventory file matches what `runtime_cmds.rs::parse_inventory_value`
/// expects so the Repos page picks it up immediately.
#[tauri::command]
pub fn rescan_now() -> Result<RootsConfig, String> {
    let cfg = get_config()?;
    let now = current_iso_timestamp();
    let repos = scan_roots_single_depth(&cfg.roots);

    let inv_path = config_path()?.with_file_name("last_inventory.json");
    let inv = serde_json::json!({
        "scanned_at": now,
        "repos": repos,
    });
    fs::write(&inv_path, serde_json::to_string_pretty(&inv).unwrap_or_default())
        .map_err(|e| format!("write inventory failed: {e}"))?;

    let mut map = read_raw()?;
    map.insert("last_scan_at".to_string(), Value::String(now));
    write_raw(&map)?;
    get_config()
}

fn current_iso_timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    // Compact ISO-8601 UTC, second precision; the UI only needs Date.parse compat.
    let (y, mo, d, h, mi, s) = epoch_to_ymdhms(secs);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

fn epoch_to_ymdhms(secs: i64) -> (i32, u32, u32, u32, u32, u32) {
    // Civil-from-days algorithm (Howard Hinnant). No chrono dep.
    let days = (secs / 86400) as i64;
    let sod = (secs % 86400) as u32;
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = (y + if m <= 2 { 1 } else { 0 }) as i32;
    (y, m, d, sod / 3600, (sod / 60) % 60, sod % 60)
}

fn scan_roots_single_depth(roots: &[String]) -> Vec<Value> {
    let mut out = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for root in roots {
        let root_pb = PathBuf::from(root);
        let Ok(entries) = fs::read_dir(&root_pb) else { continue };
        for entry in entries.flatten() {
            let p = entry.path();
            if !p.is_dir() { continue }
            let name = match p.file_name().and_then(|s| s.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            if name.starts_with('.') { continue }
            if !p.join(".git").exists() { continue }
            let local_path = p.to_string_lossy().replace('\\', "/");
            let key = local_path.to_lowercase();
            if !seen.insert(key) { continue }
            let (remote, github) = read_git_origin(&p.join(".git"));
            out.push(serde_json::json!({
                "local_path": local_path,
                "is_git_repo": true,
                "is_worktree": p.join(".git").is_file(),
                "worktree_parent_path": null,
                "git_remote": remote,
                "git_origin_github": github,
                "canonical": true,
            }));
        }
    }
    out
}

fn read_git_origin(dotgit: &PathBuf) -> (Option<String>, Option<Value>) {
    // .git can be a file (worktree) or directory. Only parse the directory case
    // for origin URL; worktrees inherit from their parent which is good enough
    // for our single-depth scan.
    let cfg = dotgit.join("config");
    if !cfg.exists() { return (None, None) }
    let txt = match fs::read_to_string(&cfg) {
        Ok(t) => t,
        Err(_) => return (None, None),
    };
    let mut in_origin = false;
    let mut url: Option<String> = None;
    for line in txt.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_origin = line == "[remote \"origin\"]";
            continue;
        }
        if in_origin {
            if let Some(rest) = line.strip_prefix("url") {
                let v = rest.trim_start_matches(|c: char| c.is_whitespace() || c == '=').trim();
                url = Some(v.to_string());
                break;
            }
        }
    }
    let github = url.as_ref().and_then(parse_github_origin);
    (url, github)
}

fn parse_github_origin(url: &String) -> Option<Value> {
    // Match git@github.com:owner/repo.git, https://github.com/owner/repo(.git)
    let stripped = url.trim_end_matches(".git");
    let tail = if let Some(rest) = stripped.strip_prefix("git@github.com:") {
        rest
    } else if let Some(rest) = stripped.strip_prefix("https://github.com/") {
        rest
    } else if let Some(rest) = stripped.strip_prefix("http://github.com/") {
        rest
    } else {
        return None;
    };
    let mut parts = tail.splitn(2, '/');
    let owner = parts.next()?.to_string();
    let repo = parts.next()?.to_string();
    if owner.is_empty() || repo.is_empty() { return None }
    Some(serde_json::json!({ "owner": owner, "repo": repo }))
}

