import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development the API runs on :8080; proxy it so the app and API share one origin (cookies, CSRF).
// In production the backend serves the built app itself.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": { target: "http://localhost:8080", changeOrigin: false } },
  },
  build: { outDir: "dist", sourcemap: false },
});
