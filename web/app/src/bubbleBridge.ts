/** Le pont de la bulle flottante (`src/lib/platform.ts`) vers le plugin
 * Kotlin de l'application Android (`app-tauri/src/bubble.rs`,
 * `BubblePlugin.kt`). Ailleurs, la commande n'existe pas : pas de pont. */
import { invoke } from "@tauri-apps/api/core";
import { setBubbleBridge } from "../../src/lib/platform";

const reduced = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** Avant de passer la main au système : la page se détache, s'arrondit et
 * part vers l'endroit où la bulle va naître. */
async function lift(anchor: { x: number; y: number }): Promise<void> {
  const root = document.getElementById("root");
  if (!root || reduced()) return;
  const html = document.documentElement;
  html.style.background = "#000";
  root.style.transformOrigin = `${anchor.x}px ${anchor.y}px`;
  root.style.overflow = "hidden";
  const a = root.animate(
    [
      { transform: "scale(1)", borderRadius: "0px", filter: "brightness(1)" },
      { transform: "scale(0.9)", borderRadius: "32px", filter: "brightness(0.85)" },
    ],
    { duration: 170, easing: "cubic-bezier(0.3, 0, 0.8, 0.15)", fill: "forwards" },
  );
  await a.finished.catch(() => {});
}

/** Rend la page telle quelle, sans animation (l'application est cachée). */
function reset(): void {
  const root = document.getElementById("root");
  if (!root) return;
  root.getAnimations().forEach((a) => a.cancel());
  root.style.transformOrigin = "";
  root.style.overflow = "";
  document.documentElement.style.background = "";
}

/** Au retour (par la bulle, ou d'ailleurs) : la page se pose, un peu comme
 * elle était partie — Android la fait déjà grandir depuis la bulle. */
function settle(): void {
  const root = document.getElementById("root");
  if (!root || reduced()) return;
  root.style.overflow = "hidden";
  root.animate(
    [
      { transform: "scale(0.94)", borderRadius: "28px", opacity: 0.6 },
      { transform: "scale(1)", borderRadius: "0px", opacity: 1 },
    ],
    { duration: 460, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
  ).finished.then(() => { root.style.overflow = ""; }, () => {});
}

export async function installBubble(): Promise<void> {
  const available = await invoke<{ value: boolean }>("plugin:bubble|available").then((r) => r.value, () => false);
  if (!available) return;
  let away = false;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      away = true;
      reset();
    } else if (away) {
      away = false;
      settle();
    }
  });
  setBubbleBridge({
    async show() {
      const { value } = await invoke<{ value: boolean }>("plugin:bubble|allowed");
      if (!value) {
        await invoke("plugin:bubble|ask");
        return false;
      }
      const anchor = await invoke<{ x: number; y: number }>("plugin:bubble|anchor").catch(() => null);
      if (anchor) await lift(anchor);
      try {
        await invoke("plugin:bubble|show");
      } catch (e) {
        reset();
        throw e;
      }
      return true;
    },
    setLocked: (locked) => invoke<void>("plugin:bubble|locked", { locked }),
    auto: (enabled) => invoke<{ enabled: boolean; allowed: boolean }>("plugin:bubble|auto", enabled === undefined ? {} : { enabled }),
    ask: () => invoke<void>("plugin:bubble|ask"),
  });
}
