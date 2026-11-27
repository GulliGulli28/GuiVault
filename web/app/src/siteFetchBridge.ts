/** Les icônes des sites (`src/lib/siteIcon.ts`) vers
 * `app-tauri/src/site_fetch.rs` au bureau, `SiteFetchPlugin.kt` sous
 * Android (`site_fetch_android.rs`) : mêmes réponses. */
import { invoke } from "@tauri-apps/api/core";
import { fromBase64 } from "../../src/lib/bytes";
import { setSiteFetchBridge } from "../../src/lib/platform";

export function installSiteFetch(mobile: boolean): void {
  const command = mobile ? "plugin:sitefetch|fetch" : "site_fetch";
  setSiteFetchBridge({
    fetch: async (url) => {
      const r = await invoke<{ url: string; type: string; data: string }>(command, { url });
      return { url: r.url, type: r.type, bytes: fromBase64(r.data) };
    },
  });
}
