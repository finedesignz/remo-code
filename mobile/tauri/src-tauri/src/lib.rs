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

use std::sync::Mutex;

use tauri::webview::PageLoadEvent;
use tauri::{Emitter, Manager, Url, WebviewWindow};
use tauri_plugin_deep_link::DeepLinkExt;

const FINALIZE_PATH: &str = "/api/auth/finalize-mobile";
const APP_FINALIZE_PATH: &str = "/auth/app-finalize";
const APP_ORIGIN: &str = "https://app.remo-code.com";
const APP_HOST: &str = "app.remo-code.com";

/// A finalize script waiting for the WebView to show a hub document.
///
/// The login's `remo_login` pending cookie is set by the hub SPA (a hub-origin,
/// SameSite=Lax cookie). A finalize `fetch` from any other document (the bundled
/// shell page `tauri://localhost` / `http://tauri.localhost`, which is what the
/// WebView shows on a cold start by the deep link) is cross-site, so that cookie
/// is not sent and `/auth/app-finalize` answers `state_mismatch`. The script
/// therefore only ever runs inside a first-party hub document: immediately on
/// the warm path, else parked here and run by `on_page_load` once the WebView
/// has navigated to the hub. Holds a script, never logged.
#[derive(Default)]
struct PendingFinalize(Mutex<Option<String>>);

/// True for a first-party hub document (`https://app.remo-code.com`, default port).
fn is_hub_document(url: &Url) -> bool {
    url.scheme() == "https" && url.host_str() == Some(APP_HOST) && url.port().is_none()
}

/// The hub entry the shell normally redirects to (ui/src/main.ts), with the
/// `remo_shell` marker the SPA reads (web/src/lib/platform.ts).
fn hub_entry_url(version: &str) -> Url {
    let mut url = Url::parse(APP_ORIGIN).expect("APP_ORIGIN is a valid URL");
    url.query_pairs_mut().append_pair("remo_shell", if version.is_empty() { "1" } else { version });
    url
}

/// Run `js` inside a first-party hub document: now when the WebView already
/// shows one (warm path), else park it and navigate to the hub (cold start).
fn run_in_hub_document(window: &WebviewWindow, js: String) {
    let on_hub = window.url().map(|u| is_hub_document(&u)).unwrap_or(false);
    if on_hub {
        if let Err(e) = window.eval(&js) {
            log::error!("[mobile] eval finalize JS failed: {}", e);
        }
        return;
    }
    if let Some(pending) = window.try_state::<PendingFinalize>() {
        *pending.0.lock().unwrap_or_else(|p| p.into_inner()) = Some(js);
    }
    let version = window.app_handle().package_info().version.to_string();
    log::info!("[mobile] deep link: navigating to the hub origin before finalizing");
    if let Err(e) = window.navigate(hub_entry_url(&version)) {
        log::error!("[mobile] navigate to the hub failed: {}", e);
    }
}

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

// The fetch below runs only inside a first-party hub document
// (Origin: https://app.remo-code.com), see run_in_hub_document: the remo_login
// pending cookie the hub SPA set is SameSite=Lax and would not be sent from the
// bundled shell page (tauri://localhost, http://tauri.localhost), whose fetch is
// cross-site. No Rust HTTP client is used for the login: the cookies live in the
// WebView's jar.
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

/// Query params that carry a one-time credential or login binding. Never logged.
const SECRET_PARAMS: &[&str] = &["act", "state", "code", "token", "code_verifier"];

/// A deep-link URL safe to log: scheme, host and path, plus the query with every
/// value of `SECRET_PARAMS` replaced by `REDACTED`. Fragment and userinfo are
/// dropped. An unparseable URL logs as a fixed placeholder (it may hold anything).
fn redact_deep_link(url_str: &str) -> String {
    let Ok(parsed) = Url::parse(url_str) else {
        return "<unparseable deep link>".to_string();
    };
    let mut out = format!("{}://{}{}", parsed.scheme(), parsed.host_str().unwrap_or(""), parsed.path());
    let pairs: Vec<String> = parsed
        .query_pairs()
        .map(|(k, v)| {
            if SECRET_PARAMS.iter().any(|s| k.eq_ignore_ascii_case(s)) {
                format!("{}=REDACTED", k)
            } else {
                format!("{}={}", k, v)
            }
        })
        .collect();
    if !pairs.is_empty() {
        out.push('?');
        out.push_str(&pairs.join("&"));
    }
    out
}

fn handle_deep_link(window: &WebviewWindow, url_str: &str) {
    log::info!("[mobile] deep link received: {}", redact_deep_link(url_str));
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
        log::warn!("[mobile] deep link not a callback: {}", redact_deep_link(url_str));
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
        run_in_hub_document(window, app_finalize_js(&state, &act, APP_ORIGIN, APP_FINALIZE_PATH));
        return;
    }

    // Legacy own magic link handoff (hub LEGACY_MAGIC_LINK_LOGIN=on only).
    let Some(token) = param("token") else {
        log::warn!("[mobile] callback missing act/state (and legacy token)");
        return;
    };

    run_in_hub_document(window, finalize_js(&token, APP_ORIGIN, FINALIZE_PATH));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_deep_link::init())
        .manage(PendingFinalize::default())
        // Drain a parked finalize once a hub document has loaded (see PendingFinalize).
        .on_page_load(|webview, payload| {
            if payload.event() != PageLoadEvent::Finished || !is_hub_document(payload.url()) {
                return;
            }
            let Some(pending) = webview.try_state::<PendingFinalize>() else {
                return;
            };
            let parked = {
                let mut slot = pending.0.lock().unwrap_or_else(|e| e.into_inner());
                slot.take()
            };
            if let Some(js) = parked {
                if let Err(e) = webview.eval(&js) {
                    log::error!("[mobile] eval parked finalize JS failed: {}", e);
                }
            }
        })
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

    #[test]
    fn redact_deep_link_hides_every_secret_param() {
        let url = "remo-code://auth/callback?state=S1st&code_challenge=cc456&act=S2act\
                   &code=S3code&token=S4tok&code_verifier=S5ver&Act=S6act&ok=1#S7frag";
        let out = redact_deep_link(url);
        for secret in ["S1st", "S2act", "S3code", "S4tok", "S5ver", "S6act", "S7frag"] {
            assert!(!out.contains(secret), "{secret} leaked in {out}");
        }
        assert!(out.starts_with("remo-code://auth/callback?"));
        assert!(out.contains("act=REDACTED") && out.contains("state=REDACTED"));
        assert!(out.contains("code=REDACTED") && out.contains("token=REDACTED"));
        assert!(out.contains("code_verifier=REDACTED"));
        assert!(out.contains("code_challenge=cc456") && out.contains("ok=1"));
    }

    #[test]
    fn only_a_first_party_hub_document_runs_the_finalize() {
        for ok in ["https://app.remo-code.com/", "https://app.remo-code.com/#/login", "https://app.remo-code.com/?remo_shell=1"] {
            assert!(is_hub_document(&Url::parse(ok).unwrap()), "{ok}");
        }
        for no in [
            "tauri://localhost/",
            "http://tauri.localhost/",
            "http://app.remo-code.com/",
            "https://app.remo-code.com:8443/",
            "https://app.remo-code.com.evil.example/",
            "https://evil.example/app.remo-code.com",
        ] {
            assert!(!is_hub_document(&Url::parse(no).unwrap()), "{no}");
        }
    }

    #[test]
    fn hub_entry_url_is_a_hub_document_with_the_shell_marker() {
        let url = hub_entry_url("0.1.0");
        assert!(is_hub_document(&url));
        assert_eq!(url.as_str(), "https://app.remo-code.com/?remo_shell=0.1.0");
        assert_eq!(hub_entry_url("").as_str(), "https://app.remo-code.com/?remo_shell=1");
    }

    #[test]
    fn redact_deep_link_never_echoes_an_unparseable_url() {
        assert_eq!(redact_deep_link("not a url act=secret"), "<unparseable deep link>");
    }
}
