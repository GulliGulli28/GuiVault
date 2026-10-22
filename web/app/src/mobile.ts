/** L'application tourne-t-elle sur mobile (Android) ? Lu une fois au
 * démarrage (`app_mobile`, `app-tauri/src/lib.rs`) : pas de boîte de
 * dialogue de dossiers ni de mises à jour par l'updater, les coffres dans le
 * dossier privé de l'app. */
import { invoke } from "@tauri-apps/api/core";

let mobile = false;
let dir: string | null = null;

export async function detectMobile(): Promise<void> {
  mobile = await invoke<boolean>("app_mobile").catch(() => false);
  if (mobile) dir = await invoke<string>("local_dir").catch(() => null);
}

export function isMobile(): boolean {
  return mobile;
}

/** Le dossier des coffres de l'appareil (mobile seulement). */
export function coffresDir(): string | null {
  return dir;
}

/** Les coffres du dossier de l'appareil. */
export function deviceCoffres(): Promise<string[]> {
  return dir ? invoke<string[]>("local_list", { dir }).catch(() => []) : Promise.resolve([]);
}
