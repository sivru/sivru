import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server proxies /api/* to the local @sivrujs/observe HTTP server.
// Default port 7676 matches the CLI command's default.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:7676",
    },
  },
});
