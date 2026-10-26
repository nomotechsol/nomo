import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  build: { outDir: "../web-dist", emptyOutDir: true },
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:8789", "/health": "http://127.0.0.1:8789" } },
});
