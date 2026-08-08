import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Two ways this app gets served, and both have to keep working:
 *
 *   npm run dev      Vite on :5173, proxying /api to the backend on :3000.
 *                    Hot reload, no build step in the loop.
 *   npm run build    Static output into frontend/dist, which backend/server.js
 *                    serves directly — so `npm run server:local` still hands
 *                    you the whole app on one port, as it always did.
 *
 * Routing stays hash-based (#/demo). express.static has no catch-all, so a
 * path-based route would 404 on a hard refresh of /console in production.
 */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // The demo is shown on laptops with no network; a source map costs nothing
    // here and makes a stack trace in front of an audience readable.
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.BACKEND_URL || "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
