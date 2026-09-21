import { useState } from "react";
import type { VaultIndex } from "../lib/entities";
import { groupPath } from "../lib/entities";
import { cardBrand, identityFullName } from "../lib/items";
import { SQL_ENGINE_LABELS, type AuthMethod, type CustomField, type DbTunnel, type Host, type Payload, type SecretBase, type SqlConnection } from "../lib/types";
import { PasswordStrength } from "./PasswordStrength";
import { TotpCode } from "./TotpCode";
import { BUILTIN_ICONS, HostIcon, hasIcon } from "./icons";
import { groupColor } from "./ItemTree";
import { ACCENT_COLORS, type UiAccent } from "../lib/preferences";
import { IconPasskey } from "./secret-icons";
import { CopyButton, Eyebrow, formatWhen, Row, SecretValue } from "./ui";

/** La fiche d'une entité, en lecture : ce que Guiterm montre dans ses
 * panneaux, secrets masqués et copiables. */
export function ItemView({ payload, index }: { payload: Payload; index: VaultIndex }) {
  const groups = new Map(index.groups.map((g) => [g.id, g]));
  const hostLabel = (id: string | null | undefined) => (id ? index.hosts.find((h) => h.id === id)?.label ?? `hôte inconnu (${id.slice(0, 8)})` : null);

  switch (payload.kind) {
    case "host": {
      const h = payload.host;
      const s = payload.secrets ?? {};
      const kind = h.kind ?? "ssh";
      return (
        <div className="space-y-4">
          <Section title="Connexion">
            <Row label="Type">{HOST_KIND_LABELS[kind]}</Row>
            {kind === "dockerExec" && h.dockerViaHostId ? <Row label="Via l'hôte">{hostLabel(h.dockerViaHostId)}</Row> : <Row label={kind === "k8sExec" ? "Contexte" : "Adresse"} mono>{h.address}{kind === "ssh" || kind === "rdp" ? `:${h.port}` : ""}</Row>}
            <Row label={kind === "k8sExec" ? "Namespace" : "Utilisateur"} mono>{h.username || <Muted>—</Muted>}</Row>
            {kind !== "dockerExec" && kind !== "k8sExec" && <Row label="Authentification">{describeAuth(h.auth, index)}</Row>}
            {s.password !== undefined && <Row label="Mot de passe"><SecretValue value={s.password} /></Row>}
            {s.passphrase !== undefined && <Row label="Passphrase"><SecretValue value={s.passphrase} /></Row>}
            {h.jumpVia.length > 0 && <Row label="Relais">{h.jumpVia.map((id) => hostLabel(id)).join(" → ")}</Row>}
            {h.proxyCommand && <Row label="ProxyCommand" mono>{h.proxyCommand}</Row>}
          </Section>
          <Section title="Organisation">
            <Row label="Dossier">{h.groupId ? groupPath(groups, h.groupId) || <Muted>dossier inconnu</Muted> : <Muted>racine</Muted>}</Row>
            <Row label="Tags"><Tags tags={h.tags} /></Row>
            {h.icon && <Row label="Icône"><IconCell iconId={h.icon} index={index} /></Row>}
          </Section>
          {(h.startupSnippets.length > 0 || h.envVars.length > 0 || h.keepaliveIntervalSecs || h.agentForward || (h.persistentShell && h.persistentShell !== "off")) && (
            <Section title="Session">
              {h.startupSnippets.length > 0 && <Row label="Au démarrage">{h.startupSnippets.map((id) => index.snippets.find((sn) => sn.id === id)?.name ?? id.slice(0, 8)).join(", ")}</Row>}
              {h.envVars.length > 0 && (
                <Row label="Environnement">
                  <div className="space-y-0.5">
                    {h.envVars.map((v) => (
                      <div key={v.key} className="flex flex-wrap items-center gap-1 font-mono text-[12px]">
                        <span>{v.key}=</span>
                        {v.secret ? (s.env?.[v.key] !== undefined ? <SecretValue value={s.env[v.key]} /> : <Muted>(secret absent)</Muted>) : <span>{v.value}</span>}
                      </div>
                    ))}
                  </div>
                </Row>
              )}
              {h.keepaliveIntervalSecs ? <Row label="Keepalive">{h.keepaliveIntervalSecs} s</Row> : null}
              {h.agentForward && <Row label="Agent">transféré</Row>}
              {h.persistentShell && h.persistentShell !== "off" && <Row label="Shell persistant">{h.persistentShell}</Row>}
            </Section>
          )}
        </div>
      );
    }
    case "group": {
      const g = payload.group;
      return (
        <Section title="Dossier">
          <Row label="Nom">{g.name}</Row>
          <Row label="Parent">{g.parentId ? groupPath(groups, g.parentId) || <Muted>dossier inconnu</Muted> : <Muted>racine</Muted>}</Row>
          {g.color && <Row label="Couleur"><span className="inline-block h-3 w-3 rounded-full align-middle" style={{ background: groupColor(g.color) ?? "var(--c-bg3)" }} /> {g.color in ACCENT_COLORS ? ACCENT_COLORS[g.color as UiAccent].label : <span className="font-mono text-[12px]">{g.color}</span>}</Row>}
          {g.icon && <Row label="Icône"><IconCell iconId={g.icon} index={index} /></Row>}
        </Section>
      );
    }
    case "snippet": {
      const s = payload.snippet;
      return (
        <div className="space-y-4">
          <Section title={s.adaptive ? "Snippet adaptatif" : "Snippet"}>
            <Row label="Tags"><Tags tags={s.tags} /></Row>
          </Section>
          <div className="relative">
            <pre className="card overflow-x-auto p-3 font-mono text-[12px] leading-relaxed text-[var(--c-text)]">{s.command}</pre>
            <CopyButton value={s.command} label="Copier la commande" className="absolute right-1 top-1" />
          </div>
        </div>
      );
    }
    case "key": {
      const k = payload.key;
      return (
        <div className="space-y-4">
          <Section title="Clé privée">
            <Row label="Nom">{k.name}</Row>
            {k.path && <Row label="Chemin" mono>{k.path}</Row>}
            {payload.passphrase != null && <Row label="Passphrase"><SecretValue value={payload.passphrase} /></Row>}
            <Row label="Contenu">{payload.content ? "dans le vault" : <Muted>par chemin seulement (le fichier reste sur la machine)</Muted>}</Row>
          </Section>
          {payload.content && <KeyContent content={payload.content} />}
        </div>
      );
    }
    case "sql-connection": {
      const cnx = payload.connection;
      return (
        <div className="space-y-4">
          <Section title={SQL_ENGINE_LABELS[cnx.engine]}>
            {describeSql(cnx, index).map(([label, value, mono]) => <Row key={label} label={label} mono={mono}>{value}</Row>)}
            {payload.password != null && <Row label="Mot de passe"><SecretValue value={payload.password} /></Row>}
          </Section>
          <Section title="Organisation">
            <Row label="Dossier">{cnx.groupId ? groupPath(groups, cnx.groupId) || <Muted>dossier inconnu</Muted> : <Muted>racine</Muted>}</Row>
            <Row label="Tags"><Tags tags={cnx.tags} /></Row>
          </Section>
        </div>
      );
    }
    case "icon":
      return (
        <Section title="Icône personnalisée">
          <Row label="Nom">{payload.icon.name}</Row>
          <Row label="Aperçu"><img src={payload.icon.dataUrl} alt="" className="h-8 w-8" /></Row>
        </Section>
      );
    case "login": {
      const l = payload.login;
      return (
        <div className="space-y-4">
          <Section title="Identifiant">
            <Row label="Utilisateur"><Copyable value={l.username} mono /></Row>
            <Row label="Mot de passe">
              {l.password ? (
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <SecretValue value={l.password} />
                  <PasswordStrength password={l.password} />
                </span>
              ) : <Muted>—</Muted>}
            </Row>
            {l.totp && <Row label="Code TOTP"><TotpCode secret={l.totp} /></Row>}
            {l.uris.length > 0 && (
              <Row label={l.uris.length > 1 ? "Sites" : "Site"}>
                <div className="space-y-0.5">
                  {l.uris.map((u, i) => (
                    <div key={i} className="flex items-center gap-1">
                      <a href={/^[a-z][a-z0-9+.-]*:/i.test(u.uri) ? u.uri : `https://${u.uri}`} target="_blank" rel="noopener noreferrer" className="min-w-0 truncate font-mono text-[12px] text-[var(--c-accent-text)] hover:underline" title={u.uri}>{u.uri}</a>
                      {u.match && <span className="tag" title="Mode de correspondance">{u.match}</span>}
                      <CopyButton value={u.uri} label="Copier l'adresse" />
                    </div>
                  ))}
                </div>
              </Row>
            )}
          </Section>
          <SecretCommon base={l} groups={groups} />
          {l.passkeys.length > 0 && (
            <Section title="Passkeys">
              {l.passkeys.map((k) => (
                <div key={k.credentialId} className="flex items-start gap-2 py-1.5 text-[12px]">
                  <IconPasskey size={14} className="mt-0.5 shrink-0 text-[var(--c-text-muted)]" />
                  <span className="min-w-0">
                    <span className="block text-[var(--c-text)]">{k.rpName || k.rpId}{k.userName ? ` — ${k.userName}` : ""}</span>
                    <span className="block text-[11px] text-[var(--c-text-muted)]">{k.rpId} · {k.keyAlgorithm} {k.keyCurve} · créée le {formatWhen(k.createdAt)}{k.discoverable ? " · découvrable" : ""}</span>
                  </span>
                </div>
              ))}
              <p className="help-text pt-1">Stockées et synchronisées ; une page web ne peut pas s'en servir pour se connecter — c'est le rôle de Guiterm ou d'une extension.</p>
            </Section>
          )}
          {l.passwordHistory.length > 0 && <PasswordHistory entries={l.passwordHistory} />}
        </div>
      );
    }
    case "note": {
      const n = payload.note;
      return (
        <div className="space-y-4">
          <pre className="card whitespace-pre-wrap break-words p-3 font-sans text-[12.5px] leading-relaxed text-[var(--c-text)]">{n.content || <Muted>(vide)</Muted>}</pre>
          <SecretCommon base={n} groups={groups} withoutNotes />
        </div>
      );
    }
    case "card": {
      const cd = payload.card;
      return (
        <div className="space-y-4">
          <Section title={cd.brand || cardBrand(cd.number) || "Carte"}>
            <Row label="Titulaire"><Copyable value={cd.cardholderName} /></Row>
            <Row label="Numéro">{cd.number ? <SecretValue value={cd.number} /> : <Muted>—</Muted>}</Row>
            <Row label="Expiration"><Copyable value={[cd.expMonth, cd.expYear].filter(Boolean).join(" / ")} mono /></Row>
            <Row label="Code">{cd.code ? <SecretValue value={cd.code} /> : <Muted>—</Muted>}</Row>
          </Section>
          <SecretCommon base={cd} groups={groups} />
        </div>
      );
    }
    case "identity": {
      const i = payload.identity;
      const addr = [i.address1, i.address2, i.address3].filter(Boolean).join("\n");
      const city = [i.postalCode, i.city].filter(Boolean).join(" ");
      return (
        <div className="space-y-4">
          <Section title="Identité">
            <Row label="Nom"><Copyable value={identityFullName(i)} /></Row>
            <Row label="Utilisateur"><Copyable value={i.username} mono /></Row>
            <Row label="Société"><Copyable value={i.company} /></Row>
            <Row label="E-mail"><Copyable value={i.email} mono /></Row>
            <Row label="Téléphone"><Copyable value={i.phone} mono /></Row>
          </Section>
          <Section title="Adresse">
            <Row label="Adresse"><Copyable value={addr} multiline /></Row>
            <Row label="Ville"><Copyable value={[city, i.state, i.country].filter(Boolean).join(", ")} /></Row>
          </Section>
          <Section title="Documents">
            <Row label="N° sécu.">{i.ssn ? <SecretValue value={i.ssn} /> : <Muted>—</Muted>}</Row>
            <Row label="Passeport">{i.passportNumber ? <SecretValue value={i.passportNumber} /> : <Muted>—</Muted>}</Row>
            <Row label="Permis">{i.licenseNumber ? <SecretValue value={i.licenseNumber} /> : <Muted>—</Muted>}</Row>
          </Section>
          <SecretCommon base={i} groups={groups} />
        </div>
      );
    }
  }
}

/** Dossier, tags, notes et champs personnalisés : le pied de fiche de
 * tous les secrets. */
function SecretCommon({ base, groups, withoutNotes }: { base: SecretBase; groups: Map<string, import("../lib/types").Group>; withoutNotes?: boolean }) {
  return (
    <>
      {!withoutNotes && base.notes && (
        <Section title="Notes">
          <pre className="whitespace-pre-wrap break-words py-1 font-sans text-[12.5px] leading-relaxed text-[var(--c-text)]">{base.notes}</pre>
        </Section>
      )}
      {base.fields && base.fields.length > 0 && (
        <Section title="Champs personnalisés">
          {base.fields.map((f, i) => <Row key={i} label={f.name || "(sans nom)"}><FieldValue field={f} /></Row>)}
        </Section>
      )}
      <Section title="Organisation">
        <Row label="Dossier">{base.groupId ? groupPath(groups, base.groupId) || <Muted>dossier inconnu</Muted> : <Muted>racine</Muted>}</Row>
        <Row label="Tags"><Tags tags={base.tags} /></Row>
      </Section>
    </>
  );
}

function FieldValue({ field }: { field: CustomField }) {
  if (field.type === "boolean") return <span>{field.value === "true" ? "☑ oui" : "☐ non"}</span>;
  if (field.type === "hidden") return field.value ? <SecretValue value={field.value} /> : <Muted>—</Muted>;
  return <Copyable value={field.value} />;
}

function PasswordHistory({ entries }: { entries: { password: string; changedAt: string }[] }) {
  const [open, setOpen] = useState(false);
  return (
    <section>
      <button type="button" onClick={() => setOpen((o) => !o)} className="eyebrow mb-1 hover:text-[var(--c-text)]">Historique des mots de passe ({entries.length}) {open ? "▾" : "▸"}</button>
      {open && (
        <div className="divide-y divide-[var(--c-border)]">
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
    <span className="flex min-w-0 items-start gap-1">
      <span className={`min-w-0 break-words ${multiline ? "whitespace-pre-wrap" : ""} ${mono ? "font-mono text-[12px]" : ""}`}>{value}</span>
      <CopyButton value={value} />
    </span>
  );
}


export const HOST_KIND_LABELS: Record<NonNullable<Host["kind"]>, string> = {
  ssh: "SSH",
  dockerExec: "Docker exec",
  k8sExec: "Kubernetes exec",
  rdp: "RDP",
};

function describeAuth(auth: AuthMethod, index: VaultIndex): string {
  if (auth === "password") return "mot de passe";
  if (auth === "agent") return "agent SSH";
  if (auth === "keyboardInteractive") return "keyboard-interactive (MFA)";
  const k = auth.privateKey;
  const named = k.keyId ? index.keys.find((x) => x.id === k.keyId)?.name : null;
  return `clé privée — ${named ? `${named} (trousseau)` : k.path || "sans chemin"}${k.certPath ? `, certificat ${k.certPath}` : ""}`;
}

function describeTunnel(t: DbTunnel | null | undefined, index: VaultIndex): string {
  if (!t || t.kind === "direct") return "directe";
  if (t.kind === "sshHost") return `via ${index.hosts.find((h) => h.id === t.hostId)?.label ?? "hôte inconnu"}`;
  return `via SSM ${t.target}${t.profile ? ` (profil ${t.profile})` : ""}${t.region ? ` ${t.region}` : ""}`;
}

function describeSql(c: SqlConnection, index: VaultIndex): [string, string, boolean][] {
  switch (c.engine) {
    case "sqlite":
      return [
        ["Fichier", c.path, true],
        ["Sur", c.sqliteHostId ? index.hosts.find((h) => h.id === c.sqliteHostId)?.label ?? "hôte inconnu" : "cette machine", false],
      ];
    case "mongodb":
      return [
        ["Chaîne", c.connectionString, true],
        ["Utilisateur", c.username || "—", true],
        ["Connexion", describeTunnel(c.tunnel, index), false],
        ["TLS", c.tls ? `oui${c.tlsInsecure ? " (sans vérification)" : ""}${c.tlsCaFile ? `, CA ${c.tlsCaFile}` : ""}` : "non", false],
      ];
    default:
      return [
        ["Serveur", `${c.address}:${c.port}`, true],
        ["Utilisateur", c.username || "—", true],
        [c.engine === "redis" ? "Index" : "Base", c.database || (c.engine === "redis" ? "0" : "—"), true],
        ["Connexion", describeTunnel(c.tunnel, index), false],
        ...(c.engine === "redis" ? [["TLS", c.tls ? "oui" : "non", false] as [string, string, boolean]] : []),
      ];
  }
}

function KeyContent({ content }: { content: string }) {
  return (
    <div className="relative">
      <pre className="card max-h-64 overflow-auto p-3 font-mono text-[11px] leading-relaxed text-[var(--c-text-secondary)] blur-[3px] transition hover:blur-0 focus:blur-0" tabIndex={0} title="Survoler pour lire">{content}</pre>
      <CopyButton value={content} label="Copier la clé" className="absolute right-1 top-1" />
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <Eyebrow className="mb-1">{title}</Eyebrow>
      <div className="divide-y divide-[var(--c-border)]">{children}</div>
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
  if (!hasIcon(iconId, index.icons)) return <span className="font-mono text-[12px]" title="Icône inconnue dans ce vault">{iconId}</span>;
  return <span className="inline-flex items-center gap-1.5"><HostIcon iconId={iconId} customIcons={index.icons} size={16} /> {name}</span>;
}
