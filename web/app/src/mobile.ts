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

declare global {
  interface Window {
    /** Posé par `MainActivity.kt` (Android) : les marges du système en px CSS. */
    GuiVaultInsets?: { get(): string; setDark(dark: boolean): void };
  }
}

/** Android : la WebView ne donne pas `env(safe-area-inset-*)` à une
 * application bord à bord ; `MainActivity.kt` les expose, et prévient
 * (`guivault-insets`) quand elles changent — rotation, clavier. */
export function installInsets(): void {
  const bridge = window.GuiVaultInsets;
  if (!bridge) return;
  const apply = () => {
    try {
      const i = JSON.parse(bridge.get()) as { top: number; bottom: number; ime?: number };
      const root = document.documentElement;
      root.style.setProperty("--inset-top", `${i.top}px`);
      root.style.setProperty("--inset-bottom", `${i.bottom}px`);
      root.style.setProperty("--inset-ime", `${i.ime ?? 0}px`);
      // Clavier ouvert : `touch.css` cache les onglets.
      if ((i.ime ?? 0) > 0) root.dataset.ime = "";
      else delete root.dataset.ime;
    } catch {
      // Rien de lisible : on garde les marges du navigateur.
    }
  };
  apply();
  window.addEventListener("guivault-insets", apply);
  // Les icônes de la barre d'état suivent le thème de la page
  // (`data-mode`, posé par `applyPreferences`).
  const root = document.documentElement;
  const mode = () => bridge.setDark(root.dataset.mode !== "light");
  mode();
  new MutationObserver(mode).observe(root, { attributes: true, attributeFilter: ["data-mode"] });
}
