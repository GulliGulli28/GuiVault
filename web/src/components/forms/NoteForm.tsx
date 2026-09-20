import { useState } from "react";
import type { VaultIndex } from "../../lib/entities";
import { emptyNote } from "../../lib/items";
import type { Note, Payload } from "../../lib/types";
import { Field, FormShell } from "./common";
import { SecretFooter, SecretHeader } from "./SecretBits";

export function NoteForm({ initial, index, defaultGroupId, onSave, onCancel }: {
  initial?: Note;
  index: VaultIndex;
  defaultGroupId?: string | null;
  onSave: (p: Payload) => Promise<void>;
  onCancel: () => void;
}) {
  const [note, setNote] = useState<Note>(initial ?? emptyNote(defaultGroupId ?? null));
  return (
    <FormShell title={initial ? `Modifier « ${initial.name} »` : "Nouvelle note"} onSave={() => onSave({ kind: "note", note: { ...note, name: note.name.trim() } })} onCancel={onCancel} validate={() => (note.name.trim() ? null : "Le nom est obligatoire.")}>
      <SecretHeader value={note} onChange={setNote} placeholder="Codes de secours, licence…" />
      <Field label="Contenu">
        <textarea value={note.content} onChange={(e) => setNote({ ...note, content: e.target.value })} rows={12} spellCheck={false} className="input" />
      </Field>
      <SecretFooter value={note} onChange={setNote} groups={index.groups} withoutNotes />
    </FormShell>
  );
}
