import type { PageContext } from "../App";
import { useBiometricSetting } from "../lib/biometric";
import { SettingRow } from "./ui";
import { IconFingerprint } from "./secret-icons";

const DESC = {
  local: "Le mot de passe reste demandé après un redémarrage, et tous les 14 jours",
  server: "Tant que la session reste ouverte ; le mot de passe après un redémarrage",
};

const UNAVAILABLE = {
  "not-enrolled": "Aucune empreinte ni visage enregistrés sur ce téléphone",
  unavailable: "Ce téléphone n'a pas de biométrie forte",
};

/** Android : « Déverrouiller par biométrie » pour le coffre ou le compte
 * ouvert (`biometric.ts`). Rien hors de l'application Android. `mobile` :
 * une ligne de l'onglet Réglages, sinon une ligne de Paramètres › Sécurité. */
export function BiometricSetting({ ctx, mobile }: { ctx: Pick<PageContext, "session" | "error" | "notify">; mobile?: boolean }) {
  const bio = useBiometricSetting(ctx.session);
  if (!bio) return null;
  const off = bio.status !== "ready" && !bio.enabled;
  const desc = off ? UNAVAILABLE[bio.status as keyof typeof UNAVAILABLE] : DESC[ctx.session.local ? "local" : "server"];
  const toggle = () => void bio.toggle().then((err) => {
    if (err) ctx.error(err);
    else ctx.notify(bio.enabled ? "Biométrie désactivée." : "Biométrie activée.");
  });
  const control = <button type="button" role="switch" aria-checked={bio.enabled} aria-label="Déverrouiller par biométrie" disabled={off || bio.busy} onClick={toggle} className="switch" />;
  if (mobile) {
    return (
      <div className="m-set">
        <IconFingerprint size={18} className="shrink-0 text-[var(--c-text-muted)]" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span>Déverrouiller par biométrie</span>
          <span className={`text-[13px] ${off ? "text-[var(--c-warn-text)]" : "text-[var(--c-text-muted)]"}`}>{desc}</span>
        </span>
        {control}
      </div>
    );
  }
  return <SettingRow title="Déverrouiller par biométrie" desc={desc}>{control}</SettingRow>;
}
