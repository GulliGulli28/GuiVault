import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { PageContext } from "../App";
import { api, errorMessage } from "../lib/api";
import type { AdminOverview, AdminUserInfo, RegistrationInvite } from "../lib/types";
import { ConfirmDialog } from "./ConfirmDialog";
import { IconTrash } from "./ui-icons";
import { Eyebrow, Field, formatWhen, Loading, Modal, useDelayed } from "./ui";

const REGISTRATION_LABELS: Record<AdminOverview["registration"], string> = {
  open: "ouvertes à tous",
  invite_only: "sur invitation",
  closed: "fermées",
};

const MIB = 1024 * 1024;

/** Octets en unités binaires, à la française. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} o`;
  const units = ["Kio", "Mio", "Gio", "Tio"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toLocaleString("fr-FR", { maximumFractionDigits: v < 10 ? 1 : 0 })} ${units[i]}`;
}

/** L'administration du serveur : son état, les comptes (désactiver, quota,
 * supprimer) et les inscriptions ouvertes à une adresse. Des métadonnées
 * seulement — un administrateur n'a pas plus de clé que le serveur. */
export function AdminPage({ ctx }: { ctx: PageContext }) {
  const { session, error, notify } = ctx;
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [users, setUsers] = useState<AdminUserInfo[] | null>(null);
  const [registrations, setRegistrations] = useState<RegistrationInvite[] | null>(null);
  const [filter, setFilter] = useState("");
  const [quotaFor, setQuotaFor] = useState<AdminUserInfo | null>(null);
  const [disabling, setDisabling] = useState<AdminUserInfo | null>(null);
  const [deleting, setDeleting] = useState<AdminUserInfo | null>(null);
  const [denied, setDenied] = useState<string | null>(null);
  const slow = useDelayed(users === null && denied === null);

  const load = useCallback(() => {
    Promise.all([api.adminOverview(), api.adminUsers(), api.adminRegistrations()])
      .then(([o, u, r]) => { setOverview(o); setUsers(u); setRegistrations(r); })
      .catch((e) => setDenied(errorMessage(e)));
  }, []);
  useEffect(load, [load]);

  /** Une ligne mise à jour par une action, sans tout recharger. */
  const replace = useCallback((u: AdminUserInfo) => setUsers((list) => list?.map((x) => (x.id === u.id ? u : x)) ?? null), []);
  const act = useCallback(async (run: () => Promise<AdminUserInfo>, done: string) => {
    try {
      replace(await run());
      notify(done);
      api.adminOverview().then(setOverview).catch(() => {});
    } catch (e) {
      error(errorMessage(e));
    }
  }, [replace, notify, error]);

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (users ?? []).filter((u) => !f || u.email.includes(f));
  }, [users, filter]);

  const closeQuota = useCallback(() => setQuotaFor(null), []);
  const closeDelete = useCallback(() => setDeleting(null), []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-[var(--c-border)] px-4 py-2.5 max-md:pl-11">
        <h1 className="text-[14px] font-semibold text-[var(--c-text)]">Administration du serveur</h1>
      </header>
      <div className="sidebar-scroll min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
        <p className="help-text max-w-3xl">
          Vous voyez les comptes, leurs dates et la taille de ce qu'ils stockent — jamais leur contenu : un administrateur n'a pas plus de clé que le serveur.
          Le rôle se donne et se retire depuis le serveur lui-même : <code className="font-mono">guivault admin grant &lt;email&gt;</code>.
        </p>
        {denied ? (
          <p className="callout callout-danger max-w-3xl">{denied}</p>
        ) : users === null || overview === null ? (slow ? <Loading /> : null) : (
          <>
            <ServerSummary overview={overview} />
            <RegistrationsSection
              registrations={registrations ?? []}
              registration={overview.registration}
              onChange={() => { api.adminRegistrations().then(setRegistrations).catch(() => {}); api.adminOverview().then(setOverview).catch(() => {}); }}
              ctx={ctx}
            />
            <section className="max-w-3xl space-y-1.5">
              <div className="flex items-center gap-2">
                <Eyebrow>Comptes ({users.length})</Eyebrow>
                <input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filtrer par adresse"
                  aria-label="Filtrer les comptes par adresse"
                  className="input ml-auto h-7 max-w-[220px] text-[12px]"
                />
              </div>
              {shown.map((u) => {
                const self = u.id === session.user.id;
                const quota = u.effective_quota_bytes;
                return (
                  <div key={u.id} className="card flex min-w-0 flex-wrap items-center gap-2 p-2.5" data-testid="admin-user">
                    <div className="min-w-0 flex-1">
                      <p className="flex min-w-0 flex-wrap items-center gap-1.5 text-[12.5px] text-[var(--c-text)]">
                        <span className="truncate">{u.email}</span>
                        {self && <span className="tag shrink-0">vous</span>}
                        {u.is_admin && <span className="tag shrink-0">administrateur</span>}
                        {u.disabled_at && <span className="tag shrink-0 text-[var(--c-danger)]" title={`Depuis le ${formatWhen(u.disabled_at)}`}>désactivé</span>}
                        {u.totp_enabled && <span className="tag shrink-0" title="Second facteur activé">2FA</span>}
                      </p>
                      <p className="text-[11px] text-[var(--c-text-muted)]">
                        créé le {formatWhen(u.created_at)}
                        {` · ${u.last_seen_at ? `vu le ${formatWhen(u.last_seen_at)}` : "jamais vu"}`}
                        {` · ${u.active_sessions} session${u.active_sessions > 1 ? "s" : ""}`}
                        {` · ${u.vaults_owned} vault${u.vaults_owned > 1 ? "s" : ""}`}
                        {u.vaults_joined > 0 ? ` (+${u.vaults_joined} partagé${u.vaults_joined > 1 ? "s" : ""})` : ""}
                        {` · ${u.items} élément${u.items > 1 ? "s" : ""}`}
                      </p>
                      <p className="text-[11px] text-[var(--c-text-muted)]">
                        {formatBytes(u.storage_bytes)}
                        {quota > 0 ? ` sur ${formatBytes(quota)}` : " · sans quota"}
                        {u.quota_bytes !== null ? " (propre au compte)" : ""}
                      </p>
                      {quota > 0 && (
                        <div className="mt-1 h-1 max-w-[240px] overflow-hidden rounded-full bg-[var(--c-bg3)]" aria-hidden="true">
                          <div
                            className={`h-full ${u.storage_bytes >= quota * 0.9 ? "bg-[var(--c-danger)]" : "bg-[var(--c-accent)]"}`}
                            style={{ width: `${Math.min(100, (u.storage_bytes / quota) * 100)}%` }}
                          />
                        </div>
                      )}
                    </div>
                    <button onClick={() => setQuotaFor(u)} className="btn btn-ghost btn-sm" aria-label={`Quota de ${u.email}`}>Quota…</button>
                    {!self && !u.is_admin && (
                      <>
                        {u.disabled_at ? (
                          <button onClick={() => void act(() => api.adminEnable(u.id), `${u.email} peut de nouveau se connecter.`)} className="btn btn-secondary btn-sm" aria-label={`Réactiver ${u.email}`}>Réactiver</button>
                        ) : (
                          <button onClick={() => setDisabling(u)} className="btn btn-ghost btn-sm" aria-label={`Désactiver ${u.email}`}>Désactiver</button>
                        )}
                        <button onClick={() => setDeleting(u)} className="btn btn-ghost btn-sm btn-icon hover:text-[var(--c-danger)]" title="Supprimer le compte" aria-label={`Supprimer ${u.email}`}><IconTrash size={12} /></button>
                      </>
                    )}
                  </div>
                );
              })}
              {shown.length === 0 && <p className="text-[12.5px] text-[var(--c-text-muted)]">Aucun compte ne correspond.</p>}
            </section>
          </>
        )}
      </div>
      {quotaFor && (
        <QuotaDialog
          user={quotaFor}
          defaultQuota={overview?.default_quota_bytes ?? 0}
          onClose={closeQuota}
          onSave={async (q) => { setQuotaFor(null); await act(() => api.adminSetQuota(quotaFor.id, q), "Quota enregistré."); }}
        />
      )}
      {disabling && (
        <ConfirmDialog
          title={`Désactiver ${disabling.email} ?`}
          message="Ses sessions sont coupées et il ne peut plus se connecter. Rien n'est effacé : ses vaults restent, et les autres membres de ses vaults partagés continuent. Réversible."
          confirmLabel="Désactiver"
          danger
          onConfirm={() => { const u = disabling; setDisabling(null); void act(() => api.adminDisable(u.id), `${u.email} est désactivé.`); }}
          onCancel={() => setDisabling(null)}
        />
      )}
      {deleting && (
        <DeleteUserDialog
          user={deleting}
          onClose={closeDelete}
          onDeleted={() => { notify(`Compte ${deleting.email} supprimé.`); setDeleting(null); load(); }}
        />
      )}
    </div>
  );
}

function Stat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="card min-w-0 p-2.5">
      <p className="text-[11px] text-[var(--c-text-muted)]">{label}</p>
      <p className="truncate text-[15px] font-semibold text-[var(--c-text)]">{value}</p>
      {detail && <p className="truncate text-[11px] text-[var(--c-text-muted)]">{detail}</p>}
    </div>
  );
}

function ServerSummary({ overview: o }: { overview: AdminOverview }) {
  const ips = (list: string[]) => (list.length ? list.join(", ") : "toutes");
  return (
    <section className="max-w-3xl space-y-1.5">
      <Eyebrow>Serveur</Eyebrow>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Comptes" value={String(o.users)} detail={[o.disabled_users ? `${o.disabled_users} désactivé${o.disabled_users > 1 ? "s" : ""}` : "", `${o.admins} admin${o.admins > 1 ? "s" : ""}`].filter(Boolean).join(" · ")} />
        <Stat label="Vaults" value={String(o.vaults)} detail={`${o.shared_vaults} partagé${o.shared_vaults > 1 ? "s" : ""}`} />
        <Stat label="Éléments" value={String(o.items)} detail={formatBytes(o.storage_bytes)} />
        <Stat label="Sessions actives" value={String(o.active_sessions)} detail={`${o.sends} lien${o.sends > 1 ? "s" : ""} de partage`} />
      </div>
      <div className="card space-y-0.5 p-2.5 text-[12px] text-[var(--c-text-secondary)]">
        <p>Inscriptions : <span className="text-[var(--c-text)]">{REGISTRATION_LABELS[o.registration]}</span> <span className="text-[var(--c-text-muted)]">(GUIVAULT_REGISTRATION)</span></p>
        <p>Quota par défaut : <span className="text-[var(--c-text)]">{o.default_quota_bytes > 0 ? formatBytes(o.default_quota_bytes) : "aucun"}</span> <span className="text-[var(--c-text-muted)]">(GUIVAULT_QUOTA_MB)</span></p>
        <p>Adresses admises : <span className="text-[var(--c-text)]">{ips(o.allowed_ips)}</span> ; pour l'administration : <span className="text-[var(--c-text)]">{ips(o.admin_allowed_ips)}</span></p>
        <p className="text-[var(--c-text-muted)]">GuiVault {o.server_version}</p>
      </div>
    </section>
  );
}

const DAYS = [7, 14, 30, 90];

function RegistrationsSection({ registrations, registration, onChange, ctx }: {
  registrations: RegistrationInvite[];
  registration: AdminOverview["registration"];
  onChange: () => void;
  ctx: PageContext;
}) {
  const [email, setEmail] = useState("");
  const [days, setDays] = useState(14);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.adminOpenRegistration(email.trim(), days);
      ctx.notify(`${r.email} peut créer son compte jusqu'au ${formatWhen(r.expires_at)}.`);
      setEmail("");
      onChange();
    } catch (err) {
      ctx.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="max-w-3xl space-y-1.5">
      <Eyebrow>Inscriptions autorisées</Eyebrow>
      <p className="help-text">
        {registration === "open"
          ? "Les inscriptions sont ouvertes à tous : inutile d'autoriser une adresse."
          : "Autorisez une adresse à créer son compte malgré des inscriptions " + REGISTRATION_LABELS[registration] + ". Donnez-lui l'adresse de ce serveur : l'autorisation sert une fois."}
      </p>
      <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
        <Field label="Adresse e-mail" className="min-w-[220px] flex-1">
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="input" autoComplete="off" />
        </Field>
        <Field label="Valable">
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="input">
            {DAYS.map((d) => <option key={d} value={d}>{d} jours</option>)}
          </select>
        </Field>
        <button type="submit" disabled={busy || !email.trim()} className="btn btn-primary">Autoriser</button>
      </form>
      {registrations.map((r) => (
        <div key={r.email} className="card flex min-w-0 items-center gap-2 p-2.5">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[12.5px] text-[var(--c-text)]">{r.email}</p>
            <p className="text-[11px] text-[var(--c-text-muted)]">
              jusqu'au {formatWhen(r.expires_at)}{r.invited_by ? ` · par ${r.invited_by}` : ""}
            </p>
          </div>
          <button
            onClick={async () => {
              try { await api.adminCloseRegistration(r.email); onChange(); } catch (e) { ctx.error(errorMessage(e)); }
            }}
            className="btn btn-ghost btn-sm"
            aria-label={`Retirer l'autorisation de ${r.email}`}
          >
            Retirer
          </button>
        </div>
      ))}
    </section>
  );
}

function QuotaDialog({ user, defaultQuota, onClose, onSave }: {
  user: AdminUserInfo;
  defaultQuota: number;
  onClose: () => void;
  onSave: (quota: number | null) => Promise<void>;
}) {
  const initial = user.quota_bytes === null ? "server" : user.quota_bytes === 0 ? "none" : "custom";
  const [mode, setMode] = useState<"server" | "none" | "custom">(initial);
  const [mib, setMib] = useState(user.quota_bytes ? String(Math.round(user.quota_bytes / MIB)) : "100");
  const valid = mode !== "custom" || (Number.isInteger(Number(mib)) && Number(mib) > 0);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void onSave(mode === "server" ? null : mode === "none" ? 0 : Number(mib) * MIB);
  };
  return (
    <Modal title={`Quota de ${user.email}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <p className="help-text">
          Ce que le compte stocke dans les vaults qu'il possède — ceux qu'il partage compris, quel que soit le membre qui écrit. Actuellement {formatBytes(user.storage_bytes)}.
          Un quota dépassé bloque ce qui grossit, jamais ce qui allège.
        </p>
        <fieldset className="space-y-1.5 text-[12.5px]">
          <legend className="sr-only">Quota</legend>
          <label className="flex items-center gap-2">
            <input type="radio" name="quota" checked={mode === "server"} onChange={() => setMode("server")} />
            Celui du serveur ({defaultQuota > 0 ? formatBytes(defaultQuota) : "aucun"})
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="quota" checked={mode === "none"} onChange={() => setMode("none")} />
            Aucun quota
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="quota" checked={mode === "custom"} onChange={() => setMode("custom")} />
            Propre au compte
          </label>
        </fieldset>
        {mode === "custom" && (
          <Field label="Quota en Mio">
            <input type="number" min={1} step={1} value={mib} onChange={(e) => setMib(e.target.value)} className="input w-32" autoFocus />
          </Field>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn btn-ghost">Annuler</button>
          <button type="submit" disabled={!valid} className="btn btn-primary">Enregistrer</button>
        </div>
      </form>
    </Modal>
  );
}

function DeleteUserDialog({ user, onClose, onDeleted }: { user: AdminUserInfo; onClose: () => void; onDeleted: () => void }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.adminDeleteUser(user.id);
      onDeleted();
    } catch (e2) {
      setErr(errorMessage(e2));
      setBusy(false);
    }
  };
  return (
    <Modal title={`Supprimer ${user.email}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <p className="callout callout-danger">
          Irréversible. Son vault personnel et les vaults dont il est le seul membre sont effacés ; ses liens de partage et ses accès d'urgence aussi.
          Les vaults qu'il partage avec d'autres ne sont pas perdus : ils passent au membre le mieux placé (rôle le plus haut, puis le plus ancien).
        </p>
        {user.vaults_owned > 0 && <p className="help-text">{user.vaults_owned} vault{user.vaults_owned > 1 ? "s" : ""} possédé{user.vaults_owned > 1 ? "s" : ""}, {user.items} élément{user.items > 1 ? "s" : ""}.</p>}
        <div>
          <label htmlFor="admin-delete-confirm" className="field-label">Tapez son adresse pour confirmer</label>
          <input id="admin-delete-confirm" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={user.email} className="input" autoFocus />
        </div>
        {err && <p className="callout callout-danger">{err}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn btn-ghost">Annuler</button>
          <button type="submit" disabled={busy || typed.trim().toLowerCase() !== user.email.toLowerCase()} className="btn btn-danger">{busy ? "Suppression…" : "Supprimer définitivement"}</button>
        </div>
      </form>
    </Modal>
  );
}
