/** Le pont des coffres locaux vus d'une autre session (`src/lib/platform.ts`,
 * `transfer.ts`) : l'hôte Tauri, les boîtes de dialogue et les récents de
 * l'accueil. */
import { setCoffreBridge } from "../../src/lib/platform";
import { pickCoffre, pickNewCoffre } from "./dialogs";
import { lastServer, rememberCoffre } from "./recents";
import { tauriHost, tauriPeerHost } from "./tauriHost";

export function installCoffres() {
  setCoffreBridge({
    host: tauriHost,
    peer: tauriPeerHost,
    pickNew: pickNewCoffre,
    pickExisting: pickCoffre,
    remember: rememberCoffre,
    lastServer,
  });
}
