import type { PageContext } from "../App";
import { bubbleBridge, reduceToBubble, useAutoBubble } from "../lib/bubble";
import { IconBubble } from "./secret-icons";
import { t } from "../lib/i18n";

/** Android : « Réduire en bulle », en haut à droite des pages — seulement
 * si la bulle ne vient pas d'elle-même en quittant l'application (Réglages). */
export function BubbleButton({ ctx }: { ctx?: Pick<PageContext, "notify" | "error"> }) {
  const { state } = useAutoBubble();
  if (!bubbleBridge() || !state || state.enabled) return null;
  return (
    <button onClick={() => void reduceToBubble(ctx ?? { notify: () => {}, error: () => {} })} className="m-icon shrink-0 text-[var(--c-accent-text)]" aria-label={t("Réduire en bulle")} title={t("Réduire en bulle")}>
      <IconBubble size={20} />
    </button>
  );
}
