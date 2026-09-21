import { useState } from "react";
import type { Login } from "../lib/types";
import { TotpCode } from "./TotpCode";
import { IconLogin } from "./secret-icons";
import { IconSearch, IconVault } from "./ui-icons";

export interface TotpEntry {
  id: string;
  vaultName: string;
  login: Login;
}

/** L'authentificateur : tous les identifiants qui ont un secret TOTP, avec
 * leur code en direct — ce qu'on ouvre quand un autre site demande « le
 * code de votre application ». Partagé par l'interface web et l'extension. */
export function TotpList({ entries, compact, emptyMessage = "Aucun identifiant n'a de secret TOTP. Ajoutez-en un dans la fiche d'un identifiant (URI otpauth:// ou QR code)." }: { entries: TotpEntry[]; compact?: boolean; emptyMessage?: string }) {
  const [q, setQ] = useState("");
  const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = entries
    .filter((e) => e.login.totp)
    .filter((e) => terms.every((t) => `${e.login.name} ${e.login.username} ${e.vaultName} ${e.login.uris.map((u) => u.uri).join(" ")}`.toLowerCase().includes(t)))
    .sort((a, b) => a.login.name.localeCompare(b.login.name));
  return (
    <div>
      <div className="relative mb-2">
        <IconSearch size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--c-text-muted)]" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher un code…" aria-label="Rechercher un code" className="input pl-7" />
      </div>
      {shown.length === 0 && <p className="px-2 py-6 text-center text-[12px] text-[var(--c-text-muted)]">{entries.some((e) => e.login.totp) ? "Rien ne correspond." : emptyMessage}</p>}
      {shown.map((e) => (
        <div key={e.id} className={`list-row mb-0.5 flex-wrap ${compact ? "py-1.5" : "py-2"}`}>
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--c-bg3)] text-[var(--c-text-secondary)]"><IconLogin size={12} /></span>
          <span className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="truncate text-[12.5px] font-medium text-[var(--c-text)]">{e.login.name}</span>
            <span className="flex items-center gap-1 truncate text-[10.5px] text-[var(--c-text-muted)]">{e.login.username || "—"}{!compact && <><span>·</span><IconVault size={10} /> {e.vaultName}</>}</span>
          </span>
          <TotpCode secret={e.login.totp!} />
        </div>
      ))}
    </div>
  );
}
