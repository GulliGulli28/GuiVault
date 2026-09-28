/** Le corpus de remplissage de l'extension (`npm run test:ext`) : l'extension
 * construite (`dist-extension`) chargée dans un vrai Chromium, face à des
 * pages de connexion piégeuses. Un seul navigateur, les tests à la suite. */
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
});
