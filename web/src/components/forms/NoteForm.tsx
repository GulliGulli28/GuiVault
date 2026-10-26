import { useState } from "react";
import type { VaultIndex } from "../../lib/entities";
import { emptyNote } from "../../lib/items";
import type { Note, Payload } from "../../lib/types";
import { Field, FormShell, useSeed } from "./common";
import { SecretFooter, SecretHeader } from "./SecretBits";
import { t } from "../../lib/i18n";

export function NoteForm({ initial, index, defaultGroupId, onSave, onCancel }: {
  initial?: Note;
  index: VaultIndex;
  defaultGroupId?: string | null;
  onSave: (p: Payload) => Promise<void>;
  onCancel: () => void;
}) {
  const [note, setNote] = useState<Note>(useSeed(initial, (p) => (p.kind === "note" ? p.note : undefined)) ?? emptyNote(defaultGroupId ?? null));
  return (
    <FormShell title={initial ? t("Modifier « {0} »", initial.name) : t("Nouvelle note")} onSave={() => onSave({ kind: "note", note: { ...note, name: note.name.trim() } })} onCancel={onCancel} validate={() => (note.name.trim() ? null : t("Le nom est obligatoire."))}>
      <SecretHeader value={note} onChange={setNote} placeholder={t("Codes de secours, licence…")} />
      <Field label={t("Contenu")}>
        <textarea value={note.content} onChange={(e) => setNote({ ...note, content: e.target.value })} rows={12} spellCheck={false} className="input" />
      </Field>
      <SecretFooter value={note} onChange={setNote} groups={index.groups} withoutNotes />
    </FormShell>
  );
}
