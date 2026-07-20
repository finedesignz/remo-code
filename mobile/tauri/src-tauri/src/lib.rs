// Remo Code mobile shell — iOS/Android WebView wrapper.
//
// Responsibilities:
// 1. Embed a WebView pointed at https://app.remo-code.com (the hub-served SPA).
// 2. Register the `remo-code://auth/callback?token=<X>` deep link.
// 3. On deep-link receipt, eval JS in the WebView that POSTs the token to
//    /api/auth/finalize-mobile (credentials: 'include' so the hub can set
//    the opaque session cookie on the WebView's cookie jar), then reloads
//    the SPA on 200 or alerts the user on failure.
//
// Platform-specific scaffolding (Xcode project + Gradle project) is generated
// via `cargo tauri ios init` / `cargo tauri android init` on a host with the
// appropriate toolchain — see mobile/tauri/README.md.

use tauri::{Emitter, Manager, Url, WebviewWindow};
use tauri_plugin_deep_link::DeepLinkExt;

const FINALIZE_PATH: &str = "/api/auth/finalize-mobile";
const APP_ORIGIN: &str = "https://app.remo-code.com";

fn finalize_js(token: &str, app_origin: &str, finalize_path: &str) -> String {
    // token is a Keygen-issued opaque string from the magic-link callback.
    // We escape it as a JSON string literal to neutralise quotes/backslashes.
    let token_json = serde_json::to_string(token).unwrap_or_else(|_| "\"\"".to_string());
    let origin_json = serde_json::to_string(app_origin).unwrap_or_else(|_| "\"\"".to_string());
    let path_json = serde_json::to_string(finalize_path).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        r#"(async () => {{
  try {{
    const token = {token};
    const origin = {origin};
    const path = {path};
    const res = await fetch(origin + path, {{
      method: 'POST',
      credentials: 'include',
      headers: {{ 'Content-Type': 'application/json' }},
      body: JSON.stringify({{ token }}),
    }});
    if (res.ok) {{
      location.replace(origin);
    }} else {{
      const body = await res.text().catch(() => '');
      alert('Sign-in failed (' + res.status + '). ' + body);
      location.reload();
    }}
  }} catch (e) {{
    alert('Sign-in error: ' + (e && e.message ? e.message : String(e)));
    location.reload();
  }}
}})();"#,
        token = token_json,
        origin = origin_json,
        path = path_json,
    )
}

fn handle_deep_link(window: &WebviewWindow, url_str: &str) {
    log::info!("[mobile] deep link received: {}", url_str);
    let parsed = match Url::parse(url_str) {
        Ok(u) => u,
        Err(e) => {
            log::warn!("[mobile] invalid deep link url: {}", e);
            return;
        }
    };

    // Accept either form:
    //   - Custom scheme: remo-code://auth/callback?token=...
    //       scheme = "remo-code", host parsed as "auth", path = "/callback"
    //   - Universal Link / App Link: https://app.remo-code.com/auth/callback?token=...
    //       scheme = "https", host = "app.remo-code.com", path = "/auth/callback"
    // The handler keys off scheme + path-ends-with-/callback, which works for
    // both regardless of plugin-config host registration.
    let scheme_ok = parsed.scheme() == "remo-code"
        || (parsed.scheme() == "https" && parsed.host_str() == Some("app.remo-code.com"));
    let is_callback = scheme_ok && parsed.path().ends_with("/callback");
    if !is_callback {
        log::warn!("[mobile] deep link not a callback: {}", url_str);
        return;
    }

    let token = parsed
        .query_pairs()
        .find(|(k, _)| k == "token")
        .map(|(_, v)| v.into_owned());

    let Some(token) = token else {
        log::warn!("[mobile] callback missing token");
        return;
    };

    let js = finalize_js(&token, APP_ORIGIN, FINALIZE_PATH);
    if let Err(e) = window.eval(&js) {
        log::error!("[mobile] eval finalize JS failed: {}", e);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            let handle = app.handle().clone();

            // Inject app version into the WebView before navigation so the SPA
            // can surface "Remo Code Mobile vX.Y.Z" in its about screen.
            if let Some(window) = handle.get_webview_window("main") {
                let version = handle.package_info().version.to_string();
                let inject = format!(
                    "window.__REMO_APP_VERSION__ = {};",
                    serde_json::to_string(&version).unwrap_or_else(|_| "\"0.0.0\"".to_string())
                );
                let _ = window.eval(&inject);
            }

            // Cold-start: if the app was launched by a deep link, the URL is
            // queued on the plugin — drain it here.
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                if let Some(window) = handle.get_webview_window("main") {
                    for url in urls {
                        handle_deep_link(&window, url.as_str());
                    }
                }
            }

            // Warm path: subsequent deep links arrive as events.
            let handle_for_listener = handle.clone();
            app.deep_link().on_open_url(move |event| {
                if let Some(window) = handle_for_listener.get_webview_window("main") {
                    for url in event.urls() {
                        handle_deep_link(&window, url.as_str());
                    }
                }
            });

            // Emit a `mobile-ready` event for the thin UI shell.
            let _ = app.emit("mobile-ready", ());
            // Keep `handle` referenced on platforms where the codegen path
            // above doesn't otherwise consume it.
            let _ = &handle as &dyn std::any::Any;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running remo-code mobile");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finalize_js_escapes_token() {
        let js = finalize_js("abc\"123", APP_ORIGIN, FINALIZE_PATH);
        assert!(js.contains("\"abc\\\"123\""));
        assert!(js.contains("https://app.remo-code.com"));
        assert!(js.contains("/api/auth/finalize-mobile"));
        assert!(js.contains("credentials: 'include'"));
    }
}
