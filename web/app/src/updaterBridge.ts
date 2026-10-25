/** Le pont des mises à jour (`src/lib/platform.ts`) : `tauri-plugin-updater`
 * lit `latest.json` sur la release `app-updater` du dépôt (tenue par
 * `.github/workflows/app-updater.yml` à chaque publication), télécharge
 * l'installeur, en vérifie la signature contre la clé publique de
 * `tauri.conf.json`, l'installe ; `plugin-process` relance. */
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { setUpdaterBridge } from "../../src/lib/platform";

// Un mandataire peut garder un `latest.json` en cache : on le lui interdit.
const noCache = { headers: { "Cache-Control": "no-cache", Pragma: "no-cache" } };

export function installUpdater() {
  let pending: Update | null = null;
  setUpdaterBridge({
    version: () => getVersion(),
    installer: () => invoke<"msi" | "nsis" | null>("app_installer").catch(() => null),
    async check() {
      await pending?.close().catch(() => {});
      pending = await check(noCache);
      if (pending) return { update: { version: pending.version, notes: pending.body ?? null, date: pending.date ?? null }, advertised: pending.version };
      // « Rien de plus récent » ne dit pas ce qui a été lu : une seconde
      // lecture, qui accepte toute version, le dit — sans jamais la proposer
      // à l'installation (comme Guiterm ; `app_update_advertised`).
      const advertised = await invoke<string | null>("app_update_advertised").catch(() => null);
      return { update: null, advertised };
    },
    async install(onProgress) {
      if (!pending) throw new Error("Aucune mise à jour à installer : vérifiez d'abord.");
      let total: number | null = null;
      let done = 0;
      await pending.downloadAndInstall((e) => {
        if (e.event === "Started") total = e.data.contentLength ?? null;
        if (e.event === "Progress") {
          done += e.data.chunkLength;
          onProgress?.(done, total);
        }
      });
      await relaunch();
    },
  });
}
