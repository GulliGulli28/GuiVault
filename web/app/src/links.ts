/** Les liens vers un site (« Ouvrir le site », l'adresse d'un identifiant…)
 * s'ouvrent dans le navigateur du système, pas dans la WebView de l'app — où
 * ils remplaçaient GuiVault, et cassaient les marges sous Android. */
import { openUrl } from "@tauri-apps/plugin-opener";

export function installExternalLinks(): void {
  document.addEventListener(
    "click",
    (e) => {
      if (e.defaultPrevented || e.button !== 0) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a) return;
      const url = new URL(a.href, location.href);
      if (!/^https?:$/.test(url.protocol) || url.origin === location.origin) return;
      e.preventDefault();
      void openUrl(url.href).catch(() => {});
    },
    true,
  );
}
