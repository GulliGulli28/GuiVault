/** Le format d'export de Bitwarden : lecture du JSON (en clair ou protégé
 * par mot de passe) et du CSV, écriture du CSV. Les types sont ceux de
 * l'export « unencrypted » de Bitwarden ; on ne lit que ce qu'on sait
 * ranger, le reste finit dans les notes plutôt que d'être perdu. */
import { argon2idAsync } from "@noble/hashes/argon2.js";
import { expand } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { fromBase64, uuid, utf8 } from "./bytes";
import type { Card, CustomField, Identity, Login, Note, Passkey, Payload, UriMatch } from "./types";

// ─── Types de l'export Bitwarden ────────────────────────────────────────────

interface BwField {
  name: string | null;
  value: string | null;
  type: number;
}

interface BwFido2 {
  credentialId: string;
  keyType: string;
  keyAlgorithm: string;
  keyCurve: string;
  keyValue: string;
  rpId: string;
  rpName?: string | null;
  userHandle: string;
  userName?: string | null;
  userDisplayName?: string | null;
  counter: string | number;
  discoverable: string | boolean;
  creationDate: string;
}

interface BwItem {
  id?: string;
  folderId?: string | null;
  type: number;
  name: string | null;
  notes?: string | null;
  favorite?: boolean;
  fields?: BwField[] | null;
  login?: { uris?: { uri: string | null; match?: number | null }[] | null; username?: string | null; password?: string | null; totp?: string | null; fido2Credentials?: BwFido2[] | null } | null;
  card?: Partial<Record<"cardholderName" | "brand" | "number" | "expMonth" | "expYear" | "code", string | null>> | null;
  identity?: Partial<Record<string, string | null>> | null;
  passwordHistory?: { lastUsedDate: string; password: string }[] | null;
}

interface BwExport {
  encrypted?: boolean;
  passwordProtected?: boolean;
  folders?: { id: string; name: string }[];
  items?: BwItem[];
  // Export protégé par mot de passe.
  salt?: string;
  kdfType?: number;
  kdfIterations?: number;
  kdfMemory?: number | null;
  kdfParallelism?: number | null;
  encKeyValidation_DO_NOT_EDIT?: string;
  data?: string;
}

/** Ce qu'un import produit : des secrets et des chemins de dossiers
 * (« Travail/Banque »), à résoudre contre les dossiers du vault cible. */
export interface ImportedItem {
  payload: Payload;
  folderPath: string[];
}

export interface ImportResult {
  format: string;
  items: ImportedItem[];
  warnings: string[];
}

export class NeedsPassword extends Error {
  constructor() {
    super("Cet export est protégé par un mot de passe.");
  }
}

const MATCHES: (UriMatch | null)[] = ["domain", "host", "startsWith", "exact", "regex", "never"];
const FIELD_TYPES: CustomField["type"][] = ["text", "hidden", "boolean"];

function s(v: string | null | undefined): string {
  return v ?? "";
}

export function folderPathOf(name: string | null | undefined): string[] {
  return s(name).split(/[/\\]/).map((p) => p.trim()).filter(Boolean).filter((p, i) => !(i === 0 && p.toLowerCase() === "root"));
}

function convertFields(fields: BwField[] | null | undefined, warnings: string[], name: string): CustomField[] | undefined {
  if (!fields || fields.length === 0) return undefined;
  const out: CustomField[] = [];
  for (const f of fields) {
    if (f.type === 3) {
      warnings.push(`${name} : champ lié « ${s(f.name)} » ignoré (pas d'équivalent).`);
      continue;
    }
    out.push({ name: s(f.name), value: s(f.value), type: FIELD_TYPES[f.type] ?? "text" });
  }
  return out.length ? out : undefined;
}

function convertPasskey(c: BwFido2): Passkey {
  return {
    credentialId: c.credentialId,
    keyType: c.keyType,
    keyAlgorithm: c.keyAlgorithm,
    keyCurve: c.keyCurve,
    keyValue: c.keyValue,
    rpId: c.rpId,
    rpName: c.rpName ?? null,
    userHandle: c.userHandle,
    userName: c.userName ?? null,
    userDisplayName: c.userDisplayName ?? null,
    counter: Number(c.counter) || 0,
    discoverable: c.discoverable === true || c.discoverable === "true",
    createdAt: c.creationDate,
  };
}

function convertItem(it: BwItem, warnings: string[]): Payload | null {
  const name = s(it.name) || "(sans nom)";
  const base = { id: uuid(), name, groupId: null, tags: [] as string[], favorite: it.favorite || undefined, notes: s(it.notes) || undefined, fields: convertFields(it.fields, warnings, name) };
  switch (it.type) {
    case 1: {
      const l = it.login ?? {};
      const login: Login = {
        ...base,
        username: s(l.username),
        password: s(l.password),
        uris: (l.uris ?? []).filter((u) => u.uri).map((u) => ({ uri: s(u.uri), match: u.match == null ? null : MATCHES[u.match] ?? null })),
        totp: s(l.totp) || null,
        passkeys: (l.fido2Credentials ?? []).map(convertPasskey),
        passwordHistory: (it.passwordHistory ?? []).map((h) => ({ password: h.password, changedAt: h.lastUsedDate })),
      };
      return { kind: "login", login };
    }
    case 2: {
      const note: Note = { ...base, notes: undefined, content: s(it.notes) };
      return { kind: "note", note };
    }
    case 3: {
      const c = it.card ?? {};
      const card: Card = { ...base, cardholderName: s(c.cardholderName), brand: s(c.brand), number: s(c.number), expMonth: s(c.expMonth), expYear: s(c.expYear), code: s(c.code) };
      return { kind: "card", card };
    }
    case 4: {
      const i = it.identity ?? {};
      const identity: Identity = {
        ...base,
        title: s(i.title), firstName: s(i.firstName), middleName: s(i.middleName), lastName: s(i.lastName), username: s(i.username), company: s(i.company),
        ssn: s(i.ssn), passportNumber: s(i.passportNumber), licenseNumber: s(i.licenseNumber), email: s(i.email), phone: s(i.phone),
        address1: s(i.address1), address2: s(i.address2), address3: s(i.address3), city: s(i.city), state: s(i.state), postalCode: s(i.postalCode), country: s(i.country),
      };
      return { kind: "identity", identity };
    }
    default:
      warnings.push(`${name} : type Bitwarden ${it.type} inconnu, ignoré.`);
      return null;
  }
}

export function isBitwardenJson(v: unknown): v is BwExport {
  return typeof v === "object" && v !== null && ("items" in v || "encrypted" in v) && !("format" in v);
}

export async function importBitwardenJson(doc: BwExport, password?: string): Promise<ImportResult> {
  if (doc.encrypted) {
    if (!doc.passwordProtected || !doc.data || !doc.salt) {
      throw new Error("Cet export Bitwarden est chiffré avec la clé du compte, pas un mot de passe : ré-exportez-le en clair ou protégé par mot de passe.");
    }
    if (!password) throw new NeedsPassword();
    const plain = await decryptPasswordProtected(doc, password);
    return importBitwardenJson(JSON.parse(plain) as BwExport);
  }
  const warnings: string[] = [];
  const folders = new Map((doc.folders ?? []).map((f) => [f.id, folderPathOf(f.name)]));
  const items: ImportedItem[] = [];
  for (const it of doc.items ?? []) {
    const payload = convertItem(it, warnings);
    if (payload) items.push({ payload, folderPath: (it.folderId && folders.get(it.folderId)) || [] });
  }
  return { format: "Bitwarden (JSON)", items, warnings };
}

// ─── Export protégé par mot de passe ────────────────────────────────────────
//
// `EncString` de type 2 : `2.<iv>|<chiffré>|<mac>` en base64, AES-256-CBC et
// HMAC-SHA256 sur iv‖chiffré. La clé vient du mot de passe (PBKDF2-SHA256 ou
// Argon2id, sel = la chaîne `salt` telle quelle, en UTF-8 — hachée en
// SHA-256 pour Argon2), étirée en deux clés par HKDF-expand (« enc », « mac »).

async function decryptPasswordProtected(doc: BwExport, password: string): Promise<string> {
  const salt = utf8.encode(doc.salt ?? "");
  let key: Uint8Array;
  if (doc.kdfType === 1) {
    key = await argon2idAsync(utf8.encode(password), sha256(salt), { t: doc.kdfIterations ?? 3, m: (doc.kdfMemory ?? 64) * 1024, p: doc.kdfParallelism ?? 4, dkLen: 32 });
  } else {
    const base = await crypto.subtle.importKey("raw", utf8.encode(password) as BufferSource, "PBKDF2", false, ["deriveBits"]);
    key = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: doc.kdfIterations ?? 600_000 }, base, 256));
  }
  const encKey = expand(sha256, key, utf8.encode("enc"), 32);
  const macKey = expand(sha256, key, utf8.encode("mac"), 32);
  try {
    await decryptEncString(doc.encKeyValidation_DO_NOT_EDIT ?? "", encKey, macKey);
  } catch {
    throw new Error("Mot de passe de l'export incorrect.");
  }
  return decryptEncString(doc.data ?? "", encKey, macKey);
}

async function decryptEncString(enc: string, encKey: Uint8Array, macKey: Uint8Array): Promise<string> {
  const m = /^2\.([^|]+)\|([^|]+)\|([^|]+)$/.exec(enc);
  if (!m) throw new Error("EncString illisible");
  const iv = fromBase64(m[1]);
  const ct = fromBase64(m[2]);
  const mac = fromBase64(m[3]);
  const hk = await crypto.subtle.importKey("raw", macKey as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const data = new Uint8Array(iv.length + ct.length);
  data.set(iv);
  data.set(ct, iv.length);
  if (!(await crypto.subtle.verify("HMAC", hk, mac as BufferSource, data as BufferSource))) throw new Error("MAC invalide");
  const ak = await crypto.subtle.importKey("raw", encKey as BufferSource, "AES-CBC", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-CBC", iv: iv as BufferSource }, ak, ct as BufferSource);
  return utf8.decode(new Uint8Array(plain));
}

// ─── CSV ────────────────────────────────────────────────────────────────────

export const BITWARDEN_CSV_HEADER = ["folder", "favorite", "type", "name", "notes", "fields", "reprompt", "login_uri", "login_username", "login_password", "login_totp"];

/** Les lignes CSV Bitwarden d'une liste de secrets — identifiants et notes
 * seulement, le format n'a pas de colonnes pour le reste. */
export function toBitwardenCsvRows(items: { payload: Payload; folderPath: string[] }[]): { rows: (string | number)[][]; skipped: number } {
  const rows: (string | number)[][] = [];
  let skipped = 0;
  for (const { payload: p, folderPath } of items) {
    const folder = folderPath.join("/");
    if (p.kind === "login") {
      const l = p.login;
      rows.push([folder, l.favorite ? 1 : 0, "login", l.name, l.notes ?? "", fieldsToCsv(l.fields), 0, l.uris.map((u) => u.uri).join(","), l.username, l.password, l.totp ?? ""]);
    } else if (p.kind === "note") {
      const n = p.note;
      rows.push([folder, n.favorite ? 1 : 0, "note", n.name, n.content, fieldsToCsv(n.fields), 0, "", "", "", ""]);
    } else {
      skipped++;
    }
  }
  return { rows, skipped };
}

function fieldsToCsv(fields: CustomField[] | undefined): string {
  return (fields ?? []).map((f) => `${f.name}: ${f.value}`).join("\n");
}
