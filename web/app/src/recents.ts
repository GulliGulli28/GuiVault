/** Les coffres locaux ouverts sur cet appareil, du plus récent au plus
 * ancien, et le dernier serveur : une commodité par appareil
 * (`localStorage`), rien qui doive survivre à tout. */
const RECENTS = "guivault.app.recents";
const SERVER = "guivault.app.server";
const MAX = 8;

export function recentCoffres(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(RECENTS) ?? "[]");
    return Array.isArray(raw) ? raw.filter((p): p is string => typeof p === "string").slice(0, MAX) : [];
  } catch {
    return [];
  }
}

export function rememberCoffre(path: string) {
  try {
    localStorage.setItem(RECENTS, JSON.stringify([path, ...recentCoffres().filter((p) => p !== path)].slice(0, MAX)));
  } catch {
    // stockage indisponible : la liste ne sera pas retenue, rien de plus
  }
}

export function forgetCoffre(path: string) {
  try {
    localStorage.setItem(RECENTS, JSON.stringify(recentCoffres().filter((p) => p !== path)));
  } catch {
    // idem
  }
}

export function lastServer(): string {
  try {
    return localStorage.getItem(SERVER) ?? "";
  } catch {
    return "";
  }
}

export function rememberServer(url: string) {
  try {
    localStorage.setItem(SERVER, url);
  } catch {
    // idem
  }
}

/** Le nom du dossier, quel que soit le séparateur (Windows ou non). */
export function coffreName(path: string): string {
  const name = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;
  return name.replace(/\.guivault$/i, "") || path;
}
