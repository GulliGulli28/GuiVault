import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// L'application (`app-tauri`, `docs/APP.md`) : la même interface que le web,
// derrière un écran d'accueil qui choisit un serveur ou un coffre local.
// Sortie : `dist-app/`, que `tauri.conf.json` embarque.
export default defineConfig({
  root: "app",
  plugins: [react()],
  clearScreen: false,
  server: { port: 1431, strictPort: true },
  build: { outDir: "../dist-app", emptyOutDir: true },
});
