/** Paramètres › Sécurité › Mode voyage : avant de passer une frontière, ne
 * garder sur ses appareils que les vaults marqués « sûrs en voyage »
 * (réglages de chaque vault). Le serveur ne sert plus les autres ; ils
 * quittent chaque appareil à sa prochaine synchronisation. L'activer est
 * immédiat ; le couper redemande le mot de passe maître. */
import { useCallback, useState, type FormEvent } from "react";
import type { PageContext } from "../App";
import { api, errorMessage } from "../lib/api";
import * as c from "../lib/crypto";
import { fromBase64, toBase64 } from "../lib/bytes";
import { requireKdfNotDowngraded } from "../lib/kdfPins";
import { ConfirmDialog } from "./ConfirmDialog";
import { InfoTip, Modal, PasswordInput, SettingRow } from "./ui";
import { t, plural } from "../lib/i18n";

export function TravelSettings({ ctx }: { ctx: PageContext }) {
  const { session } = ctx;
  const [dialog, setDialog] = useState<null | "on" | "off">(null);
  const close = useCallback(() => setDialog(null), []);
  const on = !!session.travelMode;
  const staying = session.vaults.filter((v) => v.travelSafe && !v.emergency);
  const leaving = session.vaults.filter((v) => !v.travelSafe && !v.emergency);

  const enable = async () => {
    setDialog(null);
    try {
      await api.setTravel(true);
      ctx.notify(t("Mode voyage activé."));
      await ctx.reload();
    } catch (e) {
      ctx.error(errorMessage(e));
    }
  };

  return (
    <section className="flex flex-col gap-2.5">
      <h2 className="eyebrow">{t("Voyage")}</h2>
      <div className="card">
        <SettingRow
          title={<>{t("Mode voyage")} {on && <span className="tag tag-warn">{t("Actif")}</span>} <InfoTip label={t("Ce que fait le mode voyage")} items={[
            { text: t("Seuls les vaults marqués « sûrs en voyage » restent sur vos appareils."), tone: "ok" },
            { text: t("Les autres disparaissent à la prochaine synchronisation, et reviennent au retour.") },
            { text: t("Le couper redemande le mot de passe maître.") },
          ]} /></>}
          desc={on ? t("{0} vault{1} sur vos appareils.", staying.length, staying.length > 1 ? "s" : "") : staying.length ? t("Gardera {0}.", staying.map((v) => `« ${v.name} »`).join(", ")) : t("Marquez d'abord un vault « sûr en voyage » (réglages du vault).")}
        >
          {on
            ? <button onClick={() => setDialog("off")} className="btn btn-secondary">{t("Désactiver…")}</button>
            : <button onClick={() => setDialog("on")} className="btn btn-secondary">{t("Activer…")}</button>}
        </SettingRow>
      </div>
      {dialog === "on" && (
        <ConfirmDialog
          title={t("Activer le mode voyage ?")}
          message={leaving.length
            ? `${plural(leaving.length, "{0} vault quitte vos appareils : {1}.", "{0} vaults quittent vos appareils : {1}.", leaving.map((v) => `« ${v.name} »`).join(", "))} ${staying.length ? t("Restent : {0}.", staying.map((v) => `« ${v.name} »`).join(", ")) : t("Aucun ne reste.")}`
            : t("Tous vos vaults sont marqués sûrs : rien ne change sur vos appareils.")}
          confirmLabel={t("Activer")}
          onConfirm={() => void enable()}
          onCancel={close}
        />
      )}
      {dialog === "off" && <TravelOffDialog ctx={ctx} onClose={close} />}
    </section>
  );
}

function TravelOffDialog({ ctx, onClose }: { ctx: PageContext; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const email = ctx.session.user.email;
      const pre = await api.prelogin(email);
      requireKdfNotDowngraded(email, pre.kdf);
      const master = await c.deriveMasterKey(password, fromBase64(pre.kdf_salt), pre.kdf);
      master.stretchedKey.fill(0);
      const authKey = toBase64(master.authKey);
      master.authKey.fill(0);
      await api.setTravel(false, authKey);
      ctx.notify(t("Mode voyage désactivé : vos vaults reviennent."));
      onClose();
      await ctx.reload();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <Modal title={t("Désactiver le mode voyage")} onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <label className="block">
          <span className="field-label">{t("Mot de passe maître")}</span>
          <PasswordInput value={password} onChange={setPassword} autoComplete="current-password" autoFocus />
        </label>
        {error && <p className="callout callout-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn btn-ghost">{t("Annuler")}</button>
          <button type="submit" disabled={!password || busy} className="btn btn-primary">{busy ? t("Vérification…") : t("Désactiver")}</button>
        </div>
      </form>
    </Modal>
  );
}
