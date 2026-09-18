import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// En développement, l'API est le serveur Rust lancé à côté (`cargo run`) :
// le proxy évite le CORS, et la production sert les deux depuis le même
// binaire de toute façon (voir `crates/guivault-server/src/web.rs`).
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1430,
    strictPort: true,
    proxy: {
      "/api": { target: process.env.GUIVAULT_DEV_API ?? "http://127.0.0.1:8080", changeOrigin: false },
    },
  },
  test: {
    environment: "node",
  },
});
