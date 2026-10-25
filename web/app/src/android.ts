/** Ce que seule l'application Android sait faire du système, par
 * l'interface `GuiVaultAndroid` que pose `MainActivity.kt` : cacher l'écran
 * aux captures (`ScreenBridge`), copier un secret marqué sensible et effacé
 * à l'échéance (`ClipboardBridge`). Absente au bureau : rien n'est posé. */
import { setClipboardBridge, setScreenBridge } from "../../src/lib/platform";

declare global {
  interface Window {
    GuiVaultAndroid?: { setSecure(on: boolean): void; copySecret(text: string, clearAfterMs: number): void };
  }
}

export function installAndroid(): void {
  const android = window.GuiVaultAndroid;
  if (!android) return;
  setScreenBridge({ setSecure: (on) => android.setSecure(on) });
  setClipboardBridge({ copySecret: async (text, clearAfterMs) => android.copySecret(text, clearAfterMs) });
}
