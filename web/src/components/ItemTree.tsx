import { useEffect, useMemo, useState, type DragEvent, type ReactNode } from "react";
import { FOLDERABLE_KINDS } from "../lib/entities";
import { hostKindMeta } from "../lib/hostKinds";
import { ACCENT_COLORS, type UiAccent } from "../lib/preferences";
import { buildVaultTree, visibleRows } from "../lib/vaultTree";
import { KIND_LABELS, type CustomIcon, type GuiVaultEntity, type GuiVaultEntityKind } from "../lib/types";
import { EntityMono, EntityRow, EntityTags, GroupRow } from "./EntityRow";
import { HostIcon, hasIcon } from "./icons";
import { IconApiKey, IconCard, IconIdentity, IconLogin, IconNote, IconStar } from "./secret-icons";
import { IconCloud, IconDatabase, IconFolder, IconFolderFilled, IconHosts, IconKeychain, IconPalette, IconRunbook, IconSnippets } from "./ui-icons";

export const KIND_ICONS: Record<GuiVaultEntityKind, (p: { size?: number; className?: string }) => ReactNode> = {
  host: IconHosts,
  group: IconFolder,
  key: IconKeychain,
  snippet: IconSnippets,
  "sql-connection": IconDatabase,
  icon: IconPalette,
  login: IconLogin,
  note: IconNote,
  card: IconCard,
  identity: IconIdentity,
  aws: IconCloud,
  "api-key": IconApiKey,
  runbook: IconRunbook,
};

const BUCKET_ICONS: Record<string, (p: { size?: number }) => ReactNode> = {
  "Clés": IconKeychain,
  "Snippets": IconSnippets,
  "Runbooks": IconRunbook,
  "Icônes": IconPalette,
};

/** L'icône d'une entité, choisie comme dans les panneaux de Guiterm : l'icône
 * qu'on lui a donnée (banque ou icône du vault) quand on sait la dessiner,
 * sinon celle de son genre — terminal, Docker, Kubernetes, écran RDP pour un
 * hôte, l'icône du type pour le reste. */
export function EntityIcon({ entity, customIcons, size = 13 }: { entity: GuiVaultEntity; customIcons: CustomIcon[]; size?: number }) {
  if (hasIcon(entity.icon, customIcons)) {
    return <span className="host-icon flex"><HostIcon iconId={entity.icon} customIcons={customIcons} size={16} /></span>;
  }
  if (entity.kind === "host") {
    const { Icon } = hostKindMeta(entity.hostKind);
    return <Icon size={size} />;
  }
  if (entity.kind === "group") {
    const color = groupColor(entity.color);
    // Un dossier coloré : le dossier plein, de sa couleur — la même que
    // Guiterm met sur ses onglets.
    if (color) return <span className="flex [&>svg]:h-full [&>svg]:w-full" style={{ color }}><IconFolderFilled size={size} /></span>;
  }
  const Icon = KIND_ICONS[entity.kind];
  return <Icon size={size} />;
}

/** La pastille de couleur d'un dossier — `c500` de l'accent nommé, comme
 * sur les onglets de Guiterm. `undefined` sans couleur ou pour une couleur
 * que Guiterm ne connaît pas. */
export function groupColor(color: string | undefined): string | undefined {
  if (!color) return undefined;
  if (color in ACCENT_COLORS) return ACCENT_COLORS[color as UiAccent].c500;
  return /^#[0-9a-f]{6}$/i.test(color) ? color : undefined;
}

/** Nommer un dossier sans quitter la liste : en créer un (à la racine ou
 * sous un dossier), ou renommer celui-ci. */
export type FolderNaming = { mode: "create"; parentId: string | null } | { mode: "rename"; id: string };

const DRAG_TYPE = "application/x-guivault-item";

/** Le champ d'un nom de dossier, à sa place dans l'arbre : Entrée valide,
 * Échap annule, quitter le champ valide s'il y a un nom. */
function FolderNameInput({ depth, initial, onSubmit, onCancel }: { depth: number; initial: string; onSubmit: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState(initial);
  const done = (commit: boolean) => {
    const v = name.trim();
    if (commit && v && v !== initial) onSubmit(v);
    else onCancel();
  };
  return (
    <div style={{ paddingLeft: 4 + depth * 14 }} className="mb-1 mt-1.5 flex min-h-[var(--group-row-h)] items-center gap-1.5 pr-1">
      <span className="flex h-5 w-5 shrink-0" />
      <span className="flex shrink-0 text-[var(--c-text-muted)]" style={{ width: "var(--group-row-icon)", height: "var(--group-row-icon)" }}><IconFolder size={14} /></span>
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); done(true); }
          if (e.key === "Escape") { e.preventDefault(); done(false); }
        }}
        onBlur={() => done(true)}
        placeholder="Nom du dossier"
        aria-label="Nom du dossier"
        className="input h-7 min-w-0 flex-1"
      />
    </div>
  );
}

/** Le contenu d'un vault, comme dans le panneau GuiVault de Guiterm : mêmes
 * lignes de dossier repliables, mêmes lignes d'entité, même indentation —
 * sans les cases à cocher, un clic ouvre l'entité.
 *
 * En écriture (`onMove`, `folderActions`, `naming`), il se manie comme le
 * panneau des hôtes de Guiterm : boutons au survol d'un dossier (nouvel
 * élément, sous-dossier, renommer), dossier nommé sur place, et
 * glisser-déposer d'un élément ou d'un dossier dans un autre — ou sur la
 * bande « racine » qui apparaît pendant le glisser. */
export function ItemTree({ entities, customIcons = [], query, selected, onSelect, emptyMessage = "Rien ici pour l'instant.", rowActions, folderActions, naming, onName, onNameCancel, onMove }: {
  entities: GuiVaultEntity[];
  /** Les icônes du vault, pour les hôtes et dossiers qui en portent une. */
  customIcons?: CustomIcon[];
  query: string;
  selected: string | null;
  onSelect: (id: string) => void;
  emptyMessage?: string;
  /** Boutons révélés au survol d'une entité (copier l'utilisateur, le mot
   * de passe…). */
  rowActions?: (entity: GuiVaultEntity) => ReactNode;
  /** Boutons au survol d'un dossier, à la place de « ouvrir ». */
  folderActions?: (folder: GuiVaultEntity) => ReactNode;
  /** Un dossier en train d'être nommé, et quoi faire du nom. */
  naming?: FolderNaming | null;
  onName?: (name: string) => void;
  onNameCancel?: () => void;
  /** Ranger un élément dans un dossier (`null` = racine) : active le
   * glisser-déposer. */
  onMove?: (id: string, folderId: string | null) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  // Créer dans un dossier replié : on le déplie pour voir le champ.
  const namingParent = naming?.mode === "create" ? naming.parentId : null;
  useEffect(() => {
    if (!namingParent) return;
    setCollapsed((prev) => {
      if (!prev.has(namingParent)) return prev;
      const next = new Set(prev);
      next.delete(namingParent);
      return next;
    });
  }, [namingParent]);
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const tree = useMemo(() => buildVaultTree(entities, query), [entities, query]);
  const visible = useMemo(() => visibleRows(tree.rows, collapsed), [tree, collapsed]);

  // ─── Glisser-déposer ───────────────────────────────────────────────────
  const parents = useMemo(() => new Map(entities.map((e) => [e.id, e.parentId ?? null])), [entities]);
  /** Un dossier ne va ni en lui-même ni dans sa descendance, et déposer là
   * où l'élément est déjà ne fait rien. */
  const canDrop = (folderId: string | null) => {
    if (!dragId) return false;
    if ((parents.get(dragId) ?? null) === folderId) return false;
    const seen = new Set<string>();
    for (let cur = folderId; cur && !seen.has(cur); cur = parents.get(cur) ?? null) {
      if (cur === dragId) return false;
      seen.add(cur);
    }
    return true;
  };
  const dragProps = (e: GuiVaultEntity) => onMove && FOLDERABLE_KINDS.has(e.kind) ? {
    draggable: true,
    onDragStart: (ev: DragEvent) => {
      ev.dataTransfer.setData(DRAG_TYPE, e.id);
      ev.dataTransfer.effectAllowed = "move";
      // Pas pendant `dragstart` : Chrome abandonne un glisser dont la page
      // bouge sous lui (la bande « racine » s'insère au-dessus).
      setTimeout(() => setDragId(e.id), 0);
    },
    onDragEnd: () => { setDragId(null); setOverId(null); },
  } : {};
  const dropProps = (folderId: string | null) => onMove ? {
    onDragOver: (ev: DragEvent) => {
      if (!canDrop(folderId)) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "move";
      if (overId !== (folderId ?? "")) setOverId(folderId ?? "");
    },
    onDragLeave: (ev: DragEvent) => {
      if (!ev.currentTarget.contains(ev.relatedTarget as Node | null)) setOverId((o) => (o === (folderId ?? "") ? null : o));
    },
    onDrop: (ev: DragEvent) => {
      ev.preventDefault();
      const id = ev.dataTransfer.getData(DRAG_TYPE) || dragId;
      setDragId(null);
      setOverId(null);
      if (id && canDrop(folderId)) onMove(id, folderId);
    },
  } : {};
  const dropClass = (folderId: string | null) => overId === (folderId ?? "") ? "rounded-md bg-[var(--c-accent-dim)] outline outline-1 outline-[var(--c-accent)]" : "";

  const nameInput = (depth: number, initial = "") => (
    <FolderNameInput key={`naming:${naming?.mode}:${naming?.mode === "create" ? naming.parentId : naming?.id}`} depth={depth} initial={initial} onSubmit={(n) => onName?.(n)} onCancel={() => onNameCancel?.()} />
  );

  if (tree.rows.length === 0) {
    return (
      <div>
        {naming?.mode === "create" && nameInput(0)}
        <p className="px-2 py-6 text-center text-[12px] text-[var(--c-text-muted)]">{query ? "Rien ne correspond." : emptyMessage}</p>
      </div>
    );
  }

  return (
    <div>
      {dragId && (
        <div {...dropProps(null)} className={`mb-1 flex items-center justify-center rounded-md border border-dashed border-[var(--c-border-strong)] px-2 py-1.5 text-[11px] text-[var(--c-text-muted)] ${dropClass(null)}`}>
          Déposer ici pour ranger à la racine
        </div>
      )}
      {naming?.mode === "create" && naming.parentId === null && nameInput(0)}
      {visible.map((row) => {
        if (row.kind === "section") return null;
        if (row.kind === "folder") {
          if (naming?.mode === "rename" && naming.id === row.entity.id) return nameInput(row.depth, row.entity.name);
          return (
            <div key={row.id} {...dragProps(row.entity)} {...dropProps(row.entity.id)} className={`${dropClass(row.entity.id)} ${dragId === row.entity.id ? "opacity-50" : ""}`}>
              <GroupRow
                depth={row.depth}
                expanded={!collapsed.has(row.id)}
                onToggle={() => toggle(row.id)}
                icon={hasIcon(row.entity.icon, customIcons)
                  ? <HostIcon iconId={row.entity.icon} customIcons={customIcons} size={15} />
                  : <EntityIcon entity={row.entity} customIcons={customIcons} size={14} />}
                name={row.entity.name}
                count={row.keys.length - 1}
                actions={folderActions ? folderActions(row.entity) : (
                  <button onClick={() => onSelect(row.entity.id)} className={`btn btn-ghost btn-sm ${selected === row.entity.id ? "btn-toggled" : ""}`} title="Ouvrir le dossier">ouvrir</button>
                )}
              />
              {naming?.mode === "create" && naming.parentId === row.entity.id && !collapsed.has(row.id) && nameInput(row.depth + 1)}
            </div>
          );
        }
        if (row.kind === "bucket") {
          const Icon = BUCKET_ICONS[row.label] ?? IconFolder;
          return <GroupRow key={row.id} depth={row.depth} expanded={!collapsed.has(row.id)} onToggle={() => toggle(row.id)} icon={<Icon size={14} />} name={row.label} count={row.keys.length} />;
        }
        const { entity } = row;
        const badges = (
          <>
            {entity.favorite && <IconStar size={11} filled className="text-[var(--c-warn)]" />}
            {entity.badge && <span className="tag">{entity.badge}</span>}
          </>
        );
        const secondary = entity.subtitle || entity.tags ? (
          <>
            {entity.subtitle && (entity.mono ? <EntityMono>{entity.subtitle}</EntityMono> : <span className="truncate">{entity.subtitle}</span>)}
            {entity.tags && <EntityTags tags={entity.tags} />}
          </>
        ) : undefined;
        const draggable = dragProps(entity);
        return (
          <div key={row.id} {...draggable} className={dragId === entity.id ? "opacity-50" : undefined}>
          <EntityRow
            depth={row.depth}
            active={selected === entity.id}
            className="cursor-pointer"
            icon={<EntityIcon entity={entity} customIcons={customIcons} />}
            title={entity.name}
            badges={entity.favorite || entity.badge ? badges : undefined}
            secondary={secondary}
            title_={`${KIND_LABELS[entity.kind]}${entity.path ? ` — ${entity.path}` : ""}`}
            onClick={() => onSelect(entity.id)}
            actions={rowActions?.(entity)}
          />
          </div>
        );
      })}
    </div>
  );
}
