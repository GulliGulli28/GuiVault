import { useState } from "react";
import type { VaultIndex } from "../../lib/entities";
import { emptyAws } from "../../lib/items";
import type { AwsAccess, AwsProfileEntry, Payload } from "../../lib/types";
import { IconClose, IconPlus } from "../ui-icons";
import { PasswordInput } from "../ui";
import { Field, FormShell, useSeed } from "./common";
import { SecretFooter, SecretHeader } from "./SecretBits";
import { t } from "../../lib/i18n";

/** Un accès AWS : une session SSO et ses profils (ce que le panneau AWS de
 * Guiterm configure), ou des clés d'accès IAM. */
export function AwsForm({ initial, index, defaultGroupId, onSave, onCancel }: {
  initial?: AwsAccess;
  index: VaultIndex;
  defaultGroupId?: string | null;
  onSave: (p: Payload) => Promise<void>;
  onCancel: () => void;
}) {
  const [aws, setAws] = useState<AwsAccess>(useSeed(initial, (p) => (p.kind === "aws" ? p.aws : undefined)) ?? emptyAws(defaultGroupId ?? null));
  const sso = aws.authType === "sso";
  const setProfile = (i: number, patch: Partial<AwsProfileEntry>) => setAws({ ...aws, profiles: aws.profiles.map((p, j) => (j === i ? { ...p, ...patch } : p)) });

  const save = () => {
    const trim = (s: string) => s.trim();
    const out: AwsAccess = {
      ...aws,
      name: aws.name.trim(),
      ssoSessionName: trim(aws.ssoSessionName),
      ssoStartUrl: trim(aws.ssoStartUrl),
      ssoRegion: trim(aws.ssoRegion),
      accessKeyId: trim(aws.accessKeyId),
      secretAccessKey: trim(aws.secretAccessKey),
      mfaSerial: trim(aws.mfaSerial),
      region: trim(aws.region),
      profiles: aws.profiles.map((p) => ({ ...p, name: trim(p.name), accountId: trim(p.accountId), roleName: trim(p.roleName), region: trim(p.region) })).filter((p) => p.name || p.accountId),
    };
    return onSave({ kind: "aws", aws: out });
  };

  return (
    <FormShell
      title={initial ? t("Modifier « {0} »", initial.name) : t("Nouvel accès AWS")}
      onSave={save}
      onCancel={onCancel}
      validate={() => (!aws.name.trim() ? t("Le nom est obligatoire.") : sso && !aws.ssoStartUrl.trim() ? t("Indiquez l'URL de démarrage SSO (https://…awsapps.com/start).") : !sso && !aws.accessKeyId.trim() ? t("Indiquez l'identifiant de la clé d'accès.") : null)}
    >
      <SecretHeader value={aws} onChange={setAws} placeholder={t("Entreprise — SSO, compte perso…")} />
      <Field group label={t("Type d'accès")}>
        <div className="segmented">
          <button type="button" onClick={() => setAws({ ...aws, authType: "sso" })} data-active={sso ? "true" : undefined}>{t("Session SSO")}</button>
          <button type="button" onClick={() => setAws({ ...aws, authType: "keys" })} data-active={!sso ? "true" : undefined}>{t("Clés d'accès")}</button>
        </div>
      </Field>
      {sso ? (
        <>
          <Field label={t("URL de démarrage")} hint={t("Le portail IAM Identity Center, https://…awsapps.com/start.")}>
            <input value={aws.ssoStartUrl} onChange={(e) => setAws({ ...aws, ssoStartUrl: e.target.value })} placeholder="https://mon-org.awsapps.com/start" className="input input-mono" />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label={t("Nom de la session")} hint={t("Le bloc [sso-session …] de ~/.aws/config.")}>
              <input value={aws.ssoSessionName} onChange={(e) => setAws({ ...aws, ssoSessionName: e.target.value })} placeholder="mon-org" className="input input-mono" />
            </Field>
            <Field label={t("Région SSO")}>
              <input value={aws.ssoRegion} onChange={(e) => setAws({ ...aws, ssoRegion: e.target.value })} placeholder="eu-west-1" className="input input-mono" />
            </Field>
          </div>
        </>
      ) : (
        <>
          <Field label={t("Identifiant de clé d'accès")}>
            <input value={aws.accessKeyId} onChange={(e) => setAws({ ...aws, accessKeyId: e.target.value })} placeholder={t("AKIA…")} autoComplete="off" className="input input-mono" />
          </Field>
          <Field label={t("Clé d'accès secrète")}>
            <PasswordInput value={aws.secretAccessKey} onChange={(secretAccessKey) => setAws({ ...aws, secretAccessKey })} autoComplete="off" />
          </Field>
          <Field label={t("Appareil MFA")} hint={t("ARN du périphérique MFA, si les rôles l'exigent.")}>
            <input value={aws.mfaSerial} onChange={(e) => setAws({ ...aws, mfaSerial: e.target.value })} placeholder="arn:aws:iam::123456789012:mfa/moi" className="input input-mono" />
          </Field>
        </>
      )}
      <Field label={t("Région par défaut")}>
        <input value={aws.region} onChange={(e) => setAws({ ...aws, region: e.target.value })} placeholder="eu-west-3" className="input input-mono" />
      </Field>
      <Field group label={t("Profils")} hint={sso ? t("Un profil par compte et rôle : ce que « aws sso login » rend utilisable.") : t("Les noms de profil sous lesquels ces clés s'utilisent (default si aucun).")}>
        <div className="space-y-1">
          {aws.profiles.map((p, i) => (
            <div key={i} className={`grid items-center gap-1 ${sso ? "grid-cols-[1fr_1fr_1fr_6rem_auto]" : "grid-cols-[1fr_8rem_auto]"}`}>
              <input value={p.name} onChange={(e) => setProfile(i, { name: e.target.value })} placeholder={t("Profil")} aria-label={t("Nom du profil {0}", i + 1)} className="input input-mono" />
              {sso && <input value={p.accountId} onChange={(e) => setProfile(i, { accountId: e.target.value })} placeholder={t("Compte (12 chiffres)")} aria-label={t("Compte du profil {0}", i + 1)} inputMode="numeric" className="input input-mono" />}
              {sso && <input value={p.roleName} onChange={(e) => setProfile(i, { roleName: e.target.value })} placeholder={t("Rôle")} aria-label={t("Rôle du profil {0}", i + 1)} className="input input-mono" />}
              <input value={p.region} onChange={(e) => setProfile(i, { region: e.target.value })} placeholder={t("Région")} aria-label={t("Région du profil {0}", i + 1)} className="input input-mono" />
              <button type="button" onClick={() => setAws({ ...aws, profiles: aws.profiles.filter((_, j) => j !== i) })} aria-label={t("Retirer le profil")} className="btn btn-ghost btn-sm btn-icon hover:text-[var(--c-danger)]"><IconClose size={11} /></button>
            </div>
          ))}
          <button type="button" onClick={() => setAws({ ...aws, profiles: [...aws.profiles, { name: "", accountId: "", roleName: "", region: "" }] })} className="btn btn-secondary btn-sm"><IconPlus size={11} /> {t("Ajouter un profil")}</button>
        </div>
      </Field>
      <SecretFooter value={aws} onChange={setAws} groups={index.groups} />
    </FormShell>
  );
}
