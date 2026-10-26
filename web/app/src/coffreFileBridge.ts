/** Le pont des archives de coffre (`src/lib/platform.ts` › `CoffreFileBridge`)
 * vers `local_export_snapshot` / `local_staging` / `local_import`
 * (`app-tauri/src/lib.rs`) et le sélecteur de documents d'Android
 * (`CoffreFilePlugin.kt`). Android seulement : au bureau, le dossier du
 * coffre se copie tel quel. */
import { invoke } from "@tauri-apps/api/core";
import { toApiError } from "../../src/lib/localHost";
import { setCoffreFileBridge } from "../../src/lib/platform";
import { freePath } from "./dialogs";
import { isMobile } from "./mobile";
import { coffreName, rememberCoffre } from "./recents";
import { t } from "../../src/lib/i18n";

/** Les refus du Rust sont des erreurs d'API (`toApiError`) ; ceux du plugin
 * Kotlin (`invoke.reject`), un objet `{ message }`. */
function failure(e: unknown): unknown {
  const api = toApiError(e);
  if (api !== e) return api;
  if (typeof e === "object" && e !== null && typeof (e as { message?: unknown }).message === "string") return new Error((e as { message: string }).message);
  return e;
}

const call = <T,>(cmd: string, args?: Record<string, unknown>) => invoke<T>(cmd, args).catch((e) => { throw failure(e); });

export function installCoffreFiles() {
  if (!isMobile()) return;
  setCoffreFileBridge({
    async exportArchive(path) {
      const dir = await call<string>("local_export_snapshot", { path });
      const r = await call<{ saved: boolean; name?: string }>("plugin:coffrefile|save", { dir, name: coffreName(path) });
      return r.saved ? (r.name ?? coffreName(path)) : null;
    },
    async importArchive() {
      const into = await call<string>("local_staging");
      const r = await call<{ picked: boolean; name?: string }>("plugin:coffrefile|pick", { into });
      if (!r.picked) return null;
      const dest = await freePath(r.name || t("Coffre importé"));
      if (!dest) return null;
      await call<void>("local_import", { staging: into, dest });
      rememberCoffre(dest);
      return dest;
    },
  });
}
