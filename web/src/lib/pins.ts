/** Empreintes épinglées : la seule défense contre un serveur qui glisserait
 * sa propre clé publique à la place de celle d'un membre. Par navigateur
 * (`localStorage`), comme Guiterm les garde par machine. */

export type FingerprintTrust = { kind: "pinned" } | { kind: "unknown" } | { kind: "changed"; previous: string };

const KEY = "guivault.pins";

function load(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

export function fingerprintTrust(email: string, fingerprint: string): FingerprintTrust {
  const pinned = load()[email.toLowerCase()];
  if (!pinned) return { kind: "unknown" };
  return pinned === fingerprint ? { kind: "pinned" } : { kind: "changed", previous: pinned };
}

export function pinFingerprint(email: string, fingerprint: string) {
  const pins = load();
  pins[email.toLowerCase()] = fingerprint;
  try {
    localStorage.setItem(KEY, JSON.stringify(pins));
  } catch {
    // Stockage indisponible (navigation privée) : l'épinglage ne vaut que
    // pour la session courante, ce qui reste mieux que rien.
  }
}

export function requirePinned(email: string, fingerprint: string) {
  const t = fingerprintTrust(email, fingerprint);
  if (t.kind !== "pinned") {
    throw new Error(
      t.kind === "changed"
        ? `L'empreinte de ${email} a changé depuis sa vérification (${t.previous}) : vérifiez-la à nouveau avant de partager.`
        : `L'empreinte de ${email} n'a pas été vérifiée : comparez-la hors bande et épinglez-la avant de partager.`,
    );
  }
}

/** L'e-mail sous lequel cette empreinte a été vérifiée, s'il y en a un :
 * pour dire qui a remis la clé d'un vault sans avoir la liste des membres. */
export function pinnedEmailFor(fingerprint: string): string | null {
  const found = Object.entries(load()).find(([, fp]) => fp === fingerprint);
  return found ? found[0] : null;
}
