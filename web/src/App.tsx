import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { setSessionLostHandler, subscribeEvents } from "./lib/api";
import { navigate, useRoute } from "./lib/route";
import { logout, refresh, wipe, type SessionState } from "./lib/session";
import { LoginScreen } from "./components/LoginScreen";
import { Sidebar } from "./components/Sidebar";
import { VaultPage } from "./components/VaultPage";
import { VaultSettings } from "./components/VaultSettings";
import { AccountPage } from "./components/AccountPage";
import { InvitationsPage } from "./components/InvitationsPage";
import { Toasts, useToasts } from "./components/ui";

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
  const [session, setSession] = useState<SessionState | null>(null);
  const [vaultTicks, setVaultTicks] = useState<Record<string, number>>({});
  const { toasts, notify, error, dismiss } = useToasts();
  const route = useRoute();
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const reload = useCallback(async () => {
    const s = sessionRef.current;
    if (!s) return;
    try {
      const warnings = await refresh(s);
      warnings.forEach(error);
      setSession({ ...s });
    } catch (e) {
      error(e instanceof Error ? e.message : String(e));
    }
  }, [error]);

  // Le jeton n'est plus accepté et n'a pas pu être rafraîchi : retour à la
  // connexion, en le disant.
  useEffect(() => {
    setSessionLostHandler(() => {
      if (sessionRef.current) {
        setSession(null);
        error("Session expirée ou révoquée : reconnectez-vous.");
      }
    });
    return () => setSessionLostHandler(null);
  }, [error]);

  // Flux d'événements : un vault modifié ailleurs, une invitation reçue.
  useEffect(() => {
    if (!session) return;
    const sub = subscribeEvents((ev) => {
      if (ev.type === "vault_changed") {
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
    if (s) wipe(s);
    setSession(null);
    navigate({ page: "home" });
  }, []);

  const ctx = useMemo<PageContext | null>(() => (session ? { session, reload, notify, error, vaultTicks } : null), [session, reload, notify, error, vaultTicks]);

  if (!ctx) {
    return (
      <div className="h-full overflow-y-auto bg-[var(--c-bg)] text-[var(--c-text)]">
        <LoginScreen onSession={(s) => { setSession(s); navigate({ page: "home" }); }} />
        <Toasts toasts={toasts} onDismiss={dismiss} />
      </div>
    );
  }

  // Sans page choisie : le premier vault (le personnel).
  const effective = route.page === "home" && ctx.session.vaults[0] ? { page: "vault" as const, id: ctx.session.vaults[0].id } : route;

  let page;
  switch (effective.page) {
    case "vault":
      page = <VaultPage key={effective.id} ctx={ctx} vaultId={effective.id} />;
      break;
    case "vault-settings":
      page = <VaultSettings key={effective.id} ctx={ctx} vaultId={effective.id} />;
      break;
    case "account":
      page = <AccountPage ctx={ctx} onLogout={onLogout} />;
      break;
    case "invitations":
      page = <InvitationsPage ctx={ctx} />;
      break;
    default:
      page = <p className="p-6 text-[12.5px] text-[var(--c-text-muted)]">Aucun vault.</p>;
  }

  return (
    <div className="flex h-full w-full overflow-hidden bg-[var(--c-bg)] text-[var(--c-text)]">
      <Sidebar ctx={ctx} route={effective} onLogout={onLogout} />
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-[var(--c-bg2)]">{page}</main>
      <Toasts toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
