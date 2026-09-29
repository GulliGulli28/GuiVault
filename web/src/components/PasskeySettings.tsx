/** Paramètres › Sécurité › Passkeys : les passkeys qui ouvrent ce compte
 * sans mot de passe maître (`lib/accountPasskeys.ts`, `docs/PASSKEYS.md`).
 * Ajouter en redemande le mot de passe ; en retirer une la rend inutile. */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { PageContext } from "../App";
import { api, errorMessage } from "../lib/api";
import { passkeysSupported, registerPasskey } from "../lib/accountPasskeys";
import type { AccountPasskey } from "../lib/types";
import { ConfirmDialog } from "./ConfirmDialog";
import { IconPasskey } from "./secret-icons";
import { Eyebrow, formatWhen, Modal, PasswordInput } from "./ui";
import { IconPlus, IconTrash } from "./ui-icons";

export function PasskeySettings({ ctx }: { ctx: PageContext }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [list, setList] = useState<AccountPasskey[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<AccountPasskey | null>(null);
  const closeAdd = useCallback(() => setAdding(false), []);
  const cancelRemove = useCallback(() => setRemoving(null), []);
  const { error } = ctx;
  const load = useCallback(() => {
    api.passkeys().then(setList).catch((e) => error(errorMessage(e)));
  }, [error]);
  useEffect(() => {
    api.health().then((h) => {
      setEnabled(!!h.passkeys);
      if (h.passkeys) load();
    }).catch(() => setEnabled(false));
  }, [load]);

  if (enabled === null) return null;
  const supported = passkeysSupported();
  return (
    <section className="max-w-2xl space-y-1.5">
      <div className="flex items-center gap-2">
        <Eyebrow>Passkeys</Eyebrow>
        {enabled && supported && (
          <button onClick={() => setAdding(true)} className="btn btn-ghost btn-sm ml-auto"><IconPlus size={11} /> Ajouter une passkey</button>
        )}
      </div>
      <div className="card divide-y divide-[var(--c-border)]">
        <p className="help-text p-3">
          {!enabled
            ? "La connexion par passkey n'est pas configurée sur ce serveur (GUIVAULT_PUBLIC_URL)."
            : !supported
              ? "Ce navigateur ne sait pas utiliser de passkey (WebAuthn)."
              : "Se connecter sans taper le mot de passe maître, avec une passkey de votre système ou une clé de sécurité — son code ou votre empreinte tiennent lieu de mot de passe et de second facteur. Elle doit savoir dériver une clé (extension PRF) : c'est elle qui rouvre le coffre, le serveur n'en garde qu'une enveloppe qu'il ne sait pas ouvrir."}
        </p>
        {list?.map((p) => (
          <div key={p.id} className="flex items-center gap-2 p-3">
            <IconPasskey size={14} className="shrink-0 text-[var(--c-text-muted)]" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[12.5px] text-[var(--c-text)]">{p.name}</p>
              <p className="text-[11px] text-[var(--c-text-muted)]">
                ajoutée le {formatWhen(p.created_at)}{p.last_used_at ? ` · dernière connexion le ${formatWhen(p.last_used_at)}` : " · jamais utilisée"}
              </p>
            </div>
            <button onClick={() => setRemoving(p)} className="btn btn-ghost btn-sm btn-icon hover:text-[var(--c-danger)]" title="Retirer" aria-label={`Retirer ${p.name}`}><IconTrash size={12} /></button>
          </div>
        ))}
      </div>
      {adding && <AddPasskeyDialog ctx={ctx} onClose={closeAdd} onAdded={load} />}
      {removing && (
        <ConfirmDialog
          title={`Retirer « ${removing.name} » ?`}
          message="Elle n'ouvrira plus ce compte ; le serveur oublie son enveloppe. La passkey elle-même reste dans votre système ou sur la clé : supprimez-la là aussi si vous n'en voulez plus."
          confirmLabel="Retirer"
          danger
          onConfirm={async () => {
            const p = removing;
            setRemoving(null);
            try {
              await api.deletePasskey(p.id);
              ctx.notify(`« ${p.name} » retirée.`);
            } catch (e) {
              error(errorMessage(e));
            }
            load();
          }}
          onCancel={cancelRemove}
        />
      )}
    </section>
  );
}

function AddPasskeyDialog({ ctx, onClose, onAdded }: { ctx: PageContext; onClose: () => void; onAdded: () => void }) {
  const [name, setName] = useState(defaultName());
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const p = await registerPasskey(ctx.session, name, password);
      ctx.notify(`« ${p.name} » ajoutée : elle ouvre maintenant ce compte.`);
      onAdded();
      onClose();
    } catch (err) {
      setError(err instanceof DOMException && err.name === "NotAllowedError" ? "Création annulée, ou refusée par le navigateur." : err instanceof DOMException && err.name === "InvalidStateError" ? "Cette passkey est déjà enregistrée pour ce compte." : errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Ajouter une passkey" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <label className="block"><span className="field-label">Nom</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} className="input" /></label>
        <div>
          <label htmlFor="passkey-password" className="field-label">Mot de passe maître</label>
          <PasswordInput id="passkey-password" value={password} onChange={setPassword} autoFocus autoComplete="current-password" />
          <p className="help-text mt-1">Redemandé : une session ouverte ne suffit pas à ajouter une façon d'entrer.</p>
        </div>
        {error && <p className="callout callout-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn btn-ghost">Annuler</button>
          <button type="submit" disabled={busy || !password || !name.trim()} className="btn btn-primary">{busy ? "Passkey…" : "Continuer"}</button>
        </div>
      </form>
    </Modal>
  );
}

function defaultName(): string {
  const ua = navigator.userAgent;
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "Mac" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iPhone" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `Passkey ${os}` : "Passkey";
}
