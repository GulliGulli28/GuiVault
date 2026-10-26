/** Le pont des sauvegardes du coffre local (`src/lib/platform.ts`) vers
 * `local_backups` / `local_restore_backup` (`app-tauri/src/main.rs`). */
import { invoke } from "@tauri-apps/api/core";
import { toApiError } from "../../src/lib/localHost";
import { setBackupBridge, type LocalBackup } from "../../src/lib/platform";
import { pickRestoreDest } from "./dialogs";
import { coffreName, rememberCoffre } from "./recents";
import { t } from "../../src/lib/i18n";

export function installBackups() {
  setBackupBridge({
    list: (path) => invoke<LocalBackup[]>("local_backups", { path }).catch((e) => { throw toApiError(e); }),
    async restoreCopy(path, name) {
      const day = name.replace(/^coffre-(\d{4})(\d{2})(\d{2}).*$/, "$1-$2-$3");
      const dest = await pickRestoreDest(t("{0} (sauvegarde du {1}).guivault", coffreName(path), day));
      if (!dest) return null;
      await invoke<void>("local_restore_backup", { path, name, dest }).catch((e) => { throw toApiError(e); });
      rememberCoffre(dest);
      return dest;
    },
  });
}
