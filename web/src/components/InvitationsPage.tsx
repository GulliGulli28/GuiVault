import { useState } from "react";
import type { PageContext } from "../App";
import { api, errorMessage } from "../lib/api";
import { fingerprintTrust } from "../lib/pins";
import { navigate } from "../lib/route";
import { invitationKeyFrom, type InvitationKey } from "../lib/session";
import { ROLE_HINTS, ROLE_LABELS, type Invitation } from "../lib/types";
import { Fingerprint, formatWhen, TrustBadge } from "./ui";

/** Les invitations reçues : accepter (la clé est déjà scellée pour vous, ou
 * l'inviteur la transmettra après avoir vérifié votre empreinte) ou refuser. */
export function InvitationsPage({ ctx }: { ctx: PageContext }) {
  const { session } = ctx;
  const [busy, setBusy] = useState<string | null>(null);
  const [, setTrustTick] = useState(0);

  const act = async (id: string, f: () => Promise<unknown>, done: string) => {
    setBusy(id);
    try {
      await f();
      ctx.notify(done);
      await ctx.reload();
    } catch (e) {
      ctx.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-[var(--c-border)] px-4 py-2.5 max-md:pl-11">
        <h1 className="text-[14px] font-semibold text-[var(--c-text)]">Invitations</h1>
      </header>
      <div className="sidebar-scroll min-h-0 flex-1 overflow-y-auto p-4">
        {session.invitations.length === 0 ? (
          <p className="text-[12.5px] text-[var(--c-text-muted)]">Aucune invitation en attente.</p>
        ) : (
          <div className="max-w-2xl space-y-2">
            {session.invitations.map((inv) => (
              <div key={inv.id} className="card space-y-1.5 p-3">
                <p className="text-[12.5px] text-[var(--c-text)]"><span className="font-medium">{inv.inviter_email}</span> vous invite dans un vault partagé comme <span className="tag" title={ROLE_HINTS[inv.role]}>{ROLE_LABELS[inv.role]}</span></p>
                <InvitationKeyInfo inv={inv} keyFrom={invitationKeyFrom(session, inv)} onPinned={() => setTrustTick((t) => t + 1)} />
                <p className="help-text">
                  {inv.has_key ? "La clé du vault est déjà enveloppée pour vous : accepter l'ouvre immédiatement." : "L'invitation a été émise avant que vous ayez un compte : après acceptation, l'inviteur devra vérifier votre empreinte puis vous transmettre la clé."}
                  {" "}Expire le {formatWhen(inv.expires_at)}.
                </p>
                <div className="flex justify-end gap-1.5">
                  <button onClick={() => void act(inv.id, () => api.declineInvitation(inv.id), "Invitation refusée.")} disabled={busy !== null} className="btn btn-ghost btn-sm">Refuser</button>
                  <button
                    onClick={() => void act(inv.id, async () => {
                      const r = await api.acceptInvitation(inv.id);
                      if (r.status === "accepted") navigate({ page: "vault", id: inv.vault_id });
                    }, inv.has_key ? "Vault rejoint." : "Acceptée : en attente de la clé de l'inviteur.")}
                    disabled={busy !== null || !acceptable(inv, invitationKeyFrom(session, inv))}
                    title={acceptable(inv, invitationKeyFrom(session, inv)) ? undefined : "La clé jointe n'est pas celle qu'on attend : voir ci-dessus"}
                    className="btn btn-primary btn-sm"
                  >
                    Accepter
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Une invitation dont l'enveloppe ne s'ouvre pas, ou vient d'une autre clé
 * que celle déjà vérifiée pour l'inviteur, ne s'accepte pas en l'état. */
function acceptable(inv: Invitation, keyFrom: InvitationKey): boolean {
  if (keyFrom?.kind === "unreadable") return false;
  if (keyFrom?.kind === "member") return fingerprintTrust(inv.inviter_email, keyFrom.fingerprint).kind !== "changed";
  return true;
}

/** Qui remet la clé du vault, lu dans l'enveloppe jointe — avant d'accepter.
 * Le serveur choisit l'e-mail affiché comme inviteur ; l'enveloppe, elle, ne
 * peut venir que du détenteur de la clé dont on montre l'empreinte. */
function InvitationKeyInfo({ inv, keyFrom, onPinned }: { inv: Invitation; keyFrom: InvitationKey; onPinned: () => void }) {
  if (!keyFrom || keyFrom.kind === "self") return null;
  if (keyFrom.kind === "unreadable") {
    return <p className="callout callout-danger">La clé jointe à cette invitation ne s'ouvre pas avec votre compte : elle n'est pas pour vous, ou pas pour ce vault. Ne l'acceptez pas, et prévenez {inv.inviter_email} par un autre canal.</p>;
  }
  if (keyFrom.kind === "anonymous") {
    return <p className="help-text">Enveloppe à l'ancien format : elle ne dit pas qui vous remet la clé. Vérifiez l'invitation auprès de {inv.inviter_email} par un autre canal.</p>;
  }
  const changed = fingerprintTrust(inv.inviter_email, keyFrom.fingerprint).kind === "changed";
  return (
    <div className={changed ? "callout callout-danger space-y-1" : "space-y-1"}>
      <p className="text-[12px] text-[var(--c-text-secondary)]">
        {changed
          ? `La clé jointe n'est pas celle de ${inv.inviter_email} que vous avez vérifiée : quelqu'un se fait peut-être passer pour elle, ou le serveur ment. Vérifiez à nouveau avant d'accepter.`
          : `Clé remise par ${inv.inviter_email} — vérifiez son empreinte par un autre canal avant d'y ranger des secrets :`}
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        <Fingerprint value={keyFrom.fingerprint} />
        <TrustBadge email={inv.inviter_email} fingerprint={keyFrom.fingerprint} onPinned={onPinned} />
      </div>
    </div>
  );
}
