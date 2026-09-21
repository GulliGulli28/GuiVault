import { defineConfig } from "vite";

export default defineConfig({
  // Pas de `public/` : celui de l'interface web (favicon) n'a rien à faire
  // dans l'extension, dont les icônes viennent de `extension/public`.
  publicDir: false,
  build: {
    outDir: "dist-extension",
    emptyOutDir: false,
    lib: { entry: "extension/src/webauthn-shim.ts", formats: ["iife"], name: "GuiVaultWebAuthn", fileName: () => "webauthn.js" },
  },
});
