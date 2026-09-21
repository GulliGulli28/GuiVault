import { useMemo, useState, type ReactNode } from "react";
import { hostKindMeta } from "../lib/hostKinds";
import { ACCENT_COLORS, type UiAccent } from "../lib/preferences";
import { buildVaultTree, visibleRows } from "../lib/vaultTree";
import { KIND_LABELS, type CustomIcon, type GuiVaultEntity, type GuiVaultEntityKind } from "../lib/types";
import { EntityMono, EntityRow, EntityTags, GroupRow } from "./EntityRow";
import { HostIcon, hasIcon } from "./icons";
import { IconCard, IconIdentity, IconLogin, IconNote, IconStar } from "./secret-icons";
import { IconDatabase, IconFolder, IconFolderFilled, IconHosts, IconKeychain, IconPalette, IconSnippets } from "./ui-icons";

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
};

const BUCKET_ICONS: Record<string, (p: { size?: number }) => ReactNode> = {
  "Clés": IconKeychain,
  "Snippets": IconSnippets,
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

/** Le contenu d'un vault, comme dans le panneau GuiVault de Guiterm : mêmes
 * lignes de dossier repliables, mêmes lignes d'entité, même indentation —
 * sans les cases à cocher, un clic ouvre l'entité. */
export function ItemTree({ entities, customIcons = [], query, selected, onSelect, emptyMessage = "Rien ici pour l'instant.", rowActions }: {
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
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const tree = useMemo(() => buildVaultTree(entities, query), [entities, query]);
  const visible = useMemo(() => visibleRows(tree.rows, collapsed), [tree, collapsed]);

  if (tree.rows.length === 0) {
    return <p className="px-2 py-6 text-center text-[12px] text-[var(--c-text-muted)]">{query ? "Rien ne correspond." : emptyMessage}</p>;
  }

  return (
    <div>
      {visible.map((row) => {
        if (row.kind === "section") return null;
        if (row.kind === "folder") {
          return (
            <GroupRow
              key={row.id}
              depth={row.depth}
              expanded={!collapsed.has(row.id)}
              onToggle={() => toggle(row.id)}
              icon={hasIcon(row.entity.icon, customIcons)
                ? <HostIcon iconId={row.entity.icon} customIcons={customIcons} size={15} />
                : <EntityIcon entity={row.entity} customIcons={customIcons} size={14} />}
              name={row.entity.name}
              count={row.keys.length - 1}
              actions={
                <button onClick={() => onSelect(row.entity.id)} className={`btn btn-ghost btn-sm ${selected === row.entity.id ? "btn-toggled" : ""}`} title="Ouvrir le dossier">ouvrir</button>
              }
            />
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
        return (
          <EntityRow
            key={row.id}
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
        );
      })}
    </div>
  );
}
