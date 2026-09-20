/** Des items déchiffrés aux entités de l'arborescence, et ce que les
 * formulaires ont besoin de connaître du reste du vault (dossiers, hôtes pour
 * les relais, clés, snippets). */
import type { DecodedItem } from "./session";
import { payloadName } from "./session";
import { describeSecret } from "./items";
import type { Group, GuiVaultEntity, Host, Payload, PrivateKey, Snippet, SqlConnection } from "./types";

export interface VaultIndex {
  groups: Group[];
  hosts: Host[];
  keys: PrivateKey[];
  snippets: Snippet[];
  connections: SqlConnection[];
  byId: Map<string, DecodedItem & { ok: true }>;
}

export function indexItems(items: DecodedItem[]): VaultIndex {
  const idx: VaultIndex = { groups: [], hosts: [], keys: [], snippets: [], connections: [], byId: new Map() };
  for (const it of items) {
    if (!it.ok) continue;
    idx.byId.set(it.id, it);
    const p = it.payload;
    switch (p.kind) {
      case "group": idx.groups.push(p.group); break;
      case "host": idx.hosts.push(p.host); break;
      case "key": idx.keys.push(p.key); break;
      case "snippet": idx.snippets.push(p.snippet); break;
      case "sql-connection": idx.connections.push(p.connection); break;
      default: break;
    }
  }
  const byName = <T extends { name?: string; label?: string }>(a: T, b: T) => (a.name ?? a.label ?? "").localeCompare(b.name ?? b.label ?? "");
  idx.groups.sort(byName);
  idx.hosts.sort(byName);
  idx.keys.sort(byName);
  idx.snippets.sort(byName);
  idx.connections.sort(byName);
  return idx;
}

function parentOf(p: Payload): string | null {
  switch (p.kind) {
    case "host": return p.host.groupId ?? null;
    case "group": return p.group.parentId ?? null;
    case "sql-connection": return p.connection.groupId ?? null;
    case "login": return p.login.groupId ?? null;
    case "note": return p.note.groupId ?? null;
    case "card": return p.card.groupId ?? null;
    case "identity": return p.identity.groupId ?? null;
    default: return null;
  }
}

/** Chemin « Prod / Bases » d'un dossier, borné contre un cycle de `parentId`. */
export function groupPath(groups: Map<string, Group>, groupId: string | null): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  let cur = groupId;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const g = groups.get(cur);
    if (!g) break;
    parts.unshift(g.name);
    cur = g.parentId;
  }
  return parts.join(" / ");
}

function payloadEntityFavorite(p: Payload): boolean {
  switch (p.kind) {
    case "login": return !!p.login.favorite;
    case "note": return !!p.note.favorite;
    case "card": return !!p.card.favorite;
    case "identity": return !!p.identity.favorite;
    default: return false;
  }
}

export function toEntities(items: DecodedItem[]): GuiVaultEntity[] {
  const groups = new Map<string, Group>();
  for (const it of items) if (it.ok && it.payload.kind === "group") groups.set(it.id, it.payload.group);
  const out: GuiVaultEntity[] = [];
  for (const it of items) {
    if (!it.ok) {
      out.push({ id: it.id, kind: (it.itemType as GuiVaultEntity["kind"]) ?? "host", name: `(illisible) ${it.id.slice(0, 8)}`, path: "", parentId: null });
      continue;
    }
    const parentId = parentOf(it.payload);
    const { subtitle, search } = describeSecret(it.payload);
    const favorite = payloadEntityFavorite(it.payload) || undefined;
    out.push({ id: it.id, kind: it.payload.kind, name: payloadName(it.payload) || "(sans nom)", path: groupPath(groups, parentId), parentId, subtitle: subtitle || undefined, search: search || undefined, favorite });
  }
  return out;
}
