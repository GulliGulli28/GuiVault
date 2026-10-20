/** L'import KeePass contre de **vraies** bases, écrites par KeePass 2.61
 * lui-même (`fixtures/kdbx/make.ps1`, KeePassLib) : KDBX 4 en Argon2d,
 * KDBX 4 en Argon2id + ChaCha20, KDBX 3.1 en AES-KDF avec fichier clé. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { importFile, NeedsKeePassKey } from "./importers";
import type { ImportResult } from "./importers";
import type { Login, Note } from "./types";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/kdbx/${name}`, import.meta.url)));
const PASSWORD = "guivault-kdbx-test";
const keyFile = fixture("keepass.keyx");

function login(r: ImportResult, name: string): { login: Login; folderPath: string[]; files?: { name: string; data: Uint8Array }[] } {
  const it = r.items.find((i) => i.payload.kind === "login" && i.payload.login.name === name);
  if (!it || it.payload.kind !== "login") throw new Error(`pas d'identifiant « ${name} »`);
  return { login: it.payload.login, folderPath: it.folderPath, files: it.files };
}

/** Ce que les trois bases contiennent, quel que soit leur chiffrement. */
function expectContent(r: ImportResult) {
  expect(r.items.map((i) => (i.payload.kind === "login" ? i.payload.login.name : i.payload.kind === "note" ? i.payload.note.name : "?")).sort()).toEqual(["Banque", "GitHub", "Serveur", "Wi-Fi maison"]);

  const gh = login(r, "GitHub");
  expect(gh.folderPath).toEqual(["Internet"]);
  expect(gh.login).toMatchObject({ username: "alice", password: "gh-pass-2", uris: [{ uri: "https://github.com/login", match: null }], notes: "notes github", totp: "JBSWY3DPEHPK3PXP", tags: ["dev", "perso"] });
  expect(gh.login.passwordHistory.map((h) => h.password)).toEqual(["gh-pass-1"]);
  expect(gh.login.fields).toEqual(expect.arrayContaining([{ name: "PIN", value: "4321", type: "hidden" }, { name: "Remarque", value: "visible", type: "text" }]));
  // Les champs TOTP de KeePass ne deviennent pas des champs personnalisés.
  expect(gh.login.fields?.some((f) => f.name.startsWith("TimeOtp"))).toBe(false);
  expect(gh.login.autoType).toEqual({ sequence: "{USERNAME}{TAB}{PASSWORD}{TAB}{TOTP}{ENTER}", windows: [{ title: "*GitHub*Firefox*", sequence: "{PASSWORD}{ENTER}" }] });
  expect(gh.files?.map((f) => [f.name, new TextDecoder().decode(f.data)])).toEqual([["cle.txt", "contenu de la pièce jointe"]]);

  const bank = login(r, "Banque");
  expect(bank.folderPath).toEqual(["Internet", "Banques"]);
  expect(bank.login.autoType).toEqual({ enabled: false });
  expect(bank.login.fields).toEqual([{ name: "Expiration (KeePass)", value: "2030-01-01", type: "text" }]);

  // KeePassXC : le TOTP dans un champ « otp » (URI).
  expect(login(r, "Serveur").login.totp).toBe("otpauth://totp/Serveur?secret=GEZDGNBVGY3TQOJQ&period=30&digits=6");

  // Sans utilisateur, mot de passe ni adresse : une note.
  const wifi = r.items.find((i) => i.payload.kind === "note");
  expect((wifi?.payload as { note: Note }).note).toMatchObject({ name: "Wi-Fi maison", content: "SSID : maison\nClé : xyz" });

  // La corbeille de la base n'est pas importée, et on le dit.
  expect(r.items.some((i) => i.payload.kind === "login" && i.payload.login.name === "Supprimé")).toBe(false);
  expect(r.warnings).toContain("1 entrée(s) de la corbeille KeePass non importée(s).");
}

describe("import KeePass (KDBX)", () => {
  it("KDBX 4, Argon2d : tout ce que la base contient", async () => {
    const r = await importFile(fixture("keepass-argon2d.kdbx"), PASSWORD);
    expect(r.format).toBe("KeePass (KDBX 4.0)");
    expectContent(r);
  }, 60_000);

  it("KDBX 4, Argon2id et ChaCha20", async () => {
    const r = await importFile(fixture("keepass-argon2id-chacha20.kdbx"), PASSWORD);
    expectContent(r);
  }, 60_000);

  it("KDBX 3.1, AES-KDF, avec fichier clé", async () => {
    const r = await importFile(fixture("keepass-kdbx31-aeskdf-keyfile.kdbx"), PASSWORD, keyFile);
    expect(r.format).toBe("KeePass (KDBX 3.1)");
    expectContent(r);
  }, 60_000);

  it("demande le mot de passe, refuse un mauvais, et dit quand il manque le fichier clé", async () => {
    await expect(importFile(fixture("keepass-argon2d.kdbx"))).rejects.toBeInstanceOf(NeedsKeePassKey);
    await expect(importFile(fixture("keepass-argon2d.kdbx"), "pas le bon")).rejects.toThrowError("Mot de passe maître incorrect — ou cette base demande aussi un fichier clé.");
    await expect(importFile(fixture("keepass-kdbx31-aeskdf-keyfile.kdbx"), PASSWORD)).rejects.toThrowError(/fichier clé/);
    await expect(importFile(fixture("keepass-kdbx31-aeskdf-keyfile.kdbx"), "pas le bon", keyFile)).rejects.toThrowError("Mot de passe maître ou fichier clé incorrect.");
  }, 60_000);

  it("un fichier texte passe toujours par les autres formats", async () => {
    const csv = new TextEncoder().encode("name,url,username,password\nSite,https://a.example,u,p\n");
    const r = await importFile(csv);
    expect(r.items).toHaveLength(1);
  });
});
