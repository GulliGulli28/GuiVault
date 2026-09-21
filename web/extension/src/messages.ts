/** Les messages entre le script de page, le popup et le service worker. Le
 * mot de passe ne traverse vers la page qu'à la demande explicite d'un
 * identifiant précis (`credentials`), jamais dans une liste. */

export interface MatchSummary {
  id: string;
  name: string;
  username: string;
  hasTotp: boolean;
  favorite: boolean;
}

export type ToBackground =
  /** La page demande ce qui lui correspond. */
  | { type: "guivault-matches"; url: string }
  /** L'utilisateur a choisi un identifiant : ses secrets, si l'URL de
   * l'onglet expéditeur correspond bien. */
  | { type: "guivault-credentials"; id: string }
  /** Un formulaire de connexion vient d'être soumis avec ces valeurs. */
  | { type: "guivault-captured"; username: string; password: string }
  /** La page (re)chargée demande s'il y a une saisie à proposer d'enregistrer. */
  | { type: "guivault-pending" }
  | { type: "guivault-save-captured"; vaultId: string }
  | { type: "guivault-dismiss-captured" };

/** Ce que la bannière « Enregistrer ? » affiche. */
export interface Pending {
  host: string;
  username: string;
  /** `update` : un identifiant de ce site a ce nom d'utilisateur mais un
   * autre mot de passe. */
  mode: "new" | "update";
  loginName: string | null;
  vaults: { id: string; name: string }[];
  defaultVaultId: string;
}

export type MatchesReply = { locked: true } | { locked: false; enabled: boolean; logins: MatchSummary[] };
export type CredentialsReply = { username: string; password: string; totp: string | null } | null;

/** Vers le script de page. */
export type ToContent =
  | { type: "guivault-fill"; username?: string; password?: string; totp?: string }
  /** Ouvrir le menu de choix (raccourci clavier avec plusieurs
   * correspondances). */
  | { type: "guivault-pick" };

export type FillReply = { username: boolean; password: boolean; totp: boolean };

// ─── Passkeys ───────────────────────────────────────────────────────────────

export type PasskeyToBackground =
  | { type: "guivault-passkey-candidates"; rpId: string; allow: string[] }
  | { type: "guivault-passkey-assert"; credentialId: string; rpId: string; challenge: string }
  | { type: "guivault-passkey-logins"; rpId: string }
  | { type: "guivault-passkey-register"; rpId: string; rpName: string; userHandle: string; userName: string; userDisplayName: string; challenge: string; loginId: string | null; discoverable: boolean };
