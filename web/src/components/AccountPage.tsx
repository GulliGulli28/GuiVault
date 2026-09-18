import { useEffect, useState, type FormEvent } from "react";
import type { PageContext } from "../App";
import { api, errorMessage } from "../lib/api";
import { changePassword } from "../lib/session";
import { applyTheme, loadTheme, type ThemeChoice } from "../lib/theme";
import type { AuditEntry, Session } from "../lib/types";
import { ConfirmDialog } from "./ConfirmDialog";
import { AuditList } from "./VaultSettings";
import { IconTrash } from "./ui-icons";
import { CopyButton, Eyebrow, Fingerprint, formatWhen, Modal, PasswordInput } from "./ui";

/** Le compte : empreinte à faire vérifier, sessions, second facteur, mot de
 * passe maître, journal, thème. L'`AccountCard` de Guiterm, en page. */
export function AccountPage({ ctx, onLogout }: { ctx: PageContext; onLogout: () => void }) {
  const { session } = ctx;
  const [sessions, setSessions] = useState<Session[]>([]);
  const [totp, setTotp] = useState<boolean | null>(null);
  const [audit, setAudit] = useState<AuditEntry[] | null>(null);
  const [theme, setTheme] = useState<ThemeChoice>(loadTheme());
  const [dialog, setDialog] = useState<null | "password" | "totp-setup" | "totp-disable">(null);
  const [revoke, setRevoke] = useState<Session | null>(null);

  const reload = () => {
    api.sessions().then(setSessions).catch((e) => ctx.error(errorMessage(e)));
    api.totpStatus().then((s) => setTotp(s.enabled)).catch(() => setTotp(null));
  };
  // Chargement initial seulement ; `ctx` change à chaque notification.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(reload, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-[var(--c-border)] px-4 py-2.5 max-md:pl-28">
        <h1 className="text-[14px] font-semibold text-[var(--c-text)]">Compte</h1>
      </header>
      <div className="sidebar-scroll min-h-0 flex-1 space-y-6 overflow-y-auto p-4">
        <section className="max-w-2xl space-y-1.5">
          <Eyebrow>Identité</Eyebrow>
          <p className="text-[13px] text-[var(--c-text)]">{session.user.email} <span className="text-[11px] text-[var(--c-text-faint)]">· compte créé le {formatWhen(session.user.created_at)}</span></p>
          <div className="card space-y-1 p-3">
            <p className="text-[11.5px] font-medium text-[var(--c-text-secondary)]">Votre empreinte</p>
            <Fingerprint value={session.fingerprint} />
            <p className="help-text">Communiquez-la hors bande (de vive voix, messagerie interne) à qui veut partager un vault avec vous : c'est ce qui lui permet de vérifier que la clé publique que le serveur lui montre est bien la vôtre.</p>
          </div>
        </section>

        <section className="max-w-2xl space-y-1.5">
          <Eyebrow>Sécurité</Eyebrow>
          <div className="card divide-y divide-[var(--c-border)]">
            <div className="flex flex-wrap items-center gap-2 p-3">
              <div className="min-w-0 flex-1">
                <p className="text-[12.5px] text-[var(--c-text)]">Mot de passe maître</p>
                <p className="help-text">Seule la clé de compte est ré-enveloppée ; vos autres sessions sont révoquées.</p>
              </div>
              <button onClick={() => setDialog("password")} className="btn btn-secondary btn-sm">Changer</button>
            </div>
            <div className="flex flex-wrap items-center gap-2 p-3">
              <div className="min-w-0 flex-1">
                <p className="text-[12.5px] text-[var(--c-text)]">Second facteur (TOTP) {totp === null ? "" : <span className={`tag ml-1 ${totp ? "tag-accent" : ""}`}>{totp ? "activé" : "désactivé"}</span>}</p>
                <p className="help-text">Un code de votre application d'authentification à chaque connexion, en plus du mot de passe.</p>
              </div>
              {totp === false && <button onClick={() => setDialog("totp-setup")} className="btn btn-secondary btn-sm">Activer</button>}
              {totp === true && <button onClick={() => setDialog("totp-disable")} className="btn btn-danger btn-sm">Désactiver</button>}
            </div>
          </div>
        </section>

        <section className="max-w-2xl space-y-1.5">
          <Eyebrow>Sessions</Eyebrow>
          <div className="space-y-1">
            {sessions.map((s) => (
              <div key={s.id} className="card flex items-center gap-2 p-2.5">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] text-[var(--c-text)]">{s.device_name ?? "appareil inconnu"}{s.current && <span className="tag ml-1.5">celle-ci</span>}</span>
                  <span className="block text-[11px] text-[var(--c-text-muted)]">vue le {formatWhen(s.last_used_at)} · ouverte le {formatWhen(s.created_at)}</span>
                </span>
                {!s.current && <button onClick={() => setRevoke(s)} className="btn btn-ghost btn-sm btn-icon hover:text-[var(--c-danger)]" title="Révoquer" aria-label="Révoquer"><IconTrash size={11} /></button>}
              </div>
            ))}
          </div>
        </section>

        <section className="max-w-2xl space-y-1.5">
          <Eyebrow>Apparence</Eyebrow>
          <div className="segmented">
            {(["dark", "light", "system"] as ThemeChoice[]).map((t) => (
              <button key={t} data-active={theme === t} onClick={() => { setTheme(t); applyTheme(t); }}>{t === "dark" ? "Sombre" : t === "light" ? "Clair" : "Système"}</button>
            ))}
          </div>
        </section>

        <section className="max-w-2xl space-y-1.5 border-t border-[var(--c-border)] pt-4">
          <div className="flex flex-wrap gap-1.5">
            <button onClick={() => { if (audit === null) api.myAudit().then(setAudit).catch((e) => ctx.error(errorMessage(e))); else setAudit(null); }} className="btn btn-ghost btn-sm">{audit === null ? "Journal de mes actions" : "Masquer le journal"}</button>
            <button onClick={onLogout} className="btn btn-secondary btn-sm">Se déconnecter</button>
          </div>
          {audit && <AuditList entries={audit} />}
        </section>
      </div>

      {dialog === "password" && <PasswordDialog ctx={ctx} onClose={() => setDialog(null)} />}
      {dialog === "totp-setup" && <TotpSetupDialog ctx={ctx} onClose={() => { setDialog(null); reload(); }} />}
      {dialog === "totp-disable" && <TotpDisableDialog ctx={ctx} onClose={() => { setDialog(null); reload(); }} />}
      {revoke && (
        <ConfirmDialog
          title={`Révoquer « ${revoke.device_name ?? "appareil inconnu"} » ?`}
          message="Cet appareil devra se reconnecter avec le mot de passe maître."
          confirmLabel="Révoquer"
          danger
          onConfirm={() => { const s = revoke; setRevoke(null); api.revokeSession(s.id).then(reload).catch((e) => ctx.error(errorMessage(e))); }}
          onCancel={() => setRevoke(null)}
        />
      )}
    </div>
  );
}

function PasswordDialog({ ctx, onClose }: { ctx: PageContext; onClose: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== confirm) { setError("Les deux saisies diffèrent."); return; }
    if (next.length < 12) { setError("Au moins 12 caractères."); return; }
    setBusy(true);
    setError(null);
    try {
      await changePassword(ctx.session, current, next);
      ctx.notify("Mot de passe maître changé. Vos autres sessions ont été révoquées.");
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Changer le mot de passe maître" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <label className="block"><span className="field-label">Mot de passe actuel</span><PasswordInput value={current} onChange={setCurrent} autoFocus autoComplete="current-password" /></label>
        <label className="block"><span className="field-label">Nouveau mot de passe</span><PasswordInput value={next} onChange={setNext} autoComplete="new-password" /></label>
        <label className="block"><span className="field-label">Confirmer</span><PasswordInput value={confirm} onChange={setConfirm} autoComplete="new-password" /></label>
        <p className="callout callout-warn">Irrécupérable s'il est perdu : le serveur ne le connaît pas.</p>
        {error && <p className="callout callout-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn btn-ghost">Annuler</button>
          <button type="submit" disabled={busy || !current || !next} className="btn btn-primary">{busy ? "Dérivation…" : "Changer"}</button>
        </div>
      </form>
    </Modal>
  );
}

function TotpSetupDialog({ ctx, onClose }: { ctx: PageContext; onClose: () => void }) {
  const [setup, setSetup] = useState<{ secret: string; otpauth_url: string } | null>(null);
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.totpSetup().then(setSetup).catch((e) => setError(errorMessage(e)));
  }, []);
  const enable = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.totpEnable(code.replace(/\s+/g, ""));
      setRecovery(r.recovery_codes);
      ctx.notify("Second facteur activé. Vos autres sessions ont été révoquées.");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Activer le second facteur" onClose={onClose}>
      {recovery ? (
        <div className="space-y-3">
          <p className="text-[12.5px] text-[var(--c-text)]">Codes de récupération — montrés une seule fois. Chacun ne sert qu'une fois et remplace un code TOTP si vous perdez votre application.</p>
          <div className="card relative grid grid-cols-2 gap-1 p-3 font-mono text-[12px]">
            {recovery.map((c) => <span key={c}>{c}</span>)}
            <CopyButton value={recovery.join("\n")} label="Copier les codes" className="absolute right-1 top-1" />
          </div>
          <div className="flex justify-end"><button onClick={onClose} className="btn btn-primary">J'ai noté ces codes</button></div>
        </div>
      ) : (
        <form onSubmit={enable} className="space-y-3">
          {setup && (
            <>
              <p className="text-[12.5px] text-[var(--c-text-secondary)]">Ajoutez ce compte dans votre application d'authentification, puis saisissez le code qu'elle affiche.</p>
              <div className="card space-y-1.5 p-3">
                <p className="text-[11.5px] font-medium text-[var(--c-text-secondary)]">Secret</p>
                <p className="flex items-center gap-1 break-all font-mono text-[12px] text-[var(--c-text)]">{setup.secret} <CopyButton value={setup.secret} label="Copier le secret" /></p>
                <a href={setup.otpauth_url} className="block truncate text-[11.5px] text-[var(--c-accent-text)]" title={setup.otpauth_url}>Ouvrir dans l'application (otpauth://)</a>
              </div>
              <input value={code} onChange={(e) => setCode(e.target.value)} autoFocus inputMode="numeric" autoComplete="one-time-code" placeholder="123 456" className="input input-mono text-center tracking-[0.2em]" />
            </>
          )}
          {error && <p className="callout callout-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="btn btn-ghost">Annuler</button>
            <button type="submit" disabled={busy || !setup || !code.trim()} className="btn btn-primary">Activer</button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function TotpDisableDialog({ ctx, onClose }: { ctx: PageContext; onClose: () => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.totpDisable(code.replace(/\s+/g, ""));
      ctx.notify("Second facteur désactivé.");
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Désactiver le second facteur" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <p className="text-[12.5px] text-[var(--c-text-secondary)]">Saisissez un code TOTP ou un code de récupération pour confirmer.</p>
        <input value={code} onChange={(e) => setCode(e.target.value)} autoFocus inputMode="numeric" autoComplete="one-time-code" className="input input-mono text-center tracking-[0.2em]" />
        {error && <p className="callout callout-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn btn-ghost">Annuler</button>
          <button type="submit" disabled={busy || !code.trim()} className="btn btn-danger">Désactiver</button>
        </div>
      </form>
    </Modal>
  );
}
