import type { Account } from "../../lib/types";
import { Field } from "./common";
import { t } from "../../lib/i18n";

/** « Compte » dans le formulaire d'un identifiant ou d'un hôte : reprendre
 * un compte enregistré du vault (`lib/accounts.ts`) au lieu de saisir
 * l'utilisateur et le mot de passe. Rien quand le vault n'a pas de compte. */
export function AccountSelect({ accounts, value, onChange }: { accounts: Account[]; value: string | null; onChange: (account: Account | null) => void }) {
  if (!accounts.length && !value) return null;
  const missing = !!value && !accounts.some((a) => a.id === value);
  return (
    <Field label={t("Compte")} hint={value ? t("L'utilisateur et le mot de passe suivent ceux du compte.") : t("Reprendre l'utilisateur et le mot de passe d'un compte enregistré.")}>
      <select value={value ?? ""} onChange={(e) => onChange(accounts.find((a) => a.id === e.target.value) ?? null)} className="input">
        <option value="">{t("Aucun : saisie libre")}</option>
        {missing && <option value={value!}>{t("Compte introuvable dans ce vault")}</option>}
        {accounts.map((a) => <option key={a.id} value={a.id}>{a.username ? `${a.name} — ${a.username}` : a.name}</option>)}
      </select>
    </Field>
  );
}

/** L'utilisateur repris d'un compte, à la place du champ ; le mot de
 * passe ne s'affiche pas (il se voit sur la fiche du compte). */
export function LinkedCredentials({ username, usernameLabel, withPassword }: { username: string; usernameLabel?: string; withPassword: boolean }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <Field label={usernameLabel ?? t("Utilisateur")}>
        <input value={username} readOnly className="input input-mono" />
      </Field>
      {withPassword && (
        <Field label={t("Mot de passe")}>
          <input value="••••••••" readOnly className="input input-mono" />
        </Field>
      )}
    </div>
  );
}
