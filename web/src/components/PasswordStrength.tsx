import { estimateStrength } from "../lib/generator";
import { t, translated } from "../lib/i18n";

/** Les mots de l'échelle (`estimateStrength` les rend en français, sans
 * dépendre de la langue : le script de page s'en sert aussi). */
export const STRENGTH_LABELS = translated(["très faible", "faible", "moyen", "fort", "très fort"]);

/** Une jauge en quatre crans et un mot : c'est une échelle, pas une
 * garantie (voir `estimateStrength`). */
export function PasswordStrength({ password, className = "" }: { password: string; className?: string }) {
  const s = estimateStrength(password);
  const color = s.score <= 1 ? "var(--c-danger)" : s.score === 2 ? "var(--c-warn)" : "var(--c-ok)";
  return (
    <span className={`flex items-center gap-2 ${className}`} title={t("≈ {0} bits", s.bits)}>
      <span className="flex gap-0.5">
        {[1, 2, 3, 4].map((i) => (
          <span key={i} className="h-1 w-4 rounded-sm" style={{ background: i <= s.score ? color : "var(--c-border)" }} />
        ))}
      </span>
      <span className="text-[11px] text-[var(--c-text-muted)]">{password ? STRENGTH_LABELS[s.score] : ""}</span>
    </span>
  );
}
