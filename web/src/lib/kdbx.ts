/** Import d'une base KeePass (KDBX 3.1 et 4 : KeePass 2, KeePassXC,
 * KeeWeb…), déchiffrée ici avec son mot de passe maître et, s'il y en a un,
 * son fichier clé — rien n'en part en clair. Le format est lu par `kdbxweb`
 * (KeeWeb) ; Argon2 est celui de `@noble/hashes`, comme pour nos comptes.
 *
 * Ce qui est repris, entrée par entrée : titre, utilisateur, mot de passe,
 * adresse, notes, étiquettes ; les champs personnalisés (protégés → masqués) ;
 * le TOTP (KeePass 2.47+ `TimeOtp-*`, KeePassXC `otp`, ancien KeePassXC
 * `TOTP Seed`/`TOTP Settings`) ; l'historique des mots de passe ; la saisie
 * automatique (séquence, fenêtres associées, désactivée) ; la date
 * d'expiration (en champ, GuiVault n'en a pas pour un identifiant) ; les
 * pièces jointes ; l'arborescence des groupes. Une entrée sans utilisateur,
 * mot de passe ni adresse, mais avec des notes, devient une note. La
 * corbeille de la base n'est pas importée. Chargé à la demande
 * (`importers.ts`) : `kdbxweb` n'alourdit pas le reste de l'interface. */
import * as kdbxweb from "kdbxweb";
import { argon2dAsync, argon2idAsync } from "@noble/hashes/argon2.js";
import { base32Encode } from "./totp";
import { emptyLogin, emptyNote, PASSWORD_HISTORY_MAX } from "./items";
import type { ImportedFile, ImportedItem, ImportResult } from "./bitwarden";
import type { AutoType, CustomField, Login, PasswordHistoryEntry } from "./types";

/** Au-delà, un fichier qui demande ça veut figer l'application : KeePass et
 * KeePassXC restent bien en dessous (64 Mio à 1 Gio). */
const MAX_ARGON2_KIB = 2 * 1024 * 1024;

kdbxweb.CryptoEngine.setArgon2Impl(async (password, salt, memory, iterations, length, parallelism, type, version) => {
  if (memory > MAX_ARGON2_KIB) throw new KdbxImportError(`Base KeePass : dérivation de ${Math.round(memory / 1024)} Mio demandée, refusée (2 Gio au plus).`);
  const opts = { t: iterations, m: memory, p: parallelism, dkLen: length, version };
  const fn = type === kdbxweb.CryptoEngine.Argon2TypeArgon2id ? argon2idAsync : argon2dAsync;
  const out = await fn(new Uint8Array(password), new Uint8Array(salt), opts);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
});

export class KdbxImportError extends Error {}

/** Les deux premiers mots de tout fichier KDBX. */
export function isKdbx(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && bytes[0] === 0x03 && bytes[1] === 0xd9 && bytes[2] === 0xa2 && bytes[3] === 0x9a && bytes[4] === 0x67 && bytes[5] === 0xfb && bytes[6] === 0x4b && bytes[7] === 0xb5;
}

/** Les champs que KeePass connaît : tout le reste est un champ personnalisé. */
const STANDARD = new Set(["Title", "UserName", "Password", "URL", "Notes"]);
/** Les champs TOTP des différents clients : repris en `totp`, pas en champs. */
const TOTP_FIELDS = new Set(["otp", "TOTP Seed", "TOTP Settings", "TimeOtp-Secret", "TimeOtp-Secret-Hex", "TimeOtp-Secret-Base32", "TimeOtp-Secret-Base64", "TimeOtp-Length", "TimeOtp-Period", "TimeOtp-Algorithm"]);

function text(v: kdbxweb.KdbxEntryField | undefined): string {
  if (v === undefined) return "";
  return typeof v === "string" ? v : v.getText();
}

function hexBytes(s: string): Uint8Array | null {
  const h = s.replace(/\s+/g, "");
  if (!/^([0-9a-f]{2})+$/i.test(h)) return null;
  return Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
}

/** Le TOTP d'une entrée, quel que soit le client qui l'a écrit : une URI
 * `otpauth://`, ou le secret base32 nu quand tout est par défaut. */
export function totpOf(fields: Map<string, kdbxweb.KdbxEntryField>, label: string): string | null {
  const get = (k: string) => text(fields.get(k)).trim();
  const otp = get("otp");
  if (otp) return otp;
  let secret = get("TimeOtp-Secret-Base32").replace(/\s+/g, "").toUpperCase();
  if (!secret && get("TimeOtp-Secret-Hex")) {
    const b = hexBytes(get("TimeOtp-Secret-Hex"));
    if (b) secret = base32Encode(b);
  }
  if (!secret && get("TimeOtp-Secret-Base64")) {
    try {
      secret = base32Encode(Uint8Array.from(atob(get("TimeOtp-Secret-Base64")), (ch) => ch.charCodeAt(0)));
    } catch {
      // secret illisible : pas de TOTP
    }
  }
  if (!secret && get("TimeOtp-Secret")) secret = base32Encode(new TextEncoder().encode(get("TimeOtp-Secret")));
  let digits = get("TimeOtp-Length");
  let period = get("TimeOtp-Period");
  const algorithm = get("TimeOtp-Algorithm").replace(/^HMAC-/i, "").toUpperCase();
  // Ancien KeePassXC : « TOTP Seed » et « TOTP Settings » = « période;chiffres ».
  if (!secret && get("TOTP Seed")) {
    secret = get("TOTP Seed").replace(/\s+/g, "").toUpperCase();
    const [p, d] = get("TOTP Settings").split(";");
    period ||= p ?? "";
    digits ||= /^\d+$/.test(d ?? "") ? d : "";
  }
  if (!secret) return null;
  const params: string[] = [];
  if (period && period !== "30") params.push(`period=${encodeURIComponent(period)}`);
  if (digits && digits !== "6") params.push(`digits=${encodeURIComponent(digits)}`);
  if (algorithm && algorithm !== "SHA1") params.push(`algorithm=${encodeURIComponent(algorithm)}`);
  if (!params.length) return secret;
  return `otpauth://totp/${encodeURIComponent(label || "KeePass")}?secret=${secret}&${params.join("&")}`;
}

function bytesOf(b: kdbxweb.KdbxBinary | kdbxweb.KdbxBinaryWithHash): Uint8Array {
  const v = "hash" in b && "value" in b ? b.value : b;
  return v instanceof kdbxweb.ProtectedValue ? v.getBinary() : new Uint8Array(v as ArrayBuffer);
}

function iso(d: Date | undefined): string {
  return (d ?? new Date()).toISOString();
}

/** Les mots de passe des versions précédentes, du plus récent au plus
 * ancien, sans doublon ni le mot de passe courant. */
function passwordHistory(entry: kdbxweb.KdbxEntry, current: string): PasswordHistoryEntry[] {
  const out: PasswordHistoryEntry[] = [];
  const seen = new Set([current]);
  const versions = [...entry.history].sort((a, b) => (b.times.lastModTime?.getTime() ?? 0) - (a.times.lastModTime?.getTime() ?? 0));
  for (const v of versions) {
    const pw = text(v.fields.get("Password"));
    if (!pw || seen.has(pw)) continue;
    seen.add(pw);
    out.push({ password: pw, changedAt: iso(v.times.lastModTime) });
    if (out.length >= PASSWORD_HISTORY_MAX) break;
  }
  return out;
}

function autoTypeOf(entry: kdbxweb.KdbxEntry): AutoType | undefined {
  const at: AutoType = {};
  if (entry.autoType.enabled === false) at.enabled = false;
  if (entry.autoType.defaultSequence?.trim()) at.sequence = entry.autoType.defaultSequence.trim();
  const windows = entry.autoType.items.filter((i) => i.window?.trim()).map((i) => (i.keystrokeSequence?.trim() ? { title: i.window.trim(), sequence: i.keystrokeSequence.trim() } : { title: i.window.trim() }));
  if (windows.length) at.windows = windows;
  return Object.keys(at).length ? at : undefined;
}

function convertEntry(entry: kdbxweb.KdbxEntry, warnings: string[]): { payload: ImportedItem["payload"]; files: ImportedFile[] } {
  const f = entry.fields;
  const name = text(f.get("Title")).trim() || "(sans titre)";
  const username = text(f.get("UserName"));
  const password = text(f.get("Password"));
  const url = text(f.get("URL")).trim();
  const notes = text(f.get("Notes"));
  const fields: CustomField[] = [];
  for (const [key, value] of f) {
    if (STANDARD.has(key) || TOTP_FIELDS.has(key)) continue;
    fields.push({ name: key, value: text(value), type: value instanceof kdbxweb.ProtectedValue ? "hidden" : "text" });
  }
  if (entry.times.expires && entry.times.expiryTime) fields.push({ name: "Expiration (KeePass)", value: entry.times.expiryTime.toISOString().slice(0, 10), type: "text" });
  if ([username, password, url, notes, ...fields.map((x) => x.value)].some((v) => v.includes("{REF:"))) {
    warnings.push(`« ${name} » contient une référence KeePass ({REF:…}) : importée telle quelle, elle ne sera pas résolue.`);
  }
  const files: ImportedFile[] = [];
  for (const [fileName, bin] of entry.binaries) files.push({ name: fileName, data: bytesOf(bin) });
  const tags = entry.tags.map((t) => t.trim()).filter(Boolean);
  const totp = totpOf(f, name);

  if (!username && !password && !url && !totp && notes.trim()) {
    const note = { ...emptyNote(), name, content: notes, tags };
    if (fields.length) note.fields = fields;
    return { payload: { kind: "note", note }, files };
  }
  const login: Login = {
    ...emptyLogin(),
    name,
    username,
    password,
    uris: url ? [{ uri: url, match: null }] : [],
    totp,
    tags,
    passwordHistory: passwordHistory(entry, password),
  };
  if (notes) login.notes = notes;
  if (fields.length) login.fields = fields;
  const autoType = autoTypeOf(entry);
  if (autoType) login.autoType = autoType;
  return { payload: { kind: "login", login }, files };
}

/** Déchiffre et convertit une base KeePass. `keyFile` : le contenu du fichier
 * clé, s'il y en a un. Erreurs : `KdbxImportError`, avec un message à
 * montrer tel quel. */
export async function importKdbx(bytes: Uint8Array, password: string, keyFile?: Uint8Array): Promise<ImportResult> {
  let db: kdbxweb.Kdbx;
  try {
    const credentials = new kdbxweb.KdbxCredentials(kdbxweb.ProtectedValue.fromString(password), keyFile ?? null);
    db = await kdbxweb.Kdbx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, credentials);
  } catch (e) {
    if (e instanceof KdbxImportError) throw e;
    const code = e instanceof kdbxweb.KdbxError ? e.code : "";
    if (code === kdbxweb.Consts.ErrorCodes.InvalidKey) throw new KdbxImportError(keyFile ? "Mot de passe maître ou fichier clé incorrect." : "Mot de passe maître incorrect — ou cette base demande aussi un fichier clé.");
    if (code === kdbxweb.Consts.ErrorCodes.InvalidVersion || code === kdbxweb.Consts.ErrorCodes.Unsupported) throw new KdbxImportError(`Base KeePass d'un format non pris en charge (${e instanceof Error ? e.message : code}).`);
    throw new KdbxImportError(`Base KeePass illisible : ${e instanceof Error ? e.message : String(e)}`);
  }
  const warnings: string[] = [];
  const items: ImportedItem[] = [];
  const recycleBin = db.meta.recycleBinEnabled ? db.meta.recycleBinUuid : undefined;
  let skipped = 0;
  const walk = (group: kdbxweb.KdbxGroup, path: string[]) => {
    for (const entry of group.entries) {
      const { payload, files } = convertEntry(entry, warnings);
      items.push(files.length ? { payload, folderPath: path, files } : { payload, folderPath: path });
    }
    for (const g of group.groups) {
      if (recycleBin && g.uuid.equals(recycleBin)) {
        skipped += countEntries(g);
        continue;
      }
      walk(g, [...path, g.name?.trim() || "(sans nom)"]);
    }
  };
  // Le groupe racine porte le nom de la base : ses dossiers vont dessous.
  walk(db.getDefaultGroup(), []);
  if (skipped) warnings.push(`${skipped} entrée(s) de la corbeille KeePass non importée(s).`);
  return { format: `KeePass (KDBX ${db.header.versionMajor}.${db.header.versionMinor})`, items, warnings };
}

function countEntries(g: kdbxweb.KdbxGroup): number {
  return g.entries.length + g.groups.reduce((n, x) => n + countEntries(x), 0);
}
