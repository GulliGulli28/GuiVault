import { useState } from "react";
import type { VaultIndex } from "../../lib/entities";
import { emptyAccount, PASSWORD_HISTORY_MAX } from "../../lib/items";
import type { Account, Payload } from "../../lib/types";
import { GeneratorPanel } from "../GeneratorPanel";
import { PasswordStrength } from "../PasswordStrength";
import { IconDice } from "../secret-icons";
import { PasswordInput } from "../ui";
import { Field, FormShell, useSeed } from "./common";
import { SecretFooter, SecretHeader } from "./SecretBits";
import { t } from "../../lib/i18n";

/** Un compte enregistré (LDAP, compte de service) : ce que des
 * identifiants et des hôtes du vault reprennent (`lib/accounts.ts`). */
export function AccountForm({ initial, index, defaultGroupId, onSave, onCancel }: {
  initial?: Account;
  index: VaultIndex;
  defaultGroupId?: string | null;
  onSave: (p: Payload) => Promise<void>;
  onCancel: () => void;
}) {
  const [account, setAccount] = useState<Account>(useSeed(initial, (p) => (p.kind === "account" ? p.account : undefined)) ?? emptyAccount(defaultGroupId ?? null));
  const [showGenerator, setShowGenerator] = useState(false);

  const save = async () => {
    const out: Account = { ...account, name: account.name.trim(), username: account.username.trim() };
    if (initial && initial.password && initial.password !== out.password) {
      out.passwordHistory = [{ password: initial.password, changedAt: new Date().toISOString() }, ...account.passwordHistory].slice(0, PASSWORD_HISTORY_MAX);
    }
    await onSave({ kind: "account", account: out });
  };

  return (
    <FormShell
      title={initial ? t("Modifier « {0} »", initial.name) : t("Nouveau compte")}
      onSave={save}
      onCancel={onCancel}
      validate={() => (!account.name.trim() ? t("Le nom est obligatoire.") : !account.username.trim() ? t("L'utilisateur est obligatoire.") : null)}
    >
      <SecretHeader value={account} onChange={setAccount} placeholder={t("LDAP, compte de service…")} />
      <Field label={t("Utilisateur")}>
        <input value={account.username} onChange={(e) => setAccount({ ...account, username: e.target.value })} autoComplete="off" className="input input-mono" />
      </Field>
      <div>
        <div className="flex items-end gap-1.5">
          <Field label={t("Mot de passe")} className="min-w-0 flex-1">
            <PasswordInput value={account.password} onChange={(password) => setAccount({ ...account, password })} autoComplete="new-password" />
          </Field>
          <button type="button" onClick={() => setShowGenerator((g) => !g)} aria-pressed={showGenerator} className={`btn btn-icon ${showGenerator ? "btn-toggled" : "btn-secondary"}`} title={t("Générer un mot de passe")} aria-label={t("Générer un mot de passe")}><IconDice size={14} /></button>
        </div>
        <PasswordStrength password={account.password} className="mt-1" />
        {showGenerator && (
          <div className="card mt-2 p-3">
            <GeneratorPanel compact onUse={(v) => { setAccount({ ...account, password: v }); setShowGenerator(false); }} />
          </div>
        )}
      </div>
      <p className="help-text -mt-1.5">{t("Les identifiants et les hôtes qui reprennent ce compte sont mis à jour à l'enregistrement.")}</p>
      <SecretFooter value={account} onChange={setAccount} groups={index.groups} />
    </FormShell>
  );
}
