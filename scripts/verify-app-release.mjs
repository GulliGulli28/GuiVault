#!/usr/bin/env node
// Vérifie une release de l'application **avant de la publier** (docs/APP.md,
// « Mises à jour ») : télécharge `latest.json` et les installeurs du
// brouillon, et contrôle pour chaque entrée (`windows-x86_64`, `-nsis`,
// `-msi`) la signature minisign contre la clé publique embarquée dans l'app
// (`app-tauri/tauri.conf.json`, plugins.updater.pubkey) — exactement ce que
// fera tauri-plugin-updater chez les utilisateurs.
//
//   node scripts/verify-app-release.mjs app-v0.1.1
//   node scripts/verify-app-release.mjs app-v0.1.1 --dir <dossier>   # latest.json et installeurs déjà là
//
// Demande `gh` (connecté) et `web/node_modules` (@noble/curves, @noble/hashes).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const noble = path.join(root, "web", "node_modules", "@noble");
const { ed25519 } = await import(path.join(noble, "curves", "ed25519.js"));
const { blake2b } = await import(path.join(noble, "hashes", "blake2.js")).catch(() => import(path.join(noble, "hashes", "blake2b.js")));

const tag = process.argv[2];
const local = process.argv[3] === "--dir" ? process.argv[4] : null;
if (!/^app-v\d+\.\d+\.\d+$/.test(tag ?? "")) {
  console.error("usage : node scripts/verify-app-release.mjs app-v<version>");
  process.exit(2);
}
const conf = JSON.parse(readFileSync(path.join(root, "app-tauri", "tauri.conf.json"), "utf8"));
const version = tag.slice("app-v".length);
const fail = (m) => {
  console.error(`ÉCHEC : ${m}`);
  process.exit(1);
};

const dir = local ?? mkdtempSync(path.join(tmpdir(), "guivault-release-"));
try {
  if (!local) execFileSync("gh", ["release", "download", tag, "-p", "latest.json", "-p", "*-setup.exe", "-p", "*.msi", "-D", dir], { cwd: root, stdio: "inherit" });
  const latest = JSON.parse(readFileSync(path.join(dir, "latest.json"), "utf8"));
  if (latest.version !== version) fail(`latest.json annonce ${latest.version}, le tag ${version}`);
  // L'entrée générique (installations d'avant le marqueur du bundler) et une
  // par installeur : un MSI recevrait sinon l'installeur NSIS.
  for (const key of ["windows-x86_64", "windows-x86_64-nsis", "windows-x86_64-msi"]) {
    if (!latest.platforms?.[key]) fail(`latest.json sans plate-forme ${key}`);
  }
  if (!latest.platforms["windows-x86_64"].url.endsWith("-setup.exe")) fail("windows-x86_64 doit rester l'installeur NSIS");
  if (!latest.platforms["windows-x86_64-msi"].url.endsWith(".msi")) fail("windows-x86_64-msi ne pointe pas vers un .msi");

  // Clé publique et signature : du texte minisign, lui-même en base64.
  const lines = (b64) => Buffer.from(b64, "base64").toString("utf8").trim().split("\n");
  const pub = Buffer.from(lines(conf.plugins.updater.pubkey)[1], "base64"); // "Ed" ‖ id(8) ‖ clé(32)
  for (const [key, entry] of Object.entries(latest.platforms)) {
    const file = decodeURIComponent(new URL(entry.url).pathname.split("/").pop());
    if (!entry.url.includes(`/releases/download/${tag}/`)) fail(`${key} : l'URL ne pointe pas vers ${tag} : ${entry.url}`);
    const sigLines = lines(entry.signature);
    const sig = Buffer.from(sigLines[1], "base64"); // algo(2) ‖ id(8) ‖ signature(64)
    if (!pub.subarray(2, 10).equals(sig.subarray(2, 10))) fail(`${key} : la signature n'est pas de la clé embarquée dans l'app`);
    const data = readFileSync(path.join(dir, file));
    const message = sig.subarray(0, 2).toString() === "ED" ? blake2b(data, { dkLen: 64 }) : data;
    if (!ed25519.verify(sig.subarray(10, 74), message, pub.subarray(10, 42))) fail(`${key} : signature invalide pour ${file}`);
    const trusted = sigLines[2].replace(/^trusted comment: /, "");
    const global = Buffer.from(sigLines[3], "base64");
    if (!ed25519.verify(global, Buffer.concat([sig.subarray(10, 74), Buffer.from(trusted)]), pub.subarray(10, 42))) fail(`${key} : commentaire de confiance altéré`);
    if (!trusted.includes(`version:${version}`)) fail(`${key} : commentaire de confiance sans version:${version} : ${trusted}`);
    console.log(`OK ${key} : ${file} (${data.length} octets) signé par la clé ${pub.subarray(2, 10).toString("hex")} — ${trusted.replace(/\t/g, ", ")}`);
  }
} finally {
  if (!local) rmSync(dir, { recursive: true, force: true });
}
