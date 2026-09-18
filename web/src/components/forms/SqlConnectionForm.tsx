import { useState } from "react";
import type { VaultIndex } from "../../lib/entities";
import { uuid } from "../../lib/bytes";
import { SQL_ENGINE_LABELS, type DbTunnel, type Payload, type SqlConnection, type SqlEngine } from "../../lib/types";
import { PasswordInput } from "../ui";
import { Checkbox, Field, FormShell, GroupSelect, HostSelect, TagsInput, parsePort } from "./common";

const DEFAULT_PORT: Record<SqlEngine, number> = { mysql: 3306, postgres: 5432, redis: 6379, sqlite: 0, mongodb: 27017 };

type TunnelKind = DbTunnel["kind"];

/** Le `SqlConnectionForm` de Guiterm : un moteur, et les champs qu'il
 * demande — serveur/port pour MySQL, PostgreSQL et Redis ; un fichier pour
 * SQLite ; une chaîne pour MongoDB. */
export function SqlConnectionForm({ initial, index, defaultGroupId, onSave, onCancel }: {
  initial?: { connection: SqlConnection; password?: string | null };
  index: VaultIndex;
  defaultGroupId?: string | null;
  onSave: (p: Payload) => Promise<void>;
  onCancel: () => void;
}) {
  const c = initial?.connection;
  const [label, setLabel] = useState(c?.label ?? "");
  const [engine, setEngine] = useState<SqlEngine>(c?.engine ?? "postgres");
  const server = c && c.engine !== "sqlite" && c.engine !== "mongodb" ? c : null;
  const [address, setAddress] = useState(server?.address ?? "");
  const [port, setPort] = useState(String(server?.port ?? DEFAULT_PORT[c?.engine ?? "postgres"]));
  const [username, setUsername] = useState(server?.username ?? (c?.engine === "mongodb" ? c.username : ""));
  const [database, setDatabase] = useState(server?.database ?? "");
  const [tls, setTls] = useState((c && c.engine !== "sqlite" && c.tls) ?? false);
  const [password, setPassword] = useState(initial?.password ?? "");
  const [path, setPath] = useState(c?.engine === "sqlite" ? c.path : "");
  const [sqliteHostId, setSqliteHostId] = useState<string | null>(c?.engine === "sqlite" ? c.sqliteHostId ?? null : null);
  const [connectionString, setConnectionString] = useState(c?.engine === "mongodb" ? c.connectionString : "");
  const [tlsCaFile, setTlsCaFile] = useState(c?.engine === "mongodb" ? c.tlsCaFile ?? "" : "");
  const [tlsInsecure, setTlsInsecure] = useState(c?.engine === "mongodb" ? c.tlsInsecure ?? false : false);
  const initialTunnel = c && c.engine !== "sqlite" ? c.tunnel ?? null : null;
  const [tunnelKind, setTunnelKind] = useState<TunnelKind>(initialTunnel?.kind ?? "direct");
  const [tunnelHostId, setTunnelHostId] = useState<string | null>(initialTunnel?.kind === "sshHost" ? initialTunnel.hostId : null);
  const [ssmTarget, setSsmTarget] = useState(initialTunnel?.kind === "ssm" ? initialTunnel.target : "");
  const [ssmProfile, setSsmProfile] = useState(initialTunnel?.kind === "ssm" ? initialTunnel.profile ?? "" : "");
  const [ssmRegion, setSsmRegion] = useState(initialTunnel?.kind === "ssm" ? initialTunnel.region ?? "" : "");
  const [groupId, setGroupId] = useState<string | null>(c?.groupId ?? defaultGroupId ?? null);
  const [tags, setTags] = useState<string[]>(c?.tags ?? []);

  const isServer = engine === "mysql" || engine === "postgres" || engine === "redis";

  const tunnel = (): DbTunnel => {
    if (tunnelKind === "sshHost" && tunnelHostId) return { kind: "sshHost", hostId: tunnelHostId };
    if (tunnelKind === "ssm") return { kind: "ssm", target: ssmTarget.trim(), profile: ssmProfile.trim() || null, region: ssmRegion.trim() || null };
    return { kind: "direct" };
  };

  const save = async () => {
    const base = { id: c?.id ?? uuid(), label: label.trim(), groupId, tags };
    // On repart des champs communs sans recopier ceux d'un autre moteur : un
    // `path` de SQLite n'a rien à faire sur une connexion PostgreSQL.
    let connection: SqlConnection;
    if (engine === "sqlite") {
      connection = { ...base, engine, path: path.trim(), sqliteHostId };
    } else if (engine === "mongodb") {
      connection = { ...base, engine, connectionString: connectionString.trim(), username: username.trim(), tunnel: tunnel(), tls, tlsCaFile: tlsCaFile.trim() || null, tlsInsecure };
    } else {
      connection = { ...base, engine, address: address.trim(), port: parsePort(port, DEFAULT_PORT[engine]), username: username.trim(), database: database.trim() || null, tunnel: tunnel(), tls };
    }
    await onSave({ kind: "sql-connection", connection, password: engine === "sqlite" ? null : password || null });
  };

  const validate = () => {
    if (!label.trim()) return "Le nom est obligatoire.";
    if (isServer && !address.trim()) return "L'adresse du serveur est obligatoire.";
    if (engine === "sqlite" && !path.trim()) return "Le chemin du fichier est obligatoire.";
    if (engine === "mongodb" && !/^mongodb(\+srv)?:\/\//.test(connectionString.trim())) return "La chaîne doit commencer par mongodb:// ou mongodb+srv://.";
    if (tunnelKind === "sshHost" && !tunnelHostId) return "Choisissez l'hôte SSH du tunnel.";
    if (tunnelKind === "ssm" && !ssmTarget.trim()) return "Indiquez l'instance SSM cible.";
    return null;
  };

  return (
    <FormShell title={c ? `Modifier « ${c.label} »` : "Nouvelle connexion"} onSave={save} onCancel={onCancel} validate={validate}>
      <Field label="Nom">
        <input value={label} onChange={(e) => setLabel(e.target.value)} autoFocus className="input" />
      </Field>
      <Field label="Moteur">
        <select
          value={engine}
          onChange={(e) => {
            const next = e.target.value as SqlEngine;
            if (!c || c.engine !== next) setPort(String(DEFAULT_PORT[next] || ""));
            setEngine(next);
          }}
          className="input"
        >
          {(Object.keys(SQL_ENGINE_LABELS) as SqlEngine[]).map((k) => <option key={k} value={k}>{SQL_ENGINE_LABELS[k]}</option>)}
        </select>
      </Field>

      {isServer && (
        <>
          <div className="grid grid-cols-[1fr_5.5rem] gap-2">
            <Field label="Adresse"><input value={address} onChange={(e) => setAddress(e.target.value)} className="input input-mono" /></Field>
            <Field label="Port"><input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" className="input input-mono" /></Field>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label={engine === "redis" ? "Utilisateur ACL (optionnel)" : "Utilisateur"}><input value={username} onChange={(e) => setUsername(e.target.value)} className="input input-mono" /></Field>
            <Field label={engine === "redis" ? "Index de base (0-15)" : engine === "postgres" ? "Base" : "Base (optionnelle)"}><input value={database} onChange={(e) => setDatabase(e.target.value)} className="input input-mono" /></Field>
          </div>
          <Field label="Mot de passe"><PasswordInput value={password} onChange={setPassword} autoComplete="off" /></Field>
          {engine === "redis" && <Checkbox checked={tls} onChange={setTls} label="TLS (rediss://)" />}
        </>
      )}

      {engine === "sqlite" && (
        <>
          <Field label="Fichier" hint={sqliteHostId ? "Sur l'hôte choisi : récupéré par SFTP à l'ouverture, réécrit à la fermeture." : "Sur la machine qui ouvre la connexion."}>
            <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/var/lib/app/data.db" className="input input-mono" />
          </Field>
          <Field label="Sur l'hôte">
            <HostSelect index={index} value={sqliteHostId} onChange={setSqliteHostId} none="Cette machine" />
          </Field>
        </>
      )}

      {engine === "mongodb" && (
        <>
          <Field label="Chaîne de connexion">
            <input value={connectionString} onChange={(e) => setConnectionString(e.target.value)} placeholder="mongodb://host:27017/db" className="input input-mono" />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Utilisateur (si absent de la chaîne)"><input value={username} onChange={(e) => setUsername(e.target.value)} className="input input-mono" /></Field>
            <Field label="Mot de passe"><PasswordInput value={password} onChange={setPassword} autoComplete="off" /></Field>
          </div>
          <Checkbox checked={tls} onChange={setTls} label="TLS" hint="DocumentDB n'accepte rien d'autre." />
          {tls && (
            <>
              <Field label="Fichier CA (optionnel)"><input value={tlsCaFile} onChange={(e) => setTlsCaFile(e.target.value)} className="input input-mono" /></Field>
              <Checkbox checked={tlsInsecure} onChange={setTlsInsecure} label="Ne pas vérifier le certificat" hint="Nécessaire pour combiner TLS et tunnel SSH." />
            </>
          )}
        </>
      )}

      {engine !== "sqlite" && (
        <Field group label="Connexion">
          <select aria-label="Mode de connexion" value={tunnelKind} onChange={(e) => setTunnelKind(e.target.value as TunnelKind)} className="input">
            <option value="direct">Directe</option>
            <option value="sshHost">Tunnel via un hôte SSH</option>
            <option value="ssm">Tunnel AWS SSM</option>
          </select>
          {tunnelKind === "sshHost" && <div className="mt-1.5"><HostSelect index={index} value={tunnelHostId} onChange={setTunnelHostId} none="Choisir un hôte…" label="Hôte du tunnel" /></div>}
          {tunnelKind === "ssm" && (
            <div className="mt-1.5 grid grid-cols-[2fr_1fr_1fr] gap-1.5">
              <input value={ssmTarget} onChange={(e) => setSsmTarget(e.target.value)} placeholder="i-0123456789abcdef0" className="input input-mono" />
              <input value={ssmProfile} onChange={(e) => setSsmProfile(e.target.value)} placeholder="profil" className="input input-mono" />
              <input value={ssmRegion} onChange={(e) => setSsmRegion(e.target.value)} placeholder="région" className="input input-mono" />
            </div>
          )}
        </Field>
      )}

      <Field label="Dossier"><GroupSelect groups={index.groups} value={groupId} onChange={setGroupId} /></Field>
      <Field label="Étiquettes"><TagsInput value={tags} onChange={setTags} /></Field>
    </FormShell>
  );
}
