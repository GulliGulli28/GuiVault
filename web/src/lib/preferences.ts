/** Les préférences d'affichage — le sous-ensemble « Apparence » de
 * `src/lib/preferences.ts` de Guiterm, avec les mêmes fonds, les mêmes
 * accents, les mêmes polices et les mêmes tailles de ligne : un vault se lit
 * pareil ici et là-bas. Les tables (`ACCENT_COLORS`, `BG_THEMES`,
 * `UI_FONT_FAMILIES`…) sont **recopiées** de Guiterm — les changer ici,
 * c'est les changer là-bas.
 *
 * Deux écarts propres au navigateur : le mode `system` (le choix du système,
 * ce qu'une page web sait suivre), et le stockage sous `guivault.preferences`
 * (l'ancien `guivault.theme` est repris une fois). */

export type UiAccent = "indigo" | "blue" | "violet" | "emerald" | "rose" | "teal" | "amber" | "cyan";
/** Une couleur nommée, ou la couleur libre de `uiAccentCustom`. */
export type UiAccentChoice = UiAccent | "custom";

export interface AccentColorEntry {
  label: string;
  /** Remplissage (bouton primaire, marqueur actif). */
  c600: string;
  /** Survol du remplissage — et la pastille de couleur d'un dossier. */
  c500: string;
  /** Texte accentué sur fond sombre. En clair, c'est `c600` qui sert : `c300`
   * n'a pas assez de contraste sur du blanc. */
  c300: string;
  dim: string;
}

export const ACCENT_COLORS: Record<UiAccent, AccentColorEntry> = {
  indigo:  { label: "Indigo",   c600: "#4f46e5", c500: "#6366f1", c300: "#a5b4fc", dim: "rgba(79,70,229,0.18)"  },
  blue:    { label: "Bleu",     c600: "#2563eb", c500: "#3b82f6", c300: "#93c5fd", dim: "rgba(37,99,235,0.18)"  },
  violet:  { label: "Violet",   c600: "#7c3aed", c500: "#8b5cf6", c300: "#c4b5fd", dim: "rgba(124,58,237,0.18)" },
  emerald: { label: "Émeraude", c600: "#059669", c500: "#10b981", c300: "#6ee7b7", dim: "rgba(5,150,105,0.18)"  },
  rose:    { label: "Rose",     c600: "#e11d48", c500: "#f43f5e", c300: "#fda4af", dim: "rgba(225,29,72,0.18)"  },
  teal:    { label: "Teal",     c600: "#0d9488", c500: "#14b8a6", c300: "#5eead4", dim: "rgba(13,148,136,0.18)" },
  amber:   { label: "Ambre",    c600: "#d97706", c500: "#f59e0b", c300: "#fcd34d", dim: "rgba(217,119,6,0.18)"  },
  cyan:    { label: "Cyan",     c600: "#0891b2", c500: "#06b6d4", c300: "#67e8f9", dim: "rgba(8,145,178,0.18)"  },
};

export type UiBg = "slate" | "gray" | "zinc" | "black" | "navy" | "aurora";
export type ColorMode = "dark" | "light";
/** Le mode choisi : les deux de Guiterm, ou celui du système. */
export type ColorModeChoice = ColorMode | "system";

export interface BgShade {
  bg: string;
  bg2: string;
  bg3: string;
  border: string;
}

export interface BgThemeEntry {
  label: string;
  /** Quand le fond clair a sa teinte propre (« Noir pur » → « Blanc pur »). */
  lightLabel?: string;
  dark: BgShade;
  light: BgShade;
}

/* Quatre tons par famille, proches les uns des autres : la fenêtre (`bg`),
 * les panneaux (`bg2`), les contrôles et cartes (`bg3`), et la bordure. Un
 * écart trop grand entre `bg` et `bg2` faisait lire l'interface comme des
 * couches empilées ; ici, c'est la bordure d'un pixel qui découpe. En clair,
 * `bg2` est blanc — le panneau — et `bg` un gris à peine teinté pour la zone
 * de travail. */
export const BG_THEMES: Record<UiBg, BgThemeEntry> = {
  slate: {
    label: "Ardoise",
    dark:  { bg: "#0a0e17", bg2: "#10151f", bg3: "#171d2a", border: "#232b3b" },
    light: { bg: "#e9eef5", bg2: "#f8fafc", bg3: "#e2e8f0", border: "#c9d3e0" },
  },
  gray: {
    label: "Gris",
    dark:  { bg: "#0b0d12", bg2: "#111318", bg3: "#181b22", border: "#242830" },
    light: { bg: "#ececee", bg2: "#f9f9fa", bg3: "#e3e3e6", border: "#cfcfd4" },
  },
  zinc: {
    label: "Zinc",
    lightLabel: "Sable",
    dark:  { bg: "#0c0c0e", bg2: "#121215", bg3: "#19191d", border: "#26262b" },
    light: { bg: "#f0eee9", bg2: "#fbfaf7", bg3: "#e8e5de", border: "#d6d2c8" },
  },
  black: {
    label: "Noir pur",
    lightLabel: "Blanc pur",
    dark:  { bg: "#000000", bg2: "#0a0a0a", bg3: "#141414", border: "#222222" },
    light: { bg: "#ffffff", bg2: "#ffffff", bg3: "#f2f2f2", border: "#e2e2e2" },
  },
  navy: {
    label: "Marine",
    lightLabel: "Ciel",
    dark:  { bg: "#060d1a", bg2: "#0b1526", bg3: "#122036", border: "#1c2d47" },
    light: { bg: "#e3ebf6", bg2: "#f4f7fc", bg3: "#d9e3f0", border: "#bfcde0" },
  },
  aurora: {
    label: "Prune",
    lightLabel: "Lavande",
    dark:  { bg: "#0b0910", bg2: "#110e17", bg3: "#191420", border: "#26202f" },
    light: { bg: "#ede8f5", bg2: "#f9f7fc", bg3: "#e4dcef", border: "#cdc2df" },
  },
};

/** Le nom d'un fond tel qu'il se présente dans le mode courant : les fonds
 * clairs ne sont pas les fonds sombres éclaircis, ils ont leur teinte propre
 * et donc leur nom. */
export function bgThemeLabel(entry: BgThemeEntry, mode: ColorMode): string {
  return mode === "light" ? entry.lightLabel ?? entry.label : entry.label;
}

export interface AppPreferences {
  colorMode: ColorModeChoice;
  uiBg: UiBg;
  uiAccent: UiAccentChoice;
  /** Couleur d'accent libre, en hexadécimal, quand `uiAccent` vaut
   * `"custom"`. Les huit couleurs nommées restent des raccourcis. */
  uiAccentCustom: string;
  /** Police de l'interface. Une valeur de `UI_FONT_FAMILIES`. */
  uiFontFamily: string;
  /** Taille de police, en pixels, du nom d'une ligne d'entité (identifiant,
   * hôte, clé…) ; la ligne secondaire en découle. */
  hostRowSize: number;
  /** Taille, en pixels, de l'icône d'une ligne d'entité. */
  hostRowIconSize: number;
  /** Taille de police, en pixels, des lignes de dossier — l'icône et la
   * hauteur de ligne en découlent (`hostGroupMetrics`). */
  hostGroupSize: number;
  /** Taille, en pixels, de l'icône des lignes de dossier. */
  hostGroupIconSize: number;
}

export const HOST_GROUP_SIZE_MIN = 11;
export const HOST_GROUP_SIZE_MAX = 20;
export const HOST_GROUP_ICON_MIN = 12;
export const HOST_GROUP_ICON_MAX = 32;
export const HOST_ROW_SIZE_MIN = 11;
export const HOST_ROW_SIZE_MAX = 18;
export const HOST_ROW_ICON_MIN = 12;
export const HOST_ROW_ICON_MAX = 32;

/** Ce que les deux tailles de ligne d'hôte posent comme variables CSS — lues
 * par `EntityRow`. La ligne secondaire (adresse, tags) reste un cran sous le
 * nom, l'icône a sa boîte à elle. */
export function hostRowMetrics(fontPx: number, iconPx: number): { font: string; sub: string; icon: string } {
  const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(v * 2) / 2));
  const font = clamp(fontPx, HOST_ROW_SIZE_MIN, HOST_ROW_SIZE_MAX);
  const icon = clamp(iconPx, HOST_ROW_ICON_MIN, HOST_ROW_ICON_MAX);
  return { font: `${font}px`, sub: `${Math.max(10, Math.round((font - 2) * 2) / 2)}px`, icon: `${icon}px` };
}

/** Ce que les deux tailles de dossier posent comme variables CSS — lues par
 * `GroupRow`. La ligne est aussi haute que le plus grand des deux, avec de
 * l'air autour. */
export function hostGroupMetrics(fontPx: number, iconPx: number): { font: string; icon: string; height: string } {
  const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(v * 2) / 2));
  const font = clamp(fontPx, HOST_GROUP_SIZE_MIN, HOST_GROUP_SIZE_MAX);
  const icon = clamp(iconPx, HOST_GROUP_ICON_MIN, HOST_GROUP_ICON_MAX);
  return { font: `${font}px`, icon: `${icon}px`, height: `${Math.round(Math.max(font * 2.2, icon + 10))}px` };
}

export const UI_FONT_FAMILIES: { value: string; label: string }[] = [
  { value: "system", label: "Système (Segoe UI sous Windows)" },
  { value: "\"Inter\", system-ui, sans-serif", label: "Inter" },
  { value: "\"Segoe UI Variable Text\", \"Segoe UI\", system-ui, sans-serif", label: "Segoe UI" },
  { value: "\"Helvetica Neue\", Helvetica, Arial, sans-serif", label: "Helvetica / Arial" },
  { value: "Verdana, Geneva, sans-serif", label: "Verdana" },
  { value: "\"JetBrains Mono\", ui-monospace, monospace", label: "JetBrains Mono (tout en mono)" },
];

/** La pile de polices réellement appliquée pour une valeur de `uiFontFamily`.
 * `"system"` est la valeur par défaut, laissée au navigateur. */
export function uiFontStack(value: string): string {
  return value === "system"
    ? "\"Segoe UI Variable Text\", \"Segoe UI\", system-ui, -apple-system, \"Helvetica Neue\", Arial, sans-serif"
    : value;
}

/** Les quatre teintes d'accent dérivées d'une couleur libre : remplissage,
 * survol (un peu plus clair), texte sur fond sombre (nettement plus clair),
 * et le voile atténué. */
export function accentFromHex(hex: string): AccentColorEntry {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0x2563eb;
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const mix = (t: number) => "#" + [r, g, b].map((c) => Math.round(c + (255 - c) * t).toString(16).padStart(2, "0")).join("");
  return { label: "Personnalisée", c600: mix(0), c500: mix(0.12), c300: mix(0.45), dim: `rgba(${r},${g},${b},0.18)` };
}

export const DEFAULT_PREFERENCES: AppPreferences = {
  colorMode: "dark",
  uiBg: "zinc",
  uiAccent: "blue",
  uiAccentCustom: "#2563eb",
  uiFontFamily: "system",
  hostRowSize: 12.5,
  hostRowIconSize: 24,
  hostGroupSize: 13,
  hostGroupIconSize: 16,
};

const STORAGE_KEY = "guivault.preferences";
/** Le réglage d'avant les préférences : seulement le mode. */
const LEGACY_THEME_KEY = "guivault.theme";

function isMode(v: unknown): v is ColorModeChoice {
  return v === "dark" || v === "light" || v === "system";
}

export function loadPreferences(): AppPreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AppPreferences>;
      const prefs: AppPreferences = { ...DEFAULT_PREFERENCES, ...parsed };
      if (!isMode(prefs.colorMode)) prefs.colorMode = DEFAULT_PREFERENCES.colorMode;
      if (!(prefs.uiBg in BG_THEMES)) prefs.uiBg = DEFAULT_PREFERENCES.uiBg;
      if (prefs.uiAccent !== "custom" && !(prefs.uiAccent in ACCENT_COLORS)) prefs.uiAccent = DEFAULT_PREFERENCES.uiAccent;
      return prefs;
    }
    const legacy = localStorage.getItem(LEGACY_THEME_KEY);
    if (isMode(legacy)) return { ...DEFAULT_PREFERENCES, colorMode: legacy };
  } catch {
    // Stockage indisponible ou illisible : les défauts.
  }
  return { ...DEFAULT_PREFERENCES };
}

export function savePreferences(prefs: AppPreferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Pas de stockage : les préférences valent pour la session.
  }
}

/** Le mode effectivement affiché — `system` résolu contre le navigateur. */
export function resolvedMode(choice: ColorModeChoice): ColorMode {
  if (choice !== "system") return choice;
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** Pose sur `<html>` ce que `App.tsx` de Guiterm pose par ses effets : les
 * surfaces du fond choisi, les quatre teintes d'accent, la police, et les
 * tailles de ligne lues par `EntityRow` et `GroupRow`. */
export function applyPreferences(prefs: AppPreferences): void {
  const root = document.documentElement;
  const mode = resolvedMode(prefs.colorMode);
  const light = mode === "light";

  const colors = prefs.uiAccent === "custom" ? accentFromHex(prefs.uiAccentCustom) : ACCENT_COLORS[prefs.uiAccent];
  root.style.setProperty("--c-accent", colors.c600);
  root.style.setProperty("--c-accent-hover", colors.c500);
  // Le texte accentué doit contraster avec la surface : pastel sur sombre,
  // plein sur clair.
  root.style.setProperty("--c-accent-text", light ? colors.c600 : colors.c300);
  root.style.setProperty("--c-accent-dim", light ? colors.dim.replace("0.18", "0.12") : colors.dim);

  const shade = BG_THEMES[prefs.uiBg][mode];
  root.style.setProperty("--c-bg", shade.bg);
  root.style.setProperty("--c-bg2", shade.bg2);
  root.style.setProperty("--c-bg3", shade.bg3);
  root.style.setProperty("--c-border", shade.border);
  root.dataset.mode = mode;

  root.style.setProperty("--font-ui", uiFontStack(prefs.uiFontFamily));

  const row = hostRowMetrics(prefs.hostRowSize, prefs.hostRowIconSize);
  root.style.setProperty("--entity-font", row.font);
  root.style.setProperty("--entity-sub-font", row.sub);
  root.style.setProperty("--entity-icon", row.icon);

  const group = hostGroupMetrics(prefs.hostGroupSize, prefs.hostGroupIconSize);
  root.style.setProperty("--group-row-font", group.font);
  root.style.setProperty("--group-row-icon", group.icon);
  root.style.setProperty("--group-row-h", group.height);
}

/** Charge, applique, et suit le système tant que le mode est `system`.
 * Renvoie de quoi arrêter de suivre. */
export function installPreferences(): { prefs: AppPreferences; stop: () => void } {
  const prefs = loadPreferences();
  applyPreferences(prefs);
  const mq = window.matchMedia("(prefers-color-scheme: light)");
  const on = () => {
    const current = loadPreferences();
    if (current.colorMode === "system") applyPreferences(current);
  };
  mq.addEventListener("change", on);
  return { prefs, stop: () => mq.removeEventListener("change", on) };
}
