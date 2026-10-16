// Remo Code mobile shell — iOS/Android WebView wrapper.
//
// Responsibilities:
// 1. Embed a WebView pointed at https://app.remo-code.com (the hub-served SPA).
// 2. Register the `remo-code://auth/callback` deep link.
// 3. Titanium hosted login (current): the SPA in this WebView starts the login
//    with POST /auth/email {client:"app"}, which stores {state, PKCE verifier} in
//    the WebView's own cookie jar and has the portal return to
//    remo-code://auth/callback?state=..&code_challenge=..&act=... On receipt we eval
//    JS in the WebView that POSTs {state, act} to /auth/app-finalize; the hub checks
//    the state against that cookie, exchanges the act with the verifier + app_slug,
//    and sets the session cookie. A deep link this device did not start is refused.
// 4. Legacy (hub LEGACY_MAGIC_LINK_LOGIN=on only): `?token=<opaque>` is POSTed to
//    /api/auth/finalize-mobile as before.
//
// Platform-specific scaffolding (Xcode project + Gradle project) is generated
// via `cargo tauri ios init` / `cargo tauri android init` on a host with the
// appropriate toolchain — see mobile/tauri/README.md.

use tauri::{Emitter, Manager, Url, WebviewWindow};
use tauri_plugin_deep_link::DeepLinkExt;

const FINALIZE_PATH: &str = "/api/auth/finalize-mobile";
const APP_FINALIZE_PATH: &str = "/auth/app-finalize";
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

// The fetch below runs in whatever document the WebView shows: the hub SPA
// (Origin: https://app.remo-code.com) or, e.g. on a cold start by the deep link,
// the bundled shell page (Origin: tauri://localhost on iOS/macOS,
// http://tauri.localhost on Android/Windows). The hub's /auth/app-finalize and
// /auth/email {client:"app"} admit exactly those configured shell origins (CORS
// with credentials, SameSite=None; Partitioned pending cookie), see
// hub/src/auth/titanium-login.ts isAppShellOrigin. No Rust HTTP client is used
// for the login: the cookies live in the WebView's jar.
fn app_finalize_js(state: &str, act: &str, app_origin: &str, path: &str) -> String {
    // state + act come from the deep link; JSON-encode them so quotes and
    // backslashes cannot break out of the string literals.
    let state_json = serde_json::to_string(state).unwrap_or_else(|_| "\"\"".to_string());
    let act_json = serde_json::to_string(act).unwrap_or_else(|_| "\"\"".to_string());
    let origin_json = serde_json::to_string(app_origin).unwrap_or_else(|_| "\"\"".to_string());
    let path_json = serde_json::to_string(path).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        r#"(async () => {{
  try {{
    const origin = {origin};
    const res = await fetch(origin + {path}, {{
      method: 'POST',
      credentials: 'include',
      headers: {{ 'Content-Type': 'application/json' }},
      body: JSON.stringify({{ state: {state}, act: {act} }}),
    }});
    if (res.ok) {{
      location.replace(origin + '/');
    }} else {{
      const body = await res.json().catch(() => ({{}}));
      location.replace(origin + '/#/login?error=' + encodeURIComponent(body.error || 'exchange_failed'));
    }}
  }} catch (e) {{
    alert('Sign-in error: ' + (e && e.message ? e.message : String(e)));
    location.reload();
  }}
}})();"#,
        origin = origin_json,
        path = path_json,
        state = state_json,
        act = act_json,
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

    let param = |name: &str| {
        parsed
            .query_pairs()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.into_owned())
    };

    // Titanium hosted login: remo-code://auth/callback?state=..&act=..
    if let (Some(act), Some(state)) = (param("act"), param("state")) {
        if parsed.scheme() == "https" {
            // A https callback is the WEB leg: let the hub handle it as a normal
            // top-level navigation (state mismatch there = confirmation page).
            let target = serde_json::to_string(url_str).unwrap_or_else(|_| "\"\"".to_string());
            let _ = window.eval(&format!("location.replace({});", target));
            return;
        }
        let js = app_finalize_js(&state, &act, APP_ORIGIN, APP_FINALIZE_PATH);
        if let Err(e) = window.eval(&js) {
            log::error!("[mobile] eval app-finalize JS failed: {}", e);
        }
        return;
    }

    // Legacy own magic link handoff (hub LEGACY_MAGIC_LINK_LOGIN=on only).
    let Some(token) = param("token") else {
        log::warn!("[mobile] callback missing act/state (and legacy token)");
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

    #[test]
    fn app_finalize_js_escapes_state_and_act() {
        let js = app_finalize_js("st\"1", "act\\2", APP_ORIGIN, APP_FINALIZE_PATH);
        assert!(js.contains("\"st\\\"1\""));
        assert!(js.contains("\"act\\\\2\""));
        assert!(js.contains("\"/auth/app-finalize\""));
        assert!(js.contains("credentials: 'include'"));
    }
}
