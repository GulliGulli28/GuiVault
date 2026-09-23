import { useState } from "react";
import type { VaultIndex } from "../../lib/entities";
import { uuid } from "../../lib/bytes";
import { ACCENT_COLORS, type UiAccent } from "../../lib/preferences";
import type { CustomIcon, Group, Payload } from "../../lib/types";
import { IconField } from "../IconPicker";
import { IconClose, IconFolder } from "../ui-icons";
import { Field, FormShell, GroupSelect, useSeed } from "./common";

export function GroupForm({ initial, index, defaultParentId, onSave, onCancel, onAddIcon }: {
  initial?: Group;
  index: VaultIndex;
  defaultParentId?: string | null;
  onSave: (p: Payload) => Promise<void>;
  onCancel: () => void;
  onAddIcon?: (icon: CustomIcon) => Promise<void>;
}) {
  const seed = useSeed(initial, (p) => (p.kind === "group" ? p.group : undefined));
  const [name, setName] = useState(seed?.name ?? "");
  const [parentId, setParentId] = useState<string | null>(seed ? seed.parentId ?? null : defaultParentId ?? null);
  const [color, setColor] = useState<string | null>(seed?.color ?? null);
  const [icon, setIcon] = useState<string | null>(seed?.icon ?? null);

  const save = async () => {
    const group: Group = { ...seed, id: seed?.id ?? uuid(), name: name.trim(), parentId, color };
    if (icon) group.icon = icon;
    else delete group.icon;
    await onSave({ kind: "group", group });
  };

  // Une couleur que Guiterm ne propose pas (un hexadécimal écrit ailleurs) :
  // on la garde tant qu'on ne choisit pas autre chose, et on la montre.
  const foreign = color !== null && !(color in ACCENT_COLORS);

  return (
    <FormShell title={initial ? `Modifier « ${initial.name} »` : "Nouveau dossier"} onSave={save} onCancel={onCancel} validate={() => (name.trim() ? null : "Le nom est obligatoire.")}>
      <Field label="Nom">
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Mon dossier" className="input" />
      </Field>
      <Field label="Dossier parent">
        <GroupSelect groups={index.groups} value={parentId} onChange={setParentId} exclude={initial?.id} />
      </Field>
      <Field group label="Icône" hint="Celle de la banque de Guiterm, ou une icône du vault.">
        <IconField value={icon} onChange={setIcon} customIcons={index.icons} onAddIcon={onAddIcon} fallback={<IconFolder size={14} />} />
      </Field>
      {/* Les huit accents de Guiterm, par leur nom : c'est ce que ses onglets
          et cette liste savent colorer. */}
      <Field group label="Couleur (affichée sur les onglets de Guiterm)">
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setColor(null)}
            title="Aucune couleur"
            aria-label="Aucune couleur"
            aria-pressed={color === null}
            className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 text-[var(--c-text-muted)] ${color === null ? "border-[var(--c-text)]" : "border-transparent hover:border-[var(--c-border-strong)]"}`}
            style={{ background: "var(--c-bg3)" }}
          >
            <IconClose size={10} />
          </button>
          {(Object.entries(ACCENT_COLORS) as [UiAccent, typeof ACCENT_COLORS[UiAccent]][]).map(([key, entry]) => (
            <button
              key={key}
              type="button"
              onClick={() => setColor(key)}
              title={entry.label}
              aria-label={entry.label}
              aria-pressed={color === key}
              className={`h-6 w-6 shrink-0 rounded-full border-2 ${color === key ? "border-[var(--c-text)]" : "border-transparent hover:border-[var(--c-border-strong)]"}`}
              style={{ background: entry.c500 }}
            />
          ))}
          {foreign && (
            <span className="flex items-center gap-1.5 text-[11.5px] text-[var(--c-text-muted)]" title="Couleur écrite par un autre client">
              <span className="h-6 w-6 rounded-full border-2 border-[var(--c-text)]" style={{ background: /^#[0-9a-f]{6}$/i.test(color) ? color : "var(--c-bg3)" }} />
              <span className="kbd">{color}</span>
            </span>
          )}
        </div>
      </Field>
    </FormShell>
  );
}
