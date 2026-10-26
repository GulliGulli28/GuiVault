/** Paramètres › Sécurité › Passkeys : les passkeys qui ouvrent ce compte
 * sans mot de passe maître (`lib/accountPasskeys.ts`, `docs/PASSKEYS.md`).
 * Ajouter en redemande le mot de passe ; en retirer une la rend inutile. */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { PageContext } from "../App";
import { api, errorMessage } from "../lib/api";
import { passkeysSupported, registerPasskey, registerSecurityKey } from "../lib/accountPasskeys";
import type { AccountPasskey } from "../lib/types";
import { ConfirmDialog } from "./ConfirmDialog";
import { IconPasskey } from "./secret-icons";
import { formatAgo, formatWhen, InfoTip, Modal, PasswordInput, SettingRow } from "./ui";
import { IconPlus } from "./ui-icons";
import { t } from "../lib/i18n";

/** `totp` : la double authentification par code est active (tenu par
 * `SettingsPage`, qui le relit quand on l'active ou la désactive) — une clé
 * de sécurité ne s'ajoute qu'à côté d'elle. */
export function PasskeySettings({ ctx, totp }: { ctx: PageContext; totp: boolean }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [list, setList] = useState<AccountPasskey[] | null>(null);
  const [adding, setAdding] = useState<null | "passkey" | "key">(null);
  const [removing, setRemoving] = useState<AccountPasskey | null>(null);
  const closeAdd = useCallback(() => setAdding(null), []);
  const cancelRemove = useCallback(() => setRemoving(null), []);
  const { error } = ctx;
  const load = useCallback(() => {
    api.passkeys().then(setList).catch((e) => error(errorMessage(e)));
  }, [error]);
  // Désactiver le TOTP retire les clés de sécurité (côté serveur) : la liste
  // se relit.
  useEffect(() => {
    if (enabled) load();
  }, [totp, enabled, load]);
  useEffect(() => {
    api.health().then((h) => {
      setEnabled(!!h.passkeys);
      if (h.passkeys) load();
    }).catch(() => setEnabled(false));
  }, [load]);

  if (enabled === null) return null;
  const supported = passkeysSupported();
  return (
    <section className="flex flex-col gap-2.5">
      <h2 className="eyebrow">{t("Passkeys")}</h2>
      <div className="card">
        <SettingRow
          title={<>{t("Se connecter avec une passkey")} <InfoTip label={t("Comment ça marche")} items={[
            { text: t("Son code ou votre empreinte remplacent mot de passe et second facteur."), tone: "ok" },
            { text: t("Elle rouvre le coffre elle-même (extension PRF) : le serveur n'en garde qu'une enveloppe fermée."), tone: "ok" },
          ]} /></>}
          desc={!enabled ? t("Non configurée sur ce serveur (GUIVAULT_PUBLIC_URL).") : !supported ? t("Ce navigateur ne gère pas les passkeys.") : t("Sans taper le mot de passe maître.")}
        >
          {enabled && supported && <button onClick={() => setAdding("passkey")} className="btn btn-secondary"><IconPlus size={14} /> {t("Ajouter")}</button>}
        </SettingRow>
        {enabled && supported && (
          <SettingRow
            title={<>{t("Clé de sécurité en second facteur")} <InfoTip label={t("Ce que fait une clé de sécurité")} items={[
              { text: t("Après le mot de passe maître, elle remplace le code TOTP.") },
              { text: t("Le code reste le recours si la clé se perd : il doit être actif."), tone: "ok" },
              { text: t("Elle n'ouvre pas le coffre seule."), tone: "ok" },
            ]} /></>}
            desc={totp ? t("YubiKey, Titan, ou celle de votre système.") : t("Activez d'abord la double authentification par code.")}
          >
            <button onClick={() => setAdding("key")} disabled={!totp} className="btn btn-secondary"><IconPlus size={14} /> {t("Ajouter")}</button>
          </SettingRow>
        )}
        {list?.map((p) => (
          <div key={p.id} className="setting-row">
            <span className="tile tile-neutral" style={{ "--tile-size": "34px" } as React.CSSProperties}><IconPasskey size={16} /></span>
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{p.name}</p>
              <p className="truncate text-[12.5px] text-[var(--c-text-muted)]">
                {p.login === false ? t("Second facteur · ") : ""}{t("Ajoutée le")} {formatWhen(p.created_at)}{p.last_used_at ? t(" · utilisée {0}", formatAgo(p.last_used_at)) : t(" · jamais utilisée")}
              </p>
            </div>
            <button onClick={() => setRemoving(p)} className="btn btn-ghost" aria-label={t("Retirer {0}", p.name)}>{t("Retirer")}</button>
          </div>
        ))}
      </div>
      {adding && <AddPasskeyDialog ctx={ctx} securityKey={adding === "key"} onClose={closeAdd} onAdded={load} />}
      {removing && (
        <ConfirmDialog
          title={t("Retirer « {0} » ?", removing.name)}
          message={t("Elle n'ouvrira plus ce compte ; le serveur oublie son enveloppe. La passkey elle-même reste dans votre système ou sur la clé : supprimez-la là aussi si vous n'en voulez plus.")}
          confirmLabel={t("Retirer")}
          danger
          onConfirm={async () => {
            const p = removing;
            setRemoving(null);
            try {
              await api.deletePasskey(p.id);
              ctx.notify(t("« {0} » retirée.", p.name));
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

function AddPasskeyDialog({ ctx, securityKey, onClose, onAdded }: { ctx: PageContext; securityKey: boolean; onClose: () => void; onAdded: () => void }) {
  const [name, setName] = useState(securityKey ? t("Clé de sécurité") : defaultName());
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const p = securityKey ? await registerSecurityKey(ctx.session, name, password) : await registerPasskey(ctx.session, name, password);
      ctx.notify(securityKey ? t("« {0} » ajoutée : elle remplace le code au second facteur.", p.name) : t("« {0} » ajoutée : elle ouvre maintenant ce compte.", p.name));
      onAdded();
      onClose();
    } catch (err) {
      setError(err instanceof DOMException && err.name === "NotAllowedError" ? t("Création annulée, ou refusée par le navigateur.") : err instanceof DOMException && err.name === "InvalidStateError" ? t("Cette passkey est déjà enregistrée pour ce compte.") : errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={securityKey ? t("Ajouter une clé de sécurité") : t("Ajouter une passkey")} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <label className="block"><span className="field-label">{t("Nom")}</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} className="input" /></label>
        <div>
          <label htmlFor="passkey-password" className="field-label">{t("Mot de passe maître")}</label>
          <PasswordInput id="passkey-password" value={password} onChange={setPassword} autoFocus autoComplete="current-password" />
          <p className="help-text mt-1">{t("Redemandé : une session ouverte ne suffit pas à ajouter une façon d'entrer.")}</p>
        </div>
        {error && <p className="callout callout-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn btn-ghost">{t("Annuler")}</button>
          <button type="submit" disabled={busy || !password || !name.trim()} className="btn btn-primary">{busy ? (securityKey ? t("Clé…") : t("Passkey…")) : t("Continuer")}</button>
        </div>
      </form>
    </Modal>
  );
}

function defaultName(): string {
  const ua = navigator.userAgent;
  const os = /Windows/.test(ua) ? t("Windows") : /Mac OS/.test(ua) ? t("Mac") : /Android/.test(ua) ? t("Android") : /iPhone|iPad/.test(ua) ? "iPhone" : /Linux/.test(ua) ? t("Linux") : "";
  return os ? t("Passkey {0}", os) : t("Passkey");
}
