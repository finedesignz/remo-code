// Phase 12.1: public Apple/Google deep-link association files.
//
// Both routes are unauthenticated, not license-gated, and mounted at the root
// (`/.well-known/*`) — Apple and Google fetch them without any custom headers.
//
//   GET /.well-known/apple-app-site-association  → Universal Links (iOS)
//   GET /.well-known/assetlinks.json             → App Links (Android)
//
// Content-type for AASA MUST be `application/json` per Apple's 2017+ guidance
// (the older `application/pkcs7-mime` form is for signed AASA, which we do
// not use). Both files have edge-cacheable bodies; we set a short max-age so
// rotating the team id / signing fingerprint propagates quickly.

import { Hono } from "hono";
import { config } from "../config.ts";

export const wellKnown = new Hono();

// Read at request time so tests (and admins rotating ids without a redeploy)
// see fresh values. Falls through to `config.*` so the typed env-validation
// path is still the source of truth in production.
function teamId(): string { return process.env.MOBILE_APPLE_TEAM_ID || config.mobileAppleTeamId; }
function bundleId(): string { return process.env.MOBILE_BUNDLE_ID || config.mobileBundleId; }
function androidFingerprint(): string {
  return process.env.MOBILE_ANDROID_SHA256_FINGERPRINT || config.mobileAndroidSha256Fingerprint;
}

const CACHE_HEADERS = {
  "Cache-Control": "public, max-age=300",
} as const;

wellKnown.get("/apple-app-site-association", (c) => {
  const appID = `${teamId()}.${bundleId()}`;
  const body = {
    applinks: {
      apps: [],
      details: [
        {
          appID,
          appIDs: [appID],
          paths: ["/api/auth/login/callback*", "/auth/*"],
          components: [
            { "/": "/api/auth/login/callback*" },
            { "/": "/auth/*" },
          ],
        },
      ],
    },
    webcredentials: { apps: [appID] },
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      ...CACHE_HEADERS,
    },
  });
});

wellKnown.get("/assetlinks.json", (c) => {
  const body = [
    {
      relation: [
        "delegate_permission/common.handle_all_urls",
        "delegate_permission/common.get_login_creds",
      ],
      target: {
        namespace: "android_app",
        package_name: bundleId(),
        sha256_cert_fingerprints: [androidFingerprint()],
      },
    },
  ];
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      ...CACHE_HEADERS,
    },
  });
});
