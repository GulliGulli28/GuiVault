/** Le service worker de l'extension : presque rien, à dessein. Il meurt au
 * bout de 30 s d'inactivité (MV3), donc il ne garde aucune clé — la session
 * vit dans `chrome.storage.session`, effacée à la fermeture du navigateur ou
 * quand l'alarme de verrouillage sonne. */
import { LOCK_ALARM, lock } from "./store";

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === LOCK_ALARM) void lock();
});

chrome.runtime.onInstalled.addListener(() => {
  // Rien à préparer : le popup guide vers la connexion.
});
