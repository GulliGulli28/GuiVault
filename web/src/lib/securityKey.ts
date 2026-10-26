/** Le second facteur par clé de sécurité (ou passkey du compte), après le
 * mot de passe maître : le serveur donne un défi et les clés du compte, la
 * clé le signe (`navigator.credentials.get`), le serveur vérifie et ouvre la
 * session — comme le code TOTP, qui reste le recours (`docs/PASSKEYS.md`,
 * « Clé de sécurité »). Rien n'est déchiffré ici : la clé prouve seulement
 * qu'on la tient. */
import { api } from "./api";
import { fromBase64, toBase64 } from "./bytes";
import type { LoginResponse } from "./types";
import { t } from "./i18n";

const buf = (b64: string): ArrayBuffer => fromBase64(b64).slice().buffer;
const bytes = (b: ArrayBuffer | ArrayBufferView): Uint8Array => (b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength));

export async function signSecondFactor(totpToken: string): Promise<LoginResponse> {
  const opts = await api.secondFactorStart(totpToken);
  const got = (await navigator.credentials.get({
    publicKey: {
      challenge: buf(opts.challenge),
      rpId: opts.rp_id,
      allowCredentials: opts.allow.map((id) => ({ type: "public-key" as const, id: buf(id) })),
      userVerification: "required",
      timeout: 120_000,
    },
  })) as PublicKeyCredential | null;
  if (!got) throw new Error(t("Clé de sécurité : annulé."));
  const response = got.response as AuthenticatorAssertionResponse;
  return api.secondFactorWebauthn({
    totp_token: totpToken,
    challenge_id: opts.challenge_id,
    credential_id: toBase64(bytes(got.rawId)),
    client_data_json: toBase64(bytes(response.clientDataJSON)),
    authenticator_data: toBase64(bytes(response.authenticatorData)),
    signature: toBase64(bytes(response.signature)),
  });
}
