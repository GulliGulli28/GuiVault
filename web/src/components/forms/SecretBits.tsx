import { useState } from "react";
import type { CustomField, Group, SecretBase } from "../../lib/types";
import { IconStar } from "../secret-icons";
import { IconClose } from "../ui-icons";
import { PasswordInput } from "../ui";
import { Field, GroupSelect, TagsInput } from "./common";

/** Le tronc commun des formulaires de secrets : nom et favori en tête,
 * dossier, tags, notes et champs personnalisés en pied. Chaque formulaire
 * garde l'objet entier en état (`base`) et n'en modifie que ses champs. */
export function SecretHeader<T extends SecretBase>({ value, onChange, placeholder }: { value: T; onChange: (v: T) => void; placeholder?: string }) {
  return (
    <div className="flex items-end gap-2">
      <Field label="Nom" className="min-w-0 flex-1">
        <input value={value.name} onChange={(e) => onChange({ ...value, name: e.target.value })} autoFocus placeholder={placeholder} className="input" />
      </Field>
      <button
        type="button"
        onClick={() => onChange({ ...value, favorite: !value.favorite })}
        aria-pressed={!!value.favorite}
        className={`btn btn-icon ${value.favorite ? "btn-toggled" : "btn-secondary"}`}
        title={value.favorite ? "Retirer des favoris" : "Ajouter aux favoris"}
        aria-label={value.favorite ? "Retirer des favoris" : "Ajouter aux favoris"}
      >
        <IconStar size={13} filled={!!value.favorite} />
      </button>
    </div>
  );
}

export function SecretFooter<T extends SecretBase>({ value, onChange, groups, withoutNotes }: { value: T; onChange: (v: T) => void; groups: Group[]; withoutNotes?: boolean }) {
  return (
    <>
      {!withoutNotes && (
        <Field label="Notes">
          <textarea value={value.notes ?? ""} onChange={(e) => onChange({ ...value, notes: e.target.value || undefined })} rows={3} className="input" />
        </Field>
      )}
      <CustomFieldsEditor fields={value.fields ?? []} onChange={(fields) => onChange({ ...value, fields: fields.length ? fields : undefined })} />
      <div className="grid grid-cols-2 gap-2">
        <Field label="Dossier"><GroupSelect groups={groups} value={value.groupId} onChange={(groupId) => onChange({ ...value, groupId })} /></Field>
        <Field label="Étiquettes"><TagsInput value={value.tags} onChange={(tags) => onChange({ ...value, tags })} /></Field>
      </div>
    </>
  );
}

export function CustomFieldsEditor({ fields, onChange }: { fields: CustomField[]; onChange: (f: CustomField[]) => void }) {
  const [newType, setNewType] = useState<CustomField["type"]>("text");
  const update = (i: number, patch: Partial<CustomField>) => onChange(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  return (
    <Field group label="Champs personnalisés">
      <div className="space-y-1">
        {fields.map((f, i) => (
          <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-center gap-1">
            <input value={f.name} onChange={(e) => update(i, { name: e.target.value })} placeholder="Nom" aria-label={`Nom du champ ${i + 1}`} className="input" />
            {f.type === "boolean" ? (
              <label className="flex h-7 items-center gap-2 text-[12px] text-[var(--c-text-secondary)]">
                <input type="checkbox" checked={f.value === "true"} onChange={(e) => update(i, { value: e.target.checked ? "true" : "false" })} aria-label={`Valeur du champ ${i + 1}`} />
                {f.value === "true" ? "oui" : "non"}
              </label>
            ) : f.type === "hidden" ? (
              <PasswordInput value={f.value} onChange={(value) => update(i, { value })} autoComplete="off" />
            ) : (
              <input value={f.value} onChange={(e) => update(i, { value: e.target.value })} placeholder="Valeur" aria-label={`Valeur du champ ${i + 1}`} className="input" />
            )}
            <button type="button" onClick={() => onChange(fields.filter((_, j) => j !== i))} aria-label="Retirer le champ" className="btn btn-ghost btn-sm btn-icon hover:text-[var(--c-danger)]"><IconClose size={11} /></button>
          </div>
        ))}
        <div className="flex items-center gap-1.5">
          <select value={newType} onChange={(e) => setNewType(e.target.value as CustomField["type"])} aria-label="Type du nouveau champ" className="input w-auto">
            <option value="text">Texte</option>
            <option value="hidden">Masqué</option>
            <option value="boolean">Case à cocher</option>
          </select>
          <button type="button" onClick={() => onChange([...fields, { name: "", value: newType === "boolean" ? "false" : "", type: newType }])} className="btn btn-secondary btn-sm">Ajouter un champ</button>
        </div>
      </div>
    </Field>
  );
}
