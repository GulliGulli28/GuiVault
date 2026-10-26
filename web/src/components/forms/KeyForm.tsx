import { useState } from "react";
import { uuid } from "../../lib/bytes";
import type { Payload, PrivateKey } from "../../lib/types";
import { SshKeyGenerator } from "../GeneratorPanel";
import { IconDice } from "../secret-icons";
import { FileButton, PasswordInput } from "../ui";
import { Field, FormShell, useSeed } from "./common";
import { t } from "../../lib/i18n";

export function KeyForm({ initial, onSave, onCancel }: {
  initial?: { key: PrivateKey; content?: string | null; passphrase?: string | null };
  onSave: (p: Payload) => Promise<void>;
  onCancel: () => void;
}) {
  const seed = useSeed(initial, (p) => (p.kind === "key" ? p : undefined));
  const k = seed?.key;
  const [name, setName] = useState(k?.name ?? "");
  const [path, setPath] = useState(k?.path ?? "");
  const [content, setContent] = useState(seed?.content ?? "");
  const [passphrase, setPassphrase] = useState(seed?.passphrase ?? "");
  const [showGenerator, setShowGenerator] = useState(false);
  const [publicKey, setPublicKey] = useState<string | null>(null);

  const save = async () => {
    // `content` sur la clé elle-même reste vide : dans un item, le contenu
    // voyage à côté (même règle que `entity::collect` dans Guiterm).
    const key: PrivateKey = { ...k, id: k?.id ?? uuid(), name: name.trim(), path: path.trim(), content: null };
    delete key.content;
    await onSave({ kind: "key", key, content: content.trim() || null, passphrase: passphrase || null });
  };

  const loadFile = (file: File | undefined) => {
    if (!file) return;
    file.text().then(setContent).catch(() => {});
  };

  return (
    <FormShell title={initial ? t("Modifier « {0} »", initial.key.name) : t("Nouvelle clé")} onSave={save} onCancel={onCancel} validate={() => (name.trim() ? content.trim() || path.trim() ? null : t("Indiquez le contenu de la clé, ou au moins son chemin.") : t("Le nom est obligatoire."))}>
      <Field label={t("Nom")}>
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus className="input" />
      </Field>
      <div>
        <div className="flex items-end gap-1.5">
          <Field label={t("Contenu de la clé privée")} className="min-w-0 flex-1">
            <textarea value={content} onChange={(e) => { setContent(e.target.value); setPublicKey(null); }} rows={8} spellCheck={false} placeholder={t("-----BEGIN OPENSSH PRIVATE KEY-----")} className="input input-mono" />
          </Field>
          <button type="button" onClick={() => setShowGenerator((g) => !g)} aria-pressed={showGenerator} className={`btn btn-icon self-start mt-[18px] ${showGenerator ? "btn-toggled" : "btn-secondary"}`} title={t("Générer une paire de clés")} aria-label={t("Générer une paire de clés")}><IconDice size={14} /></button>
        </div>
        <p className="help-text mt-1">{t("Collé, chargé ou généré ici · chiffré dans le vault.")}</p>
        <FileButton label={t("Charger un fichier de clé")} className="mt-1.5" onFile={(f) => { loadFile(f); setPublicKey(null); }} />
        {showGenerator && (
          <div className="card mt-2 p-3">
            <SshKeyGenerator
              compact
              onUse={(k, o) => {
                setContent(k.privateKey);
                setPublicKey(k.publicKey.trim());
                setPassphrase("");
                if (!name.trim()) setName(o.comment.trim() || `${o.type}${o.type === "ed25519" ? "" : `-${o.bits}`}`);
                setShowGenerator(false);
              }}
            />
          </div>
        )}
        {publicKey && (
          <p className="callout mt-2 break-all font-mono text-[11px]">{t("Clé publique à déposer sur les serveurs :")} {publicKey}</p>
        )}
      </div>
      <Field label={t("Chemin (optionnel)")} hint={t("Sans contenu, la clé est lue à ce chemin.")}>
        <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="~/.ssh/id_ed25519" className="input input-mono" />
      </Field>
      <Field label={t("Passphrase (optionnelle)")}>
        <PasswordInput value={passphrase} onChange={setPassphrase} autoComplete="off" />
      </Field>
    </FormShell>
  );
}
