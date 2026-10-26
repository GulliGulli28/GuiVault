import { useState } from "react";
import type { PageContext } from "../App";
import { errorMessage } from "../lib/api";
import { navigate } from "../lib/route";
import { createVault } from "../lib/session";
import { InfoTip, Modal } from "./ui";
import { t } from "../lib/i18n";

/** Créer un vault (barre latérale, accueil, sélecteur de vaults mobile) :
 * son nom, puis on l'ouvre. */
export function NewVaultDialog({ ctx, onClose }: { ctx: PageContext; onClose: () => void }) {
  const local = !!ctx.session.local;
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const v = await createVault(ctx.session, name.trim());
      onClose();
      await ctx.reload();
      ctx.notify(t("Vault « {0} » créé.", v.name));
      navigate({ page: "vault", id: v.id });
    } catch (e) {
      ctx.error(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <Modal title={local ? t("Nouveau vault") : t("Nouveau vault partagé")} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-4">
        <label className="block">
          <span className="field-label">{t("Nom")}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder={local ? t("Travail") : t("Équipe réseau")} className="input" />
        </label>
        <div className="flex items-center gap-2 text-[12.5px] text-[var(--c-text-muted)]">
          <span className="min-w-0 flex-1">{t("Chiffré sous sa propre clé")}{local ? "" : t(" · vous en êtes propriétaire")}</span>
          <InfoTip label={t("Ce que c'est")} align="right" items={local
            ? [{ text: t("Un vault de plus pour ranger, dans ce coffre."), tone: "ok" }]
            : [{ text: t("Le serveur ne le lit pas."), tone: "ok" }, { text: t("Invitez des membres depuis ses réglages.") }]} />
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn btn-ghost">{t("Annuler")}</button>
          <button type="submit" disabled={!name.trim() || busy} className="btn btn-primary">{t("Créer")}</button>
        </div>
      </form>
    </Modal>
  );
}
