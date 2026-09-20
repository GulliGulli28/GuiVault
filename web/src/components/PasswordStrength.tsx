import { estimateStrength } from "../lib/generator";

/** Une jauge en quatre crans et un mot : c'est une échelle, pas une
 * garantie (voir `estimateStrength`). */
export function PasswordStrength({ password, className = "" }: { password: string; className?: string }) {
  const s = estimateStrength(password);
  const color = s.score <= 1 ? "var(--c-danger)" : s.score === 2 ? "var(--c-warn)" : "var(--c-ok)";
  return (
    <span className={`flex items-center gap-2 ${className}`} title={`≈ ${s.bits} bits`}>
      <span className="flex gap-0.5">
        {[1, 2, 3, 4].map((i) => (
          <span key={i} className="h-1 w-4 rounded-sm" style={{ background: i <= s.score ? color : "var(--c-border)" }} />
        ))}
      </span>
      <span className="text-[11px] text-[var(--c-text-muted)]">{password ? s.label : ""}</span>
    </span>
  );
}
