import { useState } from "react";
import type { PageContext } from "../App";
import { navigate, routeHash, type Route } from "../lib/route";
import { createVault } from "../lib/session";
import { errorMessage } from "../lib/api";
import { ROLE_HINTS, ROLE_LABELS } from "../lib/types";
import { IconDice, IconIdentity, IconShieldClock } from "./secret-icons";
import { IconBell, IconPlus, IconVault } from "./ui-icons";
import { Logo } from "./Logo";
import { Modal } from "./ui";

/** La barre latérale : les vaults, les invitations reçues, le compte. Même
 * vocabulaire que la barre de Guiterm — surface `--c-bg`, lignes `list-row`,
 * marqueur d'accent sur l'élément actif. */
export function Sidebar({ ctx, route, onLogout, width }: { ctx: PageContext; route: Route; onLogout: () => void; width: number }) {
  const { session } = ctx;
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState(false);
  const activeVault = route.page === "vault" || route.page === "vault-settings" || route.page === "vault-tools" ? route.id : null;

  const go = (r: Route) => {
    navigate(r);
    setOpen(false);
  };

  const list = (
    <div className="flex h-full flex-col">
      {/* Le logo ramène à l'accueil : le premier vault. */}
      <a
        href={routeHash({ page: "home" })}
        onClick={(e) => { e.preventDefault(); go({ page: "home" }); }}
        className="flex items-center gap-2 px-3 py-2.5 text-[var(--c-text)] hover:text-[var(--c-accent-text)]"
        title="Accueil"
      >
        <Logo size={26} />
        <span className="text-[13px] font-semibold">GuiVault</span>
      </a>

      <div className="sidebar-scroll -mx-1 min-h-0 flex-1 overflow-y-auto px-1">
        <div className="flex items-center justify-between px-2 pb-1 pt-1">
          <span className="eyebrow">Vaults</span>
          <button onClick={() => setCreating(true)} className="btn btn-ghost btn-sm btn-icon" title="Nouveau vault partagé" aria-label="Nouveau vault partagé"><IconPlus size={12} /></button>
        </div>
        {session.vaults.map((v) => (
          <a
            key={v.id}
            href={routeHash({ page: "vault", id: v.id })}
            onClick={(e) => { e.preventDefault(); go({ page: "vault", id: v.id }); }}
            data-active={activeVault === v.id ? "true" : undefined}
            className="list-row mx-1 mb-0.5 py-1.5"
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--c-bg3)] text-[var(--c-text-secondary)]"><IconVault size={12} /></span>
            <span className="flex min-w-0 flex-1 flex-col leading-tight">
              <span className="truncate text-[12.5px] font-medium text-[var(--c-text)]">{v.name}</span>
              <span className="truncate text-[10.5px] text-[var(--c-text-muted)]" title={ROLE_HINTS[v.role]}>{v.kind === "personal" ? "personnel" : ROLE_LABELS[v.role]}</span>
            </span>
          </a>
        ))}

        <a
          href={routeHash({ page: "invitations" })}
          onClick={(e) => { e.preventDefault(); go({ page: "invitations" }); }}
          data-active={route.page === "invitations" ? "true" : undefined}
          className="list-row mx-1 mt-3 py-1.5"
        >
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--c-bg3)] text-[var(--c-text-secondary)]"><IconBell size={12} /></span>
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--c-text)]">Invitations</span>
          {session.invitations.length > 0 && <span className="tag tag-accent">{session.invitations.length}</span>}
        </a>
        <a
          href={routeHash({ page: "generator" })}
          onClick={(e) => { e.preventDefault(); go({ page: "generator" }); }}
          data-active={route.page === "generator" ? "true" : undefined}
          className="list-row mx-1 mt-0.5 py-1.5"
        >
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--c-bg3)] text-[var(--c-text-secondary)]"><IconDice size={12} /></span>
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--c-text)]">Générateur</span>
        </a>
        <a
          href={routeHash({ page: "totp" })}
          onClick={(e) => { e.preventDefault(); go({ page: "totp" }); }}
          data-active={route.page === "totp" ? "true" : undefined}
          className="list-row mx-1 mt-0.5 py-1.5"
        >
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--c-bg3)] text-[var(--c-text-secondary)]"><IconShieldClock size={12} /></span>
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--c-text)]">Authentificateur</span>
        </a>
      </div>

      <div className="border-t border-[var(--c-border)] p-2">
        <a
          href={routeHash({ page: "settings", section: "compte" })}
          onClick={(e) => { e.preventDefault(); go({ page: "settings", section: "compte" }); }}
          data-active={route.page === "settings" ? "true" : undefined}
          className="list-row py-1.5"
        >
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--c-bg3)] text-[var(--c-text-secondary)]"><IconIdentity size={12} /></span>
          <span className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="truncate text-[12.5px] text-[var(--c-text)]" title={session.user.email}>{session.user.email}</span>
            <span className="truncate text-[10.5px] text-[var(--c-text-muted)]">Compte et paramètres</span>
          </span>
        </a>
        <button onClick={onLogout} className="btn btn-ghost btn-sm mt-1 w-full justify-start">Se déconnecter</button>
      </div>
    </div>
  );

  return (
    <>
      {/* Étroit : un bouton en haut ouvre la barre en tiroir. Le titre de la
          page est juste à côté, le bouton ne le répète pas. */}
      <div className="fixed left-2 top-2 z-30 md:hidden">
        <button onClick={() => setOpen(true)} className="btn btn-secondary btn-sm btn-icon" aria-label="Menu" title="Menu">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.5 4h11M2.5 8h11M2.5 12h11" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" /></svg>
        </button>
      </div>
      {open && <div className="fixed inset-0 z-30 bg-black/50 md:hidden" onClick={() => setOpen(false)} />}
      {/* Large : la largeur réglée à la poignée (la bordure est la poignée) ;
          étroit : un tiroir de largeur fixe. */}
      <aside
        style={{ "--sidebar-w": `${width}px` } as React.CSSProperties}
        className={`fixed inset-y-0 left-0 z-40 w-64 border-r border-[var(--c-border)] bg-[var(--c-bg)] transition-transform md:static md:z-auto md:w-[var(--sidebar-w)] md:translate-x-0 md:border-r-0 ${open ? "translate-x-0" : "-translate-x-full"}`}
      >
        {list}
      </aside>

      {creating && (
        <CreateVaultDialog
          onClose={() => setCreating(false)}
          onCreate={async (name) => {
            try {
              const v = await createVault(session, name);
              setCreating(false);
              await ctx.reload();
              ctx.notify(`Vault « ${v.name} » créé.`);
              go({ page: "vault", id: v.id });
            } catch (e) {
              ctx.error(errorMessage(e));
            }
          }}
        />
      )}
    </>
  );
}

function CreateVaultDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string) => Promise<void> }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Nouveau vault partagé" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) return;
          setBusy(true);
          await onCreate(name.trim());
          setBusy(false);
        }}
        className="space-y-3"
      >
        <label className="block">
          <span className="field-label">Nom</span>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Équipe réseau" className="input" />
          <span className="help-text mt-1 block">Chiffré comme le reste : le serveur ne le lit pas. Vous en êtes propriétaire ; invitez ensuite des membres depuis ses réglages.</span>
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn btn-ghost">Annuler</button>
          <button type="submit" disabled={!name.trim() || busy} className="btn btn-primary">Créer</button>
        </div>
      </form>
    </Modal>
  );
}
