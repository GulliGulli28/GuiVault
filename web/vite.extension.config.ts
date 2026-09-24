import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// L'extension de navigateur : le popup et le service worker en modules ES
// (`npm run build:ext`), le script de remplissage à part en IIFE — un
// content script ne peut pas importer de chunk (`vite.content.config.ts`).
// Sortie : `dist-extension/`, à charger « non empaquetée » dans le
// navigateur.
export default defineConfig({
  root: "extension",
  plugins: [react()],
  build: {
    outDir: "../dist-extension",
    emptyOutDir: true,
    rollupOptions: {
      input: { popup: "extension/popup.html", offscreen: "extension/offscreen.html", background: "extension/src/background.ts" },
      output: { entryFileNames: "[name].js", chunkFileNames: "chunks/[name]-[hash].js", assetFileNames: "assets/[name]-[hash][extname]" },
    },
  },
});
