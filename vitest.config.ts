import { defineConfig } from "vitest/config";

export default defineConfig({
  // @wpa/processing's package.json exports map only declares a "require"
  // condition for its subpaths (e.g. "./data" -> dist/data.cjs) — correct
  // for the real app (electron-vite's own build already resolves it), but
  // Vite/vitest's default resolution here doesn't include "require" among
  // its conditions, so any test that transitively imports a file using
  // that subpath (e.g. electron/ipc/earringHandlers.ts, first exercised by
  // a real import in Phase 15.3's Sandbox orchestrator tests) fails to
  // resolve. Adding "require" here is a resolver setting only — it
  // doesn't change what any module actually does.
  resolve: {
    conditions: ["require"],
  },
  ssr: {
    resolve: {
      conditions: ["require"],
    },
  },
  test: {
    globals: true,
    environment: "node",
    testTimeout: 20000
  }
});
