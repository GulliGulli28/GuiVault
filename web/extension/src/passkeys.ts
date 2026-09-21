/** L'authentificateur WebAuthn de l'extension, côté service worker : les
 * passkeys rangées dans les identifiants (`Login.passkeys`, format
 * Bitwarden) servent à s'enregistrer et à s'authentifier. Les clés privées
 * restent ici ; la page ne reçoit que ce que la norme lui rend (attestation
 * « none », assertion signée).
 *
 * Choix : ES256 (P-256) seulement — ce que tout site accepte ; compteur à
 * zéro (« non géré », permis par la norme, comme les passkeys
 * synchronisées) ; drapeaux UP, UV, BE, BS (présent, vérifié — le coffre est
 * déverrouillé —, sauvegardable et sauvegardé). AAGUID nul. */
import { fromBase64, toBase64, uuid, utf8 } from "../../src/lib/bytes";
import type { SessionState, VaultView } from "../../src/lib/session";
import { registrableDomain } from "../../src/lib/urimatch";
import type { Login, Passkey } from "../../src/lib/types";
import { cborEncode } from "./cbor";
import { loadItemsCache, loadSession } from "./store";
import { saveLogin } from "./vaultops";

export function b64url(b: Uint8Array): string {
  return toBase64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s: string): Uint8Array {
  return fromBase64(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
}

async function sha256(b: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource));
}

/** L'identifiant de partie utilisatrice est valable pour cette origine s'il
 * est son hôte ou un suffixe enregistrable de celui-ci (`login.example.com`
 * peut utiliser `example.com`, pas `com`). */
export function rpIdAllowed(rpId: string, origin: string): boolean {
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  const id = rpId.toLowerCase();
  if (host === id) return true;
  return host.endsWith(`.${id}`) && registrableDomain(host) === registrableDomain(id);
}

export interface Candidate {
  loginId: string;
  loginName: string;
  credentialId: string;
  userName: string;
  vaultId: string;
}

interface Located {
  vault: VaultView;
  login: Login;
  revision: number;
}

async function unlocked(): Promise<{ state: SessionState; located: Located[] } | null> {
  const s = await loadSession();
  if (!s) return null;
  const cache = await loadItemsCache();
  const located: Located[] = [];
  for (const v of s.state.vaults) {
    for (const it of cache[v.id]?.items ?? []) if (it.ok && it.payload.kind === "login") located.push({ vault: v, login: it.payload.login, revision: it.revision });
  }
  return { state: s.state, located };
}

/** Les passkeys utilisables pour `rpId`, restreintes à `allow` si la page
 * en donne. `null` : coffre verrouillé. */
export async function candidates(rpId: string, allow: string[]): Promise<Candidate[] | null> {
  const u = await unlocked();
  if (!u) return null;
  const out: Candidate[] = [];
  for (const { vault, login } of u.located) {
    for (const k of login.passkeys) {
      if (k.rpId.toLowerCase() !== rpId.toLowerCase()) continue;
      if (allow.length && !allow.includes(k.credentialId)) continue;
      out.push({ loginId: login.id, loginName: login.name, credentialId: k.credentialId, userName: k.userName || k.userDisplayName || login.username, vaultId: vault.id });
    }
  }
  return out;
}

/** Les identifiants où ranger une nouvelle passkey : ceux qui ont déjà une
 * URI sur ce domaine. */
export async function loginsForRp(rpId: string): Promise<{ id: string; name: string; username: string }[] | null> {
  const u = await unlocked();
  if (!u) return null;
  const rp = registrableDomain(rpId);
  return u.located
    .filter(({ login }) => login.uris.some((x) => { try { return registrableDomain(new URL(/^[a-z]+:/i.test(x.uri) ? x.uri : `https://${x.uri}`).hostname) === rp; } catch { return false; } }))
    .map(({ login }) => ({ id: login.id, name: login.name, username: login.username }));
}

function clientData(type: "webauthn.get" | "webauthn.create", challenge: string, origin: string): Uint8Array {
  return utf8.encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
}

/** r‖s (64 octets, WebCrypto) → DER, ce que WebAuthn attend. */
function derSignature(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.subarray(i);
    if (v[0] & 0x80) v = new Uint8Array([0, ...v]);
    return new Uint8Array([0x02, v.length, ...v]);
  };
  const r = int(raw.subarray(0, 32));
  const s = int(raw.subarray(32));
  return new Uint8Array([0x30, r.length + s.length, ...r, ...s]);
}

const FLAGS_GET = 0x01 | 0x04 | 0x08 | 0x10; // UP, UV, BE, BS
const FLAGS_CREATE = FLAGS_GET | 0x40; // + AT

export interface Assertion {
  credentialId: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
  userHandle: string;
}

export async function assert(credentialId: string, rpId: string, challenge: string, origin: string): Promise<Assertion | null> {
  const u = await unlocked();
  if (!u) return null;
  let key: Passkey | undefined;
  for (const { login } of u.located) key ??= login.passkeys.find((k) => k.credentialId === credentialId && k.rpId.toLowerCase() === rpId.toLowerCase());
  if (!key) return null;
  const cd = clientData("webauthn.get", challenge, origin);
  const authData = new Uint8Array([...(await sha256(utf8.encode(rpId.toLowerCase()))), FLAGS_GET, 0, 0, 0, 0]);
  const toSign = new Uint8Array([...authData, ...(await sha256(cd))]);
  const priv = await crypto.subtle.importKey("pkcs8", fromBase64(key.keyValue) as BufferSource, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, priv, toSign as BufferSource));
  return { credentialId, clientDataJSON: b64url(cd), authenticatorData: b64url(authData), signature: b64url(derSignature(raw)), userHandle: key.userHandle };
}

export interface RegisterRequest {
  rpId: string;
  rpName: string;
  userHandle: string;
  userName: string;
  userDisplayName: string;
  challenge: string;
  origin: string;
  /** L'identifiant où ranger la passkey ; `null` en crée un. */
  loginId: string | null;
  discoverable: boolean;
}

export interface Attestation {
  credentialId: string;
  clientDataJSON: string;
  attestationObject: string;
  authenticatorData: string;
  /** SPKI DER, pour `getPublicKey()`. */
  publicKey: string;
}

export async function register(req: RegisterRequest): Promise<Attestation | { error: string }> {
  const u = await unlocked();
  if (!u) return { error: "coffre verrouillé" };
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const credId = crypto.getRandomValues(new Uint8Array(16));
  const credentialId = b64url(credId);
  const passkey: Passkey = {
    credentialId,
    keyType: "public-key",
    keyAlgorithm: "ECDSA",
    keyCurve: "P-256",
    keyValue: toBase64(pkcs8),
    rpId: req.rpId.toLowerCase(),
    rpName: req.rpName || null,
    userHandle: req.userHandle,
    userName: req.userName || null,
    userDisplayName: req.userDisplayName || null,
    counter: 0,
    discoverable: req.discoverable,
    createdAt: new Date().toISOString(),
  };

  // Ranger : dans l'identifiant choisi, ou un nouveau dans le vault
  // personnel (le premier vault, par construction).
  const target = req.loginId ? u.located.find((l) => l.login.id === req.loginId) : undefined;
  if (req.loginId && !target) return { error: "identifiant introuvable" };
  let vault: VaultView;
  let login: Login;
  let revision: number | undefined;
  if (target) {
    vault = target.vault;
    login = { ...target.login, passkeys: [...target.login.passkeys, passkey] };
    revision = target.revision;
  } else {
    vault = u.state.vaults.find((v) => v.kind === "personal") ?? u.state.vaults[0];
    if (!vault) return { error: "aucun vault" };
    login = { id: uuid(), name: req.rpName || req.rpId, groupId: null, tags: [], username: req.userName, password: "", uris: [{ uri: `https://${req.rpId}`, match: null }], totp: null, passkeys: [passkey], passwordHistory: [] };
  }
  try {
    await saveLogin(vault.id, login, revision);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  const cose = cborEncode(new Map<number, import("./cbor").CborValue>([[1, 2], [3, -7], [-1, 1], [-2, fromB64url(jwk.x!)], [-3, fromB64url(jwk.y!)]]));
  const authData = new Uint8Array([
    ...(await sha256(utf8.encode(req.rpId.toLowerCase()))),
    FLAGS_CREATE,
    0, 0, 0, 0,
    ...new Uint8Array(16),
    credId.length >> 8, credId.length & 0xff,
    ...credId,
    ...cose,
  ]);
  const cd = clientData("webauthn.create", req.challenge, req.origin);
  const attestationObject = cborEncode({ fmt: "none", attStmt: {}, authData });
  return { credentialId, clientDataJSON: b64url(cd), attestationObject: b64url(attestationObject), authenticatorData: b64url(authData), publicKey: b64url(spki) };
}
