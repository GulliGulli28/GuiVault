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
//   Interface      `vite preview` sur :1431       `web/dist-app` embarqué
//                  (devUrl, construite avant)
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

async function waitHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // pas encore prêt
    }
    if (Date.now() > deadline) throw new Error(`rien ne répond sur ${url}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** Lance Windows PowerShell **sans** le `PSModulePath` hérité : lancé depuis
 * PowerShell 7 (l'étape d'un runner GitHub), il pointerait vers les modules
 * de la 7, que la 5.1 ne sait pas charger — `Get-AuthenticodeSignature`
 * ne répondait alors rien, et le pilote téléchargé était refusé. */
function powershell(command) {
  const env = { ...process.env };
  delete env.PSModulePath;
  return spawnSync("powershell.exe", ["-NoProfile", "-STA", "-Command", command], { encoding: "utf8", env });
}

/** La version du runtime WebView2 installé (celle d'Edge à défaut : même
 * numéro de version, même moteur — mais sans runtime WebView2, l'app ne
 * démarre pas son webview, et le pilote attend en vain son
 * `DevToolsActivePort` : d'où `source`, dit dans le journal). */
function webview2Version() {
  const clients = ["{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}", "{56EB18F8-B008-4CBD-B6D2-8C97FE7E9062}"];
  const roots = ["HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients", "HKCU\\Software\\Microsoft\\EdgeUpdate\\Clients"];
  for (const client of clients) {
    for (const root of roots) {
      const r = spawnSync("reg", ["query", `${root}\\${client}`, "/v", "pv"], { encoding: "utf8" });
      const m = /pv\s+REG_SZ\s+([\d.]+)/.exec(r.stdout ?? "");
      if (m && m[1] !== "0.0.0.0") return { version: m[1], source: client === clients[0] ? "WebView2" : "Edge — runtime WebView2 introuvable" };
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
  const found = webview2Version();
  if (!found) throw new Error("runtime WebView2 introuvable (registre EdgeUpdate) : régler EDGEDRIVER_PATH");
  const { version, source } = found;
  const dir = path.join(os.homedir(), `edgedriver-${version}`);
  const exe = path.join(dir, "msedgedriver.exe");
  if (existsSync(exe)) return exe;
  console.log(`msedgedriver ${version} (version lue : ${source}) : téléchargement depuis Microsoft…`);
  const res = await fetch(`https://msedgedriver.microsoft.com/${version}/edgedriver_win64.zip`);
  if (!res.ok) throw new Error(`msedgedriver ${version} : HTTP ${res.status}`);
  await mkdir(dir, { recursive: true });
  const zip = path.join(dir, "edgedriver_win64.zip");
  await writeFile(zip, Buffer.from(await res.arrayBuffer()));
  const unzip = powershell(`Expand-Archive -Force -LiteralPath '${zip}' -DestinationPath '${dir}'; Remove-Item -LiteralPath '${zip}'`);
  const check = powershell(`$s = Get-AuthenticodeSignature -LiteralPath '${exe}'; "$($s.Status)|$($s.SignerCertificate.Subject)"`);
  const sig = (check.stdout ?? "").trim();
  if (!/^Valid\|.*O=Microsoft Corporation/.test(sig)) {
    await rm(dir, { recursive: true, force: true });
    const why = [unzip.stderr, check.stderr].map((e) => (e ?? "").trim()).filter(Boolean).join(" / ").slice(0, 400);
    throw new Error(`msedgedriver téléchargé, signature refusée (${sig || "illisible"}${why ? ` — ${why}` : ""}) : effacé`);
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
/** Vide un champ **comme un utilisateur** (tout sélectionner, effacer) :
 * `clearValue()` ne déclenche pas le `onChange` de React, et le filtre de la
 * liste gardait son texte. */
async function clearField(browser, el) {
  await el.click();
  await browser.keys(["Control", "a"]);
  await browser.keys("Backspace");
}

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

/** Une commande de l'application, depuis la page (W3C : la promesse est
 * attendue). Rend `{ ok, value }` ou `{ ok: false, error }`. */
async function invoke(b, cmd, args = {}) {
  return b.execute((c, a) => window.__TAURI_INTERNALS__.invoke(c, a).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error })), cmd, args);
}

async function openSettings(b, section) {
  await (await b.$("//a[contains(normalize-space(), 'Coffre local et paramètres')]")).click();
  await waitText(b, "Coffre local « Mon coffre »");
  if (section) await (await b.$(`//a[normalize-space()=${xpathText(section)}]`)).click();
}

scenario("saisie automatique : fiche, réglages, frappe réelle (Windows)", async (b) => {
  const available = (await invoke(b, "autotype_available")).value === true;
  if (!available) {
    await openSettings(b);
    assert(!(await bodyText(b)).includes("Saisie automatique"), "« Saisie automatique » est proposée sur un système où l'application ne sait pas taper");
    await (await b.$("//a[.//span[normalize-space()='Personnel']]")).click();
    return "ignoré : pas de saisie automatique sur ce système (et rien n'en est montré)";
  }

  // Un identifiant, et son bouton sur la fiche.
  await (await b.$("//button[contains(normalize-space(), 'Nouveau') and @aria-haspopup='menu']")).click();
  await (await b.$("//button[@role='menuitem'][normalize-space()='Identifiant']")).click();
  await waitText(b, "Nouvel identifiant");
  await fillField(b, "Nom", "Banque en ligne");
  await fillField(b, "Utilisateur", "alice");
  await fillField(b, "Mot de passe", "s3cret!");
  await waitText(b, "Saisie automatique");
  await click(b, "Enregistrer");
  await (await b.$('button[aria-label="Saisie automatique"]')).waitForDisplayed({ timeout: 10_000, timeoutMsg: "pas de bouton « Saisie automatique » sur la fiche d'un identifiant" });

  // Les réglages : un raccourci mal écrit refusé, un bon posé — puis ceux de
  // la personne qui lance le test remis tels quels (même profil d'app).
  const saved = await b.execute(() => localStorage.getItem("guivault.autotype"));
  try {
    await openSettings(b, "Saisie automatique");
    const hotkey = await b.$("#autotype-hotkey");
    await hotkey.waitForDisplayed({ timeout: 10_000 });
    await hotkey.clearValue();
    await hotkey.setValue("Ctrl+Pomme");
    await click(b, "Appliquer");
    await waitText(b, "refusé");
    await hotkey.clearValue();
    await hotkey.setValue("Ctrl+Alt+Shift+F11");
    await click(b, "Appliquer");
    await waitText(b, "Raccourci global : Ctrl+Alt+Shift+F11");
    await shot(b, "4-saisie-auto");
  } finally {
    const before = saved ? JSON.parse(saved).hotkey ?? "Ctrl+Alt+A" : "Ctrl+Alt+A";
    await b.execute((v) => { if (v === null) localStorage.removeItem("guivault.autotype"); else localStorage.setItem("guivault.autotype", v); }, saved);
    await invoke(b, "autotype_set_hotkey", { accelerator: before });
  }

  // Une vraie frappe (SendInput), dans GuiVault lui-même : le champ de
  // filtre de la page du vault. Jamais dans une autre fenêtre.
  await (await b.$("//a[.//span[normalize-space()='Personnel']]")).click();
  const filter = await b.$('input[placeholder^="Filtrer"]');
  await filter.waitForDisplayed({ timeout: 10_000 });
  await filter.click();
  const self = (await invoke(b, "autotype_self_target")).value;
  assert(typeof self === "string", "pas de handle pour la fenêtre de GuiVault");
  const r = await invoke(b, "autotype_type", { actions: [{ kind: "text", text: "saisie-é€x" }, { kind: "key", key: "Backspace" }], target: self });
  if (!r.ok && ["autotype_focus_lost", "autotype_modifiers"].includes(r.error?.code)) {
    await clearField(b, filter);
    return `ignoré pour la frappe : ${r.error.message} (la fenêtre de test n'avait pas le premier plan)`;
  }
  assert(r.ok, `la saisie a échoué : ${JSON.stringify(r.error)}`);
  await b.waitUntil(async () => (await filter.getValue()) === "saisie-é€", { timeout: 5000, timeoutMsg: "le champ ne contient pas le texte tapé" });
  await clearField(b, filter);
  await b.waitUntil(async () => (await filter.getValue()) === "", { timeout: 5000, timeoutMsg: "le filtre ne s'est pas vidé" });
});

/** Le presse-papiers de Windows, lu et écrit de l'extérieur de l'app. */
/** PowerShell 5.1 écrit sa sortie dans la page de code de la console : un
 * « é » relu côté node n'en est plus un. Sortie forcée en UTF-8, et le texte
 * à poser passé en base64 — sinon le presse-papiers de la personne qui lance
 * les tests, remis en fin de scénario, revenait abîmé. */
function ps(command) {
  return (powershell(`[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`).stdout ?? "").replace(/\r?\n$/, "");
}
const clipboardText = () => ps("$t = Get-Clipboard -Raw; if ($t) { [Console]::Out.Write($t) }");
const clipboardFormats = () => ps("Add-Type -AssemblyName System.Windows.Forms; $d = [System.Windows.Forms.Clipboard]::GetDataObject(); if ($d) { $d.GetFormats() -join ',' }").split(",");
/** Le presse-papiers est partagé : une autre application peut le tenir un
 * instant, et une lecture le voir à moitié. On relit jusqu'à `want`, et
 * l'échec dit ce qui a été lu. */
async function waitClipboard(want, message, timeout = 4000) {
  const deadline = Date.now() + timeout;
  let seen = clipboardText();
  while (seen !== want && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    seen = clipboardText();
  }
  assert(seen === want, `${message} (lu : ${JSON.stringify(seen)})`);
}
const setClipboard = (t) =>
  ps(t ? `Set-Clipboard -Value ([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(t, "utf8").toString("base64")}')))` : "Set-Clipboard -Value $null");

scenario("presse-papiers : hors de l'historique Windows, effacé à l'échéance (Windows)", async (b) => {
  if (!isWindows) return "ignoré : presse-papiers natif sous Windows seulement";
  assert((await invoke(b, "clipboard_native")).value === true, "l'application n'offre pas son presse-papiers natif sous Windows");
  const saved = clipboardText();
  try {
    // Par l'interface : « Copier » à côté du mot de passe de la fiche.
    await (await b.$("//*[normalize-space(text())='Banque en ligne']")).click();
    await (await b.$("//button[@aria-label='Révéler']/following-sibling::button[@aria-label='Copier']")).click();
    await waitClipboard("s3cret!", "le mot de passe n'est pas dans le presse-papiers", 5000);
    const formats = clipboardFormats();
    for (const f of ["ExcludeClipboardContentFromMonitorProcessing", "CanIncludeInClipboardHistory", "CanUploadToCloudClipboard"]) {
      assert(formats.includes(f), `format ${f} absent : le mot de passe irait dans l'historique Windows (formats : ${formats.join(", ")})`);
    }
    // Effacé à l'échéance…
    const once = await invoke(b, "clipboard_copy_secret", { text: "e2e-efface", clearAfterMs: 1200 });
    assert(once.ok, `copie refusée : ${JSON.stringify(once.error)}`);
    await waitClipboard("e2e-efface", "la copie n'est pas arrivée");
    await waitClipboard("", "le presse-papiers n'a pas été effacé à l'échéance");
    // … mais pas si quelqu'un a copié autre chose entre-temps.
    await invoke(b, "clipboard_copy_secret", { text: "e2e-remplace", clearAfterMs: 3000 });
    setClipboard("copié par quelqu'un d'autre");
    await waitClipboard("copié par quelqu'un d'autre", "la copie « d'un autre » n'est pas arrivée");
    // Au-delà de l'échéance (3 s) : notre copie n'y est plus, rien n'est effacé.
    await new Promise((r) => setTimeout(r, 3500));
    const after = clipboardText();
    assert(after === "copié par quelqu'un d'autre", `le presse-papiers ne contient plus la copie faite entre-temps : ${JSON.stringify(after)}`);
  } finally {
    setClipboard(saved);
  }
});

async function unlockFromRecents(b) {
  await (await b.$(`//button[.//span[normalize-space()='Mon coffre']]`)).click();
  await fillPasswords(b, PASSWORD);
  await click(b, "Déverrouiller");
  await b.waitUntil(async () => (await sidebarText(b)).includes("Personnel"), { timeout: 60_000, timeoutMsg: "le coffre ne s'est pas rouvert" });
}

scenario("verrouillage : le signal du système verrouille, réglages Application", async (b) => {
  await openSettings(b, "Application");
  await waitText(b, "Quand la fenêtre est réduite");
  // L'extension de navigateur : l'état se lit, on ne l'active pas (ce
  // serait écrire dans le registre ou le profil de navigateur de qui lance
  // les tests).
  await waitText(b, "Permettre à l'extension GuiVault d'ouvrir les coffres locaux");
  const linked = await invoke(b, "app_browser_integration", { enabled: null });
  assert(linked.ok && typeof linked.value === "boolean", `état de l'extension illisible : ${JSON.stringify(linked.error)}`);
  if (isWindows) {
    // Sans casse : les intitulés de section sont en capitales par CSS.
    const text = (await bodyText(b)).toLowerCase();
    for (const want of ["Zone de notification", "Fermer la fenêtre la range dans la zone de notification", "Démarrer avec Windows", "Quand la session Windows se verrouille"]) {
      assert(text.includes(want.toLowerCase()), `« ${want} » manque dans Paramètres › Application`);
    }
    // L'état du démarrage automatique se lit — on ne le change pas : ce
    // serait écrire dans le registre de la personne qui lance les tests.
    const auto = await invoke(b, "app_autostart", { enabled: null });
    assert(auto.ok && typeof auto.value === "boolean", `démarrage automatique illisible : ${JSON.stringify(auto.error)}`);
  }
  await shot(b, "5-application");
  // Ce que `system.rs` envoie quand la session Windows se verrouille (Win+L
  // ne se presse pas dans un test : il verrouillerait la vraie session).
  await invoke(b, "plugin:event|emit", { event: "system-lock", payload: "session" });
  await waitText(b, "Verrouillé : la session Windows a été verrouillée.");
  await button(b, "Créer un coffre local");
  await unlockFromRecents(b);
});

scenario("sauvegardes : prises avant d'écrire, une copie s'ouvre à part", async (b) => {
  await openSettings(b);
  await waitText(b, "au plus une par heure");
  const copy = path.join(scratch, "Copie.guivault");
  const open = await b.$("//button[normalize-space()='Ouvrir une copie…']");
  await open.waitForClickable({ timeout: 10_000, timeoutMsg: "aucune sauvegarde listée alors que le coffre a été modifié" });
  await b.execute((p) => { window.__GUIVAULT_E2E_PATH__ = p; }, copy);
  await open.click();
  await waitText(b, "Copie créée");
  const original = coffreOnDisk(coffre).json;
  const restored = coffreOnDisk(copy).json;
  assert(restored.format === 1 && restored.vaults[0].id === original.vaults[0].id, "la copie n'est pas le même coffre");
  assert(restored.id !== original.id, "la copie garde l'identifiant de l'original");
  await (await b.$("//a[.//span[normalize-space()='Personnel']]")).click();
});

scenario("import KeePass : une vraie base .kdbx, pièce jointe comprise", async (b) => {
  // Écrite par KeePass 2.61 (`src/lib/fixtures/kdbx/make.ps1`) : le chemin
  // navigateur de kdbxweb (WebCrypto) ne se prouve qu'ici, les tests unitaires
  // tournent sous Node.
  const kdbx = path.join(webRoot, "src", "lib", "fixtures", "kdbx", "keepass-argon2d.kdbx");
  const before = coffreOnDisk(coffre).json.vaults[0].items.length;
  await (await b.$('button[aria-label="Importer / exporter"]')).click();
  await waitText(b, "KeePass et KeePassXC");
  const input = await b.$('input[type="file"]');
  // Masqué (sr-only) : `setValue` le viderait d'abord, ce que WebDriver
  // refuse ; envoyer un chemin à un champ de fichier, lui, est permis.
  await input.addValue(kdbx);
  await waitText(b, "est une base KeePass");
  await fillPasswords(b, "guivault-kdbx-test");
  await click(b, "Déchiffrer");
  await waitText(b, "KeePass (KDBX 4.0) : 4 élément(s)", 60_000);
  await click(b, "Importer");
  await waitText(b, "1 pièce(s) jointe(s)", 60_000);
  const after = coffreOnDisk(coffre);
  // 4 éléments et leurs dossiers (Internet, Banques).
  assert(after.json.vaults[0].items.length >= before + 6, `import incomplet : ${after.json.vaults[0].items.length - before} écritures`);
  assert(!after.raw.includes("gh-pass-2") && !after.raw.includes("contenu de la pièce jointe"), "un secret KeePass est en clair dans coffre.json");
  assert(after.json.vaults[0].attachments.length === 1 && after.json.vaults[0].attachments[0].complete, "la pièce jointe KeePass n'est pas arrivée");
  await (await b.$("//a[.//span[normalize-space()='Personnel']]")).click();
  await waitText(b, "Wi-Fi maison");
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
  // Une seule instance (`tauri-plugin-single-instance`) : celle du test
  // s'effacerait devant une GuiVault déjà ouverte — et la piloterait.
  if (isWindows) {
    const running = spawnSync("tasklist", ["/FI", "IMAGENAME eq guivault-app.exe", "/NH"], { encoding: "utf8" }).stdout ?? "";
    if (running.toLowerCase().includes("guivault-app.exe")) {
      console.error("ÉCHEC : GuiVault est déjà ouvert (fenêtre ou zone de notification) — le quitter avant les tests.");
      process.exit(1);
    }
  }
  let native;
  try {
    native = nativeDriver ?? (await edgeDriver());
  } catch (e) {
    console.error("ÉCHEC :", e instanceof Error ? e.message : e);
    process.exit(1);
  }
  await mkdir(scratch, { recursive: true });
  // Windows, E2E_DRIVER_LOG : le journal détaillé de msedgedriver à côté
  // (`<fichier>.msedgedriver.txt`). tauri-driver ne lui passe aucune
  // option : un petit .cmd l'enveloppe et les ajoute.
  if (isWindows && process.env.E2E_DRIVER_LOG) {
    const wrapper = path.join(scratch, "msedgedriver-verbose.cmd");
    await writeFile(wrapper, `@"${native}" %* --verbose --log-path="${process.env.E2E_DRIVER_LOG}.msedgedriver.txt"\r\n`);
    native = wrapper;
  }

  let vite = null;
  if (profile === "debug") {
    // Le binaire de dev charge devUrl (:1431). Pas le serveur de dev : il
    // pré-empaquette les dépendances au premier chargement et **recharge la
    // page** quand il en découvre une — le test attendait alors une page
    // vide (cache froid : toujours en CI). L'interface construite, servie par
    // `vite preview` : rien ne bouge, et c'est ce que l'application embarque.
    // node + vite.js plutôt que le `npx` de Windows (un .cmd, que cmd.exe ne
    // lance pas depuis un chemin UNC).
    const viteJs = path.join(webRoot, "node_modules", "vite", "bin", "vite.js");
    const build = spawnSync(process.execPath, [viteJs, "build", "-c", "vite.app.config.ts", "--logLevel", "error"], { cwd: webRoot, env, stdio: "inherit" });
    if (build.status !== 0) {
      console.error("ÉCHEC : construction de l'interface de l'app");
      process.exit(1);
    }
    vite = spawn(process.execPath, [viteJs, "preview", "-c", "vite.app.config.ts", "--port", "1431", "--strictPort"], { cwd: webRoot, env, stdio: "ignore", detached: !isWindows });
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
    if (vite) await waitHttp("http://localhost:1431/", 30_000);
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
          const outcome = await run(browser);
          const took = `${Math.round((Date.now() - started) / 100) / 10} s`;
          // Un scénario qui ne peut pas se jouer ici le dit : ○, jamais ✓.
          if (typeof outcome === "string" && outcome.startsWith("ignoré")) console.log(`  ○ ${name} — ${outcome} (${took})`);
          else console.log(`  ✓ ${name} (${took})`);
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
