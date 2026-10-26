import { useState } from "react";
import { uuid } from "../../lib/bytes";
import type { Payload, Snippet } from "../../lib/types";
import { Checkbox, Field, FormShell, TagsInput, useSeed } from "./common";
import { t } from "../../lib/i18n";

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
    <FormShell title={initial ? t("Modifier « {0} »", initial.name) : t("Nouveau snippet")} onSave={save} onCancel={onCancel} validate={() => (name.trim() ? command.trim() ? null : t("La commande est vide.") : t("Le nom est obligatoire."))}>
      <Field label={t("Nom")}>
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus className="input" />
      </Field>
      <Field label={adaptive ? t("Programme adaptatif") : t("Commande")} hint={t("Peut contenir des {{variables}}, demandées avant l'exécution.")}>
        <textarea value={command} onChange={(e) => setCommand(e.target.value)} rows={8} spellCheck={false} className="input input-mono" />
      </Field>
      <Checkbox checked={adaptive} onChange={setAdaptive} label={t("Snippet adaptatif")} hint={t("Un programme du moteur adaptatif de Guiterm, résolu par hôte et par plateforme, plutôt qu'une commande littérale.")} />
      <Field label={t("Étiquettes")}>
        <TagsInput value={tags} onChange={setTags} />
      </Field>
    </FormShell>
  );
}
