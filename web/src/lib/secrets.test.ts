/** Générateur, TOTP, CSV, import/export — et les fixtures pour le crate
 * Rust `guivault-items` (`GUIVAULT_WRITE_VECTORS=1`), même mécanique que
 * `crypto.test.ts`. */
import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { toBase64, utf8 } from "./bytes";
import { parseCsv, toCsv } from "./csv";
import { exportCsv, exportEncrypted, exportJson } from "./exporters";
import { estimateStrength, generatePassphrase, generatePassword, randomInt } from "./generator";
import { importFile, NeedsPassword, resolveFolders } from "./importers";
import { emptyCard, emptyIdentity, emptyLogin, emptyNote } from "./items";
import { base32Decode, base32Encode, parseTotp, totpCode } from "./totp";
import type { Payload } from "./types";
import { EFF_LARGE_WORDLIST } from "./wordlist";

describe("générateur", () => {
  it("respecte longueur et classes", () => {
    for (let i = 0; i < 50; i++) {
      const p = generatePassword({ length: 16, lowercase: true, uppercase: true, digits: true, symbols: true, avoidAmbiguous: true, minDigits: 3, minSymbols: 2 });
      expect(p).toHaveLength(16);
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/[A-Z]/);
      expect((p.match(/\d/g) ?? []).length).toBeGreaterThanOrEqual(3);
      expect((p.match(/[^A-Za-z0-9]/g) ?? []).length).toBeGreaterThanOrEqual(2);
      expect(p).not.toMatch(/[l1IO0]/);
    }
    expect(generatePassword({ length: 12, lowercase: false, uppercase: false, digits: true, symbols: false, avoidAmbiguous: false, minDigits: 0, minSymbols: 0 })).toMatch(/^\d{12}$/);
  });

  it("fait des phrases avec la liste EFF", () => {
    expect(EFF_LARGE_WORDLIST).toHaveLength(7776);
    const p = generatePassphrase({ words: 5, separator: "-", capitalize: true, includeNumber: true });
    const parts = p.split("-");
    expect(parts).toHaveLength(5);
    expect(parts.every((w) => /^[A-Z][a-z]+\d?$/.test(w))).toBe(true);
    expect(parts.some((w) => /\d$/.test(w))).toBe(true);
  });

  it("randomInt reste dans la borne", () => {
    for (let i = 0; i < 1000; i++) expect(randomInt(7)).toBeLessThan(7);
  });

  it("classe la robustesse dans le bon ordre", () => {
    expect(estimateStrength("").score).toBe(0);
    expect(estimateStrength("aaaaaaaa").score).toBe(0);
    expect(estimateStrength("password2020").score).toBeLessThanOrEqual(1);
    expect(estimateStrength("correct-horse-battery-staple").score).toBeGreaterThanOrEqual(2);
    expect(estimateStrength("Xk9#mQ2$vL8@pR4!wN7&").score).toBe(4);
  });
});

describe("TOTP", () => {
  it("base32 aller-retour", () => {
    const b = utf8.encode("12345678901234567890");
    expect(base32Encode(b)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(utf8.decode(base32Decode("gezd gnbv gy3t qojq gezd gnbv gy3t qojq"))).toBe("12345678901234567890");
  });

  it("vecteurs RFC 6238 (SHA-1, 8 chiffres)", async () => {
    const p = parseTotp("otpauth://totp/ACME:alice@example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=ACME&digits=8");
    expect(p?.issuer).toBe("ACME");
    expect(p?.label).toBe("alice@example.com");
    expect(await totpCode(p!, 59_000)).toBe("94287082");
    expect(await totpCode(p!, 1_111_111_109_000)).toBe("07081804");
    expect(await totpCode(p!, 20_000_000_000_000)).toBe("65353130");
  });

  it("accepte un secret nu et rejette le reste", async () => {
    const p = parseTotp("GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ");
    expect(p?.digits).toBe(6);
    expect(await totpCode(p!, 59_000)).toBe("287082");
    expect(parseTotp("otpauth://hotp/x?secret=GEZD")).toBeNull();
    expect(parseTotp("!!!")).toBeNull();
  });
});

describe("CSV", () => {
  it("lit guillemets, virgules et retours à la ligne", () => {
    const rows = parseCsv('a,b,c\r\n"x, y","li\nne","dit ""bonjour"""\n,,\n');
    expect(rows).toEqual([["a", "b", "c"], ["x, y", "li\nne", 'dit "bonjour"'], ["", "", ""]]);
    expect(parseCsv(toCsv(["h"], [["a,b"], ['q"q']]))).toEqual([["h"], ["a,b"], ['q"q']]);
  });
});

const BITWARDEN = {
  encrypted: false,
  folders: [{ id: "f1", name: "Travail" }, { id: "f2", name: "Travail/Banque" }],
  items: [
    { id: "i1", folderId: "f2", type: 1, name: "Banque", notes: "note", favorite: true, fields: [{ name: "PIN", value: "1234", type: 1 }, { name: "lié", value: null, type: 3 }],
      login: { uris: [{ match: 0, uri: "https://banque.example" }], username: "alice", password: "pw", totp: "JBSWY3DPEHPK3PXP", fido2Credentials: [{ credentialId: "c1", keyType: "public-key", keyAlgorithm: "ECDSA", keyCurve: "P-256", keyValue: "k", rpId: "banque.example", userHandle: "u", userName: "alice", counter: "3", discoverable: "true", creationDate: "2026-01-01T00:00:00Z" }] },
      passwordHistory: [{ lastUsedDate: "2025-12-01T00:00:00Z", password: "old" }] },
    { id: "i2", folderId: null, type: 2, name: "Codes", notes: "secours", secureNote: { type: 0 } },
    { id: "i3", folderId: "f1", type: 3, name: "CB", card: { cardholderName: "A", brand: "Visa", number: "4111111111111111", expMonth: "12", expYear: "2030", code: "123" } },
    { id: "i4", folderId: null, type: 4, name: "Moi", identity: { firstName: "Alice", lastName: "L", email: "a@b" } },
    { id: "i5", type: 9, name: "?" },
  ],
};

describe("import", () => {
  it("Bitwarden JSON : types, dossiers, passkeys, historique", async () => {
    const r = await importFile(JSON.stringify(BITWARDEN));
    expect(r.format).toBe("Bitwarden (JSON)");
    expect(r.items.map((i) => i.payload.kind)).toEqual(["login", "note", "card", "identity"]);
    expect(r.warnings).toHaveLength(2);
    const login = r.items[0];
    expect(login.folderPath).toEqual(["Travail", "Banque"]);
    if (login.payload.kind !== "login") throw new Error();
    expect(login.payload.login.uris[0]).toEqual({ uri: "https://banque.example", match: "domain" });
    expect(login.payload.login.passkeys[0]).toMatchObject({ counter: 3, discoverable: true, rpId: "banque.example" });
    expect(login.payload.login.passwordHistory[0]).toEqual({ password: "old", changedAt: "2025-12-01T00:00:00Z" });
    expect(login.payload.login.fields).toEqual([{ name: "PIN", value: "1234", type: "hidden" }]);
    expect(login.payload.login.favorite).toBe(true);
    const note = r.items[1].payload;
    expect(note.kind === "note" && note.note.content).toBe("secours");

    const { groups, payloads } = resolveFolders(r, [{ id: "g0", name: "travail", parentId: null }], null);
    expect(groups.map((g) => g.name)).toEqual(["Banque"]);
    expect(groups[0].parentId).toBe("g0");
    expect(payloads[0].kind === "login" && payloads[0].login.groupId).toBe(groups[0].id);
    expect(payloads[2].kind === "card" && payloads[2].card.groupId).toBe("g0");
  });

  it("CSV Chrome, LastPass, Bitwarden", async () => {
    const chrome = await importFile("name,url,username,password,note\nGitHub,https://github.com,alice,pw,hello\n");
    expect(chrome.format).toBe("Chrome (CSV)");
    expect(chrome.items[0].payload).toMatchObject({ kind: "login", login: { name: "GitHub", username: "alice", password: "pw", notes: "hello", uris: [{ uri: "https://github.com" }] } });

    const lastpass = await importFile("url,username,password,totp,extra,name,grouping,fav\nhttps://x.io,bob,pw,,,X,Perso\\Web,1\n");
    expect(lastpass.format).toBe("LastPass (CSV)");
    expect(lastpass.items[0].folderPath).toEqual(["Perso", "Web"]);
    expect(lastpass.items[0].payload.kind === "login" && lastpass.items[0].payload.login.favorite).toBe(true);

    const bw = await importFile("folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\nA,0,note,N,contenu,,0,,,,\n,1,login,L,,\"k: v\",0,https://l.io,u,p,SECRET\n");
    expect(bw.format).toBe("Bitwarden (CSV)");
    expect(bw.items[0].payload).toMatchObject({ kind: "note", note: { name: "N", content: "contenu" } });
    expect(bw.items[1].payload).toMatchObject({ kind: "login", login: { totp: "SECRET", fields: [{ name: "k", value: "v" }] } });

    await expect(importFile("foo,bar\n1,2\n")).rejects.toThrow(/Colonnes non reconnues/);
  });

  it("Bitwarden protégé par mot de passe (PBKDF2, EncString type 2)", async () => {
    // Fichier fabriqué ici selon le format de Bitwarden : prouve la chaîne
    // PBKDF2 → HKDF-expand → AES-CBC + HMAC, pas la compatibilité avec un
    // export réel — à vérifier avec un vrai fichier à l'occasion.
    const { expand } = await import("@noble/hashes/hkdf.js");
    const { sha256 } = await import("@noble/hashes/sha2.js");
    const salt = "c2FsdHNhbHRzYWx0c2FsdA==";
    const base = await crypto.subtle.importKey("raw", utf8.encode("secret") as BufferSource, "PBKDF2", false, ["deriveBits"]);
    const key = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: utf8.encode(salt) as BufferSource, iterations: 1000 }, base, 256));
    const enc = expand(sha256, key, utf8.encode("enc"), 32) as Uint8Array<ArrayBuffer>;
    const mac = expand(sha256, key, utf8.encode("mac"), 32) as Uint8Array<ArrayBuffer>;
    const encString = async (plain: string) => {
      const iv = crypto.getRandomValues(new Uint8Array(16));
      const ak = await crypto.subtle.importKey("raw", enc, "AES-CBC", false, ["encrypt"]);
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, ak, utf8.encode(plain) as BufferSource));
      const hk = await crypto.subtle.importKey("raw", mac, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const data = new Uint8Array([...iv, ...ct]);
      const m = new Uint8Array(await crypto.subtle.sign("HMAC", hk, data));
      return `2.${toBase64(iv)}|${toBase64(ct)}|${toBase64(m)}`;
    };
    const doc = { encrypted: true, passwordProtected: true, salt, kdfType: 0, kdfIterations: 1000, encKeyValidation_DO_NOT_EDIT: await encString("validation"), data: await encString(JSON.stringify(BITWARDEN)) };
    await expect(importFile(JSON.stringify(doc))).rejects.toThrow(NeedsPassword);
    await expect(importFile(JSON.stringify(doc), "wrong")).rejects.toThrow(/incorrect/);
    const r = await importFile(JSON.stringify(doc), "secret");
    expect(r.items).toHaveLength(4);
  });
});

function samples(): Payload[] {
  const login = { ...emptyLogin(), id: "11111111-1111-4111-8111-111111111111", name: "GitHub", username: "alice", password: "pw", uris: [{ uri: "https://github.com", match: null }], totp: "JBSWY3DPEHPK3PXP", favorite: true, notes: "n", fields: [{ name: "PIN", value: "1", type: "hidden" as const }, { name: "ok", value: "true", type: "boolean" as const }],
    passkeys: [{ credentialId: "c", keyType: "public-key", keyAlgorithm: "ECDSA", keyCurve: "P-256", keyValue: "k", rpId: "github.com", rpName: "GitHub", userHandle: "u", userName: "alice", userDisplayName: null, counter: 1, discoverable: true, createdAt: "2026-01-01T00:00:00Z" }],
    passwordHistory: [{ password: "old", changedAt: "2025-01-01T00:00:00Z" }] };
  const note = { ...emptyNote(), id: "22222222-2222-4222-8222-222222222222", name: "Codes", content: "a\nb", groupId: "gggggggg-gggg-4ggg-8ggg-gggggggggggg".replace(/g/g, "a") };
  const card = { ...emptyCard(), id: "33333333-3333-4333-8333-333333333333", name: "CB", cardholderName: "A", brand: "Visa", number: "4111111111111111", expMonth: "12", expYear: "2030", code: "123" };
  const identity = { ...emptyIdentity(), id: "44444444-4444-4444-8444-444444444444", name: "Moi", firstName: "Alice", lastName: "L", email: "a@b" };
  return [{ kind: "login", login }, { kind: "note", note }, { kind: "card", card }, { kind: "identity", identity }];
}

describe("export", () => {
  const vault = { id: "v", name: "Perso" };
  const group: Payload = { kind: "group", group: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Dossier", parentId: null } };

  it("JSON aller-retour, dossiers compris", async () => {
    const json = exportJson(vault, [group, ...samples()]);
    const r = await importFile(json);
    expect(r.format).toBe("GuiVault (JSON)");
    expect(r.items).toHaveLength(4);
    expect(r.items[1].folderPath).toEqual(["Dossier"]);
    expect(r.items[0].payload).toEqual(samples()[0]);
  });

  it("JSON chiffré : mot de passe requis, mauvais mot de passe refusé", async () => {
    const enc = await exportEncrypted(vault, samples(), "export-pw");
    expect(enc).not.toContain("alice");
    await expect(importFile(enc)).rejects.toThrow(NeedsPassword);
    await expect(importFile(enc, "nope")).rejects.toThrow(/incorrect/);
    const r = await importFile(enc, "export-pw");
    expect(r.items.map((i) => i.payload.kind)).toEqual(["login", "note", "card", "identity"]);
  }, 30_000);

  it("CSV Bitwarden : identifiants et notes, le reste compté", async () => {
    const { csv, skipped } = exportCsv([group, ...samples()]);
    expect(skipped).toBe(2);
    const r = await importFile(csv);
    expect(r.format).toBe("Bitwarden (CSV)");
    expect(r.items[0].payload).toMatchObject({ kind: "login", login: { name: "GitHub", username: "alice", totp: "JBSWY3DPEHPK3PXP" } });
    expect(r.items[1]).toMatchObject({ folderPath: ["Dossier"], payload: { kind: "note", note: { content: "a\nb" } } });
  });

  it("écrit les fixtures du crate guivault-items (GUIVAULT_WRITE_VECTORS)", () => {
    if (!process.env.GUIVAULT_WRITE_VECTORS) return;
    writeFileSync(new URL("../../../crates/guivault-items/tests/web-items.json", import.meta.url), JSON.stringify(samples(), null, 2) + "\n");
  });
});
