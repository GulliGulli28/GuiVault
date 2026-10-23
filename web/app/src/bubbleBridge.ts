/** Le pont de la bulle flottante (`src/lib/platform.ts`) vers le plugin
 * Kotlin de l'application Android (`app-tauri/src/bubble.rs`,
 * `BubblePlugin.kt`). Ailleurs, la commande n'existe pas : pas de pont. Le
 * passage entre la bulle et le plein écran est animé côté Android
 * (`BubbleService`, une image de la fenêtre) : la page n'a rien à faire. */
import { invoke } from "@tauri-apps/api/core";
import { setBubbleBridge } from "../../src/lib/platform";

export async function installBubble(): Promise<void> {
  const available = await invoke<{ value: boolean }>("plugin:bubble|available").then((r) => r.value, () => false);
  if (!available) return;
  setBubbleBridge({
    async show() {
      const { value } = await invoke<{ value: boolean }>("plugin:bubble|allowed");
      if (!value) {
        await invoke("plugin:bubble|ask");
        return false;
      }
      await invoke("plugin:bubble|show");
      return true;
    },
    setLocked: (locked) => invoke<void>("plugin:bubble|locked", { locked }),
    auto: (enabled) => invoke<{ enabled: boolean; allowed: boolean }>("plugin:bubble|auto", enabled === undefined ? {} : { enabled }),
    ask: () => invoke<void>("plugin:bubble|ask"),
  });
}
