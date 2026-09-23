import { useState } from "react";
import { uuid } from "../../lib/bytes";
import type { Payload, Snippet } from "../../lib/types";
import { Checkbox, Field, FormShell, TagsInput, useSeed } from "./common";

export function SnippetForm({ initial, onSave, onCancel }: { initial?: Snippet; onSave: (p: Payload) => Promise<void>; onCancel: () => void }) {
  const seed = useSeed(initial, (p) => (p.kind === "snippet" ? p.snippet : undefined));
  const [name, setName] = useState(seed?.name ?? "");
  const [command, setCommand] = useState(seed?.command ?? "");
  const [tags, setTags] = useState<string[]>(seed?.tags ?? []);
  const [adaptive, setAdaptive] = useState(seed?.adaptive ?? false);

  const save = async () => {
    const snippet: Snippet = { ...seed, id: seed?.id ?? uuid(), name: name.trim(), command, tags, adaptive };
    await onSave({ kind: "snippet", snippet });
  };

  return (
    <FormShell title={initial ? `Modifier « ${initial.name} »` : "Nouveau snippet"} onSave={save} onCancel={onCancel} validate={() => (name.trim() ? command.trim() ? null : "La commande est vide." : "Le nom est obligatoire.")}>
      <Field label="Nom">
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus className="input" />
      </Field>
      <Field label={adaptive ? "Programme adaptatif" : "Commande"} hint="Peut contenir des {{variables}}, demandées avant l'exécution.">
        <textarea value={command} onChange={(e) => setCommand(e.target.value)} rows={8} spellCheck={false} className="input input-mono" />
      </Field>
      <Checkbox checked={adaptive} onChange={setAdaptive} label="Snippet adaptatif" hint="Un programme du moteur adaptatif de Guiterm, résolu par hôte et par plateforme, plutôt qu'une commande littérale." />
      <Field label="Étiquettes">
        <TagsInput value={tags} onChange={setTags} />
      </Field>
    </FormShell>
  );
}
