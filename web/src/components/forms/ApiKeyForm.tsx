import { useState } from "react";
import type { VaultIndex } from "../../lib/entities";
import { emptyApiKey } from "../../lib/items";
import type { ApiKey, Payload } from "../../lib/types";
import { PasswordInput } from "../ui";
import { Field, FormShell, useSeed } from "./common";
import { SecretFooter, SecretHeader } from "./SecretBits";

/** Une clé d'API, un jeton d'accès, un couple client ID / secret. */
export function ApiKeyForm({ initial, index, defaultGroupId, onSave, onCancel }: {
  initial?: ApiKey;
  index: VaultIndex;
  defaultGroupId?: string | null;
  onSave: (p: Payload) => Promise<void>;
  onCancel: () => void;
}) {
  const [key, setKey] = useState<ApiKey>(useSeed(initial, (p) => (p.kind === "api-key" ? p.apiKey : undefined)) ?? emptyApiKey(defaultGroupId ?? null));
  return (
    <FormShell
      title={initial ? `Modifier « ${initial.name} »` : "Nouvelle clé d'API"}
      onSave={() => onSave({ kind: "api-key", apiKey: { ...key, name: key.name.trim(), service: key.service.trim(), url: key.url.trim(), keyId: key.keyId.trim(), secret: key.secret.trim() } })}
      onCancel={onCancel}
      validate={() => (!key.name.trim() ? "Le nom est obligatoire." : !key.secret.trim() ? "Le secret est vide." : null)}
    >
      <SecretHeader value={key} onChange={setKey} placeholder="Stripe — production, jeton GitHub CI…" />
      <div className="grid grid-cols-2 gap-2">
        <Field label="Service">
          <input value={key.service} onChange={(e) => setKey({ ...key, service: e.target.value })} placeholder="GitHub" className="input" />
        </Field>
        <Field label="Expire le">
          <input type="date" value={key.expiresAt} onChange={(e) => setKey({ ...key, expiresAt: e.target.value })} className="input" />
        </Field>
      </div>
      <Field label="URL" hint="La console où la clé se gère, ou l'URL de base de l'API.">
        <input value={key.url} onChange={(e) => setKey({ ...key, url: e.target.value })} placeholder="https://github.com/settings/tokens" className="input input-mono" />
      </Field>
      <Field label="Identifiant" hint="La partie publique, s'il y en a une : identifiant de clé, client ID.">
        <input value={key.keyId} onChange={(e) => setKey({ ...key, keyId: e.target.value })} autoComplete="off" className="input input-mono" />
      </Field>
      <Field label="Secret">
        <PasswordInput value={key.secret} onChange={(secret) => setKey({ ...key, secret })} autoComplete="off" />
      </Field>
      <Field label="Portée" hint="Les droits accordés à la clé.">
        <input value={key.scopes} onChange={(e) => setKey({ ...key, scopes: e.target.value })} placeholder="repo, read:org" className="input" />
      </Field>
      <SecretFooter value={key} onChange={setKey} groups={index.groups} />
    </FormShell>
  );
}
