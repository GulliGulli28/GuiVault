/** Le remplissage automatique de l'application Android (`platform.ts`,
 * `AutofillBridge`, `docs/REMPLISSAGE.md`) : l'index des identifiants du
 * coffre ouvert, que le service de remplissage propose aux autres
 * applications, et l'état du réglage. */
import { useCallback, useEffect, useState } from "react";
import { coffreName } from "./localHost";
import type { VaultItem } from "./allItems";
import { autofillBridge, type AutofillIndex } from "./platform";
import type { SessionState } from "./session";

export { autofillBridge };

/** Les identifiants (pas les autres secrets) de tous les vaults lisibles ;
 * les adresses « jamais » n'en sortent pas. */
export function buildAutofillIndex(session: SessionState, items: VaultItem[]): AutofillIndex {
  const entries: AutofillIndex["entries"] = [];
  for (const { vault, item } of items) {
    if (item.payload.kind !== "login") continue;
    const l = item.payload.login;
    if (!l.username && !l.password) continue;
    entries.push({
      id: item.id,
      name: l.name || l.username || "Sans nom",
      vault: vault.name,
      username: l.username,
      password: l.password,
      uris: l.uris.filter((u) => u.uri.trim() && u.match !== "never").map((u) => ({ uri: u.uri.trim(), match: u.match ?? null })),
    });
  }
  return { v: 1, label: session.local ? coffreName(session.local.path) : session.user.email, entries };
}

export interface AutofillStatus {
  supported: boolean;
  enabled: boolean;
  biometric: boolean;
}

/** L'état du réglage, relu au retour dans l'application (on vient peut-être
 * de choisir GuiVault dans les réglages d'Android). `null` hors de l'app. */
export function useAutofillStatus(): { status: AutofillStatus | null; refresh: () => void } {
  const [status, setStatus] = useState<AutofillStatus | null>(null);
  const refresh = useCallback(() => {
    void autofillBridge()?.status().then(setStatus, () => {});
  }, []);
  useEffect(() => {
    if (!autofillBridge()) return;
    refresh();
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);
  return { status, refresh };
}
