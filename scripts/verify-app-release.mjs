#!/usr/bin/env node
// Vérifie une release de l'application **avant de la publier** (docs/APP.md,
// « Mises à jour ») : télécharge `latest.json` et l'installeur NSIS du
// brouillon, et contrôle la signature minisign contre la clé publique
// embarquée dans l'app (`app-tauri/tauri.conf.json`, plugins.updater.pubkey)
// — exactement ce que fera tauri-plugin-updater chez les utilisateurs.
//
//   node scripts/verify-app-release.mjs app-v0.1.1
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

const dir = mkdtempSync(path.join(tmpdir(), "guivault-release-"));
try {
  execFileSync("gh", ["release", "download", tag, "-p", "latest.json", "-p", "*-setup.exe", "-D", dir], { cwd: root, stdio: "inherit" });
  const latest = JSON.parse(readFileSync(path.join(dir, "latest.json"), "utf8"));
  if (latest.version !== version) fail(`latest.json annonce ${latest.version}, le tag ${version}`);
  const win = latest.platforms?.["windows-x86_64"];
  if (!win) fail("latest.json sans plate-forme windows-x86_64");
  const exe = decodeURIComponent(new URL(win.url).pathname.split("/").pop());
  if (!win.url.includes(`/releases/download/${tag}/`)) fail(`l'URL ne pointe pas vers ${tag} : ${win.url}`);

  // Clé publique et signature : du texte minisign, lui-même en base64.
  const lines = (b64) => Buffer.from(b64, "base64").toString("utf8").trim().split("\n");
  const pub = Buffer.from(lines(conf.plugins.updater.pubkey)[1], "base64"); // "Ed" ‖ id(8) ‖ clé(32)
  const sigLines = lines(win.signature);
  const sig = Buffer.from(sigLines[1], "base64"); // algo(2) ‖ id(8) ‖ signature(64)
  if (!pub.subarray(2, 10).equals(sig.subarray(2, 10))) fail("la signature n'est pas de la clé embarquée dans l'app");
  const data = readFileSync(path.join(dir, exe));
  const message = sig.subarray(0, 2).toString() === "ED" ? blake2b(data, { dkLen: 64 }) : data;
  if (!ed25519.verify(sig.subarray(10, 74), message, pub.subarray(10, 42))) fail(`signature invalide pour ${exe}`);
  const trusted = sigLines[2].replace(/^trusted comment: /, "");
  const global = Buffer.from(sigLines[3], "base64");
  if (!ed25519.verify(global, Buffer.concat([sig.subarray(10, 74), Buffer.from(trusted)]), pub.subarray(10, 42))) fail("commentaire de confiance altéré");
  if (!trusted.includes(`version:${version}`)) fail(`commentaire de confiance sans version:${version} : ${trusted}`);
  console.log(`OK : ${exe} (${data.length} octets) signé par la clé ${pub.subarray(2, 10).toString("hex")} — ${trusted.replace(/\t/g, ", ")}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
