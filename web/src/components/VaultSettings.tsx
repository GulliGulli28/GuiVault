import { Page } from "./Page";
import { ACCENT_COLORS } from "../lib/preferences";
import { setVaultColor, useVaultColors, VAULT_COLORS, vaultColor, vaultColorName } from "../lib/vaultColors";
import { useCallback, useEffect, useState } from "react";
import type { PageContext } from "../App";
import { api, errorMessage, supports } from "../lib/api";
import { navigate } from "../lib/route";
import { completeInvitation, invite, renameVault, rotateVaultKey, type VaultView } from "../lib/session";
import { fingerprintTrust } from "../lib/pins";
import { canManage, ROLE_HINTS, ROLE_LABELS, type AuditEntry, type Invitation, type Role, type UserLookupResponse, type VaultMember } from "../lib/types";
import { ConfirmDialog } from "./ConfirmDialog";
import { IconTrash } from "./ui-icons";
import { Eyebrow, Fingerprint, formatWhen, TrustBadge } from "./ui";
import { t } from "../lib/i18n";

/** Les réglages d'un vault — le `VaultDetail` du panneau GuiVault de
 * Guiterm : nom, membres, invitations, rotation de clé, journal, quitter ou
 * supprimer. */
export function VaultSettings({ ctx, vaultId }: { ctx: PageContext; vaultId: string }) {
  const vault = ctx.session.vaults.find((v) => v.id === vaultId);
  if (!vault) return <p className="p-6 text-[12.5px] text-[var(--c-text-muted)]">{t("Ce vault n'existe pas (ou plus).")}</p>;
  return <Body key={vault.id} ctx={ctx} vault={vault} />;
}

type Confirm = null | { kind: "remove"; m: VaultMember } | { kind: "leave" } | { kind: "delete" } | { kind: "rotate" } | { kind: "transfer"; m: VaultMember };

function Body({ ctx, vault }: { ctx: PageContext; vault: VaultView }) {
  const { session } = ctx;
  const isPersonal = vault.kind === "personal";
  const colors = useVaultColors();
  // Un coffre local (l'app) n'a qu'un utilisateur : ni membres, ni
  // invitations, ni journal, ni rotation — un vault y sert à ranger.
  const sharing = supports("members");
  const manage = !isPersonal && sharing && canManage(vault.role);
  const [members, setMembers] = useState<VaultMember[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("reader");
  const [lookup, setLookup] = useState<UserLookupResponse | null | "none">(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [audit, setAudit] = useState<AuditEntry[] | null>(null);
  const [, setTrustTick] = useState(0);
  const repaint = () => setTrustTick((t) => t + 1);

  const reload = useCallback(() => {
    if (isPersonal || !sharing) return;
    api.members(vault.id).then(setMembers).catch((e) => ctx.error(errorMessage(e)));
    if (manage) api.vaultInvitations(vault.id).then(setInvitations).catch((e) => ctx.error(errorMessage(e)));
  }, [vault.id, manage, isPersonal, sharing, ctx]);
  useEffect(() => { reload(); }, [reload]);

  const act = async (label: string, p: () => Promise<unknown>, after?: () => void) => {
    setBusy(label);
    try {
      await p();
      reload();
      after?.();
    } catch (e) {
      ctx.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const doLookup = async () => {
    if (!inviteEmail.trim()) return;
    try {
      const u = await api.lookup(inviteEmail.trim().toLowerCase());
      setLookup(u ?? "none");
    } catch (e) {
      ctx.error(errorMessage(e));
    }
  };

  const doInvite = () =>
    act("invite", () => invite(session, vault, inviteEmail, inviteRole), () => {
      ctx.notify(t("Invitation envoyée à {0}", inviteEmail.trim()));
      setInviteEmail("");
      setLookup(null);
    });

  const pending = invitations.filter((i) => i.status === "pending" || i.status === "awaiting_key");
  const canInvite = lookup !== null && (lookup === "none" || fingerprintTrust(lookup.email, lookup.fingerprint).kind === "pinned");

  return (
    <Page
      title={isPersonal || !sharing ? t("Réglages du vault") : t("Membres et réglages")}
      sub={<span className="inline-flex max-w-full items-center gap-2"><span className="vdot" style={{ background: vaultColor(vault.id, isPersonal, colors) }} /><span className="truncate">{vault.name}</span><span className="tag" title={ROLE_HINTS[vault.role]}>{isPersonal ? t("Personnel") : ROLE_LABELS[vault.role]}</span></span>}
      back={{ label: vault.name, route: { page: "vault", id: vault.id } }}
      width="max-w-[760px]"
    >
        <section className="flex flex-col gap-2.5">
          <Eyebrow>{t("Couleur")}</Eyebrow>
          <div className="flex flex-wrap items-center gap-2">
            {VAULT_COLORS.map((c) => {
              const on = vaultColorName(vault.id, isPersonal, colors) === c;
              return <button key={c} onClick={() => setVaultColor(vault.id, c)} aria-pressed={on} title={ACCENT_COLORS[c].label} aria-label={t("Couleur {0}", ACCENT_COLORS[c].label)} className={`h-7 w-7 rounded-full ${on ? "ring-2 ring-[var(--c-text)] ring-offset-2 ring-offset-[var(--c-bg2)]" : ""}`} style={{ background: ACCENT_COLORS[c].c500 }} />;
            })}
            <span className="text-[12.5px] text-[var(--c-text-muted)]">{t("Pour vous seul, sur tous vos appareils.")}</span>
          </div>
        </section>

        {supports("setVaultTravel") && !vault.emergency && (
          <section className="flex flex-col gap-2.5">
            <Eyebrow>{t("Voyage")}</Eyebrow>
            <div className="card flex items-center gap-3 px-4 py-3">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-[13.5px]">{t("Sûr en voyage")}</span>
                <span className="text-[12.5px] text-[var(--c-text-muted)]">{t("Reste sur vos appareils en mode voyage (Paramètres › Sécurité).")}</span>
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={!!vault.travelSafe}
                aria-label={t("Sûr en voyage")}
                onClick={() => void act("travel", () => api.setVaultTravel(vault.id, !vault.travelSafe), () => void ctx.reload())}
                className="switch"
              />
            </div>
          </section>
        )}

        <section className="flex flex-col gap-2.5">
          <Eyebrow>{t("Nom")}</Eyebrow>
          {renaming === null ? (
            <div className="flex items-center gap-2">
              <p className="text-[13px] text-[var(--c-text)]">{vault.name}</p>
              {(isPersonal || manage) && <button onClick={() => setRenaming(vault.name)} className="btn btn-secondary btn-sm">{t("Renommer")}</button>}
            </div>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const n = renaming.trim();
                setRenaming(null);
                if (n && n !== vault.name) void act("rename", () => renameVault(vault, n), () => void ctx.reload());
              }}
              className="flex gap-2"
            >
              <input value={renaming} autoFocus onChange={(e) => setRenaming(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setRenaming(null); }} className="input max-w-xs" />
              <button type="submit" className="btn btn-primary btn-sm">{t("Enregistrer")}</button>
              <button type="button" onClick={() => setRenaming(null)} className="btn btn-ghost btn-sm">{t("Annuler")}</button>
            </form>
          )}
          <p className="help-text">{sharing ? t("Chiffré sous la clé du vault : le serveur ne le lit pas.") : t("Chiffré sous la clé du vault.")}</p>
        </section>

        {isPersonal && sharing && (
          <p className="callout">{t("Le vault personnel ne se partage pas. Pour partager, créez un vault avec « + » dans la barre latérale.")}</p>
        )}

        {!isPersonal && sharing && <KeyProvenance vault={vault} members={members} onPinned={repaint} />}

        {!isPersonal && sharing && (
          <section className="flex flex-col gap-2.5">
            <Eyebrow>{t("Membres")}</Eyebrow>
            {members.map((m) => {
              const isMe = m.user_id === session.user.id;
              return (
                <div key={m.user_id} className="card min-w-0 space-y-1 p-2.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--c-text)]" title={m.email}>{m.email}{isMe && <span className="tag ml-1.5">{t("vous")}</span>}</span>
                    {manage && !isMe && m.role !== "owner" && (
                      <button onClick={() => setConfirm({ kind: "remove", m })} className="btn btn-ghost btn-sm btn-icon shrink-0 hover:text-[var(--c-danger)]" title={t("Retirer du vault")} aria-label={t("Retirer du vault")}><IconTrash size={11} /></button>
                    )}
                  </div>
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    {manage && !isMe && m.role !== "owner" ? (
                      <select value={m.role} onChange={(e) => void act("role", () => api.updateMember(vault.id, m.user_id, e.target.value as Role))} className="input w-auto" title={t("Rôle")}>
                        {(["reader", "writer", "admin"] as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                      </select>
                    ) : (
                      <span className="tag" title={ROLE_HINTS[m.role]}>{ROLE_LABELS[m.role]}</span>
                    )}
                    {vault.role === "owner" && !isMe && (
                      <button onClick={() => setConfirm({ kind: "transfer", m })} className="btn btn-ghost btn-sm" title={t("Transférer la propriété")}>{t("Rendre propriétaire")}</button>
                    )}
                    <span className="text-[11px] text-[var(--c-text-faint)]">{t("depuis le")} {formatWhen(m.added_at)}</span>
                  </div>
                  {!isMe && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Fingerprint value={m.fingerprint} />
                      <TrustBadge email={m.email} fingerprint={m.fingerprint} onPinned={repaint} />
                    </div>
                  )}
                </div>
              );
            })}
          </section>
        )}

        {manage && (
          <section className="flex flex-col gap-2.5">
            <Eyebrow>{t("Inviter")}</Eyebrow>
            <div className="flex flex-wrap gap-1.5">
              <input value={inviteEmail} onChange={(e) => { setInviteEmail(e.target.value); setLookup(null); }} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void doLookup(); } }} placeholder={t("E-mail")} type="email" className="input min-w-[9rem] flex-1" />
              <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as Role)} className="input w-auto" title={ROLE_HINTS[inviteRole]}>
                {(["reader", "writer", "admin"] as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
              </select>
              <button onClick={() => void doLookup()} disabled={!inviteEmail.trim()} className="btn btn-secondary btn-sm">{t("Chercher")}</button>
            </div>
            <p className="help-text">{ROLE_HINTS[inviteRole]}.</p>
            {lookup === "none" && (
              <div className="callout space-y-1.5">
                <p>{t("Pas encore de compte sur ce serveur. L'invitation lui permettra de s'inscrire ; vous compléterez ensuite le partage après avoir vérifié son empreinte.")}</p>
                <div className="flex justify-end"><button onClick={() => void doInvite()} disabled={busy !== null} className="btn btn-primary btn-sm">{t("Inviter sans clé")}</button></div>
              </div>
            )}
            {lookup && lookup !== "none" && (
              <div className="callout space-y-1.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[12px] text-[var(--c-text)]">{lookup.email}</span>
                  <Fingerprint value={lookup.fingerprint} />
                  <TrustBadge email={lookup.email} fingerprint={lookup.fingerprint} onPinned={repaint} />
                </div>
                <div className="flex justify-end">
                  <button onClick={() => void doInvite()} disabled={busy !== null || !canInvite} className="btn btn-primary btn-sm" title={!canInvite ? t("Vérifiez d'abord l'empreinte") : undefined}>
                    {t("Inviter comme")} {ROLE_LABELS[inviteRole]}
                  </button>
                </div>
              </div>
            )}
            {pending.length > 0 && (
              <div className="space-y-1">
                {pending.map((inv) => (
                  <div key={inv.id} className="card min-w-0 space-y-1 p-2.5">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--c-text)]" title={inv.invitee_email}>{inv.invitee_email}</span>
                      <button onClick={() => void act("revoke", () => api.revokeInvitation(inv.id))} className="btn btn-ghost btn-sm btn-icon shrink-0 hover:text-[var(--c-danger)]" title={t("Révoquer")} aria-label={t("Révoquer")}><IconTrash size={11} /></button>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="tag">{ROLE_LABELS[inv.role]}</span>
                      <span className="tag">{inv.status === "awaiting_key" ? t("a accepté, clé à fournir") : inv.has_key ? t("en attente") : t("en attente d'inscription")}</span>
                      <span className="text-[11px] text-[var(--c-text-faint)]">{t("expire le")} {formatWhen(inv.expires_at)}</span>
                    </div>
                    {inv.invitee_fingerprint && !inv.has_key && (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Fingerprint value={inv.invitee_fingerprint} />
                        <TrustBadge email={inv.invitee_email} fingerprint={inv.invitee_fingerprint} onPinned={repaint} />
                        <button
                          onClick={() => void act("complete", () => completeInvitation(session, vault, inv), () => ctx.notify(t("Clé transmise à {0}", inv.invitee_email)))}
                          disabled={fingerprintTrust(inv.invitee_email, inv.invitee_fingerprint).kind !== "pinned" || busy !== null}
                          className="btn btn-primary btn-sm"
                        >
                          {t("Transmettre la clé")}
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {!isPersonal && (
          <section className="flex flex-col gap-2.5 border-t border-[var(--c-border)] pt-5">
            <div className="flex flex-wrap items-center gap-1.5">
              {manage && (
                <button onClick={() => { if (audit === null) api.vaultAudit(vault.id).then(setAudit).catch((e) => ctx.error(errorMessage(e))); else setAudit(null); }} className="btn btn-ghost btn-sm">{audit === null ? t("Journal") : t("Masquer le journal")}</button>
              )}
              {manage && <button onClick={() => setConfirm({ kind: "rotate" })} disabled={busy !== null} className="btn btn-secondary btn-sm" title={t("Nouvelle clé de vault, tout re-chiffré")}>{busy === "rotate" ? t("Rotation…") : t("Faire tourner la clé")}</button>}
              {vault.role !== "owner" && sharing && <button onClick={() => setConfirm({ kind: "leave" })} className="btn btn-secondary btn-sm">{t("Quitter")}</button>}
              {vault.role === "owner" && <button onClick={() => setConfirm({ kind: "delete" })} className="btn btn-danger btn-sm">{t("Supprimer le vault")}</button>}
            </div>
            {audit && <AuditList entries={audit} />}
          </section>
        )}

      {confirm?.kind === "remove" && (
        <ConfirmDialog
          title={t("Retirer {0} ?", confirm.m.email)}
          message={t("Il gardera une copie de ce qu'il a déjà synchronisé, et la clé du vault : celle-ci sera remplacée (tout est re-chiffré) pour que rien de ce qui sera ajouté ensuite ne lui soit lisible. Cela demande que l'empreinte de chaque membre restant soit vérifiée.")}
          confirmLabel={t("Retirer et changer la clé")}
          danger
          onConfirm={() => {
            const m = confirm.m;
            setConfirm(null);
            void act("rotate", async () => {
              await api.removeMember(vault.id, m.user_id);
              const remaining = await api.members(vault.id);
              await rotateVaultKey(session, vault, remaining);
            }, () => { ctx.notify(t("{0} retiré, clé du vault renouvelée", m.email)); void ctx.reload(); });
          }}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm?.kind === "transfer" && (
        <ConfirmDialog
          title={t("Faire de {0} le propriétaire ?", confirm.m.email)}
          message={t("Vous devenez admin. Seul le propriétaire peut supprimer le vault ou le transférer à nouveau.")}
          confirmLabel={t("Transférer")}
          onConfirm={() => { const m = confirm.m; setConfirm(null); void act("transfer", () => api.transferOwnership(vault.id, m.user_id), () => void ctx.reload()); }}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm?.kind === "rotate" && (
        <ConfirmDialog
          title={t("Faire tourner la clé du vault ?")}
          message={t("Une nouvelle clé est générée, chaque entité est re-chiffrée et une enveloppe est transmise à chaque membre — dont l'empreinte doit avoir été vérifiée. Les invitations en attente sont annulées.")}
          confirmLabel={t("Faire tourner")}
          onConfirm={() => { setConfirm(null); void act("rotate", () => rotateVaultKey(session, vault, members), () => { ctx.notify(t("Clé du vault renouvelée")); void ctx.reload(); }); }}
          onCancel={() => setConfirm(null)}
        />
      )}
      {(confirm?.kind === "leave" || confirm?.kind === "delete") && (
        <ConfirmDialog
          title={confirm.kind === "delete" ? t("Supprimer « {0} » ?", vault.name) : t("Quitter « {0} » ?", vault.name)}
          message={confirm.kind === "delete" && !sharing ? t("Le vault et tout son contenu sont supprimés de ce coffre, pièces jointes comprises.") : confirm.kind === "delete" ? t("Le vault et tout son contenu sont supprimés pour tous ses membres. Les appareils qui l'avaient synchronisé en gardent une copie locale jusqu'à leur prochaine synchronisation.") : t("Vous n'y aurez plus accès. Vos appareils qui l'avaient synchronisé en gardent une copie locale.")}
          confirmLabel={confirm.kind === "delete" ? t("Supprimer") : t("Quitter")}
          danger
          onConfirm={() => {
            const k = confirm.kind;
            setConfirm(null);
            void act(k, () => (k === "delete" ? api.deleteVault(vault.id) : api.leaveVault(vault.id)), () => { void ctx.reload(); navigate({ page: "home" }); });
          }}
          onCancel={() => setConfirm(null)}
        />
      )}
    </Page>
  );
}

export function AuditList({ entries }: { entries: AuditEntry[] }) {
  if (entries.length === 0) return <p className="text-[11.5px] text-[var(--c-text-muted)]">{t("Journal vide.")}</p>;
  return (
    <div className="space-y-0.5">
      {entries.map((e) => (
        <div key={e.id} className="flex gap-2 font-mono text-[10.5px] text-[var(--c-text-muted)]">
          <span className="shrink-0">{formatWhen(e.at)}</span>
          <span className="shrink-0 text-[var(--c-text-secondary)]">{e.actor_email ?? "—"}</span>
          <span className="min-w-0 truncate text-[var(--c-text)]" title={e.metadata ? JSON.stringify(e.metadata) : undefined}>{e.action}{e.target ? ` ${e.target}` : ""}</span>
        </div>
      ))}
    </div>
  );
}

/** Qui a remis la clé de ce vault à ce compte (`KeyFrom`). Une enveloppe de
 * format 2 ne peut avoir été produite que par le détenteur de la clé privée
 * de son expéditeur : son empreinte, vérifiée, dit que ce vault vient bien
 * de lui et pas d'un serveur qui l'aurait fabriqué pour qu'on y range des
 * secrets. */
function KeyProvenance({ vault, members, onPinned }: { vault: VaultView; members: VaultMember[]; onPinned: () => void }) {
  const from = vault.keyFrom;
  if (from.kind === "self") {
    return (
      <section className="flex flex-col gap-2.5">
        <Eyebrow>{t("Clé du vault")}</Eyebrow>
        <p className="text-[12.5px] text-[var(--c-text-secondary)]">{t("Créée ou renouvelée par vous.")}</p>
      </section>
    );
  }
  if (from.kind === "anonymous") {
    return (
      <section className="flex flex-col gap-2.5">
        <Eyebrow>{t("Clé du vault")}</Eyebrow>
        <p className="callout">
          {t("Enveloppe à l'ancien format : elle ne dit pas qui vous a remis la clé de ce vault. Un admin peut la renouveler (« Faire tourner la clé ») pour que chaque membre sache de qui il la tient.")}
        </p>
      </section>
    );
  }
  const sender = members.find((m) => m.fingerprint === from.fingerprint);
  return (
    <section className="flex flex-col gap-2.5">
      <Eyebrow>{t("Clé du vault")}</Eyebrow>
      {sender ? (
        <>
          <p className="text-[12.5px] text-[var(--c-text)]">{t("Remise par")} {sender.email}</p>
          <div className="flex flex-wrap items-center gap-1.5">
            <Fingerprint value={from.fingerprint} />
            <TrustBadge email={sender.email} fingerprint={from.fingerprint} onPinned={onPinned} />
          </div>
          <p className="help-text">
            {t("Seul le détenteur de cette clé a pu vous la remettre. Vérifiez son empreinte avant d'y ranger des secrets : c'est ce qui distingue un vault partagé par un collègue d'un vault fabriqué par le serveur.")}
          </p>
        </>
      ) : (
        members.length > 0 && (
          <div className="callout callout-warn space-y-1">
            <p>
              {t("Remise par une clé qui n'est celle d'aucun membre actuel. Son auteur a peut-être quitté le vault depuis ; sinon, le serveur est peut-être compromis — n'y rangez rien avant d'avoir vérifié avec les membres.")}
            </p>
            <Fingerprint value={from.fingerprint} />
          </div>
        )
      )}
    </section>
  );
}
