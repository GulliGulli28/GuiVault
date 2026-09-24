import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { currentTokens, setSessionLostHandler, setTokens, setTokensChangedHandler, subscribeEvents } from "./lib/api";
import { pullSettings, startSettingsSync, stopSettingsSync } from "./lib/syncedSettings";
import "./lib/settingsSections";
import { clearWebSession, loadWebSession, saveWebSession, saveWebTokens, touchWebSession, webSessionIdle } from "./lib/persist";
import { navigate, useRoute } from "./lib/route";
import { acceptRollback, logout, refresh, wipe, type SessionState } from "./lib/session";
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
import { Toasts, useToasts } from "./components/ui";
import { PaneHandle, usePersistedPane } from "./hooks/usePersistedPane";

/** Ce que chaque page reçoit : la session, et de quoi la recharger, notifier,
 * signaler une erreur. */
export interface PageContext {
  session: SessionState;
  /** Recharge vaults et invitations (`/sync`) et redessine. */
  reload: () => Promise<void>;
  notify: (m: string) => void;
  error: (m: string) => void;
  /** Incrémenté quand le serveur signale qu'un vault a changé (SSE) — la
   * page du vault recharge ses items. */
  vaultTicks: Record<string, number>;
}

export default function App() {
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
    if (!s) return;
    try {
      const warnings = await refresh(s);
      warnings.forEach(error);
      setSession({ ...s });
      if (currentTokens()) saveWebSession(s, currentTokens()!);
    } catch (e) {
      error(e instanceof Error ? e.message : String(e));
    }
  }, [error]);

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
  useEffect(() => {
    if (!session) return;
    const touch = () => touchWebSession();
    const events = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
    events.forEach((ev) => window.addEventListener(ev, touch, { passive: true }));
    const timer = setInterval(() => {
      if (webSessionIdle() && sessionRef.current) {
        clearWebSession();
        wipe(sessionRef.current);
        setSession(null);
        navigate({ page: "home" });
        error("Verrouillé après inactivité : reconnectez-vous.");
      }
    }, 15_000);
    return () => {
      events.forEach((ev) => window.removeEventListener(ev, touch));
      clearInterval(timer);
    };
    // `session` identity only matters for connect/disconnect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session !== null, error]);

  // Les réglages synchronisés : relus à la connexion, envoyés quand ils
  // changent ici (`syncedSettings.ts`).
  useEffect(() => {
    const s = sessionRef.current;
    if (!s) return;
    void startSettingsSync(s.account.userKey);
    return () => stopSettingsSync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session !== null]);

  // Flux d'événements : un vault modifié ailleurs, une invitation reçue,
  // des réglages changés sur un autre appareil.
  useEffect(() => {
    if (!session) return;
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
      return;
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearch((s) => !s);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // `session` identity only matters for connect/disconnect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session !== null]);

  // La barre latérale se redimensionne à la souris, comme dans Guiterm.
  const sidebar = usePersistedPane("sidebar", { initial: 256, min: 200, max: 480, axis: "horizontal", mode: "px" });

  const ctx = useMemo<PageContext | null>(() => (session ? { session, reload, notify, error, vaultTicks } : null), [session, reload, notify, error, vaultTicks]);

  if (!ctx) {
    return (
      <div className="h-full overflow-y-auto bg-[var(--c-bg)] text-[var(--c-text)]">
        <LoginScreen onSession={(s) => { const t = currentTokens(); if (t) saveWebSession(s, t); setSession(s); navigate({ page: "home" }); }} />
        <Toasts toasts={toasts} onDismiss={dismiss} />
      </div>
    );
  }

  // Sans page choisie : le premier vault (le personnel).
  const effective = route.page === "home" && ctx.session.vaults[0] ? { page: "vault" as const, id: ctx.session.vaults[0].id } : route;

  let page;
  if (booting) {
    page = <p className="p-6 text-[12.5px] text-[var(--c-text-muted)]">Reprise de la session…</p>;
  } else switch (effective.page) {
    case "vault":
      page = <VaultPage key={effective.id} ctx={ctx} vaultId={effective.id} itemId={effective.item} />;
      break;
    case "vault-settings":
      page = <VaultSettings key={effective.id} ctx={ctx} vaultId={effective.id} />;
      break;
    case "settings":
      page = <SettingsPage ctx={ctx} section={effective.section} />;
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
    default:
      page = <p className="p-6 text-[12.5px] text-[var(--c-text-muted)]">Aucun vault.</p>;
  }

  return (
    <div className="flex h-full w-full overflow-hidden bg-[var(--c-bg)] text-[var(--c-text)]">
      <Sidebar ctx={ctx} route={effective} onLogout={onLogout} onSearch={openSearch} width={sidebar.value} />
      <PaneHandle onMouseDown={sidebar.onMouseDown} />
      <main className={`flex min-w-0 flex-1 flex-col overflow-hidden bg-[var(--c-bg2)] ${sidebar.isDragging ? "pointer-events-none select-none" : ""}`}>
        <RollbackBanner rollbacks={ctx.session.rollbacks} onAccept={(id) => { acceptRollback(ctx.session, id); setSession({ ...ctx.session }); }} />
        {page}
      </main>
      {search && <SearchPalette ctx={ctx} onClose={closeSearch} />}
      <Toasts toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
