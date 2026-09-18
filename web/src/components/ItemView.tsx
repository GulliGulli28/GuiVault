import type { VaultIndex } from "../lib/entities";
import { groupPath } from "../lib/entities";
import { SQL_ENGINE_LABELS, type AuthMethod, type DbTunnel, type Host, type Payload, type SqlConnection } from "../lib/types";
import { CopyButton, Eyebrow, Row, SecretValue } from "./ui";

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
            {h.icon && <Row label="Icône" mono>{h.icon}</Row>}
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
          {g.color && <Row label="Couleur"><span className="inline-block h-3 w-3 rounded-sm align-middle" style={{ background: g.color }} /> <span className="font-mono text-[12px]">{g.color}</span></Row>}
          {g.icon && <Row label="Icône" mono>{g.icon}</Row>}
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
  }
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

