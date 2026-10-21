/** Les réglages du web qui suivent le compte (voir `syncedSettings.ts`) :
 * l'apparence, les deux générateurs et l'effacement du presse-papiers. Importé pour son effet par l'app et
 * par le popup de l'extension. */
import { applyPreferences, DESIGN_VERSION, loadPreferences, savePreferences, type AppPreferences } from "./preferences";
import { CLIPBOARD_KEY } from "./clipboard";
import { registerSettingsSection } from "./syncedSettings";

registerSettingsSection({
  key: "appearance",
  read: () => loadPreferences(),
  write: (v) => {
    if (!v || typeof v !== "object") return;
    // `loadPreferences` écarte ce qu'un autre client aurait mis d'invalide.
    // Un client d'avant la refonte envoie l'ancien fond, l'ancien accent,
    // l'ancienne police et les anciennes lignes : ils ne remplacent pas ceux
    // d'ici.
    const remote = { ...(v as Partial<AppPreferences>) };
    if ((remote.design ?? 0) < DESIGN_VERSION) {
      delete remote.uiBg;
      delete remote.uiAccent;
      delete remote.uiFontFamily;
      delete remote.hostRowSize;
      delete remote.hostRowIconSize;
      delete remote.design;
    }
    savePreferences({ ...loadPreferences(), ...remote });
    applyPreferences(loadPreferences());
  },
});

/** Une clé de `localStorage` tenue en JSON, telle quelle. */
function jsonSection(key: string, storageKey: string) {
  registerSettingsSection({
    key,
    read: () => {
      try {
        const raw = localStorage.getItem(storageKey);
        return raw ? (JSON.parse(raw) as unknown) : null;
      } catch {
        return null;
      }
    },
    write: (v) => {
      if (v === null || typeof v !== "object") return;
      try {
        localStorage.setItem(storageKey, JSON.stringify(v));
      } catch {
        // sans stockage, rien à retenir
      }
    },
  });
}

jsonSection("generator", "guivault.generator");
jsonSection("sshKey", "guivault.sshkey");
jsonSection("clipboard", CLIPBOARD_KEY);
// La couleur de chaque vault (`lib/vaultColors.ts`).
jsonSection("vaultColors", "guivault.vaultColors");
