/** Ce qu'on sait faire d'un secret sans le serveur : le créer vide, le
 * décrire pour la liste, le fouiller. */
import { uuid } from "./bytes";
import type { Card, Identity, Login, Note, Payload, SecretKind } from "./types";

export function emptyLogin(groupId: string | null = null): Login {
  return { id: uuid(), name: "", groupId, tags: [], username: "", password: "", uris: [], totp: null, passkeys: [], passwordHistory: [] };
}

export function emptyNote(groupId: string | null = null): Note {
  return { id: uuid(), name: "", groupId, tags: [], content: "" };
}

export function emptyCard(groupId: string | null = null): Card {
  return { id: uuid(), name: "", groupId, tags: [], cardholderName: "", brand: "", number: "", expMonth: "", expYear: "", code: "" };
}

export function emptyIdentity(groupId: string | null = null): Identity {
  return {
    id: uuid(), name: "", groupId, tags: [],
    title: "", firstName: "", middleName: "", lastName: "", username: "", company: "", ssn: "", passportNumber: "", licenseNumber: "",
    email: "", phone: "", address1: "", address2: "", address3: "", city: "", state: "", postalCode: "", country: "",
  };
}

export function emptyPayload(kind: SecretKind, groupId: string | null = null): Payload {
  switch (kind) {
    case "login": return { kind, login: emptyLogin(groupId) };
    case "note": return { kind, note: emptyNote(groupId) };
    case "card": return { kind, card: emptyCard(groupId) };
    case "identity": return { kind, identity: emptyIdentity(groupId) };
  }
}

export function isSecret(p: Payload): p is Extract<Payload, { kind: SecretKind }> {
  return p.kind === "login" || p.kind === "note" || p.kind === "card" || p.kind === "identity";
}

/** L'hôte d'une URI, pour la ligne secondaire (« github.com »). Une URI
 * sans schéma est tentée en https. */
export function uriHost(uri: string): string {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:/i.test(uri) ? uri : `https://${uri}`).host || uri;
  } catch {
    return uri;
  }
}

/** Marque de carte devinée depuis le numéro, quand elle n'est pas dite. */
export function cardBrand(number: string): string {
  const n = number.replace(/\D/g, "");
  if (/^4/.test(n)) return "Visa";
  if (/^(5[1-5]|2[2-7])/.test(n)) return "Mastercard";
  if (/^3[47]/.test(n)) return "American Express";
  if (/^(6011|65|64[4-9])/.test(n)) return "Discover";
  if (/^35/.test(n)) return "JCB";
  if (/^3(0[0-5]|[68])/.test(n)) return "Diners Club";
  return "";
}

export function maskedCardNumber(number: string): string {
  const n = number.replace(/\s/g, "");
  return n.length > 4 ? `•••• ${n.slice(-4)}` : n;
}

export function identityFullName(i: Identity): string {
  return [i.title, i.firstName, i.middleName, i.lastName].filter(Boolean).join(" ");
}

/** Ligne secondaire et texte de recherche d'un secret, pour la liste. */
export function describeSecret(p: Payload): { subtitle: string; search: string } {
  switch (p.kind) {
    case "login": {
      const host = p.login.uris[0] ? uriHost(p.login.uris[0].uri) : "";
      return { subtitle: [p.login.username, host].filter(Boolean).join(" · "), search: [p.login.username, ...p.login.uris.map((u) => u.uri), p.login.notes ?? ""].join(" ") };
    }
    case "card":
      return { subtitle: [p.card.brand || cardBrand(p.card.number), maskedCardNumber(p.card.number)].filter(Boolean).join(" "), search: p.card.cardholderName };
    case "identity":
      return { subtitle: [identityFullName(p.identity), p.identity.email].filter(Boolean).join(" · "), search: [identityFullName(p.identity), p.identity.email, p.identity.username, p.identity.company].join(" ") };
    case "note":
      return { subtitle: p.note.content.split("\n")[0].slice(0, 60), search: "" };
    default:
      return { subtitle: "", search: "" };
  }
}
