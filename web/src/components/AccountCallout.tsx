import { useState } from "react";
import { linkState, linkedItems, syncLinked, withAccount } from "../lib/accounts";
import { errorMessage } from "../lib/api";
import { changeItem, type DecodedItem, type VaultView } from "../lib/session";
import type { Account } from "../lib/types";
import { plural, t } from "../lib/i18n";

/** Sur la fiche : une copie restée en arrière de son compte enregistré
 * (écriture ratée, compte changé depuis un autre appareil), et de quoi la
 * rattraper. Sur la fiche du compte : ceux qui le reprennent en retard. */
export function AccountCallout({ vault, item, items, accounts, writable, notify, error, onChanged }: {
  vault: VaultView;
  item: DecodedItem & { ok: true };
  items: readonly DecodedItem[];
  accounts: Account[];
  writable: boolean;
  notify: (m: string) => void;
  error: (m: string) => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const p = item.payload;
  let text: string | null = null;
  let fix: (() => Promise<void>) | null = null;
  if (p.kind === "account") {
    const late = linkedItems(items, p.account.id).filter((i) => withAccount(i.payload, p.account) !== null);
    if (late.length) {
      text = plural(late.length, "{0} élément qui reprend ce compte n'est pas à jour.", "{0} éléments qui reprennent ce compte ne sont pas à jour.");
      fix = async () => {
        const r = await syncLinked(vault, p.account, items);
        if (r.failed.length) error(r.failed.map((f) => `${f.name} : ${f.error}`).join(" · "));
        else notify(plural(r.done, "{0} élément relié mis à jour.", "{0} éléments reliés mis à jour."));
      };
    }
  } else {
    const s = linkState(p, accounts);
    if (s.kind === "linked" && s.stale) {
      text = t("L'utilisateur ou le mot de passe n'est plus celui du compte « {0} ».", s.account.name);
      fix = async () => {
        await changeItem(vault, item, (cur) => withAccount(cur, s.account));
        notify(t("Mis à jour depuis le compte « {0} ».", s.account.name));
      };
    }
  }
  if (!text) return null;
  const run = async () => {
    if (!fix) return;
    setBusy(true);
    try {
      await fix();
    } catch (e) {
      error(errorMessage(e));
    } finally {
      setBusy(false);
      onChanged();
    }
  };
  return (
    <div className="callout callout-warn flex flex-wrap items-center gap-2">
      <span className="min-w-0 flex-1">{text}</span>
      {writable && <button onClick={() => void run()} disabled={busy} className="btn btn-secondary btn-sm">{t("Mettre à jour")}</button>}
    </div>
  );
}
