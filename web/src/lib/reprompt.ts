/** Redemander le mot de passe maître pour un élément (`SecretBase.reprompt`,
 * le « reprompt » de Bitwarden) : avant d'afficher, copier, remplir ou
 * modifier ses secrets.
 *
 * Un garde de l'interface, pas du chiffrement : quand la question est posée,
 * l'élément est déjà déchiffré en mémoire (comme tout le coffre ouvert). Il
 * protège d'un regard par-dessus l'épaule ou d'une session laissée ouverte,
 * pas d'un code qui tournerait dans la page. Le mot de passe se vérifie ici,
 * sans le serveur : Argon2id sur ses paramètres, puis la user key doit
 * s'ouvrir et être celle de la session.
 *
 * Une fois donné, il vaut quelques minutes pour cet élément-là ; tout est
 * oublié au verrouillage (`forgetUnlocked`). */
import { fromBase64 } from "./bytes";
import * as c from "./crypto";
import { payloadEntity, type SessionState } from "./session";
import type { Payload } from "./types";

/** Le temps pendant lequel un élément déverrouillé le reste. */
export const REPROMPT_GRACE_MS = 5 * 60_000;

const unlocked = new Map<string, number>();

/** L'élément demande-t-il le mot de passe maître ? */
export function isProtected(p: Payload | null | undefined): boolean {
  return !!p && p.kind !== "group" && payloadEntity(p).reprompt === true;
}

/** Protégé et pas déverrouillé récemment : il faut demander. */
export function needsReprompt(p: Payload | null | undefined): boolean {
  if (!p || !isProtected(p)) return false;
  const until = unlocked.get(payloadEntity(p).id);
  return until === undefined || until < Date.now();
}

export function markUnlocked(id: string) {
  unlocked.set(id, Date.now() + REPROMPT_GRACE_MS);
}

/** Au verrouillage, à la fermeture de la session. */
export function forgetUnlocked() {
  unlocked.clear();
}

/** `ok`, `wrong`, ou `unavailable` : la session n'a pas le compte enveloppé
 * (ouverte par passkey) et ne peut pas vérifier un mot de passe. */
export async function verifyMasterPassword(state: SessionState, password: string): Promise<"ok" | "wrong" | "unavailable"> {
  const blobs = state.blobs;
  if (!blobs) return "unavailable";
  const master = await c.deriveMasterKey(password, fromBase64(blobs.kdf_salt), blobs.kdf);
  try {
    const account = c.unlockAccount(master.stretchedKey, fromBase64(blobs.protected_user_key), fromBase64(blobs.protected_private_key));
    const same = account.userKey.length === state.account.userKey.length && account.userKey.every((b, i) => b === state.account.userKey[i]);
    account.userKey.fill(0);
    return same ? "ok" : "wrong";
  } catch {
    return "wrong";
  } finally {
    master.stretchedKey.fill(0);
    master.authKey.fill(0);
  }
}
