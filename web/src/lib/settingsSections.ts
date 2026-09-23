/** Les réglages du web qui suivent le compte (voir `syncedSettings.ts`) :
 * l'apparence et les deux générateurs. Importé pour son effet par l'app et
 * par le popup de l'extension. */
import { applyPreferences, loadPreferences, savePreferences, type AppPreferences } from "./preferences";
import { registerSettingsSection } from "./syncedSettings";

registerSettingsSection({
  key: "appearance",
  read: () => loadPreferences(),
  write: (v) => {
    if (!v || typeof v !== "object") return;
    // `loadPreferences` écarte ce qu'un autre client aurait mis d'invalide.
    savePreferences({ ...loadPreferences(), ...(v as Partial<AppPreferences>) });
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
