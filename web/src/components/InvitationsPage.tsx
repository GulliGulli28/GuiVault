import { useState } from "react";
import type { PageContext } from "../App";
import { api, errorMessage } from "../lib/api";
import { navigate } from "../lib/route";
import { ROLE_HINTS, ROLE_LABELS } from "../lib/types";
import { formatWhen } from "./ui";

/** Les invitations reçues : accepter (la clé est déjà scellée pour vous, ou
 * l'inviteur la transmettra après avoir vérifié votre empreinte) ou refuser. */
export function InvitationsPage({ ctx }: { ctx: PageContext }) {
  const { session } = ctx;
  const [busy, setBusy] = useState<string | null>(null);

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
                <p className="help-text">
                  {inv.has_key ? "La clé du vault est déjà scellée pour vous : accepter l'ouvre immédiatement." : "L'invitation a été émise avant que vous ayez un compte : après acceptation, l'inviteur devra vérifier votre empreinte puis vous transmettre la clé."}
                  {" "}Expire le {formatWhen(inv.expires_at)}.
                </p>
                <div className="flex justify-end gap-1.5">
                  <button onClick={() => void act(inv.id, () => api.declineInvitation(inv.id), "Invitation refusée.")} disabled={busy !== null} className="btn btn-ghost btn-sm">Refuser</button>
                  <button
                    onClick={() => void act(inv.id, async () => {
                      const r = await api.acceptInvitation(inv.id);
                      if (r.status === "accepted") navigate({ page: "vault", id: inv.vault_id });
                    }, inv.has_key ? "Vault rejoint." : "Acceptée : en attente de la clé de l'inviteur.")}
                    disabled={busy !== null}
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
