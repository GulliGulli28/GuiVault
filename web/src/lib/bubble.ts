/** La bulle de l'application Android (`platform.ts`, `BubbleBridge`) : la
 * réduire à la main, et le réglage « en quittant l'application ». */
import { useCallback, useEffect, useState } from "react";
import type { PageContext } from "../App";
import { errorMessage } from "./api";
import { bubbleBridge } from "./platform";
import { t } from "./i18n";

export { bubbleBridge };

export async function reduceToBubble(ctx: Pick<PageContext, "notify" | "error">): Promise<void> {
  const b = bubbleBridge();
  if (!b) return;
  try {
    if (!(await b.show())) ctx.notify(t("Autorisez « Afficher par-dessus d'autres applis », puis réessayez."));
  } catch (e) {
    ctx.error(t("Bulle : {0}", errorMessage(e)));
  }
}

interface AutoState {
  enabled: boolean;
  allowed: boolean;
}

let state: AutoState | null = null;
const listeners = new Set<(s: AutoState) => void>();
const publish = (s: AutoState) => {
  state = s;
  listeners.forEach((f) => f(s));
};

/** Le réglage « bulle en quittant l'application » ; `null` hors de l'app
 * Android. Relu au retour dans l'app (la permission a pu changer). */
export function useAutoBubble(): { state: AutoState | null; setEnabled: (v: boolean) => void; ask: () => void } {
  const [s, setS] = useState<AutoState | null>(state);
  useEffect(() => {
    const b = bubbleBridge();
    if (!b) return;
    listeners.add(setS);
    const read = () => void b.auto().then(publish, () => {});
    read();
    const onVisible = () => { if (document.visibilityState === "visible") read(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      listeners.delete(setS);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  const setEnabled = useCallback((v: boolean) => void bubbleBridge()?.auto(v).then(publish, () => {}), []);
  const ask = useCallback(() => void bubbleBridge()?.ask(), []);
  return { state: s, setEnabled, ask };
}
