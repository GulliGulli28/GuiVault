/** Détection du format d'un fichier et conversion en secrets : export
 * GuiVault (en clair ou chiffré), Bitwarden (JSON, CSV), et les CSV de
 * Chrome, Firefox, LastPass, KeePassXC — ou n'importe quel CSV dont les
 * colonnes se reconnaissent (nom, url, utilisateur, mot de passe, notes). */
import { fromBase64, uuid, utf8 } from "./bytes";
import { parseCsv } from "./csv";
import * as c from "./crypto";
import { folderPathOf, importBitwardenJson, isBitwardenJson, NeedsPassword, type ImportResult, type ImportedItem } from "./bitwarden";
import { emptyLogin, emptyNote } from "./items";
import { withParent } from "./entities";
import type { Group, Payload } from "./types";

export { NeedsPassword };
export type { ImportResult, ImportedItem };

export const GUIVAULT_FORMAT = "guivault-export";
export const GUIVAULT_ENCRYPTED_FORMAT = "guivault-export-encrypted";

export interface GuiVaultExport {
  format: typeof GUIVAULT_FORMAT;
  version: 1;
  exportedAt: string;
  vault: { id: string; name: string };
  /** Les dossiers, pour reconstruire l'arborescence à l'import. */
  groups: Group[];
  items: Payload[];
}

export interface GuiVaultEncryptedExport {
  format: typeof GUIVAULT_ENCRYPTED_FORMAT;
  version: 1;
  kdf: c.KdfParams;
  kdf_salt: string;
  blob: string;
}

export async function importFile(text: string, password?: string): Promise<ImportResult> {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let doc: unknown;
    try {
      doc = JSON.parse(trimmed);
    } catch {
      throw new Error("Le fichier ressemble à du JSON mais ne se lit pas.");
    }
    return importJson(doc, password);
  }
  return importCsv(text);
}

async function importJson(doc: unknown, password?: string): Promise<ImportResult> {
  if (typeof doc !== "object" || doc === null) throw new Error("Format JSON inconnu.");
  const d = doc as Record<string, unknown>;
  if (d.format === GUIVAULT_ENCRYPTED_FORMAT) {
    if (!password) throw new NeedsPassword();
    const e = doc as GuiVaultEncryptedExport;
    const key = await c.deriveExportKey(password, fromBase64(e.kdf_salt), e.kdf);
    let plain: Uint8Array;
    try {
      plain = c.open(key, fromBase64(e.blob), c.AAD_EXPORT);
    } catch {
      throw new Error("Mot de passe de l'export incorrect.");
    } finally {
      key.fill(0);
    }
    return importJson(JSON.parse(utf8.decode(plain)));
  }
  if (d.format === GUIVAULT_FORMAT) return importGuiVault(doc as GuiVaultExport);
  if (isBitwardenJson(doc)) return importBitwardenJson(doc, password);
  throw new Error("Format JSON inconnu : attendu un export GuiVault ou Bitwarden.");
}

/** Un export GuiVault : les items reviennent tels quels (mêmes ids — un
 * ré-import dans le même vault écrase, dans un autre vault duplique), les
 * dossiers sont retrouvés par chemin. */
function importGuiVault(doc: GuiVaultExport): ImportResult {
  const groups = new Map((doc.groups ?? []).map((g) => [g.id, g]));
  const pathOf = (id: string | null | undefined): string[] => {
    const parts: string[] = [];
    const seen = new Set<string>();
    let cur = id ?? null;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const g = groups.get(cur);
      if (!g) break;
      parts.unshift(g.name);
      cur = g.parentId;
    }
    return parts;
  };
  const items: ImportedItem[] = [];
  for (const p of doc.items ?? []) {
    if (p.kind === "group") continue;
    const groupId = "host" in p ? p.host.groupId : "connection" in p ? p.connection.groupId : "login" in p ? p.login.groupId : "note" in p ? p.note.groupId : "card" in p ? p.card.groupId : "identity" in p ? p.identity.groupId : null;
    items.push({ payload: p, folderPath: pathOf(groupId) });
  }
  return { format: "GuiVault (JSON)", items, warnings: [] };
}

// ─── CSV ────────────────────────────────────────────────────────────────────

/** Les noms de colonnes reconnus, normalisés (minuscules, sans espaces). */
const COLUMNS: Record<string, string[]> = {
  name: ["name", "title", "nom", "titre", "account"],
  url: ["url", "uri", "login_uri", "website", "web site", "site", "hostname"],
  username: ["username", "user", "login_username", "login", "user name", "utilisateur", "email"],
  password: ["password", "login_password", "pass", "mot de passe", "mdp"],
  notes: ["notes", "note", "extra", "comment", "comments", "remarques"],
  totp: ["totp", "login_totp", "otp", "otpauth"],
  folder: ["folder", "grouping", "group", "dossier", "category", "path"],
  favorite: ["favorite", "fav", "favori"],
  type: ["type"],
  fields: ["fields"],
};

function normalize(h: string): string {
  return h.trim().toLowerCase().replace(/^\uFEFF/, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

function columnIndex(header: string[]): Record<string, number> {
  const idx: Record<string, number> = {};
  const norm = header.map(normalize);
  for (const [key, names] of Object.entries(COLUMNS)) {
    const i = norm.findIndex((h) => names.includes(h) || names.includes(h.replace(/ /g, "_")));
    if (i !== -1) idx[key] = i;
  }
  return idx;
}

function guessFormat(header: string[]): string {
  const h = header.map(normalize);
  if (h.includes("login uri") && h.includes("login username")) return "Bitwarden (CSV)";
  if (h.includes("grouping") && h.includes("extra")) return "LastPass (CSV)";
  if (h.includes("group") && h.includes("title") && h.includes("url")) return "KeePassXC (CSV)";
  if (h.includes("httprealm") || h.includes("formactionorigin")) return "Firefox (CSV)";
  if (h[0] === "name" && h.includes("url") && h.includes("username")) return "Chrome (CSV)";
  return "CSV";
}

export function importCsv(text: string): ImportResult {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error("CSV vide ou sans en-tête.");
  const header = rows[0];
  const col = columnIndex(header);
  if (col.password === undefined && col.url === undefined && col.name === undefined) {
    throw new Error(`Colonnes non reconnues : ${header.join(", ")}. Il faut au moins un nom, une URL ou un mot de passe.`);
  }
  const format = guessFormat(header);
  const warnings: string[] = [];
  const items: ImportedItem[] = [];
  const get = (row: string[], key: string) => (col[key] === undefined ? "" : (row[col[key]] ?? "").trim());
  for (const row of rows.slice(1)) {
    if (row.every((cell) => cell.trim() === "")) continue;
    const url = get(row, "url");
    const type = get(row, "type").toLowerCase();
    const folderPath = folderPathOf(get(row, "folder"));
    const favorite = ["1", "true", "yes", "oui"].includes(get(row, "favorite").toLowerCase()) || undefined;
    const notes = get(row, "notes");
    const name = get(row, "name") || (url ? hostOf(url) : "") || "(sans nom)";
    if (type === "note" || (format === "Bitwarden (CSV)" && type !== "login")) {
      const note = { ...emptyNote(), id: uuid(), name, favorite, content: notes };
      items.push({ payload: { kind: "note", note }, folderPath });
      continue;
    }
    const login = { ...emptyLogin(), id: uuid(), name, favorite, notes: notes || undefined, username: get(row, "username"), password: get(row, "password"), totp: get(row, "totp") || null };
    if (url) login.uris = url.split(/[,\n]/).map((u) => u.trim()).filter(Boolean).map((uri) => ({ uri, match: null }));
    const fields = get(row, "fields");
    if (fields) login.fields = fields.split("\n").map((line) => { const [n, ...v] = line.split(": "); return { name: n, value: v.join(": "), type: "text" as const }; });
    items.push({ payload: { kind: "login", login }, folderPath });
  }
  if (items.length === 0) warnings.push("Aucune ligne exploitable.");
  return { format, items, warnings };
}

function hostOf(url: string): string {
  try {
    return new URL(/^[a-z]+:/i.test(url) ? url : `https://${url}`).host;
  } catch {
    return url;
  }
}

// ─── Dossiers ───────────────────────────────────────────────────────────────

/** Rattache chaque item importé à un dossier du vault : un chemin existant
 * est réutilisé (nom pour nom, niveau par niveau), le reste est créé. Rend
 * les dossiers à créer et les payloads prêts à écrire. */
export function resolveFolders(result: ImportResult, existing: Group[], rootId: string | null): { groups: Group[]; payloads: Payload[] } {
  const created: Group[] = [];
  const all = [...existing];
  const find = (name: string, parentId: string | null) => all.find((g) => g.parentId === parentId && g.name.toLowerCase() === name.toLowerCase());
  const idFor = (path: string[]): string | null => {
    let parent = rootId;
    for (const name of path) {
      let g = find(name, parent);
      if (!g) {
        g = { id: uuid(), name, parentId: parent };
        all.push(g);
        created.push(g);
      }
      parent = g.id;
    }
    return parent;
  };
  const payloads = result.items.map(({ payload, folderPath }) => withGroup(payload, idFor(folderPath)));
  return { groups: created, payloads };
}

function withGroup(p: Payload, groupId: string | null): Payload {
  // Un dossier importé garde sa place : seul son contenu est rangé ici.
  return p.kind === "group" ? p : withParent(p, groupId) ?? p;
}
