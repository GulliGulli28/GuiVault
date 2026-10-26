/** L'extension sur un **coffre local** de l'application (`docs/EXTENSION.md`,
 * « Coffre local ») : le popup, l'hôte natif — le vrai binaire de l'app
 * (`app-tauri`), lancé par Chromium —, un vrai coffre sur le disque, fait
 * avec la vraie crypto (`cargo run -p guivault-local --example make_coffre`).
 * Rien n'est simulé entre le popup et le fichier.
 *
 * Linux seulement (sous Windows, l'hôte s'inscrit dans le registre) et
 * seulement si le binaire de l'app est construit (`cd app-tauri && cargo
 * build`) : le job `app` du CI le construit et joue ce fichier. L'hôte est
 * déclaré dans le profil jetable de Chromium (`NativeMessagingHosts/`), les
 * coffres connus dans un dossier de configuration jetable
 * (`GUIVAULT_CONFIG_DIR`) : rien ne touche au profil de qui lance le test. */
import { chromium, expect, test, type BrowserContext, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startFixtures } from "./server";

const here = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION = path.resolve(here, "../../dist-extension");
const REPO = path.resolve(here, "../../..");
const APP = path.join(REPO, "app-tauri", "target", "debug", "guivault-app");
const ORIGIN = "chrome-extension://dpfgcnelnadjmggpdchgekenoebmljpc/";
const PASSWORD = "mot de passe du coffre e2e";

const skip = process.platform !== "linux" ? "hôte natif testé sous Linux (Windows : registre)" : !existsSync(APP) ? `binaire de l'app absent (${APP}) : cd app-tauri && cargo build` : null;
test.skip(!!skip, skip ?? "");

let context: BrowserContext;
let extensionId = "";
let port = 0;
let stopFixtures: (() => Promise<void>) | null = null;
let scratch = "";

test.beforeAll(async () => {
  test.setTimeout(240_000);
  scratch = await mkdtemp(path.join(os.tmpdir(), "guivault-native-"));
  const profile = path.join(scratch, "profil");
  const config = path.join(scratch, "config");
  const coffre = path.join(scratch, "Coffre e2e.guivault");
  await mkdir(path.join(profile, "NativeMessagingHosts"), { recursive: true });
  await mkdir(config, { recursive: true });
  // Un vrai coffre, et l'application qui l'aurait ouvert.
  execFileSync("cargo", ["run", "--quiet", "-p", "guivault-local", "--example", "make_coffre", "--", coffre, PASSWORD], { cwd: REPO, stdio: "pipe" });
  await writeFile(path.join(config, "coffres.json"), JSON.stringify([coffre]));
  // L'hôte : le binaire de l'app, avec le dossier de configuration jetable.
  const host = path.join(scratch, "hote.sh");
  await writeFile(host, `#!/bin/sh\nexport GUIVAULT_CONFIG_DIR='${config}'\nexec '${APP}' "$@"\n`);
  await chmod(host, 0o755);
  await writeFile(
    path.join(profile, "NativeMessagingHosts", "dev.guivault.client.json"),
    JSON.stringify({ name: "dev.guivault.client", description: "e2e", path: host, type: "stdio", allowed_origins: [ORIGIN] }),
  );

  const fixtures = await startFixtures();
  port = fixtures.port;
  stopFixtures = fixtures.close;
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    viewport: { width: 1100, height: 800 },
    // Les textes vérifiés sont ceux de l'interface en français.
    locale: "fr-FR",
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`, "--host-resolver-rules=MAP *.test 127.0.0.1", "--lang=fr-FR"],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  extensionId = new URL(worker.url()).host;
});

test.afterAll(async () => {
  await context?.close();
  await stopFixtures?.();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

test("l'identifiant de l'extension est celui que l'hôte autorise", () => {
  expect(`chrome-extension://${extensionId}/`).toBe(ORIGIN);
});

test("popup : ouvrir le coffre local par l'hôte natif, puis remplir la page", async () => {
  const site: Page = await context.newPage();
  await site.goto(`http://coffre.test:${port}/plain.html`, { waitUntil: "load" });
  const worker = context.serviceWorkers()[0];
  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: "*://coffre.test/*" }))[0]?.id ?? 0);
  expect(tabId).toBeGreaterThan(0);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tab=${tabId}`);
  await popup.getByRole("tab", { name: "Coffre local" }).click();
  // Le coffre que « l'application » connaît, proposé par l'hôte.
  await expect(popup.getByText("Coffre e2e", { exact: true })).toBeVisible({ timeout: 30_000 });
  await popup.locator('input[type="password"]').fill(PASSWORD);
  await popup.getByRole("button", { name: "Déverrouiller" }).click();
  // Déchiffré dans l'extension : l'identifiant du site, proposé en tête.
  await expect(popup.getByText("Banque locale").first()).toBeVisible({ timeout: 60_000 });

  await popup.getByRole("button", { name: /^Remplir/ }).first().click();
  await expect.poll(() => site.evaluate(() => (window as unknown as { __fields: Record<string, HTMLInputElement> }).__fields.username?.value ?? ""), { timeout: 15_000 }).toBe("alice@coffre");
  await expect.poll(() => site.evaluate(() => (window as unknown as { __fields: Record<string, HTMLInputElement> }).__fields.password?.value ?? "")).toBe("mdp-coffre-local");
});

test("popup : un mauvais mot de passe est refusé", async () => {
  // Le scénario d'avant a laissé le coffre ouvert : on le verrouille comme
  // l'extension le fait (la session de l'extension effacée).
  await context.serviceWorkers()[0].evaluate(() => chrome.storage.session.clear());
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.getByRole("tab", { name: "Coffre local" }).click();
  await expect(popup.getByText("Coffre e2e", { exact: true })).toBeVisible({ timeout: 30_000 });
  await popup.locator('input[type="password"]').fill("pas le bon");
  await popup.getByRole("button", { name: "Déverrouiller" }).click();
  await expect(popup.getByText("Mot de passe maître incorrect.")).toBeVisible({ timeout: 60_000 });
});
