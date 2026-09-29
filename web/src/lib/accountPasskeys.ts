/** Se connecter avec une passkey (`docs/PASSKEYS.md`) — celles du compte, à
 * ne pas confondre avec les passkeys rangées dans un identifiant.
 *
 * L'extension PRF de WebAuthn fait calculer à l'authentificateur un secret
 * propre à la passkey, jamais envoyé au serveur ; `passkeyKey` en tire une
 * clé qui enveloppe la user key. Le serveur garde l'enveloppe à côté de la
 * clé publique de la passkey : à la connexion, il vérifie la signature et la
 * rend, et seule la PRF la rouvre. Une passkey sans PRF (certaines clés
 * anciennes, certains gestionnaires) ne peut pas servir. */
import { api, setTokens } from "./api";
import { fromBase64, randomBytes, toBase64 } from "./bytes";
import * as c from "./crypto";
import { requireKdfNotDowngraded } from "./kdfPins";
import { deviceName, openSession, type SessionState } from "./session";
import type { AccountPasskey } from "./types";

type Prf = { enabled?: boolean; results?: { first?: BufferSource } };

export function passkeysSupported(): boolean {
  return typeof window !== "undefined" && !!window.PublicKeyCredential && !!navigator.credentials?.create;
}

const buf = (b64: string): ArrayBuffer => fromBase64(b64).slice().buffer;
const bytes = (b: ArrayBuffer | ArrayBufferView): Uint8Array => (b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength));

function prfOutput(cred: PublicKeyCredential): Uint8Array | null {
  const first = (cred.getClientExtensionResults() as { prf?: Prf }).prf?.results?.first;
  return first ? bytes(first as ArrayBuffer) : null;
}

const NO_PRF =
  "Cette passkey ne sait pas dériver de clé (extension PRF de WebAuthn) : elle ne peut pas ouvrir le coffre. " +
  "Essayez une passkey de votre système (Windows Hello, trousseau Apple, Google) ou une clé de sécurité récente.";

/** Ajoute une passkey au compte : mot de passe maître redemandé (le serveur
 * le vérifie), puis la passkey est créée, sa PRF interrogée, et la user key
 * enveloppée sous la clé qu'on en tire. */
export async function registerPasskey(state: SessionState, name: string, password: string): Promise<AccountPasskey> {
  const pre = await api.prelogin(state.user.email);
  requireKdfNotDowngraded(state.user.email, pre.kdf);
  const master = await c.deriveMasterKey(password, fromBase64(pre.kdf_salt), pre.kdf);
  master.stretchedKey.fill(0);
  try {
    const opts = await api.passkeyRegisterStart();
    const salt = buf(opts.prf_salt);
    const created = (await navigator.credentials.create({
      publicKey: {
        challenge: buf(opts.challenge),
        rp: { id: opts.rp_id, name: opts.rp_name },
        user: { id: buf(opts.user_handle), name: opts.user_name, displayName: opts.user_name },
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -8 },
          { type: "public-key", alg: -257 },
        ],
        authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
        excludeCredentials: opts.exclude.map((id) => ({ type: "public-key" as const, id: buf(id) })),
        attestation: "none",
        timeout: 120_000,
        extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
    if (!created) throw new Error("Création de la passkey annulée.");
    const ext = (created.getClientExtensionResults() as { prf?: Prf }).prf;
    if (!ext?.enabled && !ext?.results?.first) throw new Error(NO_PRF);
    const credentialId = bytes(created.rawId);
    // Certains authentificateurs ne rendent la PRF qu'à la connexion : on la
    // demande tout de suite (un second geste), sur cette passkey seulement.
    let prf = prfOutput(created);
    if (!prf) {
      const got = (await navigator.credentials.get({
        publicKey: {
          challenge: randomBytes(32).slice().buffer,
          rpId: opts.rp_id,
          allowCredentials: [{ type: "public-key", id: created.rawId }],
          userVerification: "required",
          timeout: 120_000,
          extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
        },
      })) as PublicKeyCredential | null;
      prf = got ? prfOutput(got) : null;
      if (!prf) throw new Error(NO_PRF);
    }
    const key = c.passkeyKey(prf);
    prf.fill(0);
    const wrapped = c.sealPasskeyUserKey(key, credentialId, state.account.userKey);
    key.fill(0);
    const response = created.response as AuthenticatorAttestationResponse;
    return await api.registerPasskey({
      challenge_id: opts.challenge_id,
      auth_key: toBase64(master.authKey),
      name: name.trim(),
      credential_id: toBase64(credentialId),
      client_data_json: toBase64(bytes(response.clientDataJSON)),
      attestation_object: toBase64(bytes(response.attestationObject)),
      protected_user_key: toBase64(wrapped),
    });
  } finally {
    master.authKey.fill(0);
  }
}

/** Se connecter sans mot de passe maître : la passkey signe le défi du
 * serveur (utilisateur vérifié), et sa PRF rouvre la user key. */
export async function loginWithPasskey(): Promise<SessionState> {
  const opts = await api.passkeyLoginStart();
  const got = (await navigator.credentials.get({
    publicKey: {
      challenge: buf(opts.challenge),
      rpId: opts.rp_id,
      userVerification: "required",
      timeout: 120_000,
      extensions: { prf: { eval: { first: buf(opts.prf_salt) } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!got) throw new Error("Connexion par passkey annulée.");
  const prf = prfOutput(got);
  if (!prf) throw new Error(NO_PRF);
  const credentialId = bytes(got.rawId);
  const response = got.response as AuthenticatorAssertionResponse;
  const res = await api.passkeyLogin({
    challenge_id: opts.challenge_id,
    credential_id: toBase64(credentialId),
    client_data_json: toBase64(bytes(response.clientDataJSON)),
    authenticator_data: toBase64(bytes(response.authenticatorData)),
    signature: toBase64(bytes(response.signature)),
    device_name: deviceName(),
  });
  const key = c.passkeyKey(prf);
  prf.fill(0);
  let userKey: Uint8Array;
  try {
    userKey = c.openPasskeyUserKey(key, credentialId, fromBase64(res.passkey_user_key));
  } catch {
    throw new Error("Cette passkey n'ouvre pas le coffre : son enveloppe ne correspond pas (passkey réenregistrée ailleurs ?).");
  } finally {
    key.fill(0);
  }
  setTokens(res);
  const account = c.unlockAccountWithUserKey(userKey, fromBase64(res.protected_private_key));
  // Pas de paramètres Argon2id ici (rien n'a été dérivé) : la copie hors
  // ligne, qui les demande, attend la prochaine connexion par mot de passe.
  return openSession(res.user, account);
}
