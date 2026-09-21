import { useState } from "react";
import type { VaultIndex } from "../../lib/entities";
import { emptyLogin } from "../../lib/items";
import { decodeQrImage } from "../../lib/qr";
import { parseTotp } from "../../lib/totp";
import type { Login, LoginUri, Payload, UriMatch } from "../../lib/types";
import { GeneratorPanel } from "../GeneratorPanel";
import { PasswordStrength } from "../PasswordStrength";
import { TotpCode } from "../TotpCode";
import { IconDice, IconPasskey } from "../secret-icons";
import { IconClose, IconPlus } from "../ui-icons";
import { FileButton, PasswordInput, formatWhen } from "../ui";
import { Field, FormShell } from "./common";
import { SecretFooter, SecretHeader } from "./SecretBits";

const MATCH_LABELS: Record<UriMatch, string> = { domain: "domaine", host: "hôte", startsWith: "commence par", exact: "exact", regex: "expression régulière", never: "jamais" };
const HISTORY_MAX = 10;

export function LoginForm({ initial, index, defaultGroupId, onSave, onCancel }: {
  initial?: Login;
  index: VaultIndex;
  defaultGroupId?: string | null;
  onSave: (p: Payload) => Promise<void>;
  onCancel: () => void;
}) {
  const [login, setLogin] = useState<Login>(initial ?? emptyLogin(defaultGroupId ?? null));
  const [showGenerator, setShowGenerator] = useState(false);
  const [qrError, setQrError] = useState<string | null>(null);
  const totp = login.totp ? parseTotp(login.totp) : null;

  const readQr = async (file: Blob | undefined) => {
    if (!file) return;
    setQrError(null);
    try {
      const text = await decodeQrImage(file);
      if (!text || !parseTotp(text)) setQrError("Pas de QR code TOTP lisible dans cette image.");
      else setLogin({ ...login, totp: text });
    } catch {
      setQrError("Image illisible.");
    }
  };

  const save = async () => {
    const out: Login = { ...login, name: login.name.trim(), username: login.username.trim(), uris: login.uris.filter((u) => u.uri.trim()).map((u) => ({ ...u, uri: u.uri.trim() })), totp: login.totp?.trim() || null };
    // Un mot de passe remplacé passe dans l'historique, borné aux dix
    // derniers — le format de Bitwarden, qu'on relit et réexporte.
    if (initial && initial.password && initial.password !== out.password) {
      out.passwordHistory = [{ password: initial.password, changedAt: new Date().toISOString() }, ...login.passwordHistory].slice(0, HISTORY_MAX);
    }
    await onSave({ kind: "login", login: out });
  };

  const setUri = (i: number, patch: Partial<LoginUri>) => setLogin({ ...login, uris: login.uris.map((u, j) => (j === i ? { ...u, ...patch } : u)) });

  return (
    <FormShell title={initial ? `Modifier « ${initial.name} »` : "Nouvel identifiant"} onSave={save} onCancel={onCancel} validate={() => (login.name.trim() ? login.totp && !totp ? "Le secret TOTP ne se lit pas (URI otpauth:// ou base32 attendu)." : null : "Le nom est obligatoire.")}>
      <SecretHeader value={login} onChange={setLogin} placeholder="GitHub, banque, Wi-Fi…" />
      <Field label="Utilisateur">
        <input value={login.username} onChange={(e) => setLogin({ ...login, username: e.target.value })} autoComplete="off" className="input input-mono" />
      </Field>
      <div>
        <div className="flex items-end gap-1.5">
          <Field label="Mot de passe" className="min-w-0 flex-1">
            <PasswordInput value={login.password} onChange={(password) => setLogin({ ...login, password })} autoComplete="new-password" />
          </Field>
          <button type="button" onClick={() => setShowGenerator((g) => !g)} aria-pressed={showGenerator} className={`btn btn-icon ${showGenerator ? "btn-toggled" : "btn-secondary"}`} title="Générer un mot de passe" aria-label="Générer un mot de passe"><IconDice size={14} /></button>
        </div>
        <PasswordStrength password={login.password} className="mt-1" />
        {showGenerator && (
          <div className="card mt-2 p-3">
            <GeneratorPanel compact onUse={(v) => { setLogin({ ...login, password: v }); setShowGenerator(false); }} />
          </div>
        )}
      </div>

      <Field group label="Sites (URI)" hint="Le premier sert de ligne secondaire dans la liste. Le mode de correspondance est celui que lira un remplissage automatique.">
        <div className="space-y-1">
          {login.uris.map((u, i) => (
            <div key={i} className="grid grid-cols-[1fr_auto_auto] items-center gap-1">
              <input value={u.uri} onChange={(e) => setUri(i, { uri: e.target.value })} placeholder="https://example.com" aria-label={`Site ${i + 1}`} className="input input-mono" />
              <select value={u.match ?? ""} onChange={(e) => setUri(i, { match: (e.target.value || null) as UriMatch | null })} aria-label={`Correspondance du site ${i + 1}`} className="input w-auto">
                <option value="">par défaut</option>
                {(Object.keys(MATCH_LABELS) as UriMatch[]).map((m) => <option key={m} value={m}>{MATCH_LABELS[m]}</option>)}
              </select>
              <button type="button" onClick={() => setLogin({ ...login, uris: login.uris.filter((_, j) => j !== i) })} aria-label="Retirer le site" className="btn btn-ghost btn-sm btn-icon hover:text-[var(--c-danger)]"><IconClose size={11} /></button>
            </div>
          ))}
          <button type="button" onClick={() => setLogin({ ...login, uris: [...login.uris, { uri: "", match: null }] })} className="btn btn-secondary btn-sm"><IconPlus size={11} /> Ajouter un site</button>
        </div>
      </Field>

      <Field label="Secret TOTP" hint="Collez l'URI otpauth:// (le texte du QR code), le secret base32, ou une image du QR code (fichier, ou Ctrl+V dans le champ). Le code courant s'affiche dès qu'il se lit.">
        <input
          value={login.totp ?? ""}
          onChange={(e) => setLogin({ ...login, totp: e.target.value || null })}
          onPaste={(e) => { const f = Array.from(e.clipboardData.files).find((x) => x.type.startsWith("image/")); if (f) { e.preventDefault(); void readQr(f); } }}
          placeholder="otpauth://totp/…?secret=…"
          autoComplete="off"
          spellCheck={false}
          className="input input-mono"
        />
        {totp && <div className="mt-1.5"><TotpCode secret={login.totp!} compact /></div>}
        <FileButton label="Image du QR code" accept="image/*" className="mt-1.5" onFile={(f) => void readQr(f)} />
        {qrError && <p className="help-text text-[var(--c-danger)]">{qrError}</p>}
      </Field>

      {login.passkeys.length > 0 && (
        <Field group label="Passkeys">
          <div className="space-y-1">
            {login.passkeys.map((k, i) => (
              <div key={k.credentialId} className="flex items-center gap-2 rounded-md border border-[var(--c-border)] px-2 py-1.5 text-[12px]">
                <IconPasskey size={13} className="shrink-0 text-[var(--c-text-muted)]" />
                <span className="min-w-0 flex-1 truncate text-[var(--c-text)]">{k.rpName || k.rpId}{k.userName ? ` — ${k.userName}` : ""} <span className="text-[var(--c-text-faint)]">· {formatWhen(k.createdAt)}</span></span>
                <button type="button" onClick={() => setLogin({ ...login, passkeys: login.passkeys.filter((_, j) => j !== i) })} aria-label="Retirer la passkey" className="btn btn-ghost btn-sm btn-icon hover:text-[var(--c-danger)]"><IconClose size={11} /></button>
              </div>
            ))}
          </div>
          <p className="help-text mt-1">Une passkey se crée depuis un authentificateur (Guiterm, extension), pas depuis cette page : ici on la garde ou on la retire.</p>
        </Field>
      )}

      <SecretFooter value={login} onChange={setLogin} groups={index.groups} />
    </FormShell>
  );
}
