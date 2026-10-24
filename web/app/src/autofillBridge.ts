/** Le pont du remplissage automatique (`src/lib/platform.ts`) vers le plugin
 * Kotlin de l'application Android (`app-tauri/src/autofill.rs`,
 * `AutofillPlugin.kt`). Ailleurs, ou sur un téléphone qui ne le permet pas :
 * pas de pont. */
import { invoke } from "@tauri-apps/api/core";
import { setAutofillBridge } from "../../src/lib/platform";

export async function installAutofill(): Promise<void> {
  const status = await invoke<{ supported: boolean; enabled: boolean; biometric: boolean }>("plugin:autofill|status").catch(() => null);
  if (!status?.supported) return;
  setAutofillBridge({
    status: () => invoke("plugin:autofill|status"),
    request: () => invoke<void>("plugin:autofill|request"),
    disable: () => invoke<void>("plugin:autofill|disable"),
    update: (index) => invoke<void>("plugin:autofill|update", { index: JSON.stringify(index) }),
    clear: () => invoke<void>("plugin:autofill|clear"),
    forget: () => invoke<void>("plugin:autofill|forget"),
    passwordUsed: () => invoke<void>("plugin:autofill|password"),
  });
}
