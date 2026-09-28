/** Le remplissage de l'extension, rejoué dans un vrai Chromium face à des
 * pages de connexion piégeuses (`fixtures/`) : shadow DOM ouvert, fermé,
 * imbriqué, tardif ; champs contrôlés à la React ; inscription et
 * changement de mot de passe ; connexion dans un cadre — du même site, d'un
 * fournisseur, ou d'une publicité.
 *
 * L'extension construite (`npm run build:ext`) est chargée telle quelle ; sa
 * session est amorcée directement dans `chrome.storage.session` (des
 * identifiants déchiffrés, comme après une connexion), sans serveur. On
 * clique le bouton GuiVault là où il est posé et on choisit au clavier : le
 * menu vit dans une shadow root fermée, que ni le test ni une page ne
 * peuvent fouiller — seuls les vrais clics et touches y agissent. */
import { chromium, expect, test, type BrowserContext, type Frame, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startFixtures } from "./server";

const EXTENSION = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist-extension");

const BANK = { id: "l-bank", name: "Banque", username: "alice@banque", password: "mdp-banque-42", uris: [{ uri: "http://bank.test", match: null }], totp: "JBSWY3DPEHPK3PXP" };
const PROVIDER = { id: "l-provider", name: "Fournisseur", username: "alice@fournisseur", password: "mdp-fournisseur", uris: [{ uri: "http://login.provider.test", match: null }], totp: null };

const asItem = (l: typeof BANK | typeof PROVIDER) => ({
  id: l.id,
  revision: 1,
  updatedAt: "2026-01-01T00:00:00Z",
  ok: true,
  payload: { kind: "login", login: { ...l, groupId: null, tags: [], passkeys: [], passwordHistory: [] } },
});

let context: BrowserContext;
let extensionId = "";
let port = 0;
let stopFixtures: (() => Promise<void>) | null = null;
let profile = "";

test.beforeAll(async () => {
  const fixtures = await startFixtures();
  port = fixtures.port;
  stopFixtures = fixtures.close;
  profile = await mkdtemp(path.join(os.tmpdir(), "guivault-e2e-"));
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    viewport: { width: 1100, height: 800 },
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`, "--host-resolver-rules=MAP *.test 127.0.0.1"],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  extensionId = new URL(worker.url()).host;
  await worker.evaluate(async (items) => {
    await chrome.storage.local.set({ settings: { serverUrl: "http://guivault.test", email: "e2e@guivault.test", lockMinutes: 60, inlineAutofill: true, autoTotp: true, otpPatterns: "" } });
    await chrome.storage.session.set({ session: { e2e: true }, items: { "v-e2e": { revision: 1, items } } });
  }, [asItem(BANK), asItem(PROVIDER)]);
});

test.afterAll(async () => {
  await context?.close();
  await stopFixtures?.();
  if (profile) await rm(profile, { recursive: true, force: true });
});

const url = (host: string, file: string) => `http://${host}:${port}/${file}`;

async function open(file: string, host = "bank.test"): Promise<Page> {
  const page = await context.newPage();
  await page.goto(url(host, file), { waitUntil: "load" });
  return page;
}

function frameOf(page: Page, host: string, file: string): Frame {
  const f = page.frames().find((x) => x.url().startsWith(url(host, file)));
  if (!f) throw new Error(`cadre ${host}/${file} introuvable`);
  return f;
}

/** Où est le cadre dans la page (le principal : l'origine). */
async function offset(frame: Frame) {
  if (!frame.parentFrame()) return { x: 0, y: 0 };
  const box = await (await frame.frameElement()).boundingBox();
  return { x: box!.x, y: box!.y };
}

const fieldValue = (frame: Frame, name: string) => frame.evaluate((n) => (window as unknown as { __fields: Record<string, HTMLInputElement> }).__fields[n]?.value ?? null, name);
const stateOf = (frame: Frame, key: string) => frame.evaluate((k) => (window as unknown as { __state: Record<string, string> }).__state[k] ?? "", key);

/** Clique dans le champ `name` (il prend le focus), attend le bouton
 * GuiVault posé à sa droite, le clique, et attend que le menu ait le focus. */
async function openMenu(page: Page, frame: Frame, name: string) {
  await expect.poll(() => frame.evaluate((n) => !!(window as unknown as { __fields: Record<string, HTMLInputElement> }).__fields[n], name)).toBe(true);
  const o = await offset(frame);
  const r = await frame.evaluate((n) => {
    const b = (window as unknown as { __fields: Record<string, HTMLInputElement> }).__fields[n].getBoundingClientRect();
    return { left: b.left, right: b.right, y: b.top + b.height / 2 };
  }, name);
  // Juste après son chargement, Chromium peut encore router le clic d'un
  // cadre d'un autre site (autre processus) vers la page qui l'héberge : on
  // reclique jusqu'à ce que le cadre ait bien le focus.
  await expect(async () => {
    await page.mouse.click(o.x + r.left + 6, o.y + r.y);
    expect(await frame.evaluate(() => document.hasFocus())).toBe(true);
  }).toPass({ timeout: 5_000 });
  await expect.poll(() => frame.evaluate(([x, y]) => document.elementFromPoint(x, y)?.id ?? "", [r.right - 14, r.y])).toBe("guivault-inline");
  await page.mouse.click(o.x + r.right - 14, o.y + r.y);
  // Le focus est dans l'interface injectée (l'hôte, vu d'ici).
  await expect.poll(() => frame.evaluate(() => document.activeElement?.id ?? "")).toBe("guivault-inline");
}

/** Ouvre le menu du champ `name` et choisit sa première ligne. */
async function fillFirst(page: Page, frame: Frame, name: string) {
  await openMenu(page, frame, name);
  await page.keyboard.press("Enter");
}

test("formulaire classique : bouton, menu, remplissage", async () => {
  const page = await open("plain.html");
  const f = page.mainFrame();
  await fillFirst(page, f, "username");
  await expect.poll(() => fieldValue(f, "username")).toBe(BANK.username);
  expect(await fieldValue(f, "password")).toBe(BANK.password);
  await page.close();
});

test("champ reconnu par son seul libellé, à côté d'une lettre d'information", async () => {
  const page = await open("labels.html");
  const f = page.mainFrame();
  await fillFirst(page, f, "username");
  await expect.poll(() => fieldValue(f, "password")).toBe(BANK.password);
  expect(await fieldValue(f, "username")).toBe(BANK.username);
  expect(await fieldValue(f, "newsletter")).toBe("");
  await page.close();
});

for (const [file, what] of [
  ["shadow-open.html", "shadow root ouverte"],
  ["shadow-closed.html", "shadow root fermée"],
  ["shadow-nested.html", "racines fermées dans une racine ouverte"],
] as const) {
  test(`formulaire dans une ${what} : rempli, et le composant l'a vu`, async () => {
    const page = await open(file);
    const f = page.mainFrame();
    await fillFirst(page, f, "username");
    await expect.poll(() => fieldValue(f, "password")).toBe(BANK.password);
    expect(await fieldValue(f, "username")).toBe(BANK.username);
    // Les événements `composed` sont sortis de la racine jusqu'au composant.
    expect(await stateOf(f, "username")).toBe(BANK.username);
    expect(await stateOf(f, "password")).toBe(BANK.password);
    await page.close();
  });
}

test("formulaire créé après le chargement dans une racine fermée", async () => {
  const page = await open("shadow-late.html");
  const f = page.mainFrame();
  await fillFirst(page, f, "username");
  await expect.poll(() => fieldValue(f, "password")).toBe(BANK.password);
  expect(await stateOf(f, "username")).toBe(BANK.username);
  await page.close();
});

test("champs contrôlés à la React : l'état suit, le rendu suivant n'efface rien", async () => {
  const page = await open("react.html");
  const f = page.mainFrame();
  await fillFirst(page, f, "username");
  await expect.poll(() => stateOf(f, "password")).toBe(BANK.password);
  expect(await stateOf(f, "username")).toBe(BANK.username);
  expect(await fieldValue(f, "username")).toBe(BANK.username);
  expect(await fieldValue(f, "password")).toBe(BANK.password);
  await page.close();
});

test("inscription : le mot de passe et sa confirmation", async () => {
  const page = await open("signup.html");
  const f = page.mainFrame();
  await fillFirst(page, f, "username");
  await expect.poll(() => fieldValue(f, "confirm")).toBe(BANK.password);
  expect(await fieldValue(f, "password")).toBe(BANK.password);
  await page.close();
});

test("changement de mot de passe : l'actuel seulement, jamais le nouveau", async () => {
  const page = await open("change-password.html");
  const f = page.mainFrame();
  await fillFirst(page, f, "current");
  await expect.poll(() => fieldValue(f, "current")).toBe(BANK.password);
  expect(await fieldValue(f, "new")).toBe("");
  expect(await fieldValue(f, "confirm")).toBe("");
  await page.close();
});

test("connexion en deux étapes : l'utilisateur seul", async () => {
  const page = await open("two-step.html");
  const f = page.mainFrame();
  await fillFirst(page, f, "username");
  await expect.poll(() => fieldValue(f, "username")).toBe(BANK.username);
  await page.close();
});

test("code à six cases, rempli tout seul (un seul identifiant du site a un TOTP)", async () => {
  const page = await open("otp.html");
  const f = page.mainFrame();
  await expect.poll(async () => (await Promise.all([0, 1, 2, 3, 4, 5].map((k) => fieldValue(f, `c${k}`)))).join("")).toMatch(/^\d{6}$/);
  await page.close();
});

test("cadre du même site : ses identifiants, sans confirmation", async () => {
  const page = await open("iframe-same.html");
  const f = frameOf(page, "bank.test", "frame.html");
  await fillFirst(page, f, "username");
  await expect.poll(() => fieldValue(f, "password")).toBe(BANK.password);
  await page.close();
});

test("cadre d'un fournisseur d'identité : les identifiants du fournisseur", async () => {
  const page = await open("iframe-provider.html");
  const f = frameOf(page, "login.provider.test", "frame.html");
  await fillFirst(page, f, "username");
  await expect.poll(() => fieldValue(f, "password")).toBe(PROVIDER.password);
  expect(await fieldValue(f, "username")).toBe(PROVIDER.username);
  await page.close();
});

test("cadre publicitaire : les identifiants du site seulement après confirmation", async () => {
  const page = await open("iframe-ad.html");
  const f = frameOf(page, "ads.test", "fake-login.html");
  // Première ligne : l'identifiant de la banque, « à confirmer ». Échap
  // referme la confirmation : rien n'est rempli.
  await fillFirst(page, f, "username");
  await expect.poll(() => f.evaluate(() => document.activeElement?.id ?? "")).toBe("guivault-inline");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  expect(await fieldValue(f, "password")).toBe("");
  // Confirmé (Entrée sur « Remplir quand même ») : rempli.
  await fillFirst(page, f, "username");
  await expect.poll(() => f.evaluate(() => document.activeElement?.id ?? "")).toBe("guivault-inline");
  await page.keyboard.press("Enter");
  await expect.poll(() => fieldValue(f, "password")).toBe(BANK.password);
  await page.close();
});

/** Ce que ferait « Remplir » dans le popup : le message au service worker,
 * depuis une page de l'extension. */
async function fillFromPopup(pageUrl: string, loginId: string, frameId?: number) {
  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${extensionId}/offscreen.html`);
  const reply = await ext.evaluate(
    async ({ pageUrl, loginId, frameId }) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((t) => t.url?.startsWith(pageUrl));
      return chrome.runtime.sendMessage({ type: "guivault-fill-tab", tabId: tab!.id, loginId, what: "credentials", frameId });
    },
    { pageUrl, loginId, frameId },
  );
  await ext.close();
  return reply as { ok: boolean; reason?: string; frameId?: number; frameHost?: string };
}

test("popup : remplit la page, pas le cadre publicitaire à côté", async () => {
  const page = await open("iframe-ad-with-login.html");
  const ad = frameOf(page, "ads.test", "fake-login.html");
  const reply = await fillFromPopup(url("bank.test", "iframe-ad-with-login.html"), BANK.id);
  expect(reply.ok).toBe(true);
  await expect.poll(() => fieldValue(page.mainFrame(), "password")).toBe(BANK.password);
  expect(await fieldValue(ad, "password")).toBe("");
  expect(await fieldValue(ad, "username")).toBe("");
  await page.close();
});

test("popup : un formulaire seul dans un cadre d'un autre site demande confirmation", async () => {
  const page = await open("iframe-ad.html");
  const ad = frameOf(page, "ads.test", "fake-login.html");
  const reply = await fillFromPopup(url("bank.test", "iframe-ad.html"), BANK.id);
  expect(reply).toMatchObject({ ok: false, reason: "confirm", frameHost: `ads.test:${port}` });
  expect(await fieldValue(ad, "password")).toBe("");
  const confirmed = await fillFromPopup(url("bank.test", "iframe-ad.html"), BANK.id, reply.frameId);
  expect(confirmed.ok).toBe(true);
  await expect.poll(() => fieldValue(ad, "password")).toBe(BANK.password);
  await page.close();
});

test("la page ne peut pas atteindre l'interface injectée", async () => {
  const page = await open("plain.html");
  await openMenu(page, page.mainFrame(), "username");
  const seen = await page.evaluate(() => {
    const host = document.getElementById("guivault-inline");
    // Un clic de script sur l'hôte n'atteint rien dedans.
    host?.click();
    return { host: !!host, shadow: host?.shadowRoot ?? null };
  });
  expect(seen.host).toBe(true);
  expect(seen.shadow).toBeNull();
  expect(await fieldValue(page.mainFrame(), "password")).toBe("");
  await page.close();
});
