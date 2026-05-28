// Minimal mobile shell entry.
//
// The Remo Code web SPA is hosted at https://app.remo-code.com and is the
// real UI on every platform. This native shell exists to:
//   1. Provide a binary for App Store / Play Store distribution.
//   2. Register the `remo-code://auth/callback` deep link with the OS so
//      the magic-link flow can hand a token back to the WebView.
//
// On boot we redirect to VITE_REMO_URL (defaults to the production app),
// preserving any window.__REMO_APP_VERSION__ that the Rust setup() hook
// injected so the SPA can show "Mobile vX.Y.Z".

const APP_URL =
  (import.meta.env && (import.meta.env.VITE_REMO_URL as string | undefined)) ||
  "https://app.remo-code.com";

declare global {
  interface Window {
    __REMO_APP_VERSION__?: string;
  }
}

const version = window.__REMO_APP_VERSION__;
if (version) {
  // Hand the version off via sessionStorage so the redirected SPA can pick it
  // up from the same origin (location.replace wipes the JS globals).
  try {
    sessionStorage.setItem("remo:mobile_app_version", version);
  } catch {
    // sessionStorage may be blocked in some WebView configurations — non-fatal.
  }
}

location.replace(APP_URL);
