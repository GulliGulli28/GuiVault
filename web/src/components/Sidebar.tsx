import { useEffect, useMemo, useRef, useState } from "react";
import type { PageContext } from "../App";
import { navigate, routeHash, type Route } from "../lib/route";
import { createVault, type VaultView } from "../lib/session";
import { healthSummary, useAllItems } from "../lib/allItems";
import { personInitials } from "../lib/tiles";
import { useVaultColors, vaultColor } from "../lib/vaultColors";
import { errorMessage, supports } from "../lib/api";
import { coffreName } from "../lib/localHost";
import { systemBridge } from "../lib/platform";
import { ROLE_LABELS } from "../lib/types";
import { IconDice, IconHome, IconIdentity, IconLifebuoy, IconLink, IconLogout, IconPulse, IconShieldClock, IconUsers } from "./secret-icons";
import { IconBell, IconDatabase, IconLock, IconPlus, IconSearch, IconSettings, IconShield } from "./ui-icons";
import { Logo } from "./Logo";
import { Modal } from "./ui";
import { NARROW, TOUCH, useMediaQuery } from "../hooks/useMediaQuery";

/** La barre latérale (`docs/DESIGN.md`) : l'accueil, les coffres avec leur
 * pastille et leur nombre d'éléments, les outils, la sécurité ; en pied, le
 * compte, les paramètres et « Verrouiller ». */
export function Sidebar({ ctx, route, onLogout, onLock, onSearch, width }: { ctx: PageContext; route: Route; onLogout: () => void; onLock: () => void; onSearch: () => void; width: number }) {
  const { session } = ctx;
  // Un coffre local (l'app) : ni invitations ni liens, pas d'e-mail — son nom.
  const local = session.local;
  const [creating, setCreating] = useState(false);
  const [accountMenu, setAccountMenu] = useState(false);
  const accountButton = useRef<HTMLButtonElement>(null);
  const colors = useVaultColors();
  const { items, counts } = useAllItems(session, ctx.error);
  const totpCount = useMemo(() => items.filter((x) => x.item.payload.kind === "login" && x.item.payload.login.totp).length, [items]);
  const health = useMemo(() => healthSummary(items), [items]);
  // Étroit : le tiroir est ouvert pour une page ; en changer (lien, palette,
  // retour arrière) le referme sans rien d'autre à faire.
  const here = routeHash(route);
  const [openAt, setOpenAt] = useState<string | null>(null);
  const open = openAt === here;
  const setOpen = (o: boolean) => setOpenAt(o ? here : null);
  const narrow = useMediaQuery(NARROW);
  const touch = useMediaQuery(TOUCH);
  const menuButton = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLElement>(null);
  // Ouvert : le focus y entre, Échap le referme et le rend au bouton.
  useEffect(() => {
    if (!open || !narrow) return;
    drawer.current?.querySelector<HTMLElement>("a, button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpenAt(null);
      menuButton.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, narrow]);
  const activeVault = route.page === "vault" || route.page === "vault-settings" || route.page === "vault-tools" || route.page === "vault-trash" ? route.id : null;

  const go = (r: Route) => {
    navigate(r);
    setOpen(false);
  };

  const nav = (r: Route, active: boolean, icon: React.ReactNode, label: string, extra?: React.ReactNode) => (
    <a
      key={routeHash(r)}
      href={routeHash(r)}
      onClick={(e) => { e.preventDefault(); go(r); }}
      data-active={active ? "true" : undefined}
      aria-current={active ? "page" : undefined}
      className="nav-item"
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {extra}
    </a>
  );
  const vaultRow = (v: VaultView, sub?: React.ReactNode) => nav(
    { page: "vault", id: v.id },
    activeVault === v.id,
    <span className="vdot" style={{ background: vaultColor(v.id, v.kind === "personal", colors) }} />,
    v.name,
    <>
      {sub}
      {counts[v.id] !== undefined && <span className="shrink-0 text-[12px] tabular-nums text-[var(--c-text-muted)]">{counts[v.id]}</span>}
    </>,
  );
  const label = (text: string, action?: React.ReactNode) => (
    <div className="flex h-7 items-center justify-between px-2.5 text-[12px] font-medium text-[var(--c-text-muted)]">
      <span>{text}</span>
      {action}
    </div>
  );
  const name = local ? coffreName(local.path) : session.user.email;

  const list = (
    <div className="flex h-full flex-col gap-4 px-3 pb-3 pt-4">
      {/* Le logo ramène à l'accueil. */}
      <a
        href={routeHash({ page: "home" })}
        onClick={(e) => { e.preventDefault(); go({ page: "home" }); }}
        className="flex items-center gap-2.5 px-1.5 text-[var(--c-text)]"
        title="Accueil"
      >
        <Logo size={28} />
        <span className="text-[15.5px] font-semibold tracking-[-0.01em]">GuiVault</span>
      </a>
      <button onClick={() => { setOpen(false); onSearch(); }} className="flex h-9 min-w-0 items-center gap-2.5 rounded-[9px] border border-[var(--c-border)] bg-[var(--c-surface)] px-2.5 text-left text-[13px] text-[var(--c-text-muted)] hover:border-[var(--c-border-strong)]" title="Rechercher dans tous les vaults">
        <IconSearch size={14} />
        <span className="min-w-0 flex-1 truncate">Rechercher partout</span>
        {!touch && <span className="kbd">Ctrl K</span>}
      </button>

      <div className="sidebar-scroll -mx-1 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-1">
        <nav aria-label="Général" className="flex flex-col gap-0.5">
          {nav({ page: "home" }, route.page === "home", <IconHome size={16} />, "Accueil")}
          {supports("myInvitations") && session.invitations.length > 0 && nav({ page: "invitations" }, route.page === "invitations", <IconBell size={16} />, "Invitations", <span className="tag tag-accent">{session.invitations.length}</span>)}
        </nav>

        <nav aria-label="Coffres" className="flex flex-col gap-0.5">
          {label("Coffres", <button onClick={() => setCreating(true)} className="btn btn-ghost btn-sm btn-icon -mr-1.5 h-6 w-6" title={local ? "Nouveau vault" : "Nouveau vault partagé"} aria-label={local ? "Nouveau vault" : "Nouveau vault partagé"}><IconPlus size={13} /></button>)}
          {session.vaults.map((v) => vaultRow(v, v.kind !== "personal" && !local ? <span title={`Partagé · ${ROLE_LABELS[v.role]}`} className="flex shrink-0 text-[var(--c-text-muted)]"><IconUsers size={14} /></span> : undefined))}
        </nav>

        {/* Les vaults qu'un accès d'urgence nous remet : à part, en lecture. */}
        {session.emergencyVaults.length > 0 && (
          <nav aria-label="Confiés" className="flex flex-col gap-0.5">
            {label("Confiés")}
            {session.emergencyVaults.map((v) => vaultRow(v, <span title={`Confié par ${v.emergency?.grantor}, en lecture seule`} className="flex shrink-0 text-[var(--c-text-muted)]"><IconLifebuoy size={13} /></span>))}
          </nav>
        )}

        <nav aria-label="Outils" className="flex flex-col gap-0.5">
          {label("Outils")}
          {nav({ page: "generator" }, route.page === "generator", <IconDice size={16} />, "Générateur")}
          {nav({ page: "totp" }, route.page === "totp", <IconShieldClock size={16} />, "Codes 2FA", totpCount > 0 ? <span className="shrink-0 text-[12px] tabular-nums text-[var(--c-text-muted)]">{totpCount}</span> : undefined)}
          {supports("sends") && nav({ page: "sends" }, route.page === "sends", <IconLink size={16} />, "Liens de partage")}
        </nav>

        <nav aria-label="Sécurité" className="flex flex-col gap-0.5">
          {label("Sécurité")}
          {nav({ page: "health" }, route.page === "health", <IconPulse size={16} />, "Santé", health.issues > 0 ? <span className="badge" title={`${health.issues} élément(s) à traiter`}>{health.issues}</span> : undefined)}
          {session.emergency && nav({ page: "settings", section: "urgence" }, route.page === "settings" && route.section === "urgence", <IconLifebuoy size={16} />, "Accès d'urgence")}
          {session.user.is_admin && nav({ page: "admin" }, route.page === "admin", <IconDatabase size={16} />, "Administration")}
        </nav>
      </div>

      <div className="flex flex-col gap-2">
        <div className="relative flex min-w-0 items-center gap-1.5">
          <button
            ref={accountButton}
            onClick={() => setAccountMenu((m) => !m)}
            aria-haspopup="menu"
            aria-expanded={accountMenu}
            aria-label="Menu du compte"
            className="flex min-w-0 flex-1 items-center gap-2.5 rounded-[10px] border border-[var(--c-border)] bg-[var(--c-surface)] p-2 text-left hover:border-[var(--c-border-strong)]"
            title={local ? local.path : session.user.email}
          >
            <span className="tile h-[30px] w-[30px] rounded-full text-[12px]" style={{ "--tile-h": 238 } as React.CSSProperties}>{personInitials(name)}</span>
            <span className="flex min-w-0 flex-1 flex-col leading-tight">
              <span className="truncate text-[13px] font-medium text-[var(--c-text)]">{name}</span>
              <span className="truncate text-[12px] text-[var(--c-text-muted)]">{local ? "Coffre local" : "Compte"}</span>
            </span>
          </button>
          <a
            href={routeHash({ page: "settings", section: "apparence" })}
            onClick={(e) => { e.preventDefault(); go({ page: "settings", section: "apparence" }); }}
            data-active={route.page === "settings" ? "true" : undefined}
            className={`btn btn-icon shrink-0 ${route.page === "settings" ? "btn-toggled" : "btn-secondary"}`}
            title="Paramètres"
            aria-label="Paramètres"
          >
            <IconSettings size={15} />
          </a>
          {accountMenu && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setAccountMenu(false)} />
              <div className="popover absolute bottom-full left-0 z-20 mb-1.5 w-full py-1" role="menu">
                <button role="menuitem" className="menu-item" onClick={() => { setAccountMenu(false); go({ page: "settings", section: "compte" }); }}><IconIdentity size={14} /> {local ? "Coffre local" : "Compte"}</button>
                <button role="menuitem" className="menu-item" onClick={() => { setAccountMenu(false); go({ page: "settings", section: "securite" }); }}><IconShield size={14} /> Sécurité</button>
                <div className="menu-sep" />
                <button role="menuitem" className="menu-item text-[var(--c-danger-text)]" onClick={() => { setAccountMenu(false); onLogout(); }}><IconLogout size={14} /> {local ? "Fermer le coffre" : "Se déconnecter"}</button>
              </div>
            </>
          )}
        </div>
        <button onClick={onLock} className="btn btn-secondary w-full" title="Verrouiller maintenant">
          <IconLock size={14} /> Verrouiller<span className="flex-1" />{!touch && systemBridge() && <span className="kbd">Ctrl L</span>}
        </button>
      </div>
    </div>
  );

  return (
    <>
      {/* Étroit : un bouton en haut ouvre la barre en tiroir. Le titre de la
          page est juste à côté, le bouton ne le répète pas. */}
      <div className="fixed left-2 top-2 z-30 md:hidden">
        <button ref={menuButton} onClick={() => setOpen(true)} className="btn btn-secondary btn-sm btn-icon" aria-label="Menu" title="Menu" aria-expanded={open}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.5 4h11M2.5 8h11M2.5 12h11" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" /></svg>
        </button>
      </div>
      {open && <div className="fixed inset-0 z-30 bg-black/50 md:hidden" onClick={() => setOpen(false)} />}
      {/* Large : la largeur réglée à la poignée (la bordure est la poignée) ;
          étroit : un tiroir de largeur fixe. */}
      <aside
        ref={drawer}
        // Fermé en étroit, il est hors de l'écran : ni focus ni lecteur d'écran.
        inert={narrow && !open}
        aria-label="Navigation"
        style={{ "--sidebar-w": `${width}px` } as React.CSSProperties}
        className={`fixed inset-y-0 left-0 z-40 w-64 border-r border-[var(--c-border)] bg-[var(--c-bg)] transition-transform md:static md:z-auto md:w-[var(--sidebar-w)] md:translate-x-0 md:border-r-0 ${open ? "translate-x-0" : "-translate-x-full"}`}
      >
        {list}
      </aside>

      {creating && (
        <CreateVaultDialog
          local={!!local}
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

function CreateVaultDialog({ local, onClose, onCreate }: { local: boolean; onClose: () => void; onCreate: (name: string) => Promise<void> }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={local ? "Nouveau vault" : "Nouveau vault partagé"} onClose={onClose}>
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
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder={local ? "Travail" : "Équipe réseau"} className="input" />
          <span className="help-text mt-1 block">{local ? "Chiffré comme le reste, sous sa propre clé : un vault de plus pour ranger, dans ce coffre." : "Chiffré comme le reste : le serveur ne le lit pas. Vous en êtes propriétaire ; invitez ensuite des membres depuis ses réglages."}</span>
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn btn-ghost">Annuler</button>
          <button type="submit" disabled={!name.trim() || busy} className="btn btn-primary">Créer</button>
        </div>
      </form>
    </Modal>
  );
}
