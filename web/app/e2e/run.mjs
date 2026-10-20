#!/usr/bin/env node
// Les tests de bout en bout de l'application (`docs/APP.md`) : le **vrai
// binaire** Tauri, piloté par WebDriver (`tauri-driver`), avec de vrais
// `invoke(...)` vers `guivault-local` et un vrai coffre sur le disque — ce
// qu'aucun navigateur headless ne voit. Même principe que
// `~/gui-termius/scripts/e2e-run.mjs`.
//
//                 Linux (WSLg, CI)               Windows natif
//   Rendu          WebKitGTK                      WebView2 (ce que lancent les utilisateurs)
//   Pilote         /usr/bin/WebKitWebDriver       msedgedriver.exe (EDGEDRIVER_PATH)
//   Binaire        debug (`cargo build`)          release + `tauri/custom-protocol`
//   Interface      Vite sur :1431 (devUrl)        `web/dist-app` embarqué
//
// Préalables : `cargo install tauri-driver` ; Linux : `webkit2gtk-driver` ;
// Windows : `msedgedriver.exe` de la même version majeure que le runtime
// WebView2. Construire le binaire avant (recette dans docs/APP.md).
//
// Usage : `npm run test:app` (Linux) ; sous Windows, `node app\e2e\run.mjs`
// avec CARGO_TARGET_DIR réglé comme au build.
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { remote } from "webdriverio";

const isWindows = process.platform === "win32";
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const repoRoot = path.resolve(webRoot, "..");
const outDir = path.join(webRoot, "app", "e2e", ".output");

const profile = process.env.E2E_BUILD_PROFILE || (isWindows ? "release" : "debug");
const targetDir = process.env.CARGO_TARGET_DIR || (isWindows ? path.join(os.homedir(), "guivault-app-target-windows") : path.join(repoRoot, "app-tauri", "target"));
const appBinary = path.join(targetDir, profile, isWindows ? "guivault-app.exe" : "guivault-app");
// Windows : voir `edgeDriver()` plus bas.
const nativeDriver = isWindows ? null : "/usr/bin/WebKitWebDriver";
const tauriDriver = (() => {
  const p = path.join(os.homedir(), ".cargo", "bin", isWindows ? "tauri-driver.exe" : "tauri-driver");
  return existsSync(p) ? p : "tauri-driver";
})();
// WSLg : GTK rendrait en Wayland natif, invisible pour WebKitWebDriver.
const env = isWindows ? { ...process.env } : { ...process.env, DISPLAY: process.env.DISPLAY || ":0", GDK_BACKEND: "x11" };

/** Le dossier des coffres de ce passage : effacé à la fin, retiré des
 * coffres récents de l'app. */
const scratch = path.join(os.tmpdir(), `guivault-e2e-${process.pid}-${Date.now()}`);
const PASSWORD = "un mot de passe maître de test";
const SECRET = "Code de la porte";

function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const s = net.connect(port, "127.0.0.1");
      s.once("connect", () => { s.end(); resolve(); });
      s.once("error", () => {
        s.destroy();
        if (Date.now() > deadline) reject(new Error(`rien n'écoute sur le port ${port}`));
        else setTimeout(tick, 300);
      });
    };
    tick();
  });
}

/** Le premier `/src/main.tsx` fait pré-empaqueter les dépendances par Vite :
 * on le paie ici, pas dans l'attente du montage de React. */
async function warmVite(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await fetch("http://localhost:1431/src/main.tsx");
      await r.text();
      if (r.ok) return;
    } catch {
      // pas encore prêt
    }
    if (Date.now() > deadline) throw new Error("Vite n'a jamais servi /src/main.tsx");
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** La version du runtime WebView2 installé (celle d'Edge à défaut : même
 * numéro de version, même moteur). */
function webview2Version() {
  const clients = ["{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}", "{56EB18F8-B008-4CBD-B6D2-8C97FE7E9062}"];
  const roots = ["HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients", "HKCU\\Software\\Microsoft\\EdgeUpdate\\Clients"];
  for (const client of clients) {
    for (const root of roots) {
      const r = spawnSync("reg", ["query", `${root}\\${client}`, "/v", "pv"], { encoding: "utf8" });
      const m = /pv\s+REG_SZ\s+([\d.]+)/.exec(r.stdout ?? "");
      if (m && m[1] !== "0.0.0.0") return m[1];
    }
  }
  return null;
}

/** Le `msedgedriver.exe` de **la même version** que le runtime WebView2 —
 * sinon « only supports Microsoft Edge version N », et WebView2 se met à
 * jour tout seul. Téléchargé une fois depuis Microsoft dans
 * `~/edgedriver-<version>/`, et gardé seulement si sa signature Authenticode
 * est valide et au nom de Microsoft. `EDGEDRIVER_PATH` l'impose. */
async function edgeDriver() {
  if (process.env.EDGEDRIVER_PATH) return process.env.EDGEDRIVER_PATH;
  const version = webview2Version();
  if (!version) throw new Error("runtime WebView2 introuvable (registre EdgeUpdate) : régler EDGEDRIVER_PATH");
  const dir = path.join(os.homedir(), `edgedriver-${version}`);
  const exe = path.join(dir, "msedgedriver.exe");
  if (existsSync(exe)) return exe;
  console.log(`msedgedriver ${version} (celle de WebView2) : téléchargement depuis Microsoft…`);
  const res = await fetch(`https://msedgedriver.microsoft.com/${version}/edgedriver_win64.zip`);
  if (!res.ok) throw new Error(`msedgedriver ${version} : HTTP ${res.status}`);
  await mkdir(dir, { recursive: true });
  const zip = path.join(dir, "edgedriver_win64.zip");
  await writeFile(zip, Buffer.from(await res.arrayBuffer()));
  const ps = (cmd) => spawnSync("powershell.exe", ["-NoProfile", "-Command", cmd], { encoding: "utf8" });
  ps(`Expand-Archive -Force -LiteralPath '${zip}' -DestinationPath '${dir}'; Remove-Item -LiteralPath '${zip}'`);
  const sig = ps(`$s = Get-AuthenticodeSignature -LiteralPath '${exe}'; "$($s.Status)|$($s.SignerCertificate.Subject)"`).stdout.trim();
  if (!/^Valid\|.*O=Microsoft Corporation/.test(sig)) {
    await rm(dir, { recursive: true, force: true });
    throw new Error(`msedgedriver téléchargé, signature refusée (${sig || "illisible"}) : effacé`);
  }
  return exe;
}

/** Tue un processus **et ses enfants** : tauri-driver lance le pilote natif
 * (WebKitWebDriver, msedgedriver), qui survivrait sinon à son parent et
 * garderait le port 4445 — le passage suivant échouerait sur « Failed to
 * match capabilities », et sous WSL ce port bloque même le Windows d'à côté
 * (relayé par `wslrelay.exe`). Linux : tout le groupe (lancé `detached`) ;
 * Windows : `taskkill /T`. */
function killTree(child) {
  if (!child?.pid) return;
  if (isWindows) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

// ─── Petits outils ──────────────────────────────────────────────────────────

const xpathText = (s) => (s.includes("'") ? `concat('${s.split("'").join("', \"'\", '")}')` : `'${s}'`);

async function button(browser, text, timeout = 10_000) {
  const el = await browser.$(`//button[normalize-space()=${xpathText(text)}]`);
  await el.waitForClickable({ timeout, timeoutMsg: `bouton « ${text} » introuvable` });
  return el;
}

const click = async (browser, text, timeout) => (await button(browser, text, timeout)).click();

async function fillField(browser, label, value) {
  const el = await browser.$(`//label[span[normalize-space()=${xpathText(label)}]]//*[self::input or self::textarea]`);
  await el.waitForDisplayed({ timeout: 10_000, timeoutMsg: `champ « ${label} » introuvable` });
  await el.setValue(value);
}

async function fillPasswords(browser, ...values) {
  const inputs = await browser.$$('input[type="password"]');
  if (inputs.length < values.length) throw new Error(`${values.length} champs de mot de passe attendus, ${inputs.length} trouvés`);
  for (let i = 0; i < values.length; i++) await inputs[i].setValue(values[i]);
}

/** Le texte visible, par `innerText` (calculé par la page, CSS compris) :
 * le `getText()` de WebKitWebDriver saute le texte des liens `<a>`. */
async function bodyText(browser) {
  return browser.execute(() => document.body.innerText);
}

async function waitText(browser, text, timeout = 15_000) {
  await browser.waitUntil(async () => (await bodyText(browser)).includes(text), { timeout, timeoutMsg: `« ${text} » n'est jamais apparu` });
}

/** Le texte visible de la barre latérale (le tiroir des fenêtres étroites,
 * masqué, n'a pas d'`innerText`). */
async function sidebarText(browser) {
  return browser.execute(() => Array.from(document.querySelectorAll("aside")).map((a) => a.innerText).join("\n"));
}

/** Ce que l'app a écrit sur le disque. */
function coffreOnDisk(dir) {
  const raw = readFileSync(path.join(dir, "coffre.json"), "utf8");
  return { raw, json: JSON.parse(raw) };
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function shot(browser, name) {
  await mkdir(outDir, { recursive: true }).catch(() => {});
  await browser.saveScreenshot(path.join(outDir, `${name}.png`)).catch(() => {});
}

// ─── Scénarios ──────────────────────────────────────────────────────────────

const scenarios = [];
const scenario = (name, run) => scenarios.push({ name, run });

const coffre = path.join(scratch, "Mon coffre.guivault");

scenario("la fenêtre s'ouvre sur l'accueil", async (b) => {
  await b.waitUntil(async () => (await b.getTitle()) === "GuiVault", { timeout: 15_000, timeoutMsg: "le titre n'est jamais devenu « GuiVault »" });
  await button(b, "Créer un coffre local", 30_000);
  await button(b, "Ouvrir un coffre local");
  await button(b, "Se connecter à un serveur");
  await shot(b, "1-accueil");
});

scenario("créer un coffre local : un dossier sur le disque, rien en clair", async (b) => {
  await b.execute((p) => { window.__GUIVAULT_E2E_PATH__ = p; }, coffre);
  await click(b, "Créer un coffre local");
  await waitText(b, "Nouveau coffre : Mon coffre");
  await fillPasswords(b, PASSWORD, PASSWORD);
  await click(b, "Créer le coffre");
  // Argon2id à 64 Mio dans le webview : quelques secondes.
  await b.waitUntil(async () => (await sidebarText(b).catch(() => "")).includes("Personnel"), { timeout: 60_000, timeoutMsg: "la page du vault n'est jamais apparue" });
  const { raw, json } = coffreOnDisk(coffre);
  assert(json.format === 1 && json.vaults.length === 1 && json.vaults[0].kind === "personal", "coffre.json ne décrit pas un coffre neuf avec son vault personnel");
  assert(!raw.includes("Personnel"), "le nom du vault est en clair dans coffre.json");
});

scenario("en local, ce qui demande un serveur n'apparaît pas", async (b) => {
  const side = await sidebarText(b);
  for (const absent of ["Invitations", "Liens de partage", "Se déconnecter"]) assert(!side.includes(absent), `« ${absent} » est dans la barre latérale d'un coffre local`);
  assert(side.includes("Mon coffre") && side.includes("Fermer le coffre"), "la barre latérale ne nomme pas le coffre local");
  await (await b.$("//a[contains(normalize-space(), 'Coffre local et paramètres')]")).click();
  await waitText(b, "Coffre local « Mon coffre »");
  let text = await bodyText(b);
  for (const absent of ["Sessions", "Accès d'urgence", "Supprimer le compte", "Votre empreinte"]) assert(!text.includes(absent), `« ${absent} » est dans les paramètres d'un coffre local`);
  await (await b.$("//a[normalize-space()='Sécurité']")).click();
  await waitText(b, "Mot de passe maître");
  text = await bodyText(b);
  for (const absent of ["Second facteur", "Copie hors ligne", "Passkeys"]) assert(!text.includes(absent), `« ${absent} » est dans la sécurité d'un coffre local`);
  await shot(b, "2-parametres");
  await (await b.$("//a[.//span[normalize-space()='Personnel']]")).click();
});

scenario("créer une note : écrite chiffrée dans le coffre", async (b) => {
  await (await b.$("//button[contains(normalize-space(), 'Nouveau') and @aria-haspopup='menu']")).click();
  await (await b.$("//button[@role='menuitem'][normalize-space()='Note']")).click();
  await waitText(b, "Nouvelle note");
  await fillField(b, "Nom", SECRET);
  await fillField(b, "Contenu", "1234-5678");
  await click(b, "Enregistrer");
  await b.waitUntil(async () => coffreOnDisk(coffre).json.vaults[0].items.length === 1, { timeout: 15_000, timeoutMsg: "la note n'a jamais été écrite dans coffre.json" });
  await waitText(b, SECRET);
  const { raw } = coffreOnDisk(coffre);
  assert(!raw.includes(SECRET) && !raw.includes("1234-5678"), "la note est en clair dans coffre.json");
  await shot(b, "3-note");
});

scenario("fermer puis rouvrir : coffres récents, mauvais mot de passe refusé", async (b) => {
  await click(b, "Fermer le coffre");
  await button(b, "Créer un coffre local");
  await (await b.$(`//button[.//span[normalize-space()='Mon coffre']]`)).click();
  await fillPasswords(b, "pas le bon mot de passe");
  await click(b, "Déverrouiller");
  await waitText(b, "Mot de passe maître incorrect.", 60_000);
  const input = await b.$('input[type="password"]');
  await input.clearValue();
  await input.setValue(PASSWORD);
  await click(b, "Déverrouiller");
  await b.waitUntil(async () => (await bodyText(b)).includes(SECRET), { timeout: 60_000, timeoutMsg: "la note n'est pas revenue après le déverrouillage" });
  await click(b, "Fermer le coffre");
  await button(b, "Créer un coffre local");
});

scenario("créer par-dessus un coffre existant : l'erreur de l'hôte arrive", async (b) => {
  await b.execute((p) => { window.__GUIVAULT_E2E_PATH__ = p; }, coffre);
  await click(b, "Créer un coffre local");
  await fillPasswords(b, PASSWORD, PASSWORD);
  await click(b, "Créer le coffre");
  await waitText(b, "il y a déjà un coffre", 60_000);
  await click(b, "Retour");
});

scenario("se connecter à un serveur qui ne répond pas : dit clairement", async (b) => {
  await click(b, "Se connecter à un serveur");
  const url = await b.$('input[placeholder="https://vault.exemple.fr"]');
  await url.clearValue();
  await url.setValue("http://127.0.0.1:9");
  await click(b, "Continuer");
  await waitText(b, "Aucun serveur GuiVault ne répond");
  await click(b, "Retour");
});

// ─── Déroulement ────────────────────────────────────────────────────────────

async function main() {
  if (!existsSync(appBinary)) {
    console.error(`Binaire introuvable : ${appBinary}`);
    console.error(profile === "release" ? "Construire : cd app-tauri && cargo build --release --features tauri/custom-protocol" : "Construire : cd app-tauri && cargo build");
    process.exit(1);
  }
  let native;
  try {
    native = nativeDriver ?? (await edgeDriver());
  } catch (e) {
    console.error("ÉCHEC :", e instanceof Error ? e.message : e);
    process.exit(1);
  }
  await mkdir(scratch, { recursive: true });

  let vite = null;
  if (profile === "debug") {
    // Le binaire de dev charge devUrl. node + vite.js plutôt que le `npx`
    // de Windows (un .cmd, que cmd.exe ne lance pas depuis un chemin UNC).
    vite = spawn(process.execPath, [path.join(webRoot, "node_modules", "vite", "bin", "vite.js"), "-c", "vite.app.config.ts"], { cwd: webRoot, env, stdio: "ignore", detached: !isWindows });
  }
  // E2E_DRIVER_LOG=fichier : ce que disent tauri-driver et le pilote natif
  // (une session refusée ne dit rien d'autre que « capabilities »).
  const driverLog = process.env.E2E_DRIVER_LOG ? createWriteStream(process.env.E2E_DRIVER_LOG) : null;
  const driver = spawn(tauriDriver, ["--native-driver", native], { env, stdio: driverLog ? ["ignore", "pipe", "pipe"] : "ignore", detached: !isWindows });
  if (driverLog) {
    driver.stdout.pipe(driverLog);
    driver.stderr.pipe(driverLog);
  }
  driver.on("error", (e) => console.error("tauri-driver ne démarre pas (cargo install tauri-driver ?) :", e.message));

  let failed = 0;
  try {
    if (vite) await warmVite(120_000);
    await waitForPort(4444, 15_000);
    const browser = await remote({
      hostname: "127.0.0.1",
      port: 4444,
      path: "/",
      capabilities: { "tauri:options": { application: appBinary } },
      logLevel: "warn",
      connectionRetryCount: 3,
    });
    try {
      // Les scénarios s'enchaînent : un échec arrête la suite (les suivants
      // partent de l'état que le précédent laisse).
      for (const { name, run } of scenarios) {
        const started = Date.now();
        try {
          await run(browser);
          console.log(`  ✓ ${name} (${Math.round((Date.now() - started) / 100) / 10} s)`);
        } catch (e) {
          failed++;
          console.error(`  ✗ ${name}\n    ${e instanceof Error ? e.message : e}`);
          const visible = await bodyText(browser).catch((err) => `(illisible : ${err.message})`);
          console.error(`    texte visible : ${visible.replace(/\s+/g, " ").slice(0, 300)}`);
          await shot(browser, "echec");
          console.error(`    capture : ${path.join(outDir, "echec.png")}`);
          break;
        }
      }
    } finally {
      // Les coffres de ce passage ne restent pas dans les récents de l'app,
      // même après un échec.
      await browser.execute((prefix) => {
        try {
          const list = JSON.parse(localStorage.getItem("guivault.app.recents") ?? "[]");
          localStorage.setItem("guivault.app.recents", JSON.stringify(list.filter((p) => !String(p).startsWith(prefix))));
        } catch {
          // stockage inaccessible : rien à ranger
        }
      }, scratch).catch(() => {});
      await browser.deleteSession().catch(() => {});
    }
  } catch (e) {
    failed++;
    console.error("ÉCHEC :", e instanceof Error ? e.message : e);
  } finally {
    killTree(driver);
    killTree(vite);
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
  console.log(failed ? `ÉCHEC (${scenarios.length} scénarios, arrêt au premier échec)` : `OK : ${scenarios.length} scénarios dans la vraie fenêtre (${isWindows ? "WebView2" : "WebKitGTK"}).`);
  process.exit(failed ? 1 : 0);
}

main();
