import { useState } from "react";
import type { VaultIndex } from "../../lib/entities";
import { emptyIdentity } from "../../lib/items";
import type { Identity, Payload } from "../../lib/types";
import { PasswordInput } from "../ui";
import { Field, FormShell, useSeed } from "./common";
import { SecretFooter, SecretHeader } from "./SecretBits";

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
    <FormShell title={initial ? `Modifier « ${initial.name} »` : "Nouvelle identité"} onSave={() => onSave({ kind: "identity", identity: { ...identity, name: identity.name.trim() } })} onCancel={onCancel} validate={() => (identity.name.trim() ? null : "Le nom est obligatoire.")}>
      <SecretHeader value={identity} onChange={setIdentity} placeholder="Moi, société…" />
      <div className="grid grid-cols-[6rem_1fr_1fr] gap-2">
        {text("title", "Civilité")}
        {text("firstName", "Prénom")}
        {text("lastName", "Nom de famille")}
      </div>
      <div className="grid grid-cols-2 gap-2">
        {text("middleName", "Deuxième prénom")}
        {text("company", "Société")}
      </div>
      <div className="grid grid-cols-2 gap-2">
        {text("username", "Nom d'utilisateur", { mono: true })}
        {text("email", "E-mail", { mono: true })}
      </div>
      {text("phone", "Téléphone", { mono: true })}
      {text("address1", "Adresse")}
      {text("address2", "Complément d'adresse")}
      {text("address3", "Complément (2)")}
      <div className="grid grid-cols-[8rem_1fr] gap-2">
        {text("postalCode", "Code postal", { mono: true })}
        {text("city", "Ville")}
      </div>
      <div className="grid grid-cols-2 gap-2">
        {text("state", "Région / État")}
        {text("country", "Pays")}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {secret("ssn", "N° de sécurité sociale")}
        {secret("passportNumber", "N° de passeport")}
        {secret("licenseNumber", "N° de permis")}
      </div>
      <SecretFooter value={identity} onChange={setIdentity} groups={index.groups} />
    </FormShell>
  );
}
