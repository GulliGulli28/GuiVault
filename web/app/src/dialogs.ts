/** Choisir le dossier d'un coffre : les boîtes de dialogue du système
 * (`tauri-plugin-dialog`).
 *
 * Les tests de bout en bout (`app/e2e/run.mjs`) ne peuvent pas piloter une
 * boîte de dialogue native par WebDriver : ils posent le chemin voulu dans
 * `window.__GUIVAULT_E2E_PATH__` avant de cliquer. Seul un script de la page
 * peut le poser — la CSP n'en admet pas d'autre que les nôtres —, et il ne
 * fait que choisir un chemin, ce que la boîte de dialogue ferait aussi. */
import { open, save } from "@tauri-apps/plugin-dialog";

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

export async function pickCoffre(): Promise<string | null> {
  const forced = e2ePath();
  if (forced) return forced;
  const path = await open({ directory: true, title: "Ouvrir un coffre local" });
  return typeof path === "string" ? path : null;
}

export async function pickNewCoffre(): Promise<string | null> {
  const forced = e2ePath();
  if (forced) return forced;
  return save({ title: "Créer un coffre local", defaultPath: "Mon coffre.guivault" });
}

/** Où ranger la copie restaurée d'une sauvegarde (`backupBridge.ts`). */
export async function pickRestoreDest(defaultPath: string): Promise<string | null> {
  const forced = e2ePath();
  if (forced) return forced;
  return save({ title: "Ranger la copie restaurée", defaultPath });
}
