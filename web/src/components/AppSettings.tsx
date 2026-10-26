/** Paramètres › Application : ce que seule l'application sait faire, sur cet
 * appareil (`lib/appSettings.ts`). Montré seulement quand elle a posé son
 * pont système (`platform.ts`). */
import { useEffect, useState } from "react";
import { errorMessage } from "../lib/api";
import { loadAppLock, loadAppTray, saveAppLock, saveAppTray, type AppLockSettings } from "../lib/appSettings";
import { systemBridge } from "../lib/platform";
import { Eyebrow } from "./ui";
import { AppUpdates } from "./AppUpdates";
import { t } from "../lib/i18n";

export function AppSettings({ error }: { error: (m: string) => void }) {
  const [lock, setLock] = useState(loadAppLock);
  const [tray, setTray] = useState(loadAppTray);
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [browser, setBrowser] = useState<boolean | null>(null);
  const system = systemBridge();
  useEffect(() => {
    if (system?.tray) system.autostart().then(setAutostart).catch(() => setAutostart(null));
    system?.browserIntegration().then(setBrowser).catch(() => setBrowser(null));
  }, [system]);
  const toggleBrowser = (enabled: boolean) => {
    system?.browserIntegration(enabled).then(setBrowser).catch((e) => error(t("Extension de navigateur : {0}", errorMessage(e))));
  };

  const toggleAutostart = (enabled: boolean) => {
    system?.autostart(enabled).then(setAutostart).catch((e) => error(t("Démarrer avec Windows : {0}", errorMessage(e))));
  };
  const toggleCloseToTray = (closeToTray: boolean) => {
    const next = { ...tray, closeToTray };
    setTray(next);
    saveAppTray(next);
    system?.setCloseToTray(closeToTray).catch((e) => error(errorMessage(e)));
  };
  const update = (patch: Partial<AppLockSettings>) => {
    const next = { ...lock, ...patch };
    setLock(next);
    saveAppLock(next);
  };

  return (
    <div className="space-y-6">
      <AppUpdates />
      {system?.tray && (
        <section className="max-w-2xl space-y-1.5">
          <Eyebrow>{t("Zone de notification")}</Eyebrow>
          <div className="card divide-y divide-[var(--c-border)]">
            <label className="flex items-start gap-2 p-3">
              <input type="checkbox" checked={tray.closeToTray} onChange={(e) => toggleCloseToTray(e.target.checked)} className="mt-0.5" />
              <span className="min-w-0 flex-1 text-[12.5px] text-[var(--c-text)]">{t("Fermer la fenêtre la range dans la zone de notification")}</span>
            </label>
            <label className="flex items-start gap-2 p-3">
              <input type="checkbox" checked={autostart === true} disabled={autostart === null} onChange={(e) => toggleAutostart(e.target.checked)} className="mt-0.5" />
              <span className="min-w-0 flex-1 text-[12.5px] text-[var(--c-text)]">{t("Démarrer avec Windows, dans la zone de notification")}</span>
            </label>
          </div>
          <p className="help-text">{t("Le raccourci de saisie reste actif ; l'icône rouvre, verrouille ou quitte.")}</p>
        </section>
      )}

      <section className="max-w-2xl space-y-1.5">
        <Eyebrow>{t("Extension de navigateur")}</Eyebrow>
        <div className="card p-3">
          <label className="flex items-start gap-2">
            <input type="checkbox" checked={browser === true} disabled={browser === null} onChange={(e) => toggleBrowser(e.target.checked)} className="mt-0.5" />
            <span className="min-w-0 flex-1 text-[12.5px] text-[var(--c-text)]">{t("Permettre à l'extension GuiVault d'ouvrir les coffres locaux de cet ordinateur")}</span>
          </label>
        </div>
        <p className="help-text">{t("L'extension propose alors « Coffre local » et déchiffre elle-même ; l'application ne lui passe que du chiffré.")}</p>
      </section>

      <section className="max-w-2xl space-y-1.5">
        <Eyebrow>{t("Verrouillage")}</Eyebrow>
        <div className="card divide-y divide-[var(--c-border)]">
          {system?.systemEvents && (
            <label className="flex items-start gap-2 p-3">
              <input type="checkbox" checked={lock.onSystemLock} onChange={(e) => update({ onSystemLock: e.target.checked })} className="mt-0.5" />
              <span className="min-w-0 flex-1 text-[12.5px] text-[var(--c-text)]">{t("Quand la session Windows se verrouille (Win+L) ou que l'ordinateur se met en veille")}</span>
            </label>
          )}
          <label className="flex items-start gap-2 p-3">
            <input type="checkbox" checked={lock.onMinimize} onChange={(e) => update({ onMinimize: e.target.checked })} className="mt-0.5" />
            <span className="min-w-0 flex-1 text-[12.5px] text-[var(--c-text)]">{t("Quand la fenêtre est réduite")}{system?.tray ? t(" ou rangée dans la zone de notification") : ""}</span>
          </label>
          {system?.systemEvents && (
            <div role="radiogroup" aria-label={t("Ce que mesure l'inactivité")} className="space-y-1.5 p-3">
              <p className="text-[12.5px] text-[var(--c-text)]">{t("« Verrouiller après » (Sécurité) compte l'inactivité…")}</p>
              <label className="flex items-center gap-2 text-[12.5px] text-[var(--c-text-secondary)]">
                <input type="radio" name="idle-scope" checked={lock.idleScope === "app"} onChange={() => update({ idleScope: "app" })} />
                {t("dans GuiVault — le plus sûr")}
              </label>
              <label className="flex items-center gap-2 text-[12.5px] text-[var(--c-text-secondary)]">
                <input type="radio" name="idle-scope" checked={lock.idleScope === "system"} onChange={() => update({ idleScope: "system" })} />
                {t("sur tout l'ordinateur")}
              </label>
            </div>
          )}
        </div>
        {system?.systemEvents && <p className="help-text">{t("Sur tout l'ordinateur : plus pratique avec la saisie automatique, moins sûr si vous vous absentez sans verrouiller la session.")}</p>}
      </section>
    </div>
  );
}
