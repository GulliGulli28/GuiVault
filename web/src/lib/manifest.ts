/** Le manifeste d'un vault — port de `guivault_crypto::manifest` : la liste
 * authentifiée de ses items (id → SHA-256 du chiffré), scellée sous la clé
 * du vault comme un item, sous un id et un type réservés. Réécrite avec
 * chaque écriture ; vérifiée à chaque lecture complète. Voir
 * `docs/MANIFESTE.md`. */
import { sha256 } from "@noble/hashes/sha2.js";
import * as c from "./crypto";
import { toBase64Url, utf8 } from "./bytes";

export const MANIFEST_ID = "00000000-0000-0000-0000-000000000000";
export const MANIFEST_TYPE = "manifest";
export const MANIFEST_VERSION = 1;

export interface Manifest {
  v: number;
  /** Monte de 1 à chaque écriture ; égal à la révision annoncée par le serveur. */
  counter: number;
  /** Id d'item → empreinte de son chiffré (`itemDigest`). */
  items: Record<string, string>;
}

/** L'empreinte d'un chiffré d'item : SHA-256 en base64url sans remplissage. */
export function itemDigest(ciphertext: Uint8Array): string {
  return toBase64Url(sha256(ciphertext));
}

/** Le manifeste d'un ensemble d'items (id, chiffré), au compteur donné. */
export function manifestOf(counter: number, items: { id: string; ciphertext: Uint8Array }[]): Manifest {
  const out: Record<string, string> = {};
  for (const it of items) out[it.id] = itemDigest(it.ciphertext);
  return { v: MANIFEST_VERSION, counter, items: out };
}

/** Le suivant, sur la révision `base` annoncée : même contenu, compteur + 1. */
export function nextManifest(m: Manifest, base: number): Manifest {
  return { v: MANIFEST_VERSION, counter: base + 1, items: { ...m.items } };
}

export function sealManifest(vaultKey: Uint8Array, vaultId: string, m: Manifest): Uint8Array {
  return c.sealItem(vaultKey, vaultId, MANIFEST_ID, MANIFEST_TYPE, utf8.encode(JSON.stringify(m)));
}

export function openManifest(vaultKey: Uint8Array, vaultId: string, blob: Uint8Array): Manifest {
  const m = JSON.parse(utf8.decode(c.openItem(vaultKey, vaultId, MANIFEST_ID, MANIFEST_TYPE, blob))) as Manifest;
  if (m?.v !== MANIFEST_VERSION || !Number.isInteger(m.counter) || typeof m.items !== "object" || m.items === null) {
    throw new Error("manifeste de format inconnu");
  }
  return m;
}

/** Ce qu'une vérification peut trouver (mêmes cas que `ManifestProblem`). */
export type ManifestProblem =
  | { kind: "missing"; seen: number }
  | { kind: "unreadable" }
  | { kind: "mismatch"; counter: number; revision: number }
  | { kind: "rollback"; counter: number; seen: number }
  | { kind: "unexpected"; itemId: string }
  | { kind: "altered"; itemId: string }
  | { kind: "withheld"; itemId: string };

/** Vérifie ce que sert le serveur : `served`, le manifeste (révision, chiffré)
 * ou rien ; `items`, **tous** les items vivants servis ; `seen`, le plus grand
 * compteur vu d'ici. Sans manifeste servi ni jamais vu : rien à vérifier. */
export function verifyManifest(
  vaultKey: Uint8Array,
  vaultId: string,
  served: { revision: number; ciphertext: Uint8Array } | null,
  items: { id: string; ciphertext: Uint8Array }[],
  seen: number | null,
): { manifest: Manifest | null; problems: ManifestProblem[] } {
  if (!served) {
    return { manifest: null, problems: seen !== null && seen > 0 ? [{ kind: "missing", seen }] : [] };
  }
  let manifest: Manifest;
  try {
    manifest = openManifest(vaultKey, vaultId, served.ciphertext);
  } catch {
    return { manifest: null, problems: [{ kind: "unreadable" }] };
  }
  const problems: ManifestProblem[] = [];
  if (manifest.counter !== served.revision) problems.push({ kind: "mismatch", counter: manifest.counter, revision: served.revision });
  if (seen !== null && seen > manifest.counter) problems.push({ kind: "rollback", counter: manifest.counter, seen });
  const itemProblems: ManifestProblem[] = [];
  const servedIds = new Set<string>();
  for (const it of items) {
    servedIds.add(it.id);
    const expected = manifest.items[it.id];
    if (expected === undefined) itemProblems.push({ kind: "unexpected", itemId: it.id });
    else if (expected !== itemDigest(it.ciphertext)) itemProblems.push({ kind: "altered", itemId: it.id });
  }
  for (const id of Object.keys(manifest.items)) if (!servedIds.has(id)) itemProblems.push({ kind: "withheld", itemId: id });
  const order = { altered: 0, unexpected: 1, withheld: 2 } as Record<string, number>;
  itemProblems.sort((a, b) => order[a.kind] - order[b.kind] || ("itemId" in a && "itemId" in b ? a.itemId.localeCompare(b.itemId) : 0));
  return { manifest, problems: [...problems, ...itemProblems] };
}

/** L'id d'item qu'un écart concerne, s'il en concerne un. */
export function problemItem(p: ManifestProblem): string | null {
  return "itemId" in p ? p.itemId : null;
}

/** Le même texte que `Display for ManifestProblem`, avec le nom de l'élément
 * quand on le connaît. */
export function problemText(p: ManifestProblem, nameOf: (id: string) => string | undefined = () => undefined): string {
  const item = (id: string) => {
    const name = nameOf(id);
    return name ? `« ${name} »` : `l'élément ${id}`;
  };
  switch (p.kind) {
    case "missing": return `le serveur ne sert plus le manifeste de ce vault (vu ici jusqu'à la version ${p.seen})`;
    case "unreadable": return "le manifeste ne s'ouvre pas avec la clé du vault";
    case "mismatch": return `le manifeste (version ${p.counter}) ne correspond pas à la révision annoncée (${p.revision})`;
    case "rollback": return `le manifeste est revenu à la version ${p.counter}, alors que la ${p.seen} a déjà été vue ici`;
    case "unexpected": return `${item(p.itemId)} n'est pas dans le manifeste (ajouté hors des clients, ou revenu après suppression)`;
    case "altered": return `${item(p.itemId)} n'est pas la version annoncée par le manifeste (une ancienne version rejouée ?)`;
    case "withheld": return `${item(p.itemId)} est dans le manifeste mais le serveur ne le sert pas`;
  }
}
