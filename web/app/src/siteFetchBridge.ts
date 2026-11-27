/** Les icônes des sites (`src/lib/siteIcon.ts`) vers
 * `app-tauri/src/site_fetch.rs` : posé au bureau seulement. */
import { invoke } from "@tauri-apps/api/core";
import { fromBase64 } from "../../src/lib/bytes";
import { setSiteFetchBridge } from "../../src/lib/platform";

export function installSiteFetch(): void {
  setSiteFetchBridge({
    fetch: async (url) => {
      const r = await invoke<{ url: string; type: string; data: string }>("site_fetch", { url });
      return { url: r.url, type: r.type, bytes: fromBase64(r.data) };
    },
  });
}
