import { useState } from "react";
import type { VaultIndex } from "../lib/entities";
import { groupPath } from "../lib/entities";
import { awsConfigText, cardBrand, identityFullName, uriHost } from "../lib/items";
import { SQL_ENGINE_LABELS, type AuthMethod, type CustomField, type DbTunnel, type Host, type Payload, type SecretBase, type SqlConnection } from "../lib/types";
import { PasswordStrength } from "./PasswordStrength";
import { TotpCode } from "./TotpCode";
import { BUILTIN_ICONS, HostIcon, hasIcon } from "./icons";
import { groupColor } from "./ItemTree";
import { ACCENT_COLORS, type UiAccent } from "../lib/preferences";
import { IconPasskey } from "./secret-icons";
import { CopyButton, Eyebrow, formatWhen, Row, SecretValue } from "./ui";
import { ACTION_LABELS, APPROVAL_LABELS, ON_FAILURE_LABELS } from "./forms/RunbookForm";
import { t, translated } from "../lib/i18n";

/** La fiche d'une entité, en lecture : ce que Guiterm montre dans ses
 * panneaux, secrets masqués et copiables. `shared` : reçue par un lien de
 * partage — sans le rangement (dossier, tags) de qui l'a envoyée. */
export function ItemView({ payload, index, shared, withoutOrganisation }: { payload: Payload; index: VaultIndex; shared?: boolean; withoutOrganisation?: boolean }) {
  // Dossier et tags : ni pour un lien de partage, ni quand la fiche les
  // montre à côté (`ItemAside`).
  const organisation = !shared && !withoutOrganisation;
  const groups = new Map(index.groups.map((g) => [g.id, g]));
  const hostLabel = (id: string | null | undefined) => (id ? index.hosts.find((h) => h.id === id)?.label ?? t("hôte inconnu ({0})", id.slice(0, 8)) : null);

  switch (payload.kind) {
    case "host": {
      const h = payload.host;
      const s = payload.secrets ?? {};
      const kind = h.kind ?? "ssh";
      return (
        <div className="space-y-6">
          <Section title={t("Connexion")}>
            <Row label={t("Type")}>{HOST_KIND_LABELS[kind]}</Row>
            {kind === "dockerExec" && h.dockerViaHostId ? <Row label={t("Via l'hôte")}>{hostLabel(h.dockerViaHostId)}</Row> : <Row label={kind === "k8sExec" ? t("Contexte") : t("Adresse")} mono>{h.address}{kind === "ssh" || kind === "rdp" ? `:${h.port}` : ""}</Row>}
            <Row label={kind === "k8sExec" ? t("Namespace") : t("Utilisateur")} mono>{h.username || <Muted>—</Muted>}</Row>
            {kind !== "dockerExec" && kind !== "k8sExec" && <Row label={t("Authentification")}>{describeAuth(h.auth, index)}</Row>}
            {s.password !== undefined && <Row label={t("Mot de passe")}><SecretValue value={s.password} /></Row>}
            {s.passphrase !== undefined && <Row label={t("Passphrase")}><SecretValue value={s.passphrase} /></Row>}
            {h.jumpVia.length > 0 && <Row label={t("Relais")}>{h.jumpVia.map((id) => hostLabel(id)).join(" → ")}</Row>}
            {h.proxyCommand && <Row label="ProxyCommand" mono>{h.proxyCommand}</Row>}
          </Section>
          {organisation ? (
            <Section title={t("Organisation")}>
              <Row label={t("Dossier")}>{h.groupId ? groupPath(groups, h.groupId) || <Muted>{t("dossier inconnu")}</Muted> : <Muted>{t("racine")}</Muted>}</Row>
              <Row label={t("Tags")}><Tags tags={h.tags} /></Row>
              {h.icon && <Row label={t("Icône")}><IconCell iconId={h.icon} index={index} /></Row>}
            </Section>
          ) : h.icon && (
            <Section title={t("Icône")}>
              <Row label={t("Icône")}><IconCell iconId={h.icon} index={index} /></Row>
            </Section>
          )}
          {(h.startupSnippets.length > 0 || h.envVars.length > 0 || h.keepaliveIntervalSecs || h.agentForward || (h.persistentShell && h.persistentShell !== "off")) && (
            <Section title={t("Session")}>
              {h.startupSnippets.length > 0 && <Row label={t("Au démarrage")}>{h.startupSnippets.map((id) => index.snippets.find((sn) => sn.id === id)?.name ?? id.slice(0, 8)).join(", ")}</Row>}
              {h.envVars.length > 0 && (
                <Row label={t("Environnement")}>
                  <div className="space-y-0.5">
                    {h.envVars.map((v) => (
                      <div key={v.key} className="flex flex-wrap items-center gap-1 font-mono text-[13px]">
                        <span>{v.key}=</span>
                        {v.secret ? (s.env?.[v.key] !== undefined ? <SecretValue value={s.env[v.key]} /> : <Muted>{t("(secret absent)")}</Muted>) : <span>{v.value}</span>}
                      </div>
                    ))}
                  </div>
                </Row>
              )}
              {h.keepaliveIntervalSecs ? <Row label={t("Keepalive")}>{h.keepaliveIntervalSecs} {t("s")}</Row> : null}
              {h.agentForward && <Row label={t("Agent")}>{t("transféré")}</Row>}
              {h.persistentShell && h.persistentShell !== "off" && <Row label={t("Shell persistant")}>{h.persistentShell}</Row>}
            </Section>
          )}
        </div>
      );
    }
    case "group": {
      const g = payload.group;
      return (
        <Section title={t("Dossier")}>
          <Row label={t("Nom")}>{g.name}</Row>
          <Row label={t("Parent")}>{g.parentId ? groupPath(groups, g.parentId) || <Muted>{t("dossier inconnu")}</Muted> : <Muted>{t("racine")}</Muted>}</Row>
          {g.color && <Row label={t("Couleur")}><span className="inline-block h-3 w-3 rounded-full align-middle" style={{ background: groupColor(g.color) ?? "var(--c-bg3)" }} /> {g.color in ACCENT_COLORS ? ACCENT_COLORS[g.color as UiAccent].label : <span className="font-mono text-[13px]">{g.color}</span>}</Row>}
          {g.icon && <Row label={t("Icône")}><IconCell iconId={g.icon} index={index} /></Row>}
        </Section>
      );
    }
    case "snippet": {
      const s = payload.snippet;
      return (
        <div className="space-y-6">
          <Section title={s.adaptive ? t("Snippet adaptatif") : t("Snippet")}>
            <Row label={t("Tags")}><Tags tags={s.tags} /></Row>
          </Section>
          <div className="relative">
            <pre className="card overflow-x-auto p-3 font-mono text-[13px] leading-relaxed text-[var(--c-text)]">{s.command}</pre>
            <CopyButton value={s.command} label={t("Copier la commande")} className="absolute right-1 top-1" />
          </div>
        </div>
      );
    }
    case "key": {
      const k = payload.key;
      return (
        <div className="space-y-6">
          <Section title={t("Clé privée")}>
            <Row label={t("Nom")}>{k.name}</Row>
            {k.path && <Row label={t("Chemin")} mono>{k.path}</Row>}
            {payload.passphrase != null && <Row label={t("Passphrase")}><SecretValue value={payload.passphrase} /></Row>}
            <Row label={t("Contenu")}>{payload.content ? t("dans le vault") : <Muted>{t("par chemin seulement (le fichier reste sur la machine)")}</Muted>}</Row>
          </Section>
          {payload.content && <KeyContent content={payload.content} />}
        </div>
      );
    }
    case "sql-connection": {
      const cnx = payload.connection;
      return (
        <div className="space-y-6">
          <Section title={SQL_ENGINE_LABELS[cnx.engine]}>
            {describeSql(cnx, index).map(([label, value, mono]) => <Row key={label} label={label} mono={mono}>{value}</Row>)}
            {payload.password != null && <Row label={t("Mot de passe")}><SecretValue value={payload.password} /></Row>}
          </Section>
          {organisation && (
            <Section title={t("Organisation")}>
              <Row label={t("Dossier")}>{cnx.groupId ? groupPath(groups, cnx.groupId) || <Muted>{t("dossier inconnu")}</Muted> : <Muted>{t("racine")}</Muted>}</Row>
              <Row label={t("Tags")}><Tags tags={cnx.tags} /></Row>
            </Section>
          )}
        </div>
      );
    }
    case "icon":
      return (
        <Section title={t("Icône personnalisée")}>
          <Row label={t("Nom")}>{payload.icon.name}</Row>
          <Row label={t("Aperçu")}><img src={payload.icon.dataUrl} alt="" className="h-8 w-8" /></Row>
        </Section>
      );
    case "login": {
      const l = payload.login;
      return (
        <div className="space-y-6">
          <Section title={t("Identifiant")}>
            <Row label={t("Utilisateur")}><Copyable value={l.username} mono /></Row>
            <Row label={t("Mot de passe")}>
              {l.password ? (
                <span className="flex flex-col gap-1">
                  <SecretValue value={l.password} />
                  <PasswordStrength password={l.password} />
                </span>
              ) : <Muted>—</Muted>}
            </Row>
            {l.totp && <Row label={t("Code TOTP")}><TotpCode secret={l.totp} /></Row>}
            {l.uris.length > 0 && (
              <Row label={l.uris.length > 1 ? t("Sites") : t("Site")}>
                <div className="space-y-0.5">
                  {l.uris.map((u, i) => (
                    <div key={i} className="flex min-w-0 items-center gap-1">
                      <a href={/^[a-z][a-z0-9+.-]*:/i.test(u.uri) ? u.uri : `https://${u.uri}`} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate font-mono text-[var(--c-accent-text)] hover:underline" title={u.uri}>{u.uri}</a>
                      {u.match && <span className="tag" title={t("Mode de correspondance")}>{u.match}</span>}
                      <CopyButton value={u.uri} label={t("Copier l'adresse")} />
                    </div>
                  ))}
                </div>
              </Row>
            )}
          </Section>
          <SecretCommon base={l} groups={groups} organisation={organisation} />
          {l.passkeys.length > 0 && (
            <Section title={t("Passkeys")}>
              {l.passkeys.map((k) => (
                <div key={k.credentialId} className="flex items-start gap-2 py-1.5 text-[12px]">
                  <IconPasskey size={14} className="mt-0.5 shrink-0 text-[var(--c-text-muted)]" />
                  <span className="min-w-0">
                    <span className="block text-[var(--c-text)]">{k.rpName || k.rpId}{k.userName ? ` — ${k.userName}` : ""}</span>
                    <span className="block text-[13px] text-[var(--c-text-muted)]">{k.rpId} · {k.keyAlgorithm} {k.keyCurve} {t("· créée le")} {formatWhen(k.createdAt)}{k.discoverable ? t(" · découvrable") : ""}</span>
                  </span>
                </div>
              ))}
              <p className="help-text pt-1">{t("Utilisables par l'extension ou Guiterm.")}</p>
            </Section>
          )}
          {l.passwordHistory.length > 0 && <PasswordHistory entries={l.passwordHistory} />}
        </div>
      );
    }
    case "note": {
      const n = payload.note;
      return (
        <div className="space-y-6">
          <pre className="card whitespace-pre-wrap break-words p-3 font-sans text-[13.5px] leading-relaxed text-[var(--c-text)]">{n.content || <Muted>{t("(vide)")}</Muted>}</pre>
          <SecretCommon base={n} groups={groups} organisation={organisation} withoutNotes />
        </div>
      );
    }
    case "card": {
      const cd = payload.card;
      return (
        <div className="space-y-6">
          <Section title={cd.brand || cardBrand(cd.number) || t("Carte")}>
            <Row label={t("Titulaire")}><Copyable value={cd.cardholderName} /></Row>
            <Row label={t("Numéro")}>{cd.number ? <SecretValue value={cd.number} /> : <Muted>—</Muted>}</Row>
            <Row label={t("Expiration")}><Copyable value={[cd.expMonth, cd.expYear].filter(Boolean).join(" / ")} mono /></Row>
            <Row label={t("Code")}>{cd.code ? <SecretValue value={cd.code} /> : <Muted>—</Muted>}</Row>
          </Section>
          <SecretCommon base={cd} groups={groups} organisation={organisation} />
        </div>
      );
    }
    case "identity": {
      const i = payload.identity;
      const addr = [i.address1, i.address2, i.address3].filter(Boolean).join("\n");
      const city = [i.postalCode, i.city].filter(Boolean).join(" ");
      return (
        <div className="space-y-6">
          <Section title={t("Identité")}>
            <Row label={t("Nom")}><Copyable value={identityFullName(i)} /></Row>
            <Row label={t("Utilisateur")}><Copyable value={i.username} mono /></Row>
            <Row label={t("Société")}><Copyable value={i.company} /></Row>
            <Row label={t("E-mail")}><Copyable value={i.email} mono /></Row>
            <Row label={t("Téléphone")}><Copyable value={i.phone} mono /></Row>
          </Section>
          <Section title={t("Adresse")}>
            <Row label={t("Adresse")}><Copyable value={addr} multiline /></Row>
            <Row label={t("Ville")}><Copyable value={[city, i.state, i.country].filter(Boolean).join(", ")} /></Row>
          </Section>
          <Section title={t("Documents")}>
            <Row label={t("N° sécu.")}>{i.ssn ? <SecretValue value={i.ssn} /> : <Muted>—</Muted>}</Row>
            <Row label={t("Passeport")}>{i.passportNumber ? <SecretValue value={i.passportNumber} /> : <Muted>—</Muted>}</Row>
            <Row label={t("Permis")}>{i.licenseNumber ? <SecretValue value={i.licenseNumber} /> : <Muted>—</Muted>}</Row>
          </Section>
          <SecretCommon base={i} groups={groups} organisation={organisation} />
        </div>
      );
    }
    case "aws": {
      const a = payload.aws;
      const text = awsConfigText(a);
      return (
        <div className="space-y-6">
          <Section title={a.authType === "sso" ? t("Session SSO") : t("Clés d'accès")}>
            {a.authType === "sso" ? (
              <>
                <Row label={t("Portail")}>{a.ssoStartUrl ? <Copyable value={a.ssoStartUrl} mono /> : <Muted>—</Muted>}</Row>
                <Row label={t("Session")} mono>{a.ssoSessionName || <Muted>—</Muted>}</Row>
                <Row label={t("Région SSO")} mono>{a.ssoRegion || <Muted>—</Muted>}</Row>
              </>
            ) : (
              <>
                <Row label={t("Clé d'accès")}><Copyable value={a.accessKeyId} mono /></Row>
                <Row label={t("Secret")}>{a.secretAccessKey ? <SecretValue value={a.secretAccessKey} /> : <Muted>—</Muted>}</Row>
                {a.mfaSerial && <Row label="MFA"><Copyable value={a.mfaSerial} mono /></Row>}
              </>
            )}
            {a.region && <Row label={t("Région")} mono>{a.region}</Row>}
          </Section>
          {a.profiles.length > 0 && (
            <Section title={t("Profils ({0})", a.profiles.length)}>
              {a.profiles.map((p, i) => (
                <Row key={i} label={p.name || t("(sans nom)")} mono>
                  {[p.accountId, p.roleName, p.region || a.region].filter(Boolean).join(" · ") || <Muted>—</Muted>}
                </Row>
              ))}
            </Section>
          )}
          <section>
            <Eyebrow className="mb-1">{t("~/.aws/config")}</Eyebrow>
            <div className="relative">
              <pre className="card overflow-x-auto p-3 font-mono text-[11.5px] leading-relaxed text-[var(--c-text)]">{text.config}</pre>
              <CopyButton value={text.config} label={t("Copier ~/.aws/config")} className="absolute right-1 top-1" />
            </div>
            {text.credentials && (
              <>
                <Eyebrow className="mb-1 mt-3">{t("~/.aws/credentials")}</Eyebrow>
                <div className="relative">
                  <pre className="card overflow-x-auto p-3 font-mono text-[11.5px] leading-relaxed text-[var(--c-text)] blur-[3px] transition hover:blur-0 focus:blur-0" tabIndex={0} title={t("Survoler pour lire")}>{text.credentials}</pre>
                  <CopyButton value={text.credentials} label={t("Copier ~/.aws/credentials")} className="absolute right-1 top-1" />
                </div>
              </>
            )}
          </section>
          <SecretCommon base={a} groups={groups} organisation={organisation} />
        </div>
      );
    }
    case "api-key": {
      const k = payload.apiKey;
      const expired = !!k.expiresAt && k.expiresAt < new Date().toISOString().slice(0, 10);
      return (
        <div className="space-y-6">
          <Section title={k.service || t("Clé d'API")}>
            {k.url && <Row label="URL"><a href={/^[a-z][a-z0-9+.-]*:/i.test(k.url) ? k.url : `https://${k.url}`} target="_blank" rel="noopener noreferrer" className="font-mono text-[13px] text-[var(--c-accent-text)] hover:underline">{uriHost(k.url)}</a></Row>}
            {k.keyId && <Row label={t("Identifiant")}><Copyable value={k.keyId} mono /></Row>}
            <Row label={t("Secret")}>{k.secret ? <SecretValue value={k.secret} /> : <Muted>—</Muted>}</Row>
            {k.scopes && <Row label={t("Portée")}>{k.scopes}</Row>}
            <Row label={t("Expiration")}>{k.expiresAt ? <span className={expired ? "text-[var(--c-danger)]" : ""}>{k.expiresAt}{expired ? t(" — expirée") : ""}</span> : <Muted>{t("aucune")}</Muted>}</Row>
          </Section>
          <SecretCommon base={k} groups={groups} organisation={organisation} />
        </div>
      );
    }
    case "runbook": {
      const rb = payload.runbook;
      return (
        <div className="space-y-6">
          {rb.description && <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-[var(--c-text-secondary)]">{rb.description}</p>}
          <section className="space-y-2">
            <Eyebrow>{t("Étapes (")}{rb.steps.length})</Eyebrow>
            {rb.steps.map((st, i) => {
              const code = st.action.kind === "command" ? st.action.command : st.action.kind === "program" ? st.action.programText : null;
              const scope = [st.scope.tags.length ? `tags ${st.scope.tags.join(" + ")}` : "", st.scope.groups.length ? `dans ${st.scope.groups.join(" ou ")}` : ""].filter(Boolean).join(", ");
              return (
                <div key={st.id} className="card space-y-1.5 p-3">
                  <p className="flex items-center gap-2 text-[13.5px] font-medium text-[var(--c-text)]"><span className="tag">{i + 1}</span>{st.title || <Muted>{t("(sans titre)")}</Muted>}<span className="ml-auto text-[10.5px] font-normal text-[var(--c-text-faint)]">{ACTION_LABELS[st.action.kind]}</span></p>
                  {code !== null && (
                    <div className="relative">
                      <pre className="overflow-x-auto rounded-md bg-[var(--c-bg3)] p-2 font-mono text-[11.5px] leading-relaxed text-[var(--c-text)]">{code}</pre>
                      <CopyButton value={code} label={t("Copier")} className="absolute right-1 top-1" />
                    </div>
                  )}
                  {st.action.kind === "playbook" && (
                    <p className="font-mono text-[11.5px] text-[var(--c-text-secondary)]">{st.action.playbook}{st.action.inventory ? ` -i ${st.action.inventory}` : ""} <span className="font-sans text-[var(--c-text-muted)]">{t("depuis")} {hostLabel(st.action.relayHostId) ?? st.action.relayHostLabel}</span></p>
                  )}
                  <p className="text-[13px] text-[var(--c-text-muted)]">{[scope || t("toutes les cibles"), t("échec : {0}", ON_FAILURE_LABELS[st.onFailure].toLowerCase()), `accord : ${APPROVAL_LABELS[st.approval].toLowerCase()}`].join(" · ")}</p>
                  {st.notes && <p className="whitespace-pre-wrap text-[11.5px] text-[var(--c-text-secondary)]">{st.notes}</p>}
                </div>
              );
            })}
          </section>
        </div>
      );
    }
  }
}

/** Dossier, tags, notes et champs personnalisés : le pied de fiche de
 * tous les secrets. */
function SecretCommon({ base, groups, withoutNotes, organisation }: { base: SecretBase; groups: Map<string, import("../lib/types").Group>; withoutNotes?: boolean; organisation: boolean }) {
  return (
    <>
      {!withoutNotes && base.notes && (
        <Section title={t("Notes")}>
          <pre className="whitespace-pre-wrap break-words font-sans text-[13.5px] leading-relaxed text-[var(--c-text-secondary)]">{base.notes}</pre>
        </Section>
      )}
      {base.fields && base.fields.length > 0 && (
        <Section title={t("Champs personnalisés")}>
          {base.fields.map((f, i) => <Row key={i} label={f.name || t("(sans nom)")}><FieldValue field={f} /></Row>)}
        </Section>
      )}
      {organisation && (
        <Section title={t("Organisation")}>
          <Row label={t("Dossier")}>{base.groupId ? groupPath(groups, base.groupId) || <Muted>{t("dossier inconnu")}</Muted> : <Muted>{t("racine")}</Muted>}</Row>
          <Row label={t("Tags")}><Tags tags={base.tags} /></Row>
        </Section>
      )}
    </>
  );
}

function FieldValue({ field }: { field: CustomField }) {
  if (field.type === "boolean") return <span>{field.value === "true" ? t("☑ oui") : t("☐ non")}</span>;
  if (field.type === "hidden") return field.value ? <SecretValue value={field.value} /> : <Muted>—</Muted>;
  return <Copyable value={field.value} />;
}

function PasswordHistory({ entries }: { entries: { password: string; changedAt: string }[] }) {
  const [open, setOpen] = useState(false);
  return (
    <section>
      <button type="button" onClick={() => setOpen((o) => !o)} className="eyebrow mb-2 hover:text-[var(--c-text)]">{t("Anciens mots de passe (")}{entries.length}) {open ? "▾" : "▸"}</button>
      {open && (
        <div className="card divide-y divide-[var(--c-border)]">
          {entries.map((e, i) => <Row key={i} label={formatWhen(e.changedAt)}><SecretValue value={e.password} /></Row>)}
        </div>
      )}
    </section>
  );
}

/** Une valeur en clair avec son bouton copier, ou un tiret si vide. */
function Copyable({ value, mono, multiline }: { value: string; mono?: boolean; multiline?: boolean }) {
  if (!value) return <Muted>—</Muted>;
  return (
    <span className="flex min-w-0 items-center gap-1">
      <span className={`min-w-0 flex-1 break-words ${multiline ? "whitespace-pre-wrap" : ""} ${mono ? "font-mono" : ""}`}>{value}</span>
      <CopyButton value={value} />
    </span>
  );
}


export const HOST_KIND_LABELS: Record<NonNullable<Host["kind"]>, string> = translated({
  ssh: "SSH",
  dockerExec: "Docker exec",
  k8sExec: "Kubernetes exec",
  rdp: "RDP",
});

function describeAuth(auth: AuthMethod, index: VaultIndex): string {
  if (auth === "password") return t("mot de passe");
  if (auth === "agent") return t("agent SSH");
  if (auth === "keyboardInteractive") return t("keyboard-interactive (MFA)");
  const k = auth.privateKey;
  const named = k.keyId ? index.keys.find((x) => x.id === k.keyId)?.name : null;
  return t("clé privée — {0}{1}", named ? `${named} (trousseau)` : k.path || t("sans chemin"), k.certPath ? t(", certificat {0}", k.certPath) : "");
}

function describeTunnel(tunnel: DbTunnel | null | undefined, index: VaultIndex): string {
  if (!tunnel || tunnel.kind === "direct") return "directe";
  if (tunnel.kind === "sshHost") return `via ${index.hosts.find((h) => h.id === tunnel.hostId)?.label ?? t("hôte inconnu")}`;
  return t("via SSM {0}{1}{2}", tunnel.target, tunnel.profile ? t(" (profil {0})", tunnel.profile) : "", tunnel.region ? ` ${tunnel.region}` : "");
}

function describeSql(c: SqlConnection, index: VaultIndex): [string, string, boolean][] {
  switch (c.engine) {
    case "sqlite":
      return [
        [t("Fichier"), c.path, true],
        [t("Sur"), c.sqliteHostId ? index.hosts.find((h) => h.id === c.sqliteHostId)?.label ?? t("hôte inconnu") : t("cette machine"), false],
      ];
    case "mongodb":
      return [
        [t("Chaîne"), c.connectionString, true],
        [t("Utilisateur"), c.username || "—", true],
        [t("Connexion"), describeTunnel(c.tunnel, index), false],
        ["TLS", c.tls ? `oui${c.tlsInsecure ? t(" (sans vérification)") : ""}${c.tlsCaFile ? t(", CA {0}", c.tlsCaFile) : ""}` : "non", false],
      ];
    default:
      return [
        [t("Serveur"), `${c.address}:${c.port}`, true],
        [t("Utilisateur"), c.username || "—", true],
        [c.engine === "redis" ? t("Index") : t("Base"), c.database || (c.engine === "redis" ? "0" : "—"), true],
        [t("Connexion"), describeTunnel(c.tunnel, index), false],
        ...(c.engine === "redis" ? [["TLS", c.tls ? "oui" : "non", false] as [string, string, boolean]] : []),
      ];
  }
}

function KeyContent({ content }: { content: string }) {
  return (
    <div className="relative">
      <pre className="card max-h-64 overflow-auto p-3 font-mono text-[13px] leading-relaxed text-[var(--c-text-secondary)] blur-[3px] transition hover:blur-0 focus:blur-0" tabIndex={0} title={t("Survoler pour lire")}>{content}</pre>
      <CopyButton value={content} label={t("Copier la clé")} className="absolute right-1 top-1" />
    </div>
  );
}

/** Une section de la fiche : son titre, et ses lignes dans une carte. */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0">
      <Eyebrow className="mb-2">{title}</Eyebrow>
      {/* Les lignes (`Row`) ont leur marge ; le reste (notes, listes) la
          reçoit d'ici. */}
      <div className="card divide-y divide-[var(--c-border)] [&>*:not([data-row])]:px-[18px] [&>*:not([data-row])]:py-3">{children}</div>
    </section>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <span className="text-[var(--c-text-muted)]">{children}</span>;
}

function Tags({ tags }: { tags: string[] }) {
  if (tags.length === 0) return <Muted>—</Muted>;
  return <span className="flex flex-wrap gap-1">{tags.map((t) => <span key={t} className="tag">{t}</span>)}</span>;
}


/** Une icône choisie, dessinée avec son nom — ou son identifiant seul quand
 * ce vault ne la connaît pas. */
function IconCell({ iconId, index }: { iconId: string; index: VaultIndex }) {
  const name = BUILTIN_ICONS.find((i) => i.id === iconId)?.name ?? index.icons.find((i) => i.id === iconId)?.name;
  if (!hasIcon(iconId, index.icons)) return <span className="font-mono text-[13px]" title={t("Icône inconnue dans ce vault")}>{iconId}</span>;
  return <span className="inline-flex items-center gap-1.5"><HostIcon iconId={iconId} customIcons={index.icons} size={16} /> {name}</span>;
}
