/** Choisir le dossier d'un coffre : les boîtes de dialogue du système
 * (`tauri-plugin-dialog`).
 *
 * Les tests de bout en bout (`app/e2e/run.mjs`) ne peuvent pas piloter une
 * boîte de dialogue native par WebDriver : ils posent le chemin voulu dans
 * `window.__GUIVAULT_E2E_PATH__` avant de cliquer. Seul un script de la page
 * peut le poser — la CSP n'en admet pas d'autre que les nôtres —, et il ne
 * fait que choisir un chemin, ce que la boîte de dialogue ferait aussi. */
import { open, save } from "@tauri-apps/plugin-dialog";
import { coffresDir, deviceCoffres, isMobile } from "./mobile";

declare global {
  interface Window {
    __GUIVAULT_E2E_PATH__?: string;
  }
}

function e2ePath(): string | null {
  const p = window.__GUIVAULT_E2E_PATH__;
  delete window.__GUIVAULT_E2E_PATH__;
  return typeof p === "string" ? p : null;
}

/** Mobile : un nom libre dans le dossier des coffres de l'appareil
 * (« Mon coffre », « Mon coffre 2 »…). */
export async function freePath(base: string): Promise<string | null> {
  const dir = coffresDir();
  if (!dir) return null;
  const taken = new Set(await deviceCoffres());
  const stem = base.replace(/\.guivault$/, "");
  for (let i = 1; ; i++) {
    const path = `${dir}/${i === 1 ? stem : `${stem} ${i}`}.guivault`;
    if (!taken.has(path)) return path;
  }
}

export async function pickCoffre(): Promise<string | null> {
  const forced = e2ePath();
  if (forced) return forced;
  // Mobile : l'accueil liste les coffres de l'appareil, rien à choisir ici.
  if (isMobile()) return null;
  const path = await open({ directory: true, title: "Ouvrir un coffre local" });
  return typeof path === "string" ? path : null;
}

export async function pickNewCoffre(): Promise<string | null> {
  const forced = e2ePath();
  if (forced) return forced;
  if (isMobile()) return freePath("Mon coffre");
  return save({ title: "Créer un coffre local", defaultPath: "Mon coffre.guivault" });
}

/** Où ranger la copie restaurée d'une sauvegarde (`backupBridge.ts`). */
export async function pickRestoreDest(defaultPath: string): Promise<string | null> {
  const forced = e2ePath();
  if (forced) return forced;
  if (isMobile()) return freePath(defaultPath);
  return save({ title: "Ranger la copie restaurée", defaultPath });
}
