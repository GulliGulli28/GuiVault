/** La feuille de secours (comme l'« Emergency Kit » de 1Password) : de quoi
 * retrouver son coffre un jour de panne — où il est, avec quel compte, son
 * empreinte — et une case pour écrire le mot de passe maître **à la main**,
 * jamais imprimé. Rien ne part au serveur : la page s'imprime d'ici
 * (Paramètres › Compte). */
import { useCallback } from "react";
import { baseUrl } from "../lib/api";
import { coffreName } from "../lib/localHost";
import type { SessionState } from "../lib/session";
import { Modal } from "./ui";
import { t, locale } from "../lib/i18n";

export function RecoveryKit({ session, onClose }: { session: SessionState; onClose: () => void }) {
  const close = useCallback(() => onClose(), [onClose]);
  const local = session.local;
  const server = baseUrl().replace(/\/api\/v1$/, "");
  const rows: [string, string][] = local
    ? [[t("Coffre local"), coffreName(local.path)], [t("Dossier"), local.path]]
    : [[t("Serveur"), server || location.origin], [t("Compte"), session.user.email]];
  rows.push(["Empreinte", session.fingerprint], ["Créée le", new Date().toLocaleDateString(locale())]);
  return (
    <Modal title={t("Feuille de secours")} onClose={close} wide>
      <div className="flex flex-col gap-4">
        <div className="print-sheet card flex flex-col gap-5 bg-white p-7 text-[#111]">
          <div>
            <h2 className="text-[22px] font-semibold">{t("GuiVault — feuille de secours")}</h2>
            <p className="text-[13px] text-[#555]">{t("À imprimer et ranger en lieu sûr, hors de l'ordinateur.")}</p>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-2 text-[14px]">
            {rows.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-[#555]">{k}</dt>
                <dd className="break-all font-mono">{v}</dd>
              </div>
            ))}
          </dl>
          <div className="flex flex-col gap-1.5">
            <span className="text-[14px] font-medium">{t("Mot de passe maître (à écrire à la main)")}</span>
            <div className="h-12 rounded-md border-2 border-dashed border-[#999]" />
          </div>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-[13px] text-[#333]">
            <li>{t("Personne ne peut réinitialiser ce mot de passe : sans lui, le coffre est perdu.")}</li>
            <li>{local ? t("Gardez aussi une copie du dossier (ou son export .zip).") : t("Les sauvegardes du serveur s'ouvrent avec ce mot de passe.")}</li>
            <li>{t("Sans GuiVault :")} <span className="font-mono">{t("gv recover")}</span> {t("relit")} {local ? t("le dossier") : t("une sauvegarde")} {t("avec ce seul mot de passe.")}</li>
          </ul>
        </div>
        <div className="flex justify-end gap-2">
          <button onClick={close} className="btn btn-ghost">{t("Fermer")}</button>
          <button onClick={() => window.print()} className="btn btn-primary">{t("Imprimer")}</button>
        </div>
      </div>
    </Modal>
  );
}
