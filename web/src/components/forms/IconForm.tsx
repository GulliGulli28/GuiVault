import { useState } from "react";
import { uuid } from "../../lib/bytes";
import type { CustomIcon, Payload } from "../../lib/types";
import { FileButton } from "../ui";
import { Field, FormShell, useSeed } from "./common";
import { t } from "../../lib/i18n";

const MAX_BYTES = 64 * 1024;

export function IconForm({ initial, onSave, onCancel }: { initial?: CustomIcon; onSave: (p: Payload) => Promise<void>; onCancel: () => void }) {
  const seed = useSeed(initial, (p) => (p.kind === "icon" ? p.icon : undefined));
  const [name, setName] = useState(seed?.name ?? "");
  const [dataUrl, setDataUrl] = useState(seed?.dataUrl ?? "");

  const loadFile = (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setDataUrl("");
      return;
    }
    const r = new FileReader();
    r.onload = () => setDataUrl(String(r.result));
    r.readAsDataURL(file);
  };

  const save = async () => {
    const icon: CustomIcon = { id: seed?.id ?? uuid(), name: name.trim(), dataUrl };
    await onSave({ kind: "icon", icon });
  };

  return (
    <FormShell title={initial ? t("Modifier « {0} »", initial.name) : t("Nouvelle icône")} onSave={save} onCancel={onCancel} validate={() => (name.trim() ? dataUrl ? null : t("Choisissez une image (SVG ou PNG, 64 Ko max).") : t("Le nom est obligatoire."))}>
      <Field label={t("Nom")}>
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus className="input" />
      </Field>
      <Field group label={t("Image")} hint={t("SVG ou PNG, 64 Ko max.")}>
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-md border border-[var(--c-border)] bg-[var(--c-bg3)]">{dataUrl && <img src={dataUrl} alt="" className="h-7 w-7" />}</span>
          <FileButton label={t("Choisir une image")} accept="image/svg+xml,image/png,image/webp" onFile={loadFile} />
        </div>
      </Field>
    </FormShell>
  );
}
