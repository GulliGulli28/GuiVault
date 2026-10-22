import type { PageContext } from "../App";
import { navigate, routeHash, type Route } from "../lib/route";
import { healthSummary, useAllItems } from "../lib/allItems";
import { IconBubble, IconHome, IconPulse, IconShieldClock } from "./secret-icons";
import { bubbleBridge, reduceToBubble } from "../lib/bubble";
import { IconSettings, IconVault } from "./ui-icons";

const LAST_VAULT = "guivault.lastVault";

/** Le vault que l'onglet « Coffres » rouvre : le dernier ouvert, sinon le
 * personnel. */
export function rememberVault(id: string) {
  try {
    localStorage.setItem(LAST_VAULT, id);
  } catch {
    // Stockage refusé (navigation privée) : on rouvrira le personnel.
  }
}

function vaultTab(ctx: PageContext): Route | null {
  const all = [...ctx.session.vaults, ...ctx.session.emergencyVaults];
  let last: string | null = null;
  try {
    last = localStorage.getItem(LAST_VAULT);
  } catch {
    last = null;
  }
  const v = all.find((x) => x.id === last) ?? ctx.session.vaults.find((x) => x.kind === "personal") ?? all[0];
  return v ? { page: "vault", id: v.id } : null;
}

/** L'onglet d'une page : ce que la barre du bas allume. */
function tabOf(route: Route): string {
  switch (route.page) {
    case "home": return "home";
    case "vault": case "vault-settings": case "vault-tools": case "vault-trash": case "invitations": return "vaults";
    case "totp": return "codes";
    case "health": return "health";
    default: return "more";
  }
}

/** Mobile (`docs/DESIGN.md`) : la barre d'onglets du bas, à la place de la
 * barre latérale — Accueil, Coffres, Codes, Santé, Réglages. */
export function MobileNav({ ctx, route }: { ctx: PageContext; route: Route }) {
  const { items } = useAllItems(ctx.session, ctx.error);
  const issues = healthSummary(items).issues;
  const vaults = vaultTab(ctx);
  const active = tabOf(route);
  const tabs: { key: string; label: string; route: Route | null; icon: React.ReactNode; badge?: number }[] = [
    { key: "home", label: "Accueil", route: { page: "home" }, icon: <IconHome size={22} /> },
    { key: "vaults", label: "Coffres", route: vaults, icon: <IconVault size={22} /> },
    { key: "codes", label: "Codes", route: { page: "totp" }, icon: <IconShieldClock size={22} /> },
    { key: "health", label: "Santé", route: { page: "health" }, icon: <IconPulse size={22} />, badge: issues },
    { key: "more", label: "Réglages", route: { page: "more" }, icon: <IconSettings size={22} /> },
  ];
  return (
    <nav aria-label="Principal" className="m-nav">
      {tabs.map((t) => t.route && (
        <a
          key={t.key}
          href={routeHash(t.route)}
          onClick={(e) => { e.preventDefault(); navigate(t.route!); }}
          aria-current={active === t.key ? "page" : undefined}
          className="m-tab"
        >
          <span className="relative">
            {t.icon}
            {!!t.badge && <span className="badge absolute -right-2.5 -top-1.5" aria-label={`${t.badge} à traiter`}>{t.badge}</span>}
          </span>
          <span className="truncate">{t.label}</span>
        </a>
      ))}
      {/* Android : se réduire en bulle, de n'importe quelle page. */}
      {bubbleBridge() && (
        <button onClick={() => void reduceToBubble(ctx)} className="m-tab m-tab-bubble" aria-label="Réduire en bulle" title="Réduire en bulle">
          <IconBubble size={22} />
          <span className="truncate">Bulle</span>
        </button>
      )}
    </nav>
  );
}
