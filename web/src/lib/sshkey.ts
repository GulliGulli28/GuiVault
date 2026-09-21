/** Générer des clés SSH dans le navigateur, au format OpenSSH (le seul que
 * tout le monde lit) : Ed25519 (noble), RSA et ECDSA (WebCrypto). La clé
 * privée n'est pas chiffrée par une passphrase — c'est le coffre qui la
 * protège ; ce serait bcrypt-pbkdf + AES-CTR, qu'on n'a pas et dont on n'a
 * pas besoin ici. */
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concat, fromBase64, randomBytes, toBase64, utf8 } from "./bytes";

export type SshKeyType = "ed25519" | "rsa" | "ecdsa";

export interface SshKeyOptions {
  type: SshKeyType;
  /** RSA : 2048, 3072, 4096. ECDSA : 256, 384. */
  bits: number;
  comment: string;
}

export const DEFAULT_SSH_KEY: SshKeyOptions = { type: "ed25519", bits: 256, comment: "" };

export interface SshKeyPair {
  /** Le fichier de clé privée (`-----BEGIN OPENSSH PRIVATE KEY-----`). */
  privateKey: string;
  /** La ligne `authorized_keys` (`ssh-ed25519 AAAA… commentaire`). */
  publicKey: string;
  /** `SHA256:…`, ce que `ssh-keygen -l` affiche. */
  fingerprint: string;
  type: string;
}

// ─── Encodage SSH ───────────────────────────────────────────────────────────

function u32(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

function str(b: Uint8Array | string): Uint8Array {
  const bytes = typeof b === "string" ? utf8.encode(b) : b;
  return concat(u32(bytes.length), bytes);
}

/** Entier multiprécision : grand-boutiste, sans zéros de tête, un zéro
 * ajouté si le bit de poids fort est à 1 (signe). */
function mpint(b: Uint8Array): Uint8Array {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  let v = b.subarray(i);
  if (v[0] & 0x80) v = concat(new Uint8Array([0]), v);
  return str(v);
}

function b64url(s: string): Uint8Array {
  return fromBase64(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
}

/** Le fichier privé OpenSSH : en-tête « openssh-key-v1 », pas de chiffrement,
 * une clé, le blob public puis le bloc privé (deux contrôles identiques, les
 * champs de la clé, le commentaire, un bourrage 1,2,3… jusqu'à 8). */
function privateFile(pubBlob: Uint8Array, privFields: Uint8Array, comment: string): string {
  const check = randomBytes(4);
  let block = concat(check, check, privFields, str(comment));
  const pad: number[] = [];
  for (let i = 1; block.length % 8 !== 0; i++) {
    pad.push(i);
    block = concat(block, new Uint8Array([i]));
  }
  const body = concat(utf8.encode("openssh-key-v1\0"), str("none"), str("none"), str(""), u32(1), str(pubBlob), str(block));
  const b64 = toBase64(body).replace(/(.{70})/g, "$1\n").replace(/\n$/, "");
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

function finish(type: string, pubBlob: Uint8Array, privFields: Uint8Array, comment: string): SshKeyPair {
  return {
    privateKey: privateFile(pubBlob, privFields, comment),
    publicKey: `${type} ${toBase64(pubBlob)}${comment ? ` ${comment}` : ""}\n`,
    fingerprint: `SHA256:${toBase64(sha256(pubBlob)).replace(/=+$/, "")}`,
    type,
  };
}

// ─── Les trois familles ─────────────────────────────────────────────────────

export function generateEd25519(comment: string): SshKeyPair {
  const seed = ed25519.utils.randomSecretKey();
  const pub = ed25519.getPublicKey(seed);
  const type = "ssh-ed25519";
  const pubBlob = concat(str(type), str(pub));
  // OpenSSH range la clé privée Ed25519 comme seed‖pub (64 octets).
  const privFields = concat(str(type), str(pub), str(concat(seed, pub)));
  return finish(type, pubBlob, privFields, comment);
}

export async function generateRsa(bits: number, comment: string): Promise<SshKeyPair> {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: bits, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const [n, e, d, p, q, qi] = [jwk.n!, jwk.e!, jwk.d!, jwk.p!, jwk.q!, jwk.qi!].map(b64url);
  const type = "ssh-rsa";
  const pubBlob = concat(str(type), mpint(e), mpint(n));
  const privFields = concat(str(type), mpint(n), mpint(e), mpint(d), mpint(qi), mpint(p), mpint(q));
  return finish(type, pubBlob, privFields, comment);
}

export async function generateEcdsa(bits: 256 | 384, comment: string): Promise<SshKeyPair> {
  const curve = bits === 384 ? "P-384" : "P-256";
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: curve }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const [x, y, d] = [jwk.x!, jwk.y!, jwk.d!].map(b64url);
  const name = `nistp${bits}`;
  const type = `ecdsa-sha2-${name}`;
  const point = concat(new Uint8Array([4]), x, y);
  const pubBlob = concat(str(type), str(name), str(point));
  const privFields = concat(str(type), str(name), str(point), mpint(d));
  return finish(type, pubBlob, privFields, comment);
}

export async function generateSshKey(o: SshKeyOptions): Promise<SshKeyPair> {
  const comment = o.comment.trim();
  switch (o.type) {
    case "ed25519": return generateEd25519(comment);
    case "rsa": return generateRsa([2048, 3072, 4096].includes(o.bits) ? o.bits : 3072, comment);
    case "ecdsa": return generateEcdsa(o.bits === 384 ? 384 : 256, comment);
  }
}
