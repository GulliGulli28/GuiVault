import { useEffect, useState } from "react";
import { parseTotp, totpCode, totpRemaining } from "../lib/totp";
import { CopyButton } from "./ui";

/** Le code TOTP courant d'un identifiant, avec le temps qui reste avant le
 * suivant. Recalculé chaque seconde ; le secret ne quitte pas la page. */
export function TotpCode({ secret, compact }: { secret: string; compact?: boolean }) {
  const params = parseTotp(secret);
  const [code, setCode] = useState<string>("");
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    if (!params) return;
    let cancelled = false;
    const tick = () => {
      totpCode(params).then((c) => { if (!cancelled) setCode(c); }).catch(() => { if (!cancelled) setCode(""); });
      setRemaining(totpRemaining(params));
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
    // Le secret suffit : `params` en dérive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secret]);

  if (!params) return <span className="text-[12px] text-[var(--c-danger)]">secret TOTP illisible</span>;
  const pretty = code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
  const fraction = remaining / params.period;
  return (
    <span className="flex items-center gap-2">
      <span className={`font-mono tabular-nums text-[var(--c-text)] ${compact ? "text-[12px]" : "text-[15px] tracking-[0.12em]"}`}>{pretty || "…"}</span>
      <span className="relative inline-block h-3.5 w-3.5" title={`${remaining} s`}>
        <svg viewBox="0 0 20 20" className="h-full w-full -rotate-90">
          <circle cx="10" cy="10" r="8" fill="none" stroke="var(--c-border)" strokeWidth="3" />
          <circle cx="10" cy="10" r="8" fill="none" stroke={remaining <= 5 ? "var(--c-warn)" : "var(--c-accent)"} strokeWidth="3" strokeDasharray={`${fraction * 50.27} 50.27`} />
        </svg>
      </span>
      {code && <CopyButton value={code} label="Copier le code" />}
    </span>
  );
}
