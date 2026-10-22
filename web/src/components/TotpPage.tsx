import { useEffect, useState } from "react";
import type { PageContext } from "../App";
import { errorMessage } from "../lib/api";
import { loadItems, putPayload } from "../lib/session";
import { Page } from "./Page";
import { TotpList, type TotpEntry } from "./TotpList";
import { Loading, useDelayed } from "./ui";
import { TotpCode } from "./TotpCode";
import { IconSearch } from "./ui-icons";
import { tileHue, tileInitial } from "../lib/tiles";
import { NARROW, useMediaQuery } from "../hooks/useMediaQuery";

/** L'authentificateur : les codes TOTP de tous les vaults au même endroit. */
export function TotpPage({ ctx }: { ctx: PageContext }) {
  const [entries, setEntries] = useState<TotpEntry[] | null>(null);
  const slow = useDelayed(entries === null);
  const narrow = useMediaQuery(NARROW);
  const [q, setQ] = useState("");
  const vaultsKey = ctx.session.vaults.map((v) => `${v.id}:${v.revision}`).join(",");

  const remove = async (e: TotpEntry) => {
    const vault = ctx.session.vaults.find((v) => v.id === e.vaultId);
    if (!vault) return;
    try {
      await putPayload(vault, { kind: "login", login: { ...e.login, totp: null } }, e.revision);
      setEntries((list) => (list ?? []).filter((x) => x.id !== e.id));
      ctx.notify(`Code de « ${e.login.name} » retiré.`);
    } catch (err) {
      ctx.error(errorMessage(err));
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const out: TotpEntry[] = [];
      for (const v of ctx.session.vaults) {
        try {
          const page = await loadItems(v);
          for (const it of page.items) if (it.ok && it.payload.kind === "login" && it.payload.login.totp) out.push({ id: it.id, vaultId: v.id, vaultName: v.name, login: it.payload.login, revision: it.revision });
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

  if (narrow) {
    const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const shown = (entries ?? [])
      .filter((e) => e.login.totp && terms.every((t) => `${e.login.name} ${e.login.username} ${e.vaultName}`.toLowerCase().includes(t)))
      .sort((a, b) => a.login.name.localeCompare(b.login.name));
    return (
      <div className="m-page">
        <header className="m-head"><h1 className="m-title min-w-0 flex-1 truncate">Codes 2FA</h1></header>
        <div className="shrink-0 px-4 pb-2.5">
          <label className="m-search"><IconSearch size={18} /><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher un code" aria-label="Rechercher un code" /></label>
        </div>
        <div className="m-body gap-2.5">
          {entries === null && slow && <Loading />}
          {entries !== null && shown.length === 0 && <p className="py-10 text-center text-[14px] text-[var(--c-text-muted)]">{entries.some((e) => e.login.totp) ? "Rien ne correspond." : "Aucun identifiant n'a de code 2FA."}</p>}
          {shown.map((e) => (
            <div key={e.id} className="m-card flex min-w-0 items-center gap-3.5 px-4 py-3.5">
              <span className="tile shrink-0" style={{ "--tile-size": "40px", "--tile-h": tileHue(e.login.name) } as React.CSSProperties}>{tileInitial(e.login.name)}</span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate font-medium">{e.login.name}</span>
                <TotpCode secret={e.login.totp!} size="lg" />
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <Page title="Codes 2FA" sub={entries ? `${entries.filter((e) => e.login.totp).length} codes · cliquez pour copier` : undefined} width="max-w-[760px]" mobileBack={null}>
      {entries === null ? (slow ? <Loading /> : null) : <TotpList entries={entries} onRemove={ctx.session.vaults.some((v) => v.role !== "reader") ? remove : undefined} />}
    </Page>
  );
}
