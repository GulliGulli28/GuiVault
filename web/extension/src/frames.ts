/** Où remplir, et pour quel site, quand une page a des cadres. Pur (aucun
 * appel à `chrome.*`) : `background.ts` s'en sert, `frames.test.ts` le
 * tient.
 *
 * La règle : un cadre est **son propre site**. Un formulaire de connexion
 * servi dans un cadre par `login.fournisseur.fr` reçoit les identifiants de
 * `login.fournisseur.fr` ; une publicité ou un widget tiers dans la page de
 * `banque.fr` ne reçoit pas ceux de `banque.fr` — sauf si l'utilisateur,
 * averti de l'écart, le confirme d'un clic. */
import type { FrameInfo } from "./messages";

/** Ce que le navigateur dit de l'expéditeur d'un message (sous-ensemble de
 * `chrome.runtime.MessageSender`). */
export interface SenderLike {
  frameId?: number;
  url?: string;
  origin?: string;
  tab?: { url?: string };
}

const isWeb = (u: string | undefined): u is string => !!u && /^https?:\/\//.test(u);

/** L'URL qui décide des correspondances pour ce script de page : celle de
 * l'onglet pour le cadre principal, celle **du cadre** sinon — telles que
 * le navigateur les connaît. Un cadre `about:blank` ou `srcdoc` hérite de
 * l'origine de qui l'a créé (`origin`). */
export function senderUrl(sender: SenderLike): string | undefined {
  if (!sender.frameId) return isWeb(sender.tab?.url) ? sender.tab!.url : isWeb(sender.url) ? sender.url : undefined;
  if (isWeb(sender.url)) return sender.url;
  if (isWeb(sender.origin)) return `${sender.origin}/`;
  return undefined;
}

/** L'URL de l'onglet (le site que l'utilisateur voit), si ce n'est pas
 * celle du cadre. */
export function parentUrl(sender: SenderLike): string | undefined {
  if (!sender.frameId) return undefined;
  const top = sender.tab?.url;
  return isWeb(top) ? top : undefined;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export interface FrameCandidate {
  frameId: number;
  info: FrameInfo;
}

export type FramePick = { fill: number } | { confirm: number; host: string } | null;

/** Le cadre où remplir un identifiant choisi dans le popup.
 * - Seuls comptent les cadres qui ont des champs à remplir.
 * - De confiance : le cadre principal (la page que l'utilisateur regarde,
 *   où il a choisi cet identifiant) ou un cadre dont l'URL correspond à
 *   l'identifiant (`matches`).
 * - Priorité : celui qui a le focus, puis celui qui a un mot de passe, puis
 *   le cadre principal.
 * - Aucun de confiance mais un autre en a : à confirmer. */
export function pickFrame(frames: FrameCandidate[], matches: (url: string) => boolean, what: "credentials" | "totp"): FramePick {
  const relevant = frames.filter((f) => (what === "totp" ? f.info.otp : f.info.password || f.info.username));
  const rank = (f: FrameCandidate) => (f.info.focused ? 0 : 4) + (what === "totp" || f.info.password ? 0 : 2) + (f.frameId === 0 ? 0 : 1);
  const ordered = [...relevant].sort((a, b) => rank(a) - rank(b));
  const trusted = ordered.find((f) => f.frameId === 0 || matches(f.info.url));
  if (trusted) return { fill: trusted.frameId };
  const other = ordered[0];
  return other ? { confirm: other.frameId, host: hostOf(other.info.url) } : null;
}

/** Le cadre à qui confier le raccourci clavier : celui qui a le focus et des
 * champs, sinon le premier qui a un mot de passe ou un champ de code, sinon
 * le principal. Il décide ensuite avec ses propres correspondances. */
export function shortcutFrame(frames: FrameCandidate[]): number {
  const withFields = frames.filter((f) => f.info.password || f.info.username || f.info.otp);
  return (withFields.find((f) => f.info.focused) ?? withFields.find((f) => f.info.password || f.info.otp) ?? withFields[0])?.frameId ?? 0;
}
