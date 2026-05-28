import { defineConfig } from "vite";

// Vite config for the minimal mobile shell entry. The "app" served here is a
// single HTML doc that immediately location.replace()s to the hosted Remo Code
// web SPA. The real UI lives at https://app.remo-code.com — this shell only
// exists so iOS/Android have a native binary to install with deep-link wiring.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: ["es2022", "safari14"],
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
});
