import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { currentTokens, setSessionLostHandler, setTokens, setTokensChangedHandler, subscribeEvents } from "./lib/api";
import { pullSettings, startSettingsSync, stopSettingsSync } from "./lib/syncedSettings";
import "./lib/settingsSections";
import { clearWebSession, loadLockMinutes, loadWebSession, saveWebSession, saveWebTokens, touchWebSession, webSessionIdle } from "./lib/persist";
import { loadAppLock, LOCK_MESSAGES } from "./lib/appSettings";
import { navigate, routeHash, useRoute, type Route } from "./lib/route";
import { acceptRollback, closeLocal, logout, refresh, wipe, type SessionState } from "./lib/session";
import { refreshOfflineCopy } from "./lib/offline";
import { LoginScreen } from "./components/LoginScreen";
import { Sidebar } from "./components/Sidebar";
import { VaultPage } from "./components/VaultPage";
import { VaultSettings } from "./components/VaultSettings";
import { SettingsPage } from "./components/SettingsPage";
import { InvitationsPage } from "./components/InvitationsPage";
import { GeneratorPage } from "./components/GeneratorPanel";
import { ToolsPage } from "./components/ToolsPage";
import { TotpPage } from "./components/TotpPage";
import { TrashPage } from "./components/TrashPage";
import { clearSearchCache, SearchPalette } from "./components/SearchPalette";
import { RollbackBanner } from "./components/RollbackBanner";
import { EmergencyBanner } from "./components/EmergencySettings";
import { SendView } from "./components/SendView";
import { SendsPage } from "./components/SendsPage";
import { AdminPage } from "./components/AdminPage";
import { HealthPage } from "./components/HealthPage";
import { HomePage } from "./components/HomePage";
import { MobileMenu } from "./components/MobileMenu";
import { MobileNav, mobileTabs, rememberVault, tabOf } from "./components/MobileNav";
import { NARROW, useMediaQuery } from "./hooks/useMediaQuery";
import { clearAllItems } from "./lib/allItems";
import { AutoTypeHost } from "./components/AutoType";
import { autoTypeBridge, bubbleBridge, systemBridge, updaterBridge } from "./lib/platform";
import { Toasts, useToasts } from "./components/ui";
import { PaneHandle, usePersistedPane } from "./hooks/usePersistedPane";

/** Ce que chaque page reçoit : la session, et de quoi la recharger, notifier,
 * signaler une erreur. */
/** Les pages d'un onglet mobile (`MobileNav`). */
const TAB_PAGES = new Set<Route["page"]>(["home", "vault", "totp", "health", "generator", "more"]);

/** Un geste qui peut changer d'onglet : pas depuis un bord (le geste
 * « retour » d'Android), ni depuis un champ, un curseur, une rangée qui
 * défile de côté, une fiche ouverte ou une fenêtre. */
function swipeable(target: EventTarget, x: number): boolean {
  if (x < 24 || x > window.innerWidth - 24) return false;
  for (let el = target as HTMLElement | null; el && el !== document.body; el = el.parentElement) {
    if (el.matches("input, textarea, select, [role=slider], [data-noswipe], .modal")) return false;
    const style = getComputedStyle(el);
    if ((style.overflowX === "auto" || style.overflowX === "scroll") && el.scrollWidth > el.clientWidth) return false;
  }
  return true;
}

/** Ce qui fait « une autre page » pour l'animation : pas l'élément ouvert
 * dans un vault (sinon le vault se rechargerait). */
function pageKey(r: Route): string {
  return r.page === "vault" ? `vault:${r.id}` : routeHash(r);
}

export interface PageContext {
  session: SessionState;
  /** Recharge vaults et invitations (`/sync`) et redessine. */
  reload: () => Promise<void>;
  notify: (m: string) => void;
  error: (m: string) => void;
  /** Incrémenté quand le serveur signale qu'un vault a changé (SSE) — la
   * page du vault recharge ses items. */
  vaultTicks: Record<string, number>;
  /** La recherche globale (Ctrl K) ; en mobile, plein écran. */
  search: () => void;
  /** Verrouiller à la main. */
  lock: () => void;
}

/** `Welcome` : l'écran sans session — la connexion au serveur qui sert la
 * page, ou, dans l'application, l'accueil qui choisit un serveur ou un
 * coffre local (`web/app`). */
export default function App({ Welcome = LoginScreen }: { Welcome?: ComponentType<{ onSession: (s: SessionState) => void }> }) {
  // La session de l'onglet d'avant rechargement, si le délai d'inactivité
  // ne l'a pas effacée — sinon on repart de la connexion, en le disant.
  const restored = useRef(loadWebSession());
  const [session, setSession] = useState<SessionState | null>(() => (restored.current !== null && restored.current !== "expired" ? restored.current.state : null));
  const [vaultTicks, setVaultTicks] = useState<Record<string, number>>({});
  const { toasts, notify, error, dismiss } = useToasts();
  const route = useRoute();
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const [booting, setBooting] = useState(restored.current !== null && restored.current !== "expired");

  const reload = useCallback(async () => {
    const s = sessionRef.current;
    if (!s || s.offline) return;
    try {
      const warnings = await refresh(s);
      warnings.forEach(error);
      setSession({ ...s });
      if (currentTokens()) saveWebSession(s, currentTokens()!);
      // La copie hors ligne, si elle est activée sur cet appareil, suit.
      void refreshOfflineCopy(s).catch(() => {});
    } catch (e) {
      error(e instanceof Error ? e.message : String(e));
    }
  }, [error]);

  // L'application : une mise à jour publiée se signale une fois, peu après
  // le démarrage ; s'il n'y a pas de réseau, rien.
  useEffect(() => {
    const updater = updaterBridge();
    if (!updater) return;
    const t = setTimeout(() => {
      updater.check().then(({ update }) => {
        if (update) notify(`Mise à jour disponible : ${update.version} — Paramètres › Application.`);
      }).catch(() => {});
    }, 8000);
    return () => clearTimeout(t);
  }, [notify]);

  // Le jeton n'est plus accepté et n'a pas pu être rafraîchi : retour à la
  // connexion, en le disant.
  useEffect(() => {
    setSessionLostHandler(() => {
      if (sessionRef.current) {
        clearWebSession();
        setSession(null);
        error("Session expirée ou révoquée : reconnectez-vous.");
      }
    });
    return () => setSessionLostHandler(null);
  }, [error]);

  // Reprise après rechargement : les jetons, puis `/sync` pour les
  // invitations et les vaults qui ont bougé entre-temps.
  useEffect(() => {
    const r = restored.current;
    restored.current = null;
    if (r === "expired") {
      error("Verrouillé après inactivité : reconnectez-vous.");
      return;
    }
    if (!r) return;
    setTokens(r.tokens);
    void reload().finally(() => setBooting(false));
  }, [reload, error]);

  // La session survit au rechargement (`sessionStorage`), pas à l'onglet ;
  // les jetons qui tournent y sont recopiés, et chaque geste repousse le
  // délai d'inactivité — dépassé, tout est effacé, comme dans l'extension.
  useEffect(() => {
    setTokensChangedHandler((t) => { if (t) saveWebTokens(t); });
    return () => setTokensChangedHandler(null);
  }, []);
  // Verrouiller : effacer la session d'ici (et fermer un coffre local), le
  // dire. Le même geste pour l'inactivité et pour ce que dit le système.
  const lockNow = useCallback((message: string, tone: "error" | "notify" = "error") => {
    const s = sessionRef.current;
    if (!s) return;
    clearWebSession();
    if (s.local) void closeLocal();
    wipe(s);
    setSession(null);
    navigate({ page: "home" });
    (tone === "error" ? error : notify)(message);
  }, [error, notify]);
  // « Verrouiller » (barre latérale, Ctrl+L dans l'application) : les clés
  // s'effacent, la session du serveur reste ; on rouvre avec le mot de passe.
  const lockByHand = useCallback(() => lockNow("Verrouillé.", "notify"), [lockNow]);

  useEffect(() => {
    if (!session) return;
    const touch = () => touchWebSession();
    const events = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
    events.forEach((ev) => window.addEventListener(ev, touch, { passive: true }));
    const timer = setInterval(() => {
      void (async () => {
        let idle = webSessionIdle();
        // L'application peut compter l'inactivité sur tout l'ordinateur.
        const sys = systemBridge();
        const minutes = loadLockMinutes();
        if (sys && minutes > 0 && loadAppLock().idleScope === "system") {
          const ms = await sys.idleMs();
          if (ms !== null) idle = ms > minutes * 60_000;
        }
        if (idle && sessionRef.current) lockNow("Verrouillé après inactivité : reconnectez-vous.");
      })();
    }, 15_000);
    return () => {
      events.forEach((ev) => window.removeEventListener(ev, touch));
      clearInterval(timer);
    };
    // `session` identity only matters for connect/disconnect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session !== null, lockNow]);

  // Le système demande de verrouiller (session Windows, veille, réduction).
  useEffect(() => {
    const sys = systemBridge();
    if (!session || !sys) return;
    return sys.onLock((reason) => lockNow(LOCK_MESSAGES[reason]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session !== null, lockNow]);

  // Les réglages synchronisés : relus à la connexion, envoyés quand ils
  // changent ici (`syncedSettings.ts`).
  useEffect(() => {
    const s = sessionRef.current;
    if (!s || s.offline) return;
    void startSettingsSync(s.account.userKey);
    return () => stopSettingsSync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session !== null]);

  // Flux d'événements : un vault modifié ailleurs, une invitation reçue,
  // des réglages changés sur un autre appareil.
  useEffect(() => {
    if (!session || session.offline) return;
    const sub = subscribeEvents((ev) => {
      if (ev.type === "settings_changed") {
        void pullSettings();
      } else if (ev.type === "vault_changed") {
        // `/sync` d'abord : une rotation de clé change la clé du vault, et
        // la page doit relire les items avec la nouvelle, pas l'ancienne.
        void reload().finally(() => setVaultTicks((t) => ({ ...t, [ev.vault_id]: (t[ev.vault_id] ?? 0) + 1 })));
      } else {
        void reload();
        if (ev.type === "invitation_received") notify("Nouvelle invitation reçue.");
      }
    });
    return () => sub.stop();
    // `session` identity only matters for connect/disconnect, not on every reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session !== null, reload, notify]);

  const onLogout = useCallback(async () => {
    const s = sessionRef.current;
    try {
      await logout();
    } catch {
      // Le serveur ne répond plus ? La session locale s'efface quand même.
    }
    clearWebSession();
    if (s) wipe(s);
    setSession(null);
    navigate({ page: "home" });
  }, []);

  // La recherche globale : Ctrl+K (Cmd+K), partout, même dans un champ.
  const [search, setSearch] = useState(false);
  // Stable : `useModalSurface` rend le focus à l'ouvreur quand `onClose`
  // change, ce qu'une fonction recréée à chaque rendu ferait sans cesse.
  const closeSearch = useCallback(() => setSearch(false), []);
  const openSearch = useCallback(() => setSearch(true), []);
  useEffect(() => {
    if (!session) {
      setSearch(false);
      clearSearchCache();
      clearAllItems();
      return;
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearch((s) => !s);
      }
      // Dans le navigateur, Ctrl+L est la barre d'adresse : seulement l'app.
      if (systemBridge() && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        lockByHand();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // `session` identity only matters for connect/disconnect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session !== null, lockByHand]);

  // La barre latérale se redimensionne à la souris, comme dans Guiterm.
  const sidebar = usePersistedPane("sidebar", { initial: 256, min: 200, max: 480, axis: "horizontal", mode: "px" });
  // La bulle d'Android (s'il y en a une) suit l'état du coffre : grise une
  // fois verrouillé, sans jamais rien montrer d'autre que le logo.
  const unlocked = session !== null;
  useEffect(() => { void bubbleBridge()?.setLocked(!unlocked).catch(() => {}); }, [unlocked]);
  // Mobile : la barre d'onglets du bas remplace la barre latérale.
  const narrow = useMediaQuery(NARROW);
  const vaultRoute = route.page === "vault" ? route.id : null;
  useEffect(() => { if (vaultRoute) rememberVault(vaultRoute); }, [vaultRoute]);

  // Mobile : glisser à gauche ou à droite passe à l'onglet voisin.
  const swipeStart = useRef<{ x: number; y: number; t: number } | null>(null);
  const [swipe, setSwipe] = useState<{ key: string; dir: "next" | "prev" }>({ key: "", dir: "next" });
  const onSwipeStart = useCallback((e: React.TouchEvent) => {
    const t = e.touches[0];
    swipeStart.current = e.touches.length === 1 && swipeable(e.target, t.clientX) ? { x: t.clientX, y: t.clientY, t: Date.now() } : null;
  }, []);
  const ctx = useMemo<PageContext | null>(() => (session ? { session, reload, notify, error, vaultTicks, search: openSearch, lock: lockByHand } : null), [session, reload, notify, error, vaultTicks, openSearch, lockByHand]);

  const onSwipeEnd = (e: React.TouchEvent) => {
    const start = swipeStart.current;
    swipeStart.current = null;
    if (!start || !ctx || !TAB_PAGES.has(route.page)) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Math.abs(dx) < 70 || Math.abs(dx) < 2 * Math.abs(dy) || Date.now() - start.t > 700) return;
    const tabs = mobileTabs(ctx).filter((x) => x.route);
    const i = tabs.findIndex((x) => x.key === tabOf(route));
    const next = tabs[i + (dx < 0 ? 1 : -1)];
    if (i < 0 || !next?.route) return;
    setSwipe({ key: pageKey(next.route), dir: dx < 0 ? "next" : "prev" });
    navigate(next.route);
  };

  // Un lien de partage s'ouvre sans compte, et hors de l'application.
  if (route.page === "send") {
    return (
      <div className="h-full overflow-y-auto bg-[var(--c-bg)] text-[var(--c-text)]">
        <SendView id={route.id} secret={route.secret} />
      </div>
    );
  }

  if (!ctx) {
    return (
      <div className="app-root h-full overflow-y-auto bg-[var(--c-bg)] text-[var(--c-text)]">
        <Welcome onSession={(s) => { const t = currentTokens(); if (t) saveWebSession(s, t); setSession(s); navigate({ page: "home" }); if (!s.offline) void refreshOfflineCopy(s).catch(() => {}); }} />
        <Toasts toasts={toasts} onDismiss={dismiss} />
      </div>
    );
  }

  const effective = route;

  let page;
  if (booting) {
    page = <p className="p-6 text-[12.5px] text-[var(--c-text-muted)]">Reprise de la session…</p>;
  } else switch (effective.page) {
    case "home":
      page = <HomePage ctx={ctx} />;
      break;
    case "vault":
      page = <VaultPage key={effective.id} ctx={ctx} vaultId={effective.id} itemId={effective.item} create={effective.create} />;
      break;
    case "vault-settings":
      page = <VaultSettings key={effective.id} ctx={ctx} vaultId={effective.id} />;
      break;
    case "settings":
      page = <SettingsPage ctx={ctx} section={effective.section} />;
      break;
    case "more":
      page = narrow ? <MobileMenu ctx={ctx} onLock={lockByHand} onLogout={() => void onLogout()} /> : <SettingsPage ctx={ctx} section="apparence" />;
      break;
    case "vault-tools":
      page = <ToolsPage key={effective.id} ctx={ctx} vaultId={effective.id} />;
      break;
    case "vault-trash":
      page = <TrashPage key={effective.id} ctx={ctx} vaultId={effective.id} />;
      break;
    case "invitations":
      page = <InvitationsPage ctx={ctx} />;
      break;
    case "generator":
      page = <GeneratorPage />;
      break;
    case "totp":
      page = <TotpPage ctx={ctx} />;
      break;
    case "sends":
      page = <SendsPage ctx={ctx} />;
      break;
    case "health":
      page = <HealthPage ctx={ctx} />;
      break;
    case "admin":
      page = <AdminPage ctx={ctx} />;
      break;
    default:
      page = <p className="p-6 text-[12.5px] text-[var(--c-text-muted)]">Aucun vault.</p>;
  }

  return (
    <div className={`app-root flex h-full w-full overflow-hidden bg-[var(--c-bg)] text-[var(--c-text)] ${narrow ? "flex-col" : ""}`}>
      {!narrow && <Sidebar ctx={ctx} route={effective} onLogout={onLogout} onLock={lockByHand} onSearch={openSearch} width={sidebar.value} />}
      {!narrow && <PaneHandle onMouseDown={sidebar.onMouseDown} />}
      <main className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--c-bg2)] ${sidebar.isDragging ? "pointer-events-none select-none" : ""}`}>
        {ctx.session.offline && (
          <div role="status" className="shrink-0 px-4 pt-3">
            <div className="callout callout-warn flex flex-wrap items-center gap-3 text-[12.5px]">
              <p className="min-w-0 flex-1">
                <span className="font-medium">Hors ligne</span> — la copie de cet appareil, mise à jour le {new Date(ctx.session.offline.savedAt).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}. Lecture seule : ce qui a changé depuis sur le serveur n'y est pas.
              </p>
              <button onClick={() => void onLogout()} className="btn btn-secondary btn-sm">Se reconnecter</button>
            </div>
          </div>
        )}
        <RollbackBanner rollbacks={ctx.session.rollbacks} onAccept={(id) => { acceptRollback(ctx.session, id); setSession({ ...ctx.session }); }} />
        {route.page !== "settings" && <EmergencyBanner grants={ctx.session.emergency?.granted_by_me ?? []} onOpen={() => navigate({ page: "settings", section: "urgence" })} />}
        {/* Mobile : chaque page entre en mouvement (`touch.css`) — les
            onglets en fondu, le reste en glissant. La clé ne change pas
            d'un élément à l'autre d'un même vault. */}
        <div
          key={pageKey(effective)}
          className={`flex min-h-0 flex-1 flex-col ${swipe.key === pageKey(effective) ? (swipe.dir === "next" ? "m-from-right" : "m-from-left") : TAB_PAGES.has(effective.page) ? "m-enter" : "m-push"}`}
          onTouchStart={narrow ? onSwipeStart : undefined}
          onTouchEnd={narrow ? onSwipeEnd : undefined}
        >
          {page}
        </div>
      </main>
      {narrow && <MobileNav ctx={ctx} route={effective} />}
      {search && <SearchPalette ctx={ctx} onClose={closeSearch} />}
      {autoTypeBridge() && <AutoTypeHost ctx={ctx} />}
      <Toasts toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
