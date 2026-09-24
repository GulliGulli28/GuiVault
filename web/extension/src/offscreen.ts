/** Le document hors écran (Chrome) : un service worker n'a pas de DOM, donc
 * pas de presse-papiers. Le worker l'ouvre le temps d'effacer ce que le
 * popup a copié (`background.ts`), puis le referme. */
import { clearClipboardIfUnchanged } from "./clipboardDom";
import type { OffscreenMessage } from "./messages";

chrome.runtime.onMessage.addListener((msg: OffscreenMessage, _sender, reply: (r: { cleared: boolean }) => void) => {
  if (msg?.type !== "guivault-offscreen-clipboard-clear") return;
  reply({ cleared: clearClipboardIfUnchanged(msg.hash) });
});
