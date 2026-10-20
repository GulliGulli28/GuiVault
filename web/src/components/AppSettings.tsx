/** Paramètres › Application : ce que seule l'application sait faire, sur cet
 * appareil (`lib/appSettings.ts`). Montré seulement quand elle a posé son
 * pont système (`platform.ts`). */
import { useEffect, useState } from "react";
import { errorMessage } from "../lib/api";
import { loadAppLock, loadAppTray, saveAppLock, saveAppTray, type AppLockSettings } from "../lib/appSettings";
import { systemBridge } from "../lib/platform";
import { Eyebrow } from "./ui";

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
    system?.browserIntegration(enabled).then(setBrowser).catch((e) => error(`Extension de navigateur : ${errorMessage(e)}`));
  };

  const toggleAutostart = (enabled: boolean) => {
    system?.autostart(enabled).then(setAutostart).catch((e) => error(`Démarrer avec Windows : ${errorMessage(e)}`));
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
      {system?.tray && (
        <section className="max-w-2xl space-y-1.5">
          <Eyebrow>Zone de notification</Eyebrow>
          <div className="card divide-y divide-[var(--c-border)]">
            <label className="flex items-start gap-2 p-3">
              <input type="checkbox" checked={tray.closeToTray} onChange={(e) => toggleCloseToTray(e.target.checked)} className="mt-0.5" />
              <span className="min-w-0 flex-1 text-[12.5px] text-[var(--c-text)]">Fermer la fenêtre la range dans la zone de notification</span>
            </label>
            <label className="flex items-start gap-2 p-3">
              <input type="checkbox" checked={autostart === true} disabled={autostart === null} onChange={(e) => toggleAutostart(e.target.checked)} className="mt-0.5" />
              <span className="min-w-0 flex-1 text-[12.5px] text-[var(--c-text)]">Démarrer avec Windows, dans la zone de notification</span>
            </label>
          </div>
          <p className="help-text">Rangé là, GuiVault garde le raccourci de saisie automatique ; son icône le rouvre, le verrouille ou le quitte. Relancer GuiVault ramène la fenêtre déjà ouverte.</p>
        </section>
      )}

      <section className="max-w-2xl space-y-1.5">
        <Eyebrow>Extension de navigateur</Eyebrow>
        <div className="card p-3">
          <label className="flex items-start gap-2">
            <input type="checkbox" checked={browser === true} disabled={browser === null} onChange={(e) => toggleBrowser(e.target.checked)} className="mt-0.5" />
            <span className="min-w-0 flex-1 text-[12.5px] text-[var(--c-text)]">Permettre à l'extension GuiVault d'ouvrir les coffres locaux de cet ordinateur</span>
          </label>
        </div>
        <p className="help-text">L'extension (Chrome, Edge, Brave, Firefox) propose alors « Coffre local » : elle déchiffre elle-même, avec votre mot de passe maître ; l'application ne lui transmet que du chiffré, et seulement des coffres déjà ouverts ici. Cette application n'a pas besoin d'être ouverte.</p>
      </section>

      <section className="max-w-2xl space-y-1.5">
        <Eyebrow>Verrouillage</Eyebrow>
        <div className="card divide-y divide-[var(--c-border)]">
          {system?.systemEvents && (
            <label className="flex items-start gap-2 p-3">
              <input type="checkbox" checked={lock.onSystemLock} onChange={(e) => update({ onSystemLock: e.target.checked })} className="mt-0.5" />
              <span className="min-w-0 flex-1 text-[12.5px] text-[var(--c-text)]">Quand la session Windows se verrouille (Win+L) ou que l'ordinateur se met en veille</span>
            </label>
          )}
          <label className="flex items-start gap-2 p-3">
            <input type="checkbox" checked={lock.onMinimize} onChange={(e) => update({ onMinimize: e.target.checked })} className="mt-0.5" />
            <span className="min-w-0 flex-1 text-[12.5px] text-[var(--c-text)]">Quand la fenêtre est réduite{system?.tray ? " ou rangée dans la zone de notification" : ""}</span>
          </label>
          {system?.systemEvents && (
            <div role="radiogroup" aria-label="Ce que mesure l'inactivité" className="space-y-1.5 p-3">
              <p className="text-[12.5px] text-[var(--c-text)]">« Verrouiller après » (Sécurité) compte l'inactivité…</p>
              <label className="flex items-center gap-2 text-[12.5px] text-[var(--c-text-secondary)]">
                <input type="radio" name="idle-scope" checked={lock.idleScope === "app"} onChange={() => update({ idleScope: "app" })} />
                dans GuiVault — le plus sûr
              </label>
              <label className="flex items-center gap-2 text-[12.5px] text-[var(--c-text-secondary)]">
                <input type="radio" name="idle-scope" checked={lock.idleScope === "system"} onChange={() => update({ idleScope: "system" })} />
                sur tout l'ordinateur
              </label>
            </div>
          )}
        </div>
        {system?.systemEvents && <p className="help-text">Sur tout l'ordinateur : GuiVault reste ouvert tant que vous travaillez ailleurs — pratique avec la saisie automatique, moins sûr si vous vous absentez sans verrouiller la session. La saisie automatique, elle, réduit la fenêtre sans la verrouiller.</p>}
      </section>
    </div>
  );
}
