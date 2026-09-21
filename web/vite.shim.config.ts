import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist-extension",
    emptyOutDir: false,
    lib: { entry: "extension/src/webauthn-shim.ts", formats: ["iife"], name: "GuiVaultWebAuthn", fileName: () => "webauthn.js" },
  },
});
