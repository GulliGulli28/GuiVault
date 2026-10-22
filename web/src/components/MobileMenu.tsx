import { useState } from "react";
import type { PageContext } from "../App";
import { supports } from "../lib/api";
import { coffreName } from "../lib/localHost";
import { LOCK_CHOICES, loadLockMinutes } from "../lib/persist";
import { applyPreferences, loadPreferences, savePreferences, type ColorModeChoice } from "../lib/preferences";
import { navigate, routeHash, type Route } from "../lib/route";
import { settingsChanged } from "../lib/syncedSettings";
import { personInitials } from "../lib/tiles";
import { settingsCategories } from "./SettingsPage";
import { IconBubble, IconLink, IconLogout } from "./secret-icons";
import { reduceToBubble, useAutoBubble } from "../lib/bubble";
import { BubbleButton } from "./BubbleButton";
import { IconBell, IconChevronRight, IconDatabase, IconLock } from "./ui-icons";

/** Mobile : l'onglet « Réglages » (maquette `MParametres`) — le compte, le
 * thème, les catégories des paramètres, les outils qui n'ont pas d'onglet,
 * puis verrouiller et se déconnecter. Chaque ligne ouvre la page du bureau. */
export function MobileMenu({ ctx, onLock, onLogout }: { ctx: PageContext; onLock: () => void; onLogout: () => void }) {
  const { session } = ctx;
  const local = session.local;
  const who = local ? coffreName(local.path) : session.user.email;
  const auto = useAutoBubble();
  const [mode, setMode] = useState<ColorModeChoice>(() => loadPreferences().colorMode);
  const setColorMode = (m: ColorModeChoice) => {
    const next = { ...loadPreferences(), colorMode: m };
    savePreferences(next);
    applyPreferences(next);
    settingsChanged("appearance");
    setMode(m);
  };
  // « Verrouiller après », à côté de « Sécurité ».
  const lock = LOCK_CHOICES.find((c) => c.value === loadLockMinutes())?.label.replace(" d'inactivité", "").replace(" de l'onglet", "");

  const row = (r: Route, label: string, value?: React.ReactNode, icon?: React.ReactNode) => (
    <a key={label} href={routeHash(r)} onClick={(e) => { e.preventDefault(); navigate(r); }} className="m-set">
      {icon && <span className="flex shrink-0 text-[var(--c-text-muted)]">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {value && <span className="max-w-[45%] shrink-0 truncate text-[14px] text-[var(--c-text-muted)]">{value}</span>}
      <IconChevronRight size={16} className="shrink-0 text-[var(--c-text-faint)]" />
    </a>
  );

  // Ce qui n'a pas d'onglet (le générateur en a un) ; rien en coffre local.
  const tools = [
    supports("sends") && row({ page: "sends" }, "Liens de partage", undefined, <IconLink size={18} />),
    supports("myInvitations") && session.invitations.length > 0 && row({ page: "invitations" }, "Invitations", String(session.invitations.length), <IconBell size={18} />),
    session.user.is_admin && row({ page: "admin" }, "Administration", undefined, <IconDatabase size={18} />),
  ].filter(Boolean);

  return (
    <div className="m-page">
      <header className="m-head"><h1 className="m-title min-w-0 flex-1 truncate">Réglages</h1><BubbleButton ctx={ctx} /></header>
      <div className="m-body">
        <a href={routeHash({ page: "settings", section: "compte" })} onClick={(e) => { e.preventDefault(); navigate({ page: "settings", section: "compte" }); }} className="m-card flex min-w-0 items-center gap-3 px-4 py-3.5 text-[var(--c-text)] hover:no-underline">
          <span className="tile shrink-0 rounded-full" style={{ "--tile-size": "44px", "--tile-h": 238, fontSize: 15 } as React.CSSProperties}>{personInitials(who)}</span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate font-semibold">{who}</span>
            <span className="truncate text-[14px] text-[var(--c-text-muted)]">{local ? "Coffre local" : location.host}</span>
          </span>
          <IconChevronRight size={16} className="shrink-0 text-[var(--c-text-faint)]" />
        </a>

        <section className="flex flex-col gap-2">
          <h2 className="m-section">Apparence</h2>
          <div className="segmented m-seg" role="radiogroup" aria-label="Thème">
            {(["dark", "light", "system"] as ColorModeChoice[]).map((m) => (
              <button key={m} role="radio" aria-checked={mode === m} data-active={mode === m ? "true" : undefined} onClick={() => setColorMode(m)}>
                {m === "dark" ? "Sombre" : m === "light" ? "Clair" : "Système"}
              </button>
            ))}
          </div>
        </section>

        {auto.state && (
          <section className="flex flex-col gap-2">
            <h2 className="m-section">Bulle</h2>
            <div className="m-card m-list">
              <div className="m-set">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span>En quittant l'application</span>
                  <span className="text-[13px] text-[var(--c-text-muted)]">Sinon, un bouton en haut des pages</span>
                </span>
                <button type="button" role="switch" aria-checked={auto.state.enabled} aria-label="Bulle en quittant l'application" onClick={() => auto.setEnabled(!auto.state!.enabled)} className="switch" />
              </div>
              {!auto.state.allowed && (
                <button onClick={auto.ask} className="m-set w-full text-left">
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span>Autoriser l'affichage par-dessus</span>
                    <span className="text-[13px] text-[var(--c-warn-text)]">Sans cette permission, pas de bulle</span>
                  </span>
                  <IconChevronRight size={16} className="shrink-0 text-[var(--c-text-faint)]" />
                </button>
              )}
              <button onClick={() => void reduceToBubble(ctx)} className="m-set w-full text-left"><IconBubble size={18} className="shrink-0 text-[var(--c-text-muted)]" /><span className="flex-1">Réduire en bulle maintenant</span></button>
            </div>
          </section>
        )}

        <section className="flex flex-col gap-2">
          <h2 className="m-section">Paramètres</h2>
          <div className="m-card m-list">
            {settingsCategories().map((c) => row({ page: "settings", section: c.key }, c.label, c.key === "securite" ? lock : undefined, <c.Icon size={18} />))}
          </div>
        </section>

        {tools.length > 0 && (
          <section className="flex flex-col gap-2">
            <h2 className="m-section">Outils</h2>
            <div className="m-card m-list">{tools}</div>
          </section>
        )}

        <div className="m-card m-list">
          <button onClick={onLock} className="m-set w-full text-left"><IconLock size={18} className="shrink-0 text-[var(--c-text-muted)]" /><span className="flex-1">Verrouiller maintenant</span></button>
          <button onClick={onLogout} className="m-set w-full text-left text-[var(--c-danger-text)]"><IconLogout size={18} className="shrink-0" /><span className="flex-1">{local ? "Fermer le coffre" : "Se déconnecter"}</span></button>
        </div>
      </div>
    </div>
  );
}
