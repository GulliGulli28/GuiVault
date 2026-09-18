/** Port TypeScript de `crates/guivault-crypto` — la même hiérarchie de clés,
 * les mêmes formats binaires, pour que le navigateur lise et écrive ce que
 * Guiterm produit (et réciproquement). Les vecteurs de `crypto.test.ts` sont
 * générés par le crate Rust : c'est ce qui tient les deux implémentations
 * ensemble.
 *
 * ```text
 * mot de passe maître ─Argon2id(sel)─▶ master key
 *        ├─ HKDF("guivault/v1/enc")  ─▶ stretched key ─enveloppe─▶ user key
 *        └─ HKDF("guivault/v1/auth") ─▶ auth key (envoyée au serveur)
 * user key ─enveloppe─▶ clé privée X25519 ◀─déscelle─ vault key ─enveloppe(AAD)─▶ items
 * ```
 *
 * Formats (octet de version `0x01` en tête) :
 * - enveloppe symétrique : `0x01 ‖ nonce(24) ‖ XChaCha20-Poly1305(…)‖tag`
 * - boîte scellée : `0x01 ‖ pk_éphémère(32) ‖ XSalsa20-Poly1305(…)‖tag`
 *   (crypto_box_seal de libsodium : nonce = BLAKE2b-24(pk_éph ‖ pk_dest)).
 *
 * Tout ici tourne côté client. Le serveur ne reçoit que `auth key` et des
 * enveloppes. */
import { argon2idAsync } from "@noble/hashes/argon2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { xsalsa20poly1305, hsalsa } from "@noble/ciphers/salsa.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { concat, randomBytes, toHex, utf8 } from "./bytes";

export const KEY_LEN = 32;
export const SALT_LEN = 16;
export const NONCE_LEN = 24;
export const TAG_LEN = 16;
const FORMAT_V1 = 0x01;

export class CryptoError extends Error {
  constructor(public readonly kind: "format" | "decrypt" | "kdf", message: string) {
    super(message);
  }
}

export interface KdfParams {
  m_cost: number;
  t_cost: number;
  p_cost: number;
}

/** ~64 MiB, 3 passes : les valeurs de `KdfParams::default()` côté Rust. */
export const DEFAULT_KDF: KdfParams = { m_cost: 65536, t_cost: 3, p_cost: 1 };

// ─── Enveloppe symétrique ────────────────────────────────────────────────────

export function seal(key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Uint8Array {
  const nonce = randomBytes(NONCE_LEN);
  const ct = xchacha20poly1305(key, nonce, aad).encrypt(plaintext);
  return concat(new Uint8Array([FORMAT_V1]), nonce, ct);
}

/** Échoue sans distinguer mauvaise clé, mauvais AAD et données altérées. */
export function open(key: Uint8Array, blob: Uint8Array, aad: Uint8Array): Uint8Array {
  if (blob.length < 1 + NONCE_LEN + TAG_LEN || blob[0] !== FORMAT_V1) {
    throw new CryptoError("format", "enveloppe illisible (format ou version inconnus)");
  }
  const nonce = blob.subarray(1, 1 + NONCE_LEN);
  const ct = blob.subarray(1 + NONCE_LEN);
  try {
    return xchacha20poly1305(key, nonce, aad).decrypt(ct);
  } catch {
    throw new CryptoError("decrypt", "déchiffrement refusé : clé ou données incorrectes");
  }
}

// ─── Dérivation depuis le mot de passe maître ───────────────────────────────

export interface MasterKey {
  /** Enveloppe la user key. Ne quitte jamais le client. */
  stretchedKey: Uint8Array;
  /** Preuve de possession présentée au serveur à la place du mot de passe. */
  authKey: Uint8Array;
}

/** Argon2id puis les deux sous-clés HKDF. Asynchrone : Argon2 sur 64 MiB
 * prend une à deux secondes dans un navigateur, et la variante `Async` de
 * noble rend la main régulièrement pour ne pas figer l'interface. */
export async function deriveMasterKey(password: string, salt: Uint8Array, params: KdfParams): Promise<MasterKey> {
  let master: Uint8Array;
  try {
    master = await argon2idAsync(utf8.encode(password), salt, {
      m: params.m_cost,
      t: params.t_cost,
      p: params.p_cost,
      dkLen: KEY_LEN,
    });
  } catch (e) {
    throw new CryptoError("kdf", `dérivation de clé impossible : ${e instanceof Error ? e.message : e}`);
  }
  const expand = (info: string) => hkdf(sha256, master, undefined, utf8.encode(info), KEY_LEN);
  const out = { stretchedKey: expand("guivault/v1/enc"), authKey: expand("guivault/v1/auth") };
  master.fill(0);
  return out;
}

// ─── Clés publiques : partage ───────────────────────────────────────────────

export interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export function generateKeyPair(): KeyPair {
  const privateKey = x25519.utils.randomSecretKey();
  return { publicKey: x25519.getPublicKey(privateKey), privateKey };
}

/** Lecture petit-boutiste, celle que Salsa20 attend quels que soient les mots
 * de la machine (noble fait pareil avec `swap32IfBE`). */
function words(bytes: Uint8Array): Uint32Array {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Uint32Array(bytes.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = v.getUint32(i * 4, true);
  return out;
}

function wordsToBytes(w: Uint32Array): Uint8Array {
  const out = new Uint8Array(w.length * 4);
  const v = new DataView(out.buffer);
  for (let i = 0; i < w.length; i++) v.setUint32(i * 4, w[i], true);
  return out;
}

const SIGMA = words(utf8.encode("expand 32-byte k"));

/** `crypto_box_beforenm` : HSalsa20(secret X25519, nonce nul). */
function boxKey(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  const shared = x25519.getSharedSecret(privateKey, publicKey);
  const out = new Uint32Array(8);
  hsalsa(SIGMA, words(shared), words(new Uint8Array(16)), out);
  shared.fill(0);
  return wordsToBytes(out);
}

function sealedBoxNonce(ephemeralPk: Uint8Array, recipientPk: Uint8Array): Uint8Array {
  return blake2b(concat(ephemeralPk, recipientPk), { dkLen: NONCE_LEN });
}

/** Boîte scellée libsodium vers `recipient`, préfixée de l'octet de version. */
export function sealFor(recipientPk: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const eph = generateKeyPair();
  const key = boxKey(eph.privateKey, recipientPk);
  const ct = xsalsa20poly1305(key, sealedBoxNonce(eph.publicKey, recipientPk)).encrypt(plaintext);
  eph.privateKey.fill(0);
  key.fill(0);
  return concat(new Uint8Array([FORMAT_V1]), eph.publicKey, ct);
}

export function unseal(keypair: KeyPair, blob: Uint8Array): Uint8Array {
  if (blob.length < 1 + 32 + TAG_LEN || blob[0] !== FORMAT_V1) {
    throw new CryptoError("format", "boîte scellée illisible (format ou version inconnus)");
  }
  const ephemeralPk = blob.subarray(1, 33);
  const ct = blob.subarray(33);
  const key = boxKey(keypair.privateKey, ephemeralPk);
  try {
    return xsalsa20poly1305(key, sealedBoxNonce(ephemeralPk, keypair.publicKey)).decrypt(ct);
  } catch {
    throw new CryptoError("decrypt", "déchiffrement refusé : clé ou données incorrectes");
  } finally {
    key.fill(0);
  }
}

/** Empreinte lisible d'une clé publique : 16 octets de SHA-256 en groupes de
 * quatre hexadécimaux — celle que Guiterm affiche, à comparer hors bande. */
export function fingerprint(publicKey: Uint8Array): string {
  const h = sha256(publicKey).subarray(0, 16);
  const parts: string[] = [];
  for (let i = 0; i < 16; i += 2) parts.push(toHex(h.subarray(i, i + 2)));
  return parts.join("-");
}

// ─── Compte ─────────────────────────────────────────────────────────────────

const AAD_USER_KEY = utf8.encode("guivault/v1/user-key");
const AAD_PRIVATE_KEY = utf8.encode("guivault/v1/private-key");

export interface AccountMaterial {
  kdf: KdfParams;
  kdfSalt: Uint8Array;
  authKey: Uint8Array;
  protectedUserKey: Uint8Array;
  publicKey: Uint8Array;
  protectedPrivateKey: Uint8Array;
}

/** Le compte déverrouillé : en mémoire seulement, jamais persisté. */
export interface UnlockedAccount {
  userKey: Uint8Array;
  keypair: KeyPair;
}

export async function createAccount(password: string): Promise<{ material: AccountMaterial; account: UnlockedAccount }> {
  const kdf = DEFAULT_KDF;
  const kdfSalt = randomBytes(SALT_LEN);
  const master = await deriveMasterKey(password, kdfSalt, kdf);
  const userKey = randomBytes(KEY_LEN);
  const keypair = generateKeyPair();
  const material: AccountMaterial = {
    kdf,
    kdfSalt,
    authKey: master.authKey,
    protectedUserKey: seal(master.stretchedKey, userKey, AAD_USER_KEY),
    publicKey: keypair.publicKey,
    protectedPrivateKey: seal(userKey, keypair.privateKey, AAD_PRIVATE_KEY),
  };
  master.stretchedKey.fill(0);
  return { material, account: { userKey, keypair } };
}

/** Un mauvais mot de passe échoue ici (tag AEAD) — le serveur l'aura déjà
 * refusé sur la clé d'auth, sauf s'il ment. */
export function unlockAccount(stretchedKey: Uint8Array, protectedUserKey: Uint8Array, protectedPrivateKey: Uint8Array): UnlockedAccount {
  const userKey = open(stretchedKey, protectedUserKey, AAD_USER_KEY);
  if (userKey.length !== KEY_LEN) throw new CryptoError("format", "user key de taille inattendue");
  const privateKey = open(userKey, protectedPrivateKey, AAD_PRIVATE_KEY);
  if (privateKey.length !== KEY_LEN) throw new CryptoError("format", "clé privée de taille inattendue");
  return { userKey, keypair: { privateKey, publicKey: x25519.getPublicKey(privateKey) } };
}

export interface RekeyMaterial {
  kdf: KdfParams;
  kdfSalt: Uint8Array;
  authKey: Uint8Array;
  protectedUserKey: Uint8Array;
}

/** Changement de mot de passe : seule la user key est ré-enveloppée. */
export async function rekeyAccount(account: UnlockedAccount, newPassword: string): Promise<RekeyMaterial> {
  const kdf = DEFAULT_KDF;
  const kdfSalt = randomBytes(SALT_LEN);
  const master = await deriveMasterKey(newPassword, kdfSalt, kdf);
  const out = { kdf, kdfSalt, authKey: master.authKey, protectedUserKey: seal(master.stretchedKey, account.userKey, AAD_USER_KEY) };
  master.stretchedKey.fill(0);
  return out;
}

// ─── Vaults et items ────────────────────────────────────────────────────────

export function wrapVaultKey(recipientPk: Uint8Array, vaultKey: Uint8Array): Uint8Array {
  return sealFor(recipientPk, vaultKey);
}

export function unwrapVaultKey(account: UnlockedAccount, wrapped: Uint8Array): Uint8Array {
  const k = unseal(account.keypair, wrapped);
  if (k.length !== KEY_LEN) throw new CryptoError("format", "vault key de taille inattendue");
  return k;
}

/** `"guivault/v1/item\0" ‖ vault_id ‖ "\0" ‖ item_id ‖ "\0" ‖ item_type` : le
 * serveur ne peut ni déplacer un item ni changer son type sans que ça se
 * voie. */
export function itemAad(vaultId: string, itemId: string, itemType: string): Uint8Array {
  return utf8.encode(`guivault/v1/item\0${vaultId}\0${itemId}\0${itemType}`);
}

export function sealItem(vaultKey: Uint8Array, vaultId: string, itemId: string, itemType: string, plaintext: Uint8Array): Uint8Array {
  return seal(vaultKey, plaintext, itemAad(vaultId, itemId, itemType));
}

export function openItem(vaultKey: Uint8Array, vaultId: string, itemId: string, itemType: string, blob: Uint8Array): Uint8Array {
  return open(vaultKey, blob, itemAad(vaultId, itemId, itemType));
}

export function sealVaultName(vaultKey: Uint8Array, vaultId: string, name: string): Uint8Array {
  return seal(vaultKey, utf8.encode(name), itemAad(vaultId, "", "vault-name"));
}

export function openVaultName(vaultKey: Uint8Array, vaultId: string, blob: Uint8Array): string {
  return utf8.decode(open(vaultKey, blob, itemAad(vaultId, "", "vault-name")));
}
