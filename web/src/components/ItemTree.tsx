import { useMemo, useState, type ReactNode } from "react";
import { buildVaultTree, visibleRows } from "../lib/vaultTree";
import { KIND_LABELS, type GuiVaultEntity, type GuiVaultEntityKind } from "../lib/types";
import { EntityRow, GroupRow } from "./EntityRow";
import { IconDatabase, IconFolder, IconHosts, IconKeychain, IconPalette, IconSnippets } from "./ui-icons";

export const KIND_ICONS: Record<GuiVaultEntityKind, (p: { size?: number }) => ReactNode> = {
  host: IconHosts,
  group: IconFolder,
  key: IconKeychain,
  snippet: IconSnippets,
  "sql-connection": IconDatabase,
  icon: IconPalette,
};

const BUCKET_ICONS: Record<string, (p: { size?: number }) => ReactNode> = {
  "Clés": IconKeychain,
  "Snippets": IconSnippets,
  "Icônes": IconPalette,
};

/** Le contenu d'un vault, comme dans le panneau GuiVault de Guiterm : mêmes
 * lignes de dossier repliables, mêmes lignes d'entité, même indentation —
 * sans les cases à cocher, un clic ouvre l'entité. */
export function ItemTree({ entities, query, selected, onSelect, emptyMessage = "Rien ici pour l'instant." }: {
  entities: GuiVaultEntity[];
  query: string;
  selected: string | null;
  onSelect: (id: string) => void;
  emptyMessage?: string;
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
              icon={<IconFolder size={14} />}
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
        const Icon = KIND_ICONS[entity.kind];
        return (
          <EntityRow
            key={row.id}
            depth={row.depth}
            active={selected === entity.id}
            className="cursor-pointer"
            icon={<Icon size={13} />}
            title={entity.name}
            title_={`${KIND_LABELS[entity.kind]}${entity.path ? ` — ${entity.path}` : ""}`}
            onClick={() => onSelect(entity.id)}
          />
        );
      })}
    </div>
  );
}
