import { useState } from "react";
import type { VaultIndex } from "../../lib/entities";
import { emptyIdentity } from "../../lib/items";
import type { Identity, Payload } from "../../lib/types";
import { PasswordInput } from "../ui";
import { Field, FormShell, useSeed } from "./common";
import { SecretFooter, SecretHeader } from "./SecretBits";
import { t } from "../../lib/i18n";

// Les champs texte de l'identité — énumérés parce que la signature d'index
// `[extra: string]: unknown` rend `keyof Identity` inutilisable.
type Key = "title" | "firstName" | "middleName" | "lastName" | "username" | "company" | "ssn" | "passportNumber" | "licenseNumber" | "email" | "phone" | "address1" | "address2" | "address3" | "city" | "state" | "postalCode" | "country";

export function IdentityForm({ initial, index, defaultGroupId, onSave, onCancel }: {
  initial?: Identity;
  index: VaultIndex;
  defaultGroupId?: string | null;
  onSave: (p: Payload) => Promise<void>;
  onCancel: () => void;
}) {
  const [identity, setIdentity] = useState<Identity>(useSeed(initial, (p) => (p.kind === "identity" ? p.identity : undefined)) ?? emptyIdentity(defaultGroupId ?? null));
  const text = (key: Key, label: string, opts: { mono?: boolean; autoComplete?: string } = {}) => (
    <Field label={label}>
      <input value={identity[key]} onChange={(e) => setIdentity({ ...identity, [key]: e.target.value })} autoComplete={opts.autoComplete ?? "off"} className={`input ${opts.mono ? "input-mono" : ""}`} />
    </Field>
  );
  const secret = (key: Key, label: string) => (
    <Field label={label}>
      <PasswordInput value={identity[key]} onChange={(v) => setIdentity({ ...identity, [key]: v })} autoComplete="off" />
    </Field>
  );
  return (
    <FormShell title={initial ? t("Modifier « {0} »", initial.name) : t("Nouvelle identité")} onSave={() => onSave({ kind: "identity", identity: { ...identity, name: identity.name.trim() } })} onCancel={onCancel} validate={() => (identity.name.trim() ? null : t("Le nom est obligatoire."))}>
      <SecretHeader value={identity} onChange={setIdentity} placeholder={t("Moi, société…")} />
      <div className="grid grid-cols-[6rem_1fr_1fr] gap-2">
        {text("title", t("Civilité"))}
        {text("firstName", t("Prénom"))}
        {text("lastName", t("Nom de famille"))}
      </div>
      <div className="grid grid-cols-2 gap-2">
        {text("middleName", t("Deuxième prénom"))}
        {text("company", t("Société"))}
      </div>
      <div className="grid grid-cols-2 gap-2">
        {text("username", t("Nom d'utilisateur"), { mono: true })}
        {text("email", t("E-mail"), { mono: true })}
      </div>
      {text("phone", t("Téléphone"), { mono: true })}
      {text("address1", t("Adresse"))}
      {text("address2", t("Complément d'adresse"))}
      {text("address3", t("Complément (2)"))}
      <div className="grid grid-cols-[8rem_1fr] gap-2">
        {text("postalCode", t("Code postal"), { mono: true })}
        {text("city", t("Ville"))}
      </div>
      <div className="grid grid-cols-2 gap-2">
        {text("state", t("Région / État"))}
        {text("country", t("Pays"))}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {secret("ssn", t("N° de sécurité sociale"))}
        {secret("passportNumber", t("N° de passeport"))}
        {secret("licenseNumber", t("N° de permis"))}
      </div>
      <SecretFooter value={identity} onChange={setIdentity} groups={index.groups} />
    </FormShell>
  );
}
