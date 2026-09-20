import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist-extension",
    emptyOutDir: false,
    lib: { entry: "extension/src/content.ts", formats: ["iife"], name: "GuiVaultFill", fileName: () => "content.js" },
  },
});
