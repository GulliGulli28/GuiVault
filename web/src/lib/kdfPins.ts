/** Paramètres Argon2id épinglés, par serveur et par compte : ceux de la
 * dernière connexion réussie depuis ce navigateur. Le prelogin laisse le
 * serveur les dicter ; le plancher de `kdfParamsSane` bloque l'absurde
 * (`m_cost = 8`) mais pas un compte de 64 MiB/3 ramené à 19 MiB/2, ~5 fois
 * moins cher à casser. Épinglés, ils ne peuvent plus baisser.
 *
 * On n'épingle qu'après avoir déverrouillé la user key : c'est la preuve
 * que ces paramètres sont les vrais (le serveur ne sait pas en fabriquer
 * d'autres qui l'ouvrent). Les hausses passent (changement de mot de passe
 * sur un autre appareil) ; aucun client ne choisit de paramètres plus
 * faibles, donc une baisse vient du serveur. Même règle que
 * `KdfParams::weaker_than` côté Rust. Pas secret : `localStorage`, comme
 * les empreintes (`pins.ts`). */
import { baseUrl } from "./api";
import type { KdfParams } from "./crypto";

const KEY = "guivault.kdf-pins";

/** L'extension parle à n'importe quel serveur : la clé porte son adresse
 * (`/api/v1` tout court pour l'interface web, servie par le sien). */
function pinKey(email: string): string {
  return `${baseUrl()}|${email.trim().toLowerCase()}`;
}

function load(): Record<string, KdfParams> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, KdfParams>;
  } catch {
    return {};
  }
}

/** `p_cost` n'entre pas en compte : il répartit le travail sans le réduire. */
export function kdfWeakerThan(p: KdfParams, pinned: KdfParams): boolean {
  return p.m_cost < pinned.m_cost || p.t_cost < pinned.t_cost;
}

export function pinnedKdf(email: string): KdfParams | null {
  return load()[pinKey(email)] ?? null;
}

/** Avant de dériver : refuse des paramètres plus faibles que ceux épinglés. */
export function requireKdfNotDowngraded(email: string, params: KdfParams) {
  const pinned = pinnedKdf(email);
  if (pinned && kdfWeakerThan(params, pinned)) {
    throw new Error(
      `Le serveur demande une dérivation plus faible qu'à votre dernière connexion depuis ce navigateur ` +
        `(Argon2id m=${params.m_cost} Kio, t=${params.t_cost} au lieu de m=${pinned.m_cost} Kio, t=${pinned.t_cost}) : ` +
        "connexion refusée, rien n'a été envoyé. Le serveur est peut-être compromis — prévenez son administrateur.",
    );
  }
}

/** Après un déverrouillage réussi (ou un changement de mot de passe). */
export function pinKdf(email: string, params: KdfParams) {
  const pins = load();
  pins[pinKey(email)] = { m_cost: params.m_cost, t_cost: params.t_cost, p_cost: params.p_cost };
  try {
    localStorage.setItem(KEY, JSON.stringify(pins));
  } catch {
    // Stockage indisponible (navigation privée) : rien d'épinglé, le
    // plancher de `kdfParamsSane` reste la seule garde.
  }
}
