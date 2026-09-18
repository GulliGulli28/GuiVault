import { useState } from "react";
import type { VaultIndex } from "../../lib/entities";
import { uuid } from "../../lib/bytes";
import type { Group, Payload } from "../../lib/types";
import { Field, FormShell, GroupSelect } from "./common";

export function GroupForm({ initial, index, defaultParentId, onSave, onCancel }: {
  initial?: Group;
  index: VaultIndex;
  defaultParentId?: string | null;
  onSave: (p: Payload) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [parentId, setParentId] = useState<string | null>(initial?.parentId ?? defaultParentId ?? null);
  const [color, setColor] = useState(initial?.color ?? "");
  const [icon, setIcon] = useState(initial?.icon ?? "");

  const save = async () => {
    const group: Group = { ...initial, id: initial?.id ?? uuid(), name: name.trim(), parentId, color: color.trim() || null };
    if (icon.trim()) group.icon = icon.trim();
    else delete group.icon;
    await onSave({ kind: "group", group });
  };

  return (
    <FormShell title={initial ? `Modifier « ${initial.name} »` : "Nouveau dossier"} onSave={save} onCancel={onCancel} validate={() => (name.trim() ? null : "Le nom est obligatoire.")}>
      <Field label="Nom">
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus className="input" />
      </Field>
      <Field label="Dossier parent">
        <GroupSelect groups={index.groups} value={parentId} onChange={setParentId} exclude={initial?.id} />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field group label="Couleur (optionnelle)">
          <div className="flex items-center gap-1.5">
            <input type="color" aria-label="Choisir la couleur" value={/^#[0-9a-f]{6}$/i.test(color) ? color : "#71717a"} onChange={(e) => setColor(e.target.value)} className="h-7 w-9 cursor-pointer rounded-md border border-[var(--c-border)] bg-transparent p-0.5" />
            <input aria-label="Couleur (optionnelle)" value={color} onChange={(e) => setColor(e.target.value)} placeholder="#2563eb" className="input input-mono" />
          </div>
        </Field>
        <Field label="Icône (optionnelle)">
          <input value={icon} onChange={(e) => setIcon(e.target.value)} className="input input-mono" />
        </Field>
      </div>
    </FormShell>
  );
}
