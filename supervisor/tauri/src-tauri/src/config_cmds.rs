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

/// Phase 08 §15 — fires `supervisor.needs_roots` if applicable; in this Tauri
/// build we just stamp `last_scan_at` to a placeholder of "" → the Bun sidecar
/// owns the real scan. This command is invoked by the UI's [Re-scan now]
/// button so the user gets immediate feedback; the actual rescan is delivered
/// by the sidecar process on the next tick (or on receipt of a future
/// SIGHUP-style trigger when one is plumbed).
#[tauri::command]
pub fn rescan_now() -> Result<RootsConfig, String> {
    // For now this is a hint the UI can act on; the sidecar process polls
    // config + scans on its own loop (Plan 003 T7). We touch last_scan_at to
    // null so the UI's "Last scanned" caption updates immediately.
    let mut map = read_raw()?;
    map.insert("last_scan_at".to_string(), Value::Null);
    write_raw(&map)?;
    get_config()
}
