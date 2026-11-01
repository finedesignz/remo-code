// Public, unauthenticated client bootstrap config.
//
//   GET /api/client-config  → { pty_interactive: boolean }
//
// Exposes the hub's `REMO_PTY_INTERACTIVE` flag (config.ptyInteractive) to the
// web SPA so the browser's default human surface (TerminalSurface vs the
// stream-json ChatSurface) stays in lockstep with the env flip — no separate
// build or deploy needed on flip. Leaks no secrets; a single boolean feature
// gate. MUST be mounted BEFORE the /api/* JWT auth catch-all.
//
// Read at request time so an admin flipping the env without rebuilding the SPA
// (the flag is fetched at boot) sees fresh values on the next page load.

import { Hono } from "hono";
import { config } from "../config.ts";

export const clientConfig = new Hono();

clientConfig.get("/", (c) => {
  return c.json({
    pty_interactive:
      process.env.REMO_PTY_INTERACTIVE === "1" || config.ptyInteractive,
  });
});
