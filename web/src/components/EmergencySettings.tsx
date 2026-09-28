import { useCallback, useEffect, useReducer, useState, type FormEvent } from "react";
import type { PageContext } from "../App";
import { api, errorMessage } from "../lib/api";
import { fingerprintTrust } from "../lib/pins";
import { navigate } from "../lib/route";
import { emergencyEnvelopes, repairEmergencyKeys, type VaultView } from "../lib/session";
import type { EmergencyGrant, EmergencyStatus, UserLookupResponse } from "../lib/types";
import { ConfirmDialog } from "./ConfirmDialog";
import { IconTrash, IconVault } from "./ui-icons";
import { Eyebrow, Field, Fingerprint, formatWhen, TrustBadge } from "./ui";

const WAIT_CHOICES = [1, 2, 3, 7, 14, 30, 60, 90];
const days = (n: number) => `${n} jour${n > 1 ? "s" : ""}`;

const STATUS_LABELS: Record<EmergencyStatus, string> = {
  invited: "en attente d'acceptation",
  accepted: "accepté",
  requested: "accès demandé",
  granted: "accès ouvert",
};

type Act = (label: string, f: () => Promise<unknown>, done?: string) => Promise<void>;

/** Paramètres › Accès d'urgence : ceux qu'on a désignés (et ce qu'on leur
 * confie), ceux qui nous ont désigné. */
export function EmergencySettings({ ctx }: { ctx: PageContext }) {
  const { session } = ctx;
  const [busy, setBusy] = useState<string | null>(null);
  // Une empreinte épinglée ne change rien à la session : on redessine.
  const [, repaint] = useReducer((n: number) => n + 1, 0);

  const act: Act = useCallback(async (label, f, done) => {
    setBusy(label);
    try {
      await f();
      await ctx.reload();
      if (done) ctx.notify(done);
    } catch (e) {
      ctx.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }, [ctx]);

  // Une enveloppe à renouveler (clé d'un vault tournée depuis un autre
  // client) se refait d'ici, sans rien demander : c'est la même désignation.
  useEffect(() => {
    if (!session.emergency?.granted_by_me.some((g) => g.vaults.some((v) => !v.has_key))) return;
    repairEmergencyKeys(session)
      .then((n) => { if (n > 0) { ctx.notify("Clés d'urgence renouvelées après une rotation."); void ctx.reload(); } })
      .catch((e) => ctx.error(errorMessage(e)));
    // Au montage : `ctx` et `session` changent d'identité à chaque `/sync`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (session.offline) return <p className="callout max-w-2xl">Hors ligne : l'accès d'urgence se règle avec le serveur.</p>;
  const overview = session.emergency;
  if (!overview) return <p className="callout max-w-2xl">Ce serveur ne connaît pas encore l'accès d'urgence : il est d'une version plus ancienne que cette interface.</p>;
  const owned = session.vaults.filter((v) => v.role === "owner");

  return (
    <>
      <p className="help-text max-w-2xl">
        Un proche que vous désignez peut demander l'accès à certains de vos vaults ; il l'obtient, en lecture, si vous ne refusez pas avant la fin du délai.
        Les clés lui sont enveloppées ici, dans votre navigateur : le serveur les garde sans pouvoir les ouvrir, et ne les lui remet qu'au bout du délai.
        Sans alerte par e-mail sur ce serveur, une demande se voit à votre prochaine connexion : choisissez un délai en conséquence.
      </p>

      <section className="max-w-2xl space-y-1.5">
        <Eyebrow>Vos contacts d'urgence</Eyebrow>
        {overview.granted_by_me.length === 0 && <p className="text-[12.5px] text-[var(--c-text-muted)]">Personne pour l'instant.</p>}
        {overview.granted_by_me.map((g) => <GrantorCard key={g.id} g={g} owned={owned} act={act} busy={busy} onPinned={repaint} ctx={ctx} />)}
        <Designate ctx={ctx} owned={owned} act={act} busy={busy} onPinned={repaint} taken={overview.granted_by_me.map((g) => g.grantee.id)} />
      </section>

      <section className="max-w-2xl space-y-1.5">
        <Eyebrow>Vous êtes le contact d'urgence de</Eyebrow>
        {overview.granted_to_me.length === 0 && <p className="text-[12.5px] text-[var(--c-text-muted)]">Personne ne vous a désigné.</p>}
        {overview.granted_to_me.map((g) => <GranteeCard key={g.id} g={g} vaults={session.emergencyVaults.filter((v) => v.emergency?.grantId === g.id)} act={act} busy={busy} onPinned={repaint} />)}
      </section>
    </>
  );
}

function StatusTag({ status }: { status: EmergencyStatus }) {
  return <span className={`tag shrink-0 ${status === "requested" || status === "granted" ? "tag-accent" : ""}`}>{STATUS_LABELS[status]}</span>;
}

/** Un contact qu'on a désigné : son état, le délai, les vaults confiés. */
function GrantorCard({ g, owned, act, busy, onPinned, ctx }: { g: EmergencyGrant; owned: VaultView[]; act: Act; busy: string | null; onPinned: () => void; ctx: PageContext }) {
  const [editing, setEditing] = useState<Set<string> | null>(null);
  const [confirm, setConfirm] = useState<null | "remove" | "approve">(null);
  const pinned = fingerprintTrust(g.grantee.email, g.grantee.fingerprint).kind === "pinned";
  const covered = new Map(g.vaults.map((v) => [v.vault_id, v.has_key]));
  const nameOf = (id: string) => owned.find((v) => v.id === id)?.name ?? `vault ${id.slice(0, 8)}`;

  const saveVaults = () => {
    if (!editing) return;
    const ids = [...editing];
    void act("vaults", () => api.updateEmergency(g.id, { vaults: emergencyEnvelopes(ctx.session, g.grantee, ids) }), "Vaults confiés mis à jour.").then(() => setEditing(null));
  };

  return (
    <div className="card min-w-0 space-y-2 p-3">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-[var(--c-text)]" title={g.grantee.email}>{g.grantee.email}</span>
        <StatusTag status={g.status} />
        <button onClick={() => setConfirm("remove")} className="btn btn-ghost btn-sm btn-icon shrink-0 hover:text-[var(--c-danger)]" title="Retirer ce contact" aria-label="Retirer ce contact"><IconTrash size={11} /></button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Fingerprint value={g.grantee.fingerprint} />
        <TrustBadge email={g.grantee.email} fingerprint={g.grantee.fingerprint} onPinned={onPinned} />
      </div>

      {g.status === "requested" && (
        <div className="callout callout-warn space-y-2 text-[12.5px]">
          <p>A demandé l'accès le {formatWhen(g.requested_at)} : il l'aura le <span className="font-medium">{formatWhen(g.access_at)}</span>, sauf refus de votre part.</p>
          <div className="flex flex-wrap gap-2">
            <button disabled={busy !== null} onClick={() => void act("reject", () => api.emergencyAction(g.id, "reject"), "Demande refusée.")} className="btn btn-secondary btn-sm">Refuser</button>
            <button disabled={busy !== null} onClick={() => setConfirm("approve")} className="btn btn-ghost btn-sm">Accorder maintenant</button>
          </div>
        </div>
      )}
      {g.status === "granted" && (
        <div className="callout space-y-2 text-[12.5px]">
          <p>Lit les vaults confiés depuis le {formatWhen(g.access_at)}. Reprendre la main coupe l'accès ; ce qu'il a déjà lu, il a pu le garder — renouvelez la clé des vaults concernés si besoin.</p>
          <button disabled={busy !== null} onClick={() => void act("reject", () => api.emergencyAction(g.id, "reject"), "Accès repris.")} className="btn btn-secondary btn-sm">Reprendre la main</button>
        </div>
      )}
      {g.status === "invited" && <p className="help-text">Il doit accepter, depuis ses propres paramètres, après avoir vérifié votre empreinte.</p>}

      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`wait-${g.id}`} className="text-[12px] text-[var(--c-text-secondary)]">Délai d'attente</label>
        <select id={`wait-${g.id}`} value={g.wait_days} disabled={busy !== null} onChange={(e) => void act("wait", () => api.updateEmergency(g.id, { wait_days: Number(e.target.value) }), "Délai modifié.")} className="input w-auto">
          {WAIT_CHOICES.map((n) => <option key={n} value={n}>{days(n)}</option>)}
        </select>
      </div>

      <div>
        <p className="text-[12px] text-[var(--c-text-secondary)]">Vaults confiés</p>
        {editing ? (
          <div className="mt-1 space-y-1">
            <VaultChecklist vaults={owned} selected={editing} onChange={setEditing} />
            {!pinned && <p className="help-text">Vérifiez son empreinte avant de lui envelopper des clés.</p>}
            <div className="flex gap-2">
              <button disabled={!pinned || editing.size === 0 || busy !== null} onClick={saveVaults} className="btn btn-primary btn-sm">Enregistrer</button>
              <button onClick={() => setEditing(null)} className="btn btn-ghost btn-sm">Annuler</button>
            </div>
          </div>
        ) : (
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {[...covered].map(([id, hasKey]) => (
              <span key={id} className="tag" title={hasKey ? undefined : "La clé de ce vault a été renouvelée : son enveloppe est à refaire (depuis un appareil où l'empreinte du contact est vérifiée)."}>
                {nameOf(id)}{hasKey ? "" : " · à renouveler"}
              </span>
            ))}
            <button onClick={() => setEditing(new Set(g.vaults.map((v) => v.vault_id).filter((id) => owned.some((o) => o.id === id))))} className="btn btn-ghost btn-sm">Modifier</button>
          </div>
        )}
      </div>

      {confirm === "remove" && (
        <ConfirmDialog
          title={`Retirer ${g.grantee.email} ?`}
          message={`Les enveloppes qui lui étaient destinées sont effacées : il ne pourra plus demander l'accès.${g.status === "granted" ? " Ce qu'il a déjà lu, il a pu le garder : renouvelez la clé des vaults concernés." : ""}`}
          confirmLabel="Retirer"
          danger
          onConfirm={() => { setConfirm(null); void act("remove", () => api.deleteEmergency(g.id), "Contact d'urgence retiré."); }}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm === "approve" && (
        <ConfirmDialog
          title={`Accorder l'accès à ${g.grantee.email} maintenant ?`}
          message={`Il lira tout de suite ${g.vaults.length > 1 ? `les ${g.vaults.length} vaults confiés` : "le vault confié"}, sans attendre la fin du délai.`}
          confirmLabel="Accorder"
          onConfirm={() => { setConfirm(null); void act("approve", () => api.emergencyAction(g.id, "approve"), "Accès accordé."); }}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}

function VaultChecklist({ vaults, selected, onChange }: { vaults: VaultView[]; selected: Set<string>; onChange: (s: Set<string>) => void }) {
  if (vaults.length === 0) return <p className="help-text">Vous n'êtes propriétaire d'aucun vault.</p>;
  return (
    <div className="space-y-0.5">
      {vaults.map((v) => (
        <label key={v.id} className="flex items-center gap-2 text-[12.5px] text-[var(--c-text)]">
          <input
            type="checkbox"
            checked={selected.has(v.id)}
            onChange={(e) => {
              const next = new Set(selected);
              if (e.target.checked) next.add(v.id);
              else next.delete(v.id);
              onChange(next);
            }}
          />
          {v.name}
          {v.kind === "personal" && <span className="text-[11px] text-[var(--c-text-faint)]">personnel</span>}
        </label>
      ))}
    </div>
  );
}

/** Désigner quelqu'un : son compte, son empreinte vérifiée, les vaults, le
 * délai. */
function Designate({ ctx, owned, act, busy, onPinned, taken }: { ctx: PageContext; owned: VaultView[]; act: Act; busy: string | null; onPinned: () => void; taken: string[] }) {
  const [email, setEmail] = useState("");
  const [found, setFound] = useState<UserLookupResponse | "none" | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(owned.filter((v) => v.kind === "personal").map((v) => v.id)));
  const [wait, setWait] = useState(7);

  const lookup = async (e: FormEvent) => {
    e.preventDefault();
    const normalized = email.trim().toLowerCase();
    if (!normalized) return;
    if (normalized === ctx.session.user.email) {
      ctx.error("On ne se désigne pas soi-même.");
      return;
    }
    try {
      setFound((await api.lookup(normalized)) ?? "none");
    } catch (err) {
      ctx.error(errorMessage(err));
    }
  };

  const pinned = found !== null && found !== "none" && fingerprintTrust(found.email, found.fingerprint).kind === "pinned";
  const already = found !== null && found !== "none" && taken.includes(found.id);

  return (
    <div className="card space-y-2 p-3">
      <form onSubmit={lookup} className="flex flex-wrap items-end gap-2">
        <Field label="Désigner un contact" className="min-w-0 flex-1">
          <input value={email} onChange={(e) => { setEmail(e.target.value); setFound(null); }} type="email" placeholder="proche@exemple.fr" className="input" />
        </Field>
        <button type="submit" disabled={!email.trim()} className="btn btn-secondary">Chercher</button>
      </form>
      {found === "none" && <p className="help-text">Pas de compte à cette adresse sur ce serveur : votre proche doit d'abord s'en créer un.</p>}
      {found && found !== "none" && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[12.5px] text-[var(--c-text)]">{found.email}</span>
            <Fingerprint value={found.fingerprint} />
            <TrustBadge email={found.email} fingerprint={found.fingerprint} onPinned={onPinned} />
          </div>
          {already ? (
            <p className="help-text">Déjà désigné : modifiez sa désignation ci-dessus.</p>
          ) : (
            <>
              <div>
                <p className="text-[12px] text-[var(--c-text-secondary)]">Vaults à lui confier</p>
                <VaultChecklist vaults={owned} selected={selected} onChange={setSelected} />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <label htmlFor="designate-wait" className="text-[12px] text-[var(--c-text-secondary)]">Délai d'attente</label>
                <select id="designate-wait" value={wait} onChange={(e) => setWait(Number(e.target.value))} className="input w-auto">
                  {WAIT_CHOICES.map((n) => <option key={n} value={n}>{days(n)}</option>)}
                </select>
              </div>
              {!pinned && <p className="help-text">Vérifiez son empreinte d'abord : c'est à cette clé que les vôtres seront confiées.</p>}
              <button
                disabled={!pinned || selected.size === 0 || busy !== null}
                onClick={() => {
                  const target = found;
                  void act("designate", () => api.createEmergency({ grantee_id: target.id, wait_days: wait, vaults: emergencyEnvelopes(ctx.session, target, [...selected]) }), `${target.email} est votre contact d'urgence (à lui d'accepter).`).then(() => { setEmail(""); setFound(null); });
                }}
                className="btn btn-primary btn-sm"
              >
                Désigner
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Quelqu'un qui nous a désigné : accepter, demander, ouvrir. */
function GranteeCard({ g, vaults, act, busy, onPinned }: { g: EmergencyGrant; vaults: VaultView[]; act: Act; busy: string | null; onPinned: () => void }) {
  const [confirm, setConfirm] = useState<null | "request" | "renounce">(null);
  const pinned = fingerprintTrust(g.grantor.email, g.grantor.fingerprint).kind === "pinned";
  const n = g.vaults.length;
  return (
    <div className="card min-w-0 space-y-2 p-3">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-[var(--c-text)]" title={g.grantor.email}>{g.grantor.email}</span>
        <StatusTag status={g.status} />
        <button onClick={() => setConfirm("renounce")} className="btn btn-ghost btn-sm btn-icon shrink-0 hover:text-[var(--c-danger)]" title="Renoncer" aria-label="Renoncer"><IconTrash size={11} /></button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Fingerprint value={g.grantor.fingerprint} />
        <TrustBadge email={g.grantor.email} fingerprint={g.grantor.fingerprint} onPinned={onPinned} />
      </div>
      <p className="text-[12px] text-[var(--c-text-muted)]">{n} vault{n > 1 ? "s" : ""} confié{n > 1 ? "s" : ""} · délai de {days(g.wait_days)}</p>

      {g.status === "invited" && (
        <div className="flex flex-wrap items-center gap-2">
          <button disabled={!pinned || busy !== null} onClick={() => void act("accept", () => api.emergencyAction(g.id, "accept"), "Désignation acceptée.")} className="btn btn-primary btn-sm">Accepter</button>
          {!pinned && <span className="help-text">Vérifiez d'abord son empreinte : c'est elle qui signera les clés qu'on vous remettra.</span>}
        </div>
      )}
      {g.status === "accepted" && (
        <button disabled={busy !== null} onClick={() => setConfirm("request")} className="btn btn-secondary btn-sm">Demander l'accès…</button>
      )}
      {g.status === "requested" && (
        <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-[var(--c-text)]">
          <span>Accès le <span className="font-medium">{formatWhen(g.access_at)}</span>, sauf refus.</span>
          <button disabled={busy !== null} onClick={() => void act("cancel", () => api.emergencyAction(g.id, "reject"), "Demande retirée.")} className="btn btn-ghost btn-sm">Retirer la demande</button>
        </div>
      )}
      {g.status === "granted" && (
        pinned ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {vaults.map((v) => (
              <button key={v.id} onClick={() => navigate({ page: "vault", id: v.id })} className="btn btn-secondary btn-sm"><IconVault size={11} /> {v.name}</button>
            ))}
            {vaults.length === 0 && <span className="help-text">Aucun vault lisible pour l'instant (clé en cours de renouvellement ?).</span>}
          </div>
        ) : (
          <p className="help-text">Vérifiez son empreinte pour ouvrir ses vaults : c'est ce qui prouve que les clés viennent bien de cette personne.</p>
        )
      )}

      {confirm === "request" && (
        <ConfirmDialog
          title={`Demander l'accès aux vaults de ${g.grantor.email} ?`}
          message={`Cette personne le verra à sa prochaine connexion et pourra refuser. Sans refus, vous lirez ${n > 1 ? `ses ${n} vaults confiés` : "le vault confié"} dans ${days(g.wait_days)}.`}
          confirmLabel="Demander"
          onConfirm={() => { setConfirm(null); void act("request", () => api.emergencyAction(g.id, "request"), "Demande envoyée."); }}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm === "renounce" && (
        <ConfirmDialog
          title={`Renoncer à être le contact d'urgence de ${g.grantor.email} ?`}
          message="Les clés qui vous étaient confiées sont effacées du serveur. Il faudra une nouvelle désignation pour revenir."
          confirmLabel="Renoncer"
          danger
          onConfirm={() => { setConfirm(null); void act("renounce", () => api.deleteEmergency(g.id), "Désignation retirée."); }}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}

/** Le bandeau du donneur quand un contact demande (ou a obtenu) l'accès :
 * c'est là, à la connexion, qu'il le découvre. */
export function EmergencyBanner({ grants, onOpen }: { grants: EmergencyGrant[]; onOpen: () => void }) {
  const pending = grants.filter((g) => g.status === "requested" || g.status === "granted");
  if (pending.length === 0) return null;
  return (
    <div role="status" className="shrink-0 space-y-2 px-4 pt-3">
      {pending.map((g) => (
        <div key={g.id} className="callout callout-warn flex flex-wrap items-center gap-3 text-[12.5px]">
          <p className="min-w-0 flex-1">
            <span className="font-medium">Accès d'urgence</span> —{" "}
            {g.status === "requested"
              ? <>{g.grantee.email} a demandé l'accès à vos vaults ; il l'aura le {formatWhen(g.access_at)} sauf refus.</>
              : <>{g.grantee.email} lit vos vaults confiés depuis le {formatWhen(g.access_at)}.</>}
          </p>
          <button onClick={onOpen} className="btn btn-secondary btn-sm">{g.status === "requested" ? "Répondre" : "Voir"}</button>
        </div>
      ))}
    </div>
  );
}
