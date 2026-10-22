import { useCallback, useEffect, useState, type ComponentType, type FormEvent } from "react";
import type { PageContext } from "../App";
import { api, ApiError, errorMessage, supports } from "../lib/api";
import { coffreName } from "../lib/localHost";
import { navigate, routeHash, type SettingsSection } from "../lib/route";
import { LOCK_CHOICES, loadLockMinutes, saveLockMinutes } from "../lib/persist";
import { CLEAR_CHOICES, loadClearSeconds, saveClearSeconds } from "../lib/clipboard";
import { OfflineSetting } from "./OfflineSetting";
import { changePassword, deleteAccount, wipe } from "../lib/session";
import { clearWebSession } from "../lib/persist";
import { disableOffline } from "../lib/offline";
import { forgetKdf } from "../lib/kdfPins";
import { forgetRevisions } from "../lib/vaultRevisions";
import { forgetCounters } from "../lib/manifestCounters";
import type { AuditEntry, Session } from "../lib/types";
import { AppearanceSettings, SettingsSyncToggle } from "./AppearanceSettings";
import { PasskeySettings } from "./PasskeySettings";
import { ConfirmDialog } from "./ConfirmDialog";
import { AuditList } from "./VaultSettings";
import { IconIdentity, IconLifebuoy } from "./secret-icons";
import { EmergencySettings } from "./EmergencySettings";
import { AutoTypeSettings } from "./AutoType";
import { AppSettings } from "./AppSettings";
import { LocalBackups } from "./LocalBackups";
import { autoTypeBridge, backupBridge, coffreBridge, systemBridge } from "../lib/platform";
import { TransferDialog } from "./TransferDialog";
import { IconChevronRight, IconKeyboard, IconMonitor, IconPalette, IconSettings, IconShield } from "./ui-icons";
import { CopyButton, Fingerprint, formatAgo, formatWhen, InfoTip, Modal, PasswordInput, SettingRow } from "./ui";

/** Les catégories, avec leur nom — la colonne de gauche du panneau
 * « Paramètres » de Guiterm. */
const CATEGORIES: { key: SettingsSection; label: string; Icon: ComponentType<{ size?: number; className?: string }> }[] = [
  { key: "apparence", label: "Apparence", Icon: IconPalette },
  { key: "compte", label: "Compte", Icon: IconIdentity },
  { key: "securite", label: "Sécurité", Icon: IconShield },
  { key: "saisie", label: "Saisie automatique", Icon: IconKeyboard },
  { key: "application", label: "Application", Icon: IconSettings },
  { key: "urgence", label: "Accès d'urgence", Icon: IconLifebuoy },
  { key: "sessions", label: "Appareils et sessions", Icon: IconMonitor },
];

/** Une ligne sous le titre de chaque catégorie. */
const SUBTITLES: Record<SettingsSection, string> = {
  apparence: "Thème, couleur d'accent, police et densité.",
  compte: "Votre identité et ce qui touche au compte entier.",
  securite: "Comment vous vous connectez, et quand GuiVault se verrouille.",
  saisie: "Taper un identifiant dans une autre application.",
  application: "Ce que l'application fait sur ce poste.",
  urgence: "Qui peut demander l'accès à vos vaults, et après quel délai.",
  sessions: "Les appareils connectés à ce compte.",
};

/** Les paramètres : l'apparence (la même page que dans Guiterm), le compte
 * — empreinte à faire vérifier, mot de passe maître, second facteur —, les
 * sessions et le journal. */
/** Les catégories que ce transport et cette plateforme proposent. */
export function settingsCategories() {
  return CATEGORIES.filter((c) => (c.key !== "urgence" || supports("emergency")) && (c.key !== "sessions" || supports("sessions")) && (c.key !== "saisie" || !!autoTypeBridge()) && (c.key !== "application" || !!systemBridge()));
}

export function SettingsPage({ ctx, section }: { ctx: PageContext; section: SettingsSection }) {
  const { session } = ctx;
  const [sessions, setSessions] = useState<Session[]>([]);
  const [totp, setTotp] = useState<boolean | null>(null);
  const [audit, setAudit] = useState<AuditEntry[] | null>(null);
  const [dialog, setDialog] = useState<null | "password" | "totp-setup" | "totp-disable" | "delete-account" | "transfer">(null);
  const [revoke, setRevoke] = useState<Session | null>(null);
  const closeDialog = useCallback(() => setDialog(null), []);
  const [lockMinutes, setLockMinutes] = useState(loadLockMinutes);

  // Un coffre local (l'app) n'a ni sessions, ni second facteur, ni accès
  // d'urgence : on ne les demande pas, et leurs pages n'apparaissent pas.
  const reload = () => {
    if (supports("sessions")) api.sessions().then(setSessions).catch((e) => ctx.error(errorMessage(e)));
    if (supports("totpStatus")) api.totpStatus().then((s) => setTotp(s.enabled)).catch(() => setTotp(null));
  };
  // Chargement initial seulement ; `ctx` change à chaque notification.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(reload, []);

  const categories = settingsCategories();
  const current = categories.find((c) => c.key === section) ?? categories[0];
  const local = session.local;
  const who = local ? coffreName(local.path) : session.user.email;

  return (
    <div className="flex h-full min-h-0 max-md:flex-col">
      {/* Les catégories : une colonne à gauche, une rangée au-dessus quand
          la fenêtre est étroite. */}
      <nav aria-label="Catégories" className="flex shrink-0 gap-0.5 border-[var(--c-border)] bg-[var(--c-bg)] px-3 py-5 max-md:hidden md:w-[232px] md:flex-col md:border-r">
        <p className="px-2.5 pb-3 text-[18px] font-semibold tracking-[-0.015em] max-md:hidden">Paramètres</p>
        {categories.map((c) => {
          const active = current.key === c.key;
          return (
            <a
              key={c.key}
              href={routeHash({ page: "settings", section: c.key })}
              onClick={(e) => { e.preventDefault(); navigate({ page: "settings", section: c.key }); }}
              data-active={active ? "true" : undefined}
              aria-current={active ? "page" : undefined}
              className="nav-item shrink-0"
            >
              <c.Icon size={15} />
              <span className="truncate">{c.label}</span>
            </a>
          );
        })}
      </nav>

      <div className="sidebar-scroll min-w-0 flex-1 overflow-y-auto">
        <div className="flex max-w-[780px] flex-col gap-8 px-12 pb-14 pt-10 max-md:gap-6 max-md:px-4 max-md:pt-[calc(1rem+env(safe-area-inset-top))]">
          <header>
            {/* Mobile : les catégories sont dans l'onglet « Réglages ». */}
            <button onClick={() => navigate({ page: "more" })} className="-ml-1 mb-2 flex min-h-[36px] items-center gap-1 text-[15px] text-[var(--c-accent-text)] md:hidden">
              <IconChevronRight size={16} className="rotate-180" /> Réglages
            </button>
            <h1 className="page-title">{current.label}</h1>
            <p className="page-sub">{SUBTITLES[current.key]}</p>
          </header>

          {current.key === "apparence" && (
            <>
              <SettingsSyncToggle />
              <AppearanceSettings />
            </>
          )}

          {current.key === "compte" && (
            <>
              <section className="flex flex-col gap-2.5">
                <h2 className="eyebrow">Identité</h2>
                <div className="card">
                  <SettingRow title={<span className="truncate">{local ? `Coffre local « ${who} »` : who}</span>} desc={`${local ? "Créé" : "Compte créé"} le ${formatWhen(session.user.created_at)}`} />
                  {local && <SettingRow title="Dossier" desc={<span className="break-all font-mono text-[12.5px]">{local.path}</span>} />}
                  {supports("members") && (
                    <SettingRow
                      title={<>Votre empreinte <InfoTip label="À quoi sert l'empreinte" items={[
                        { text: "Donnez-la par un autre canal à qui partage un vault avec vous." },
                        { text: "Elle lui prouve que la clé montrée par le serveur est bien la vôtre.", tone: "ok" },
                      ]} /></>}
                      desc={<span className="mt-1 block"><Fingerprint value={session.fingerprint} /></span>}
                    />
                  )}
                </div>
              </section>
              {local && backupBridge() && (
                <section className="flex flex-col gap-2.5">
                  <h2 className="eyebrow">Sauvegardes</h2>
                  <LocalBackups path={local.path} onError={ctx.error} onRestored={(dest) => ctx.notify(`Copie créée : ${dest}. Elle est dans les coffres récents — fermez ce coffre pour l'ouvrir.`)} />
                </section>
              )}
              {!session.offline && coffreBridge() && (
                <section className="flex flex-col gap-2.5">
                  <h2 className="eyebrow">Copie</h2>
                  <div className="card">
                    <SettingRow
                      title={<>{local ? "Copier vers un serveur" : "Copier dans un coffre local"} <InfoTip label="Ce que fait la copie" items={[
                        { text: `Une copie : ${local ? "ce coffre" : "ce compte"} reste tel quel.`, tone: "ok" },
                        { text: "Historique, corbeille et pièces jointes suivent.", tone: "ok" },
                        { text: "Interrompue, elle reprend où elle en était." },
                      ]} /></>}
                      desc={local ? "Créer un compte avec ce coffre, ou le copier dans un compte existant." : "Copier ce compte dans un nouveau coffre local, ou un coffre existant."}
                    >
                      <button onClick={() => setDialog("transfer")} className="btn btn-secondary">Copier…</button>
                    </SettingRow>
                  </div>
                </section>
              )}
              {!session.offline && supports("deleteAccount") && (
                <section className="flex flex-col gap-2.5">
                  <h2 className="eyebrow">Zone sensible</h2>
                  <div className="card">
                    <SettingRow title="Supprimer le compte" desc="Efface le compte et ce qui n'appartient qu'à lui. Irréversible.">
                      <button onClick={() => setDialog("delete-account")} className="btn btn-danger">Supprimer…</button>
                    </SettingRow>
                  </div>
                </section>
              )}
            </>
          )}

          {current.key === "securite" && (
            <>
              <section className="flex flex-col gap-2.5">
                <h2 className="eyebrow">Connexion</h2>
                <div className="card">
                  <SettingRow title="Mot de passe maître" desc={local ? "Personne ne peut le réinitialiser." : "Personne ne peut le réinitialiser. Vos autres sessions seront révoquées."}>
                    <button onClick={() => setDialog("password")} className="btn btn-secondary">Changer</button>
                  </SettingRow>
                  {supports("totpStatus") && (
                    <SettingRow title={<>Double authentification {totp !== null && <span className={`tag ${totp ? "tag-ok" : ""}`}>{totp ? "Activée" : "Désactivée"}</span>}</>} desc="Un code à 6 chiffres en plus du mot de passe.">
                      {totp === false && <button onClick={() => setDialog("totp-setup")} className="btn btn-primary">Activer</button>}
                      {totp === true && <button onClick={() => setDialog("totp-disable")} className="btn btn-danger">Désactiver</button>}
                    </SettingRow>
                  )}
                </div>
              </section>
              {supports("passkeys") && <PasskeySettings ctx={ctx} />}
              <section className="flex flex-col gap-2.5">
                <h2 className="eyebrow">Verrouillage</h2>
                <div className="card">
                  <SettingRow htmlFor="lock-minutes" title="Verrouiller après" desc="Sans activité de votre part. Le même réglage que l'extension.">
                    <select id="lock-minutes" value={lockMinutes} onChange={(e) => { const n = Number(e.target.value); setLockMinutes(n); saveLockMinutes(n); }} className="input w-auto max-w-[16rem]">
                      {LOCK_CHOICES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                    </select>
                  </SettingRow>
                  <ClipboardSetting />
                </div>
              </section>
              {!local && (
                <section className="flex flex-col gap-2.5">
                  <h2 className="eyebrow">Cet appareil</h2>
                  <div className="card">
                    <OfflineSetting session={session} notify={ctx.notify} error={ctx.error} />
                  </div>
                </section>
              )}
            </>
          )}

          {current.key === "saisie" && <AutoTypeSettings notify={ctx.notify} />}

          {current.key === "application" && <AppSettings error={ctx.error} />}

          {current.key === "urgence" && <EmergencySettings ctx={ctx} />}

          {current.key === "sessions" && (
            <>
              <section className="flex flex-col gap-2.5">
                <h2 className="eyebrow">Appareils connectés</h2>
                <div className="card divide-y divide-[var(--c-border)]">
                  {sessions.map((s) => (
                    <div key={s.id} className="flex min-w-0 items-center gap-3 px-5 py-3.5">
                      <span className="tile tile-neutral" style={{ "--tile-size": "34px" } as React.CSSProperties}><IconMonitor size={16} /></span>
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 items-center gap-1.5"><span className="truncate font-medium">{s.device_name ?? "Appareil inconnu"}</span>{s.current && <span className="tag tag-accent shrink-0">Celui-ci</span>}</span>
                        <span className="block truncate text-[12.5px] text-[var(--c-text-muted)]">Vu {formatAgo(s.last_used_at)} · ouvert le {formatWhen(s.created_at)}</span>
                      </span>
                      {!s.current && <button onClick={() => setRevoke(s)} className="btn btn-ghost">Révoquer</button>}
                    </div>
                  ))}
                </div>
              </section>
              <section className="flex flex-col gap-2.5">
                <h2 className="eyebrow">Journal</h2>
                <div className="card">
                  <SettingRow title="Vos actions" desc="Connexions, modifications de vaults, invitations.">
                    <button onClick={() => { if (audit === null) api.myAudit().then(setAudit).catch((e) => ctx.error(errorMessage(e))); else setAudit(null); }} className="btn btn-secondary">{audit === null ? "Afficher" : "Masquer"}</button>
                  </SettingRow>
                </div>
                {audit && <AuditList entries={audit} />}
              </section>
            </>
          )}
        </div>
      </div>

      {dialog === "password" && <PasswordDialog ctx={ctx} onClose={() => setDialog(null)} />}
      {dialog === "transfer" && <TransferDialog ctx={ctx} onClose={closeDialog} />}
      {dialog === "delete-account" && <DeleteAccountDialog ctx={ctx} totp={totp === true} onClose={() => setDialog(null)} />}
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

/** Supprimer le compte : le mot de passe maître (et le code du second
 * facteur), l'adresse retapée. Refusé tant qu'un vault partagé avec d'autres
 * perdrait son propriétaire — ces vaults sont nommés, avec un lien vers leurs
 * réglages. Fait : plus rien de ce compte sur cet appareil non plus. */
function DeleteAccountDialog({ ctx, totp, onClose }: { ctx: PageContext; totp: boolean; onClose: () => void }) {
  const { session } = ctx;
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blocking, setBlocking] = useState<{ id: string; name: string }[] | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setBlocking(null);
    const { email } = session.user;
    const userId = session.user.id;
    try {
      await deleteAccount(session, password, totp ? code : undefined);
    } catch (err) {
      if (err instanceof ApiError && err.code === "owns_shared_vaults") {
        const ids = (err.extra.vaults as string[] | undefined) ?? [];
        setBlocking(ids.map((id) => ({ id, name: session.vaults.find((v) => v.id === id)?.name ?? id.slice(0, 8) })));
      } else {
        setError(errorMessage(err));
      }
      setBusy(false);
      return;
    }
    // Plus rien du compte sur cet appareil : copie hors ligne, paramètres
    // épinglés, révisions vues, session.
    await disableOffline(email).catch(() => {});
    forgetKdf(email);
    forgetRevisions(userId);
    forgetCounters(session.vaults.map((v) => v.id));
    clearWebSession();
    wipe(session);
    window.location.hash = "#/";
    window.location.reload();
  };
  return (
    <Modal title="Supprimer le compte" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <p className="callout callout-danger">
          Irréversible. Votre vault personnel et les vaults partagés dont vous êtes le seul membre sont effacés, avec leur historique ; vos liens de partage cessent de s'ouvrir ; vos contacts d'urgence et ceux qui vous avaient désigné perdent ces accès. Les éléments que vous avez mis dans les vaults des autres y restent.
        </p>
        {blocking && (
          <div className="callout callout-warn space-y-1 text-[12.5px]">
            <p>Ces vaults partagés perdraient leur propriétaire : transférez-en la propriété à un autre membre, ou supprimez-les, d'abord.</p>
            <ul className="list-disc pl-5">
              {blocking.map((v) => (
                <li key={v.id}>
                  <a href={routeHash({ page: "vault-settings", id: v.id })} onClick={onClose} className="underline">{v.name}</a>
                </li>
              ))}
            </ul>
          </div>
        )}
        <label className="block"><span className="field-label">Mot de passe maître</span><PasswordInput value={password} onChange={setPassword} autoFocus autoComplete="current-password" /></label>
        {totp && (
          <label className="block"><span className="field-label">Code du second facteur</span><input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" className="input input-mono" /></label>
        )}
        <div>
          <label htmlFor="delete-confirm" className="field-label">Tapez votre adresse pour confirmer</label>
          <input id="delete-confirm" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={session.user.email} className="input" />
        </div>
        {error && <p className="callout callout-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn btn-ghost">Annuler</button>
          <button type="submit" disabled={busy || !password || (totp && !code.trim()) || typed.trim().toLowerCase() !== session.user.email.toLowerCase()} className="btn btn-danger">{busy ? "Suppression…" : "Supprimer définitivement"}</button>
        </div>
      </form>
    </Modal>
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
      ctx.notify(ctx.session.local ? "Mot de passe maître changé." : "Mot de passe maître changé. Vos autres sessions ont été révoquées.");
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

/** Le délai d'effacement du presse-papiers (`lib/clipboard.ts`), et de quoi
 * permettre à la page de vérifier ce qu'il contient : sans cette permission,
 * elle n'efface que si on ne l'a pas quittée depuis la copie. */
function ClipboardSetting() {
  const [seconds, setSeconds] = useState(loadClearSeconds);
  const [read, setRead] = useState<PermissionState | "unsupported" | null>(null);
  const query = useCallback(() => {
    navigator.permissions
      .query({ name: "clipboard-read" as PermissionName })
      .then((p) => setRead(p.state))
      .catch(() => setRead("unsupported"));
  }, []);
  useEffect(query, [query]);
  const allow = () => {
    // Un geste de l'utilisateur : Chrome demande la permission une fois.
    navigator.clipboard.readText().catch(() => {}).finally(query);
  };
  return (
    <div className="setting-row">
      <div className="min-w-0 flex-[1_1_260px]">
        <div className="setting-title flex flex-wrap items-center gap-1.5">
          <label htmlFor="clipboard-clear">Vider le presse-papiers</label>
          {read !== "granted" && read !== null && (
            <InfoTip label="Sans permission de lecture" items={[
              { text: "Sans permission de lire le presse-papiers, il est vidé au premier clic dans GuiVault après le délai.", tone: "warn" },
              { text: "Seulement si vous n'avez pas quitté la page depuis la copie." },
              { text: "L'extension, elle, le vide même popup fermé." },
            ]} />
          )}
        </div>
        <div className="setting-desc">Seulement si la valeur copiée y est encore.</div>
      </div>
      {(read === "prompt" || read === "denied") && (
        <button onClick={allow} disabled={read === "denied"} className="btn btn-secondary" title={read === "denied" ? "Refusée : à rétablir dans les réglages du site du navigateur" : "Le navigateur demandera la permission"}>
          {read === "denied" ? "Lecture refusée" : "Autoriser la lecture"}
        </button>
      )}
      <select id="clipboard-clear" value={seconds} onChange={(e) => { const n = Number(e.target.value); setSeconds(n); saveClearSeconds(n); }} className="input w-auto">
        {CLEAR_CHOICES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
      </select>
    </div>
  );
}
