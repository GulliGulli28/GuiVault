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
  /** Le code TOTP courant d'un identifiant : un de ceux du site, ou le
   * dernier rempli dans cet onglet (page de SSO sur un autre domaine). */
  | { type: "guivault-totp"; id: string }
  /** Un formulaire de connexion vient d'être soumis avec ces valeurs. */
  | { type: "guivault-captured"; username: string; password: string }
  /** La page (re)chargée demande s'il y a une saisie à proposer d'enregistrer. */
  | { type: "guivault-pending" }
  | { type: "guivault-save-captured"; vaultId: string }
  | { type: "guivault-dismiss-captured" }
  /** La page dit si elle a un formulaire de connexion (pour le badge). */
  | { type: "guivault-form"; present: boolean }
  /** Les vaults où créer un identifiant depuis la page. */
  | { type: "guivault-vaults" }
  | { type: "guivault-generate" }
  /** Les réglages du générateur (partagés avec le popup), à lire ou à garder. */
  | { type: "guivault-generator-options" }
  | { type: "guivault-generator-options-set"; options: unknown }
  | { type: "guivault-create-login"; vaultId: string; name: string; username: string; password: string; uri: string };

export type VaultsReply = { locked: true } | { locked: false; vaults: { id: string; name: string }[]; defaultVaultId: string };

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

export type MatchesReply =
  | { locked: true }
  | {
      locked: false;
      enabled: boolean;
      logins: MatchSummary[];
      /** Le dernier identifiant rempli dans cet onglet, s'il a un TOTP et
       * n'est pas déjà dans `logins` : une page de SSO qui suit la connexion
       * peut demander son code. */
      recent: MatchSummary | null;
      /** Remplir le code seul quand un seul identifiant du site a un TOTP. */
      autoTotp: boolean;
      /** Motifs de champs de code qui s'appliquent à cette page (sources de
       * regex, insensibles à la casse). */
      otpPatterns: string[];
    };
export type TotpReply = { code: string } | null;
export type CredentialsReply = { username: string; password: string; totp: string | null } | null;

/** Vers le script de page. */
export type ToContent =
  | { type: "guivault-fill"; username?: string; password?: string; totp?: string }
  /** Ouvrir le menu de choix (raccourci clavier avec plusieurs
   * correspondances). */
  | { type: "guivault-pick" }
  /** Le raccourci clavier : la page choisit — un champ de code à remplir,
   * un seul identifiant, ou le menu. */
  | { type: "guivault-shortcut" };

export type FillReply = { username: boolean; password: boolean; totp: boolean };

// ─── Passkeys ───────────────────────────────────────────────────────────────

export type PasskeyToBackground =
  | { type: "guivault-passkey-candidates"; rpId: string; allow: string[] }
  | { type: "guivault-passkey-assert"; credentialId: string; rpId: string; challenge: string }
  | { type: "guivault-passkey-logins"; rpId: string }
  | { type: "guivault-passkey-register"; rpId: string; rpName: string; userHandle: string; userName: string; userDisplayName: string; challenge: string; loginId: string | null; discoverable: boolean };

/** Du popup au service worker : effacer le presse-papiers dans `delayMs`
 * s'il contient encore ce qui a pour empreinte `hash` (`lib/clipboard.ts`). */
export type PopupToBackground = { type: "guivault-clipboard-clear"; hash: string; delayMs: number };

/** Du service worker à son document hors écran (Chrome). */
export type OffscreenMessage = { type: "guivault-offscreen-clipboard-clear"; hash: string };
