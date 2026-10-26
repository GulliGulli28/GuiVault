import { useEffect, useRef } from "react";
import type { PageContext } from "../App";
import { useAllItems } from "../lib/allItems";
import { autofillBridge, buildAutofillIndex, useAutofillStatus } from "../lib/autofill";
import { SettingRow } from "./ui";
import { IconLogin } from "./secret-icons";
import { t } from "../lib/i18n";

/** Android : tant qu'un coffre est ouvert et que GuiVault est le service de
 * remplissage, l'index de ses identifiants suit (`lib/autofill.ts`) — à
 * l'ouverture et à chaque changement. Ne dessine rien. */
export function AutofillFeeder({ ctx }: { ctx: Pick<PageContext, "session" | "error"> }) {
  const { status } = useAutofillStatus();
  const { items, loading } = useAllItems(ctx.session, ctx.error);
  const sent = useRef("");
  const enabled = !!status?.enabled;
  useEffect(() => {
    const b = autofillBridge();
    if (!b || !enabled || loading || ctx.session.offline) return;
    const t = setTimeout(() => {
      const index = buildAutofillIndex(ctx.session, items);
      // Rien de changé : rien à rechiffrer.
      const key = JSON.stringify(index);
      if (key === sent.current) return;
      sent.current = key;
      void b.update(index).catch(() => {});
    }, 400);
    return () => clearTimeout(t);
  }, [ctx.session, items, loading, enabled]);
  return null;
}

/** « Remplir les autres applications » : faire de GuiVault le service de
 * remplissage d'Android, ou ne plus l'être. `mobile` : une ligne de
 * l'onglet Réglages, sinon de Paramètres › Sécurité. */
export function AutofillSetting({ ctx, mobile }: { ctx: Pick<PageContext, "error" | "notify">; mobile?: boolean }) {
  const { status, refresh } = useAutofillStatus();
  if (!status?.supported) return null;
  const desc = !status.enabled
    ? t("GuiVault propose vos identifiants dans les autres applications")
    : status.biometric
      ? t("Coffre fermé : une empreinte, puis on remplit")
      : t("Seulement quand GuiVault est ouvert (pas d'empreinte enregistrée)");
  const toggle = () => {
    const b = autofillBridge();
    if (!b) return;
    if (status.enabled) void b.disable().then(() => { refresh(); ctx.notify(t("Remplissage désactivé.")); }, () => ctx.error(t("Le remplissage n'a pas pu être désactivé.")));
    else void b.request().catch(() => ctx.error(t("Les réglages d'Android ne se sont pas ouverts.")));
  };
  const control = <button type="button" role="switch" aria-checked={status.enabled} aria-label={t("Remplir les autres applications")} onClick={toggle} className="switch" />;
  if (mobile) {
    return (
      <div className="m-set">
        <IconLogin size={18} className="shrink-0 text-[var(--c-text-muted)]" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span>{t("Remplir les autres applications")}</span>
          <span className="text-[13px] text-[var(--c-text-muted)]">{desc}</span>
        </span>
        {control}
      </div>
    );
  }
  return <SettingRow title={t("Remplir les autres applications")} desc={desc}>{control}</SettingRow>;
}
