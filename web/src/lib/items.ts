/** Ce qu'on sait faire d'un secret sans le serveur : le créer vide, le
 * décrire pour la liste, le fouiller. */
import { uuid } from "./bytes";
import type { ApiKey, AwsAccess, Card, Identity, Login, Note, Payload, SecretKind } from "./types";

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

export function emptyAws(groupId: string | null = null): AwsAccess {
  return { id: uuid(), name: "", groupId, tags: [], authType: "sso", ssoSessionName: "", ssoStartUrl: "", ssoRegion: "", accessKeyId: "", secretAccessKey: "", mfaSerial: "", region: "", profiles: [] };
}

export function emptyApiKey(groupId: string | null = null): ApiKey {
  return { id: uuid(), name: "", groupId, tags: [], service: "", url: "", keyId: "", secret: "", scopes: "", expiresAt: "" };
}

export function emptyPayload(kind: SecretKind, groupId: string | null = null): Payload {
  switch (kind) {
    case "login": return { kind, login: emptyLogin(groupId) };
    case "note": return { kind, note: emptyNote(groupId) };
    case "card": return { kind, card: emptyCard(groupId) };
    case "identity": return { kind, identity: emptyIdentity(groupId) };
    case "aws": return { kind, aws: emptyAws(groupId) };
    case "api-key": return { kind, apiKey: emptyApiKey(groupId) };
  }
}

export function isSecret(p: Payload): p is Extract<Payload, { kind: SecretKind }> {
  return p.kind === "login" || p.kind === "note" || p.kind === "card" || p.kind === "identity" || p.kind === "aws" || p.kind === "api-key";
}

/** `~/.aws/config` (et `~/.aws/credentials` pour des clés) tels qu'un
 * accès AWS les écrirait : de quoi reconfigurer un poste d'un copier-coller,
 * ou ce que Guiterm réécrira. */
export function awsConfigText(a: AwsAccess): { config: string; credentials: string } {
  const lines: string[] = [];
  const cred: string[] = [];
  const session = a.ssoSessionName.trim() || "default";
  if (a.authType === "sso") {
    lines.push(`[sso-session ${session}]`, `sso_start_url = ${a.ssoStartUrl.trim()}`, `sso_region = ${a.ssoRegion.trim() || a.region.trim()}`, "sso_registration_scopes = sso:account:access", "");
  }
  const profiles = a.profiles.length ? a.profiles : [{ name: "default", accountId: "", roleName: "", region: "" }];
  for (const p of profiles) {
    const name = p.name.trim() || "default";
    lines.push(name === "default" ? "[default]" : `[profile ${name}]`);
    if (a.authType === "sso") {
      lines.push(`sso_session = ${session}`);
      if (p.accountId.trim()) lines.push(`sso_account_id = ${p.accountId.trim()}`);
      if (p.roleName.trim()) lines.push(`sso_role_name = ${p.roleName.trim()}`);
    } else if (a.mfaSerial.trim()) lines.push(`mfa_serial = ${a.mfaSerial.trim()}`);
    const region = p.region.trim() || a.region.trim();
    if (region) lines.push(`region = ${region}`);
    lines.push("");
    if (a.authType === "keys") cred.push(`[${name}]`, `aws_access_key_id = ${a.accessKeyId.trim()}`, `aws_secret_access_key = ${a.secretAccessKey.trim()}`, "");
  }
  return { config: lines.join("\n").trimEnd() + "\n", credentials: cred.length ? cred.join("\n").trimEnd() + "\n" : "" };
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
    case "aws": {
      const a = p.aws;
      const accounts = Array.from(new Set(a.profiles.map((x) => x.accountId).filter(Boolean)));
      const subtitle = a.authType === "sso"
        ? [a.ssoStartUrl ? uriHost(a.ssoStartUrl) : "SSO", a.profiles.length ? `${a.profiles.length} profil${a.profiles.length > 1 ? "s" : ""}` : ""].filter(Boolean).join(" · ")
        : [a.accessKeyId, a.profiles.map((x) => x.name).filter(Boolean).join(", ")].filter(Boolean).join(" · ");
      return { subtitle, search: [a.ssoStartUrl, a.ssoSessionName, a.accessKeyId, ...accounts, ...a.profiles.flatMap((x) => [x.name, x.roleName])].join(" ") };
    }
    case "runbook": {
      const steps = p.runbook.steps.map((s) => [s.title, s.action.kind === "command" ? s.action.command : s.action.kind === "playbook" ? s.action.playbook : ""].join(" "));
      return { subtitle: "", search: [p.runbook.description, ...steps].join(" ") };
    }
    case "api-key": {
      const k = p.apiKey;
      const expired = k.expiresAt && k.expiresAt < new Date().toISOString().slice(0, 10);
      return { subtitle: [k.service, k.keyId, expired ? "expirée" : k.expiresAt ? `expire le ${k.expiresAt}` : ""].filter(Boolean).join(" · "), search: [k.service, k.url, k.keyId, k.scopes].join(" ") };
    }
    default:
      return { subtitle: "", search: "" };
  }
}

// ─── Copier depuis le clavier ───────────────────────────────────────────────

/** Ce que « c » (et Ctrl+C dans la recherche globale) copie : le secret
 * principal d'un élément, avec de quoi le dire (« Mot de passe copié »). */
export function primarySecret(p: Payload): { label: string; value: string } | null {
  const pick = (label: string, value: string | null | undefined) => (value ? { label, value } : null);
  switch (p.kind) {
    case "login": return pick("Mot de passe", p.login.password);
    case "card": return pick("Numéro de carte", p.card.number);
    case "api-key": return pick("Secret", p.apiKey.secret);
    case "aws": return pick("Clé secrète", p.aws.secretAccessKey);
    case "note": return pick("Contenu", p.note.content);
    case "host": return pick("Mot de passe", p.secrets?.password);
    case "sql-connection": return pick("Mot de passe", p.password);
    case "snippet": return pick("Commande", p.snippet.command);
    default: return null;
  }
}

/** Ce que « u » (et Ctrl+Maj+C) copie : l'identifiant d'un élément. */
export function primaryUser(p: Payload): { label: string; value: string } | null {
  const pick = (label: string, value: string | null | undefined) => (value ? { label, value } : null);
  switch (p.kind) {
    case "login": return pick("Utilisateur", p.login.username);
    case "identity": return pick("E-mail", p.identity.email) ?? pick("Utilisateur", p.identity.username);
    case "api-key": return pick("Identifiant de clé", p.apiKey.keyId);
    case "aws": return pick("Access key id", p.aws.accessKeyId);
    case "card": return pick("Titulaire", p.card.cardholderName);
    case "host": return pick("Utilisateur", p.host.username);
    case "sql-connection": return pick("Utilisateur", typeof p.connection.username === "string" ? p.connection.username : null);
    default: return null;
  }
}
