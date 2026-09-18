import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const LOOPBACK_HOST = "127.0.0.1";

// Two HTML entries share the same React app. The Tauri native shell serves
// `desktop.html` at the URL path `/desktop` so the existing client-side
// `App()` route resolver (`window.location.pathname === "/desktop"`)
// selects `DesktopShell`. The default `index.html` keeps working for
// browser/Vite-dev-server access to the marketing/app-preview routes.
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        // fileURLToPath, not URL.pathname: pathname is percent-encoded, so a
        // checkout under a directory containing a space resolves to a
        // "…/My%20Project/index.html" entry that does not exist and the
        // build fails with UNRESOLVED_ENTRY.
        index: fileURLToPath(new URL("./index.html", import.meta.url)),
        desktop: fileURLToPath(new URL("./desktop.html", import.meta.url)),
      },
    },
  },
  server: {
    host: LOOPBACK_HOST,
    proxy: {
      "/api": "http://127.0.0.1:8787",
    },
  },
  preview: {
    host: LOOPBACK_HOST,
  },
});
