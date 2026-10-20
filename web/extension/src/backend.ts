/** D'où viennent les blobs : le serveur (`setBaseUrl`), ou le coffre local
 * de l'application par son hôte natif (`nativeHost.ts`). Appelé partout où
 * l'extension retrouve sa session — popup et service worker. */
import { setBaseUrl, setTransport } from "../../src/lib/api";
import { localTransport } from "../../src/lib/localHost";
import type { SessionState } from "../../src/lib/session";
import { nativeCoffre } from "./nativeHost";
import type { Settings } from "./store";

export function applyBackend(state: SessionState | null, settings: Settings) {
  if (state?.local) {
    setTransport(localTransport(nativeCoffre(state.local.path)));
    return;
  }
  setTransport(null);
  if (settings.serverUrl) setBaseUrl(settings.serverUrl);
}
