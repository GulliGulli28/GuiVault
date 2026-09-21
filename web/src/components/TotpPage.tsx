import { useEffect, useState } from "react";
import type { PageContext } from "../App";
import { errorMessage } from "../lib/api";
import { loadItems } from "../lib/session";
import { TotpList, type TotpEntry } from "./TotpList";
import { Loading, useDelayed } from "./ui";

/** L'authentificateur : les codes TOTP de tous les vaults au même endroit. */
export function TotpPage({ ctx }: { ctx: PageContext }) {
  const [entries, setEntries] = useState<TotpEntry[] | null>(null);
  const slow = useDelayed(entries === null);
  const vaultsKey = ctx.session.vaults.map((v) => `${v.id}:${v.revision}`).join(",");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const out: TotpEntry[] = [];
      for (const v of ctx.session.vaults) {
        try {
          const page = await loadItems(v);
          for (const it of page.items) if (it.ok && it.payload.kind === "login" && it.payload.login.totp) out.push({ id: it.id, vaultName: v.name, login: it.payload.login });
        } catch (e) {
          ctx.error(errorMessage(e));
        }
      }
      if (!cancelled) setEntries(out);
    })();
    return () => { cancelled = true; };
    // Relu quand un vault change de révision (SSE → reload → nouvelle clé).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultsKey]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-[var(--c-border)] px-4 py-2.5 max-md:pl-28">
        <h1 className="text-[14px] font-semibold text-[var(--c-text)]">Authentificateur</h1>
        <span className="text-[11px] text-[var(--c-text-faint)]">{entries ? `${entries.length} code(s)` : ""}</span>
      </header>
      <div className="sidebar-scroll min-h-0 flex-1 overflow-y-auto p-4">
        <div className="max-w-xl">
          {entries === null ? (slow ? <Loading /> : null) : <TotpList entries={entries} />}
        </div>
      </div>
    </div>
  );
}
