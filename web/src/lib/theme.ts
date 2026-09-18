/** Sombre (le défaut, comme Guiterm), clair, ou comme le système. Le choix
 * est propre au navigateur. */
export type ThemeChoice = "dark" | "light" | "system";

const KEY = "guivault.theme";

export function loadTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === "dark" || v === "light" || v === "system" ? v : "dark";
  } catch {
    return "dark";
  }
}

export function applyTheme(choice: ThemeChoice) {
  const system = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  document.documentElement.dataset.mode = choice === "system" ? system : choice;
  try {
    localStorage.setItem(KEY, choice);
  } catch {
    // Pas de stockage : le thème vaut pour la session.
  }
}
