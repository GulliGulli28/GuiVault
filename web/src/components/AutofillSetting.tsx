import { useEffect, useRef, useState } from "react";
import type { PageContext } from "../App";
import { useAllItems } from "../lib/allItems";
import { autofillBridge, buildAutofillIndex, useAutofillStatus } from "../lib/autofill";
import { SettingRow } from "./ui";
import { IconLogin } from "./secret-icons";
import { t } from "../lib/i18n";
import { planSave } from "../lib/autofillSave";
import { requestDraft } from "../lib/pendingDraft";
import { navigate } from "../lib/route";
import type { CapturedLogin } from "../lib/platform";

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

/** « Enregistrer dans GuiVault ? » accepté dans une autre application
 * (Android, `docs/REMPLISSAGE.md`) : la connexion attend dans le service ;
 * on la prend à l'ouverture et à chaque retour au premier plan, et on ouvre
 * le formulaire pré-rempli — nouvel identifiant, ou mot de passe d'un
 * identifiant existant à mettre à jour. Rien n'est écrit sans
 * « Enregistrer ». Ne dessine rien. */
export function AutofillSaveHost({ ctx }: { ctx: Pick<PageContext, "session" | "error" | "notify"> }) {
  const { items, loading } = useAllItems(ctx.session, ctx.error);
  const [captured, setCaptured] = useState<CapturedLogin | null>(null);
  useEffect(() => {
    const b = autofillBridge();
    if (!b || ctx.session.offline) return;
    const take = () => {
      if (document.visibilityState !== "visible") return;
      void b.takeSave().then((c) => c && setCaptured(c), () => {});
    };
    take();
    document.addEventListener("visibilitychange", take);
    return () => document.removeEventListener("visibilitychange", take);
  }, [ctx.session.offline]);
  useEffect(() => {
    if (!captured || loading) return;
    setCaptured(null);
    const plan = planSave(items, ctx.session.vaults, captured);
    if (!plan) {
      ctx.error(t("Aucun vault où écrire : la connexion n'est pas enregistrée."));
    } else if (plan.kind === "same") {
      ctx.notify(t("« {0} » est déjà dans GuiVault.", captured.label));
    } else if (plan.kind === "update") {
      requestDraft({ vaultId: plan.item.vault.id, itemId: plan.item.item.id, draft: plan.draft });
      navigate({ page: "vault", id: plan.item.vault.id, item: plan.item.item.id });
      ctx.notify(t("Nouveau mot de passe pour « {0} » : vérifiez, puis enregistrez.", captured.label));
    } else {
      requestDraft({ vaultId: plan.vaultId, draft: plan.draft });
      navigate({ page: "vault", id: plan.vaultId });
    }
  }, [captured, loading, items]); // eslint-disable-line react-hooks/exhaustive-deps
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
  const offer = status.offerSave !== false;
  const toggleOffer = () => {
    void autofillBridge()?.setOfferSave(!offer).then(refresh, () => ctx.error(t("Réglage non enregistré.")));
  };
  const offerControl = <button type="button" role="switch" aria-checked={offer} aria-label={t("Proposer d'enregistrer les connexions")} onClick={toggleOffer} className="switch" />;
  const offerDesc = t("Un mot de passe tapé ailleurs : « Enregistrer dans GuiVault ? »");
  const copyTotp = status.copyTotp !== false;
  const toggleTotp = () => {
    void autofillBridge()?.setCopyTotp(!copyTotp).then(refresh, () => ctx.error(t("Réglage non enregistré.")));
  };
  const totpControl = <button type="button" role="switch" aria-checked={copyTotp} aria-label={t("Copier le code 2FA après avoir rempli")} onClick={toggleTotp} className="switch" />;
  const totpDesc = t("Le site le demande à l'écran suivant : il est déjà copié");
  if (mobile) {
    return (
      <>
        <div className="m-set">
          <IconLogin size={18} className="shrink-0 text-[var(--c-text-muted)]" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span>{t("Remplir les autres applications")}</span>
            <span className="text-[13px] text-[var(--c-text-muted)]">{desc}</span>
          </span>
          {control}
        </div>
        {status.enabled && (
          <div className="m-set">
            <span className="w-[18px] shrink-0" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span>{t("Proposer d'enregistrer les connexions")}</span>
              <span className="text-[13px] text-[var(--c-text-muted)]">{offerDesc}</span>
            </span>
            {offerControl}
          </div>
        )}
        {status.enabled && (
          <div className="m-set">
            <span className="w-[18px] shrink-0" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span>{t("Copier le code 2FA après avoir rempli")}</span>
              <span className="text-[13px] text-[var(--c-text-muted)]">{totpDesc}</span>
            </span>
            {totpControl}
          </div>
        )}
      </>
    );
  }
  return (
    <>
      <SettingRow title={t("Remplir les autres applications")} desc={desc}>{control}</SettingRow>
      {status.enabled && <SettingRow title={t("Proposer d'enregistrer les connexions")} desc={offerDesc}>{offerControl}</SettingRow>}
      {status.enabled && <SettingRow title={t("Copier le code 2FA après avoir rempli")} desc={totpDesc}>{totpControl}</SettingRow>}
    </>
  );
}
