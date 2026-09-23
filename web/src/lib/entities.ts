/** Des items déchiffrés aux entités de l'arborescence, et ce que les
 * formulaires ont besoin de connaître du reste du vault (dossiers, hôtes pour
 * les relais, clés, snippets). */
import type { DecodedItem } from "./session";
import { payloadName } from "./session";
import { describeSecret } from "./items";
import { SQL_ENGINE_LABELS, type CustomIcon, type Group, type GuiVaultEntity, type Host, type Payload, type PrivateKey, type Snippet, type SqlConnection } from "./types";

export interface VaultIndex {
  groups: Group[];
  hosts: Host[];
  keys: PrivateKey[];
  snippets: Snippet[];
  connections: SqlConnection[];
  /** Les icônes du vault, celles que `HostIcon` sait dessiner en plus de
   * la banque de Guiterm. */
  icons: CustomIcon[];
  byId: Map<string, DecodedItem & { ok: true }>;
}

export function indexItems(items: DecodedItem[]): VaultIndex {
  const idx: VaultIndex = { groups: [], hosts: [], keys: [], snippets: [], connections: [], icons: [], byId: new Map() };
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
      case "icon": idx.icons.push(p.icon); break;
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
    case "aws": return p.aws.groupId ?? null;
    case "api-key": return p.apiKey.groupId ?? null;
    default: return null;
  }
}

/** Le même élément rangé ailleurs (`null` = racine) ; `null` pour un type
 * qui ne se range pas dans un dossier (clé, snippet, icône). */
export function withParent(p: Payload, folderId: string | null): Payload | null {
  switch (p.kind) {
    case "host": return { ...p, host: { ...p.host, groupId: folderId } };
    case "group": return { ...p, group: { ...p.group, parentId: folderId } };
    case "sql-connection": return { ...p, connection: { ...p.connection, groupId: folderId } };
    case "login": return { ...p, login: { ...p.login, groupId: folderId } };
    case "note": return { ...p, note: { ...p.note, groupId: folderId } };
    case "card": return { ...p, card: { ...p.card, groupId: folderId } };
    case "identity": return { ...p, identity: { ...p.identity, groupId: folderId } };
    case "aws": return { ...p, aws: { ...p.aws, groupId: folderId } };
    case "api-key": return { ...p, apiKey: { ...p.apiKey, groupId: folderId } };
    default: return null;
  }
}

/** Les types qui se rangent dans un dossier. */
export const FOLDERABLE_KINDS = new Set<string>(["host", "group", "sql-connection", "login", "note", "card", "identity", "aws", "api-key"]);

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
    out.push({ id: it.id, kind: it.payload.kind, name: payloadName(it.payload) || "(sans nom)", path: groupPath(groups, parentId), parentId, subtitle: subtitle || undefined, search: search || undefined, favorite, ...describeEntity(it.payload) });
  }
  return out;
}

/** Ce que la ligne d'une entité Guiterm montre en plus de son nom — la même
 * chose que les panneaux de Guiterm : `user@adresse` en mono et les tags
 * d'un hôte, le moteur d'une connexion, la commande d'un snippet. Et de quoi
 * choisir son icône. */
function describeEntity(p: Payload): Pick<GuiVaultEntity, "mono" | "icon" | "hostKind" | "color" | "badge" | "tags" | "subtitle"> {
  switch (p.kind) {
    case "host": {
      const h = p.host;
      const kind = h.kind ?? "ssh";
      const defaultPort = kind === "rdp" ? 3389 : 22;
      const subtitle =
        kind === "dockerExec" || kind === "k8sExec" ? h.address :
        `${h.username ? `${h.username}@` : ""}${h.address}${h.port && h.port !== defaultPort ? `:${h.port}` : ""}`;
      return { subtitle: subtitle || undefined, mono: true, icon: h.icon, hostKind: kind, tags: h.tags?.length ? h.tags : undefined };
    }
    case "group":
      return { icon: p.group.icon, color: p.group.color ?? undefined };
    case "sql-connection": {
      const c = p.connection;
      const target =
        c.engine === "sqlite" ? c.path :
        c.engine === "mongodb" ? c.connectionString.replace(/\/\/[^@/]*@/, "//") :
        `${c.username ? `${c.username}@` : ""}${c.address}${c.database ? `/${c.database}` : ""}`;
      return { subtitle: target || undefined, mono: true, badge: SQL_ENGINE_LABELS[c.engine], tags: c.tags?.length ? c.tags : undefined };
    }
    case "snippet":
      return { subtitle: p.snippet.command.split("\n")[0].slice(0, 80) || undefined, mono: true, tags: p.snippet.tags?.length ? p.snippet.tags : undefined };
    case "key":
      return { subtitle: p.passphrase ? "protégée par passphrase" : undefined };
    case "runbook": {
      const n = p.runbook.steps.length;
      return { subtitle: p.runbook.description.split("\n")[0].slice(0, 80) || undefined, badge: `${n} étape${n > 1 ? "s" : ""}` };
    }
    case "aws":
      return { badge: p.aws.authType === "sso" ? "SSO" : "clés" };
    default:
      return {};
  }
}

/** Les entités d'un type (ou les favoris), avec les dossiers qui mènent à
 * au moins l'une d'elles — pas les autres : filtrer sur « Identifiants »
 * ne doit pas laisser des dossiers vides. `buildVaultTree` ne retire un
 * dossier vide que sous une recherche, d'où ce tri en amont. */
export function filterEntities(entities: GuiVaultEntity[], keep: (e: GuiVaultEntity) => boolean): GuiVaultEntity[] {
  const groups = new Map(entities.filter((e) => e.kind === "group").map((e) => [e.id, e]));
  const wanted = new Set<string>();
  for (const e of entities) {
    if (e.kind === "group" || !keep(e)) continue;
    // Le dossier de l'entité et tous ses ancêtres, borné contre un cycle.
    let cur = e.parentId;
    const seen = new Set<string>();
    while (cur && groups.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      wanted.add(cur);
      cur = groups.get(cur)!.parentId;
    }
  }
  return entities.filter((e) => (e.kind === "group" ? wanted.has(e.id) : keep(e)));
}
