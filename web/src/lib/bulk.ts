/** Les actions de masse sur une sélection d'éléments (`VaultPage`,
 * `BulkBar`) : ce qui change dans chaque payload, et l'enchaînement des
 * écritures. Pur sauf `runBulk`, qui ne fait qu'appeler `op` ; testé
 * (`bulk.test.ts`). */
import { SECRET_KINDS, type ItemKind, type Payload } from "./types";

/** La clé de l'entité dans chaque payload (`payloadEntity`, en écriture). */
const ENTITY_KEY: Record<ItemKind, string> = {
  host: "host",
  group: "group",
  snippet: "snippet",
  key: "key",
  "sql-connection": "connection",
  icon: "icon",
  login: "login",
  note: "note",
  card: "card",
  identity: "identity",
  aws: "aws",
  "api-key": "apiKey",
  runbook: "runbook",
  account: "account",
};

/** Le payload avec son entité passée par `fn` ; le reste (secrets d'un
 * hôte, contenu d'une clé) tel quel. */
export function withEntity(p: Payload, fn: (e: Record<string, unknown>) => Record<string, unknown>): Payload {
  const key = ENTITY_KEY[p.kind];
  const entity = (p as unknown as Record<string, Record<string, unknown>>)[key];
  return { ...p, [key]: fn(entity) } as Payload;
}

/** Épingler (ou non) : les secrets seulement, comme le bouton de la fiche.
 * `null` : rien à changer. */
export function withFavorite(p: Payload, on: boolean): Payload | null {
  if (!SECRET_KINDS.includes(p.kind as (typeof SECRET_KINDS)[number])) return null;
  const was = (p as unknown as Record<string, { favorite?: boolean }>)[ENTITY_KEY[p.kind]].favorite === true;
  if (was === on) return null;
  // `undefined` plutôt que `false` : le même JSON qu'un élément jamais épinglé.
  return withEntity(p, (e) => ({ ...e, favorite: on ? true : undefined }));
}

/** Ajouter et retirer des étiquettes (sans tenir compte de la casse pour
 * les doublons) ; `null` si l'élément n'en porte pas ou que rien ne change. */
export function withTags(p: Payload, add: string[], remove: string[]): Payload | null {
  const tags = (p as unknown as Record<string, { tags?: unknown }>)[ENTITY_KEY[p.kind]].tags;
  if (!Array.isArray(tags)) return null;
  const gone = new Set(remove.map((t) => t.toLowerCase()));
  const next: string[] = tags.filter((t): t is string => typeof t === "string" && !gone.has(t.toLowerCase()));
  for (const t of add) if (!next.some((x) => x.toLowerCase() === t.toLowerCase())) next.push(t);
  if (next.length === tags.length && next.every((t, i) => t === tags[i])) return null;
  return withEntity(p, (e) => ({ ...e, tags: next }));
}

/** Les étiquettes tapées : séparées par des virgules, sans vides. */
export function parseTags(text: string): string[] {
  return [...new Set(text.split(",").map((t) => t.trim()).filter(Boolean))];
}

/** Maj+clic : les éléments visibles entre l'ancre et celui-ci, bornes
 * comprises ; sans ancre (ou ancre plus visible), celui-ci seul. */
export function rangeBetween(ids: string[], anchor: string | null, id: string): string[] {
  const a = anchor ? ids.indexOf(anchor) : -1;
  const b = ids.indexOf(id);
  if (b < 0) return [];
  if (a < 0) return [id];
  return ids.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/** Un dossier et tout ce qu'il contient, sous-dossiers compris (d'après
 * le `parentId` des entités), borné contre un cycle. */
export function subtreeIds(entities: readonly { id: string; parentId: string | null }[], folderId: string): string[] {
  const children = new Map<string, string[]>();
  for (const e of entities) if (e.parentId) children.set(e.parentId, [...(children.get(e.parentId) ?? []), e.id]);
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push(id);
    for (const c of children.get(id) ?? []) walk(c);
  };
  walk(folderId);
  return out;
}

/** Le haut de la sélection : ce dont le dossier n'est pas coché lui aussi
 * (ranger ailleurs ne touche qu'eux, le reste suit son dossier). */
export function topOfSelection<T extends { id: string; parentId: string | null }>(items: readonly T[], picked: ReadonlySet<string>): T[] {
  return items.filter((i) => !i.parentId || !picked.has(i.parentId));
}

export interface BulkResult {
  done: number;
  /** Rien à faire pour lui (pas d'étiquettes, déjà épinglé…). */
  skipped: number;
  failed: { name: string; error: string }[];
}

/** Une écriture après l'autre (chacune porte le manifeste du vault, qui ne
 * se met pas à jour en parallèle) ; une erreur n'arrête pas les suivantes.
 * `op` rend `false` quand il n'y avait rien à faire. */
export async function runBulk<T>(targets: T[], name: (t: T) => string, op: (t: T) => Promise<boolean>, progress?: (n: number) => void): Promise<BulkResult> {
  const out: BulkResult = { done: 0, skipped: 0, failed: [] };
  for (const [i, t] of targets.entries()) {
    try {
      if (await op(t)) out.done++;
      else out.skipped++;
    } catch (e) {
      out.failed.push({ name: name(t), error: e instanceof Error ? e.message : String(e) });
    }
    progress?.(i + 1);
  }
  return out;
}
