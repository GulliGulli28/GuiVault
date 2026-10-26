import type { PageContext } from "../App";
import { navigate, routeHash, type Route } from "../lib/route";
import { healthSummary, useAllItems } from "../lib/allItems";
import { IconDice, IconHome, IconPulse, IconShieldClock } from "./secret-icons";
import { IconSettings, IconVault } from "./ui-icons";
import { t } from "../lib/i18n";

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
    case "generator": return "generator";
    default: return "more";
  }
}

export interface MobileTab {
  key: string;
  label: string;
  route: Route | null;
  icon: React.ReactNode;
  badge?: number;
}

/** Les onglets, dans l'ordre (la barre, et le glissement d'un onglet à
 * l'autre dans `App`). */
export function mobileTabs(ctx: PageContext, issues = 0): MobileTab[] {
  return [
    { key: "home", label: t("Accueil"), route: { page: "home" }, icon: <IconHome size={22} /> },
    { key: "vaults", label: t("Coffres"), route: vaultTab(ctx), icon: <IconVault size={22} /> },
    { key: "codes", label: t("Codes"), route: { page: "totp" }, icon: <IconShieldClock size={22} /> },
    { key: "health", label: t("Santé"), route: { page: "health" }, icon: <IconPulse size={22} />, badge: issues },
    { key: "generator", label: t("Générateur"), route: { page: "generator" }, icon: <IconDice size={22} /> },
    { key: "more", label: t("Réglages"), route: { page: "more" }, icon: <IconSettings size={22} /> },
  ];
}

export { tabOf };

/** Mobile (`docs/DESIGN.md`) : la barre d'onglets du bas, à la place de la
 * barre latérale — Accueil, Coffres, Codes, Santé, Réglages. */
export function MobileNav({ ctx, route }: { ctx: PageContext; route: Route }) {
  const { items } = useAllItems(ctx.session, ctx.error);
  const issues = healthSummary(items).issues;
  const active = tabOf(route);
  const tabs = mobileTabs(ctx, issues);
  return (
    <nav aria-label={t("Principal")} className="m-nav">
      {tabs.map((tab) => tab.route && (
        <a
          key={tab.key}
          href={routeHash(tab.route)}
          onClick={(e) => { e.preventDefault(); navigate(tab.route!); }}
          aria-current={active === tab.key ? "page" : undefined}
          className="m-tab"
        >
          <span className="relative">
            {tab.icon}
            {!!tab.badge && <span className="badge absolute -right-2.5 -top-1.5" aria-label={t("{0} à traiter", tab.badge)}>{tab.badge}</span>}
          </span>
          <span className="truncate">{tab.label}</span>
        </a>
      ))}
    </nav>
  );
}
