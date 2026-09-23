import { useState } from "react";
import type { VaultIndex } from "../../lib/entities";
import { uuid } from "../../lib/bytes";
import type { AuthMethod, CustomIcon, EnvVar, Host, HostKind, HostSecrets, Payload, PersistentShellMode } from "../../lib/types";
import { HOST_KIND_LABELS } from "../ItemView";
import { IconField } from "../IconPicker";
import { IconClose, IconDocker, IconHosts, IconKubernetes, IconMonitor } from "../ui-icons";
import { PasswordInput } from "../ui";
import { Checkbox, Field, FormShell, GroupSelect, HostSelect, TagsInput, parsePort, useSeed } from "./common";

type AuthKind = "password" | "agent" | "keyboardInteractive" | "privateKey";

const HOST_KINDS: { key: HostKind; Icon: (p: { size?: number }) => React.ReactNode }[] = [
  { key: "ssh", Icon: IconHosts },
  { key: "dockerExec", Icon: IconDocker },
  { key: "k8sExec", Icon: IconKubernetes },
  { key: "rdp", Icon: IconMonitor },
];

function authKindOf(a: AuthMethod): AuthKind {
  return typeof a === "string" ? a : "privateKey";
}

/** Le formulaire d'hôte de Guiterm, moins ce qui demande la machine (test
 * de la commande de proxy, parcours du disque, aperçu d'icône). Les champs
 * que ce formulaire ne connaît pas (`source`, `lastFacts`…) sont conservés
 * tels quels. */
export function HostForm({ initial, index, defaultGroupId, onSave, onCancel, onAddIcon }: {
  initial?: { host: Host; secrets?: HostSecrets };
  index: VaultIndex;
  defaultGroupId?: string | null;
  onSave: (p: Payload) => Promise<void>;
  onCancel: () => void;
  onAddIcon?: (icon: CustomIcon) => Promise<void>;
}) {
  const seed = useSeed(initial, (p) => (p.kind === "host" ? p : undefined));
  const h = seed?.host;
  const s = seed?.secrets ?? {};
  const [label, setLabel] = useState(h?.label ?? "");
  const [kind, setKind] = useState<HostKind>(h?.kind ?? "ssh");
  const [address, setAddress] = useState(h?.address ?? "");
  const [port, setPort] = useState(String(h?.port ?? 22));
  const [username, setUsername] = useState(h?.username ?? "");
  const [authKind, setAuthKind] = useState<AuthKind>(h ? authKindOf(h.auth) : "password");
  const pk = h && typeof h.auth === "object" ? h.auth.privateKey : null;
  const [keyId, setKeyId] = useState<string | null>(pk?.keyId ?? null);
  const [keyPath, setKeyPath] = useState(pk?.path ?? "");
  const [certPath, setCertPath] = useState(pk?.certPath ?? "");
  const [password, setPassword] = useState(s.password ?? "");
  const [passphrase, setPassphrase] = useState(s.passphrase ?? "");
  const [dockerVia, setDockerVia] = useState<string | null>(h?.dockerViaHostId ?? null);
  const [groupId, setGroupId] = useState<string | null>(h?.groupId ?? defaultGroupId ?? null);
  const [jumpVia, setJumpVia] = useState<string[]>(h?.jumpVia ?? []);
  const [proxyCommand, setProxyCommand] = useState(h?.proxyCommand ?? "");
  const [tags, setTags] = useState<string[]>(h?.tags ?? []);
  const [startupSnippets, setStartupSnippets] = useState<string[]>(h?.startupSnippets ?? []);
  const [envVars, setEnvVars] = useState<(EnvVar & { secretValue: string })[]>(
    (h?.envVars ?? []).map((v) => ({ ...v, secretValue: v.secret ? s.env?.[v.key] ?? "" : "" })),
  );
  const [icon, setIcon] = useState<string | null>(h?.icon ?? null);
  const [keepalive, setKeepalive] = useState(String(h?.keepaliveIntervalSecs ?? 0));
  const [agentForward, setAgentForward] = useState(h?.agentForward ?? false);
  const [persistentShell, setPersistentShell] = useState<PersistentShellMode>(h?.persistentShell ?? "off");

  const showPort = kind === "ssh" || kind === "rdp";
  const showAuth = kind === "ssh" || kind === "rdp";
  const sshExtras = kind === "ssh";
  const addressLabel = kind === "dockerExec" ? "Socket ou hôte du démon Docker" : kind === "k8sExec" ? "Contexte kubeconfig" : "Adresse";
  const usernameLabel = kind === "k8sExec" ? "Namespace par défaut" : "Utilisateur";

  const buildAuth = (): AuthMethod => {
    if (!showAuth) return "password";
    if (authKind === "privateKey") return { privateKey: { path: keyPath.trim(), keyId, certPath: certPath.trim() || null } };
    return authKind;
  };

  const save = async () => {
    const id = h?.id ?? uuid();
    const host: Host = {
      ...h,
      id,
      label: label.trim(),
      kind,
      address: address.trim(),
      port: parsePort(port, kind === "rdp" ? 3389 : 22),
      username: username.trim(),
      auth: buildAuth(),
      dockerViaHostId: kind === "dockerExec" ? dockerVia : null,
      groupId,
      jumpVia: proxyCommand.trim() ? [] : jumpVia,
      proxyCommand: proxyCommand.trim() || null,
      tags,
      startupSnippets,
      envVars: envVars.map(({ key, value, secret }) => ({ key: key.trim(), value: secret ? "" : value, secret: !!secret })).filter((v) => v.key),
      icon: icon ?? undefined,
      keepaliveIntervalSecs: Number.parseInt(keepalive, 10) > 0 ? Number.parseInt(keepalive, 10) : null,
      agentForward: sshExtras && authKind === "agent" ? agentForward : false,
      persistentShell,
    };
    if (host.icon === undefined) delete host.icon;
    const secrets: HostSecrets = {};
    if (showAuth && authKind === "password" && password) secrets.password = password;
    if (showAuth && authKind === "privateKey" && !keyId && passphrase) secrets.passphrase = passphrase;
    const env: Record<string, string> = {};
    for (const v of envVars) if (v.secret && v.key.trim()) env[v.key.trim()] = v.secretValue;
    if (Object.keys(env).length) secrets.env = env;
    await onSave({ kind: "host", host, secrets });
  };

  const validate = () => {
    if (!label.trim()) return "Le nom est obligatoire.";
    if (kind !== "dockerExec" && !address.trim()) return `${addressLabel} : obligatoire.`;
    if (kind === "dockerExec" && !dockerVia && !address.trim()) return "Indiquez le socket du démon, ou un hôte SSH relais.";
    if (showAuth && authKind === "privateKey" && !keyId && !keyPath.trim()) return "Choisissez une clé du trousseau ou indiquez son chemin.";
    return null;
  };

  const move = <T,>(list: T[], i: number, d: -1 | 1) => {
    const next = [...list];
    const j = i + d;
    if (j < 0 || j >= next.length) return list;
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  };

  const otherHosts = index.hosts.filter((x) => x.id !== h?.id && (x.kind ?? "ssh") === "ssh");

  return (
    <FormShell title={initial ? `Modifier « ${initial.host.label} »` : "Nouvel hôte"} onSave={save} onCancel={onCancel} validate={validate}>
      <Field label="Nom">
        <input value={label} onChange={(e) => setLabel(e.target.value)} autoFocus className="input" />
      </Field>

      <Field group label="Type de connexion">
        <div className="grid grid-cols-2 gap-1.5">
          {HOST_KINDS.map(({ key, Icon }) => (
            <button
              key={key}
              type="button"
              onClick={() => {
                setKind(key);
                if (key === "rdp") {
                  setAuthKind("password");
                  if (!h && port === "22") setPort("3389");
                }
              }}
              aria-pressed={kind === key}
              className={`btn justify-start ${kind === key ? "btn-toggled border-[color-mix(in_srgb,var(--c-accent)_40%,transparent)]" : "btn-secondary text-[var(--c-text-secondary)]"}`}
            >
              <Icon size={14} /> {HOST_KIND_LABELS[key]}
            </button>
          ))}
        </div>
      </Field>

      <div className={showPort ? "grid grid-cols-[1fr_5.5rem] gap-2" : ""}>
        <Field label={addressLabel}>
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder={kind === "dockerExec" ? (dockerVia ? "ignoré : voir l'hôte SSH relais" : "unix:///var/run/docker.sock") : kind === "k8sExec" ? "mon-cluster" : "srv.example.com"}
            disabled={kind === "dockerExec" && !!dockerVia}
            className="input input-mono disabled:opacity-40"
          />
        </Field>
        {showPort && (
          <Field label="Port">
            <input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" className="input input-mono" />
          </Field>
        )}
      </div>
      {kind === "dockerExec" && (
        <Field label="Via un hôte SSH (bastion)" hint={dockerVia ? "Le démon Docker par défaut de cet hôte SSH sera utilisé ; le socket ci-dessus est ignoré." : "Utile quand le démon distant n'expose pas de port TCP."}>
          <HostSelect index={index} value={dockerVia} onChange={setDockerVia} exclude={h?.id} />
        </Field>
      )}
      {kind === "k8sExec" && <p className="help-text -mt-1.5">Authentifié via kubeconfig, pas par adresse/port. La sélection du pod se fait au moment de la connexion.</p>}

      <Field label={usernameLabel}>
        <input value={username} onChange={(e) => setUsername(e.target.value)} className="input" />
      </Field>

      {showAuth && (
        <Field label="Authentification">
          <select value={authKind} onChange={(e) => setAuthKind(e.target.value as AuthKind)} className="input" disabled={kind === "rdp"}>
            <option value="password">Mot de passe</option>
            <option value="privateKey">Clé privée</option>
            <option value="agent">Agent SSH</option>
            <option value="keyboardInteractive">Keyboard-interactive (MFA / OTP)</option>
          </select>
        </Field>
      )}
      {showAuth && authKind === "agent" && sshExtras && (
        <Checkbox checked={agentForward} onChange={setAgentForward} label="Transférer l'agent SSH" hint="Seulement pour un hôte de confiance : une machine compromise peut utiliser l'agent tant que la session est ouverte." />
      )}
      {showAuth && authKind === "privateKey" && (
        <>
          <Field label="Clé du trousseau" hint="Une clé du vault : son contenu et sa passphrase la suivent.">
            <select value={keyId ?? ""} onChange={(e) => setKeyId(e.target.value || null)} className="input">
              <option value="">— par chemin —</option>
              {index.keys.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
            </select>
          </Field>
          {!keyId && (
            <Field label="Chemin de la clé privée" hint="Sur la machine qui se connecte.">
              <input value={keyPath} onChange={(e) => setKeyPath(e.target.value)} placeholder="~/.ssh/id_ed25519" className="input input-mono" />
            </Field>
          )}
          <Field label="Certificat (optionnel)" hint="Un certificat OpenSSH présenté avec la clé, lu à chaque connexion.">
            <input value={certPath} onChange={(e) => setCertPath(e.target.value)} placeholder="~/.ssh/id_ed25519-cert.pub" className="input input-mono" />
          </Field>
        </>
      )}
      {showAuth && (authKind === "password" || (authKind === "privateKey" && !keyId)) && (
        <Field label={authKind === "password" ? "Mot de passe" : "Passphrase (optionnelle)"}>
          <PasswordInput value={authKind === "password" ? password : passphrase} onChange={authKind === "password" ? setPassword : setPassphrase} autoComplete="off" />
        </Field>
      )}

      {sshExtras && (
        <Field group label="Chaîne de bastions" hint="Dans l'ordre de traversée. Exclusif avec la commande de proxy.">
          <div className="space-y-1">
            {jumpVia.map((id, i) => (
              <div key={`${id}-${i}`} className="flex items-center gap-1">
                <span className="input flex items-center">{otherHosts.find((x) => x.id === id)?.label ?? `hôte inconnu (${id.slice(0, 8)})`}</span>
                <button type="button" onClick={() => setJumpVia(move(jumpVia, i, -1))} disabled={i === 0} aria-label="Monter" className="btn btn-ghost btn-sm btn-icon disabled:opacity-20">↑</button>
                <button type="button" onClick={() => setJumpVia(move(jumpVia, i, 1))} disabled={i === jumpVia.length - 1} aria-label="Descendre" className="btn btn-ghost btn-sm btn-icon disabled:opacity-20">↓</button>
                <button type="button" onClick={() => setJumpVia(jumpVia.filter((_, j) => j !== i))} aria-label="Retirer" className="btn btn-ghost btn-sm btn-icon hover:text-[var(--c-danger)]"><IconClose size={11} /></button>
              </div>
            ))}
            <select value="" onChange={(e) => { if (e.target.value) setJumpVia([...jumpVia, e.target.value]); }} className="input" disabled={!!proxyCommand.trim()}>
              <option value="">Ajouter un relais…</option>
              {otherHosts.filter((x) => !jumpVia.includes(x.id)).map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
            </select>
          </div>
        </Field>
      )}
      {sshExtras && (
        <Field label="Commande de proxy" hint="OpenSSH ProxyCommand (%h, %p, %r) : SSM, IAP, Bastion, cloudflared… Remplace la chaîne de bastions.">
          <input value={proxyCommand} onChange={(e) => setProxyCommand(e.target.value)} placeholder="aws ssm start-session --target %h --document-name AWS-StartSSHSession --parameters portNumber=%p" className="input input-mono" />
        </Field>
      )}

      <Field label="Dossier">
        <GroupSelect groups={index.groups} value={groupId} onChange={setGroupId} />
      </Field>
      <Field label="Étiquettes">
        <TagsInput value={tags} onChange={setTags} />
      </Field>
      <Field group label="Icône" hint="Celle de la banque de Guiterm, ou une icône du vault. Sans choix : l'icône du genre d'hôte.">
        <IconField value={icon} onChange={setIcon} customIcons={index.icons} onAddIcon={onAddIcon} fallback={(() => { const K = HOST_KINDS.find((k) => k.key === kind)?.Icon ?? IconHosts; return <K size={14} />; })()} />
      </Field>

      {kind !== "rdp" && (
        <Field group label="Snippets au démarrage">
          <div className="space-y-1">
            {startupSnippets.map((id, i) => (
              <div key={`${id}-${i}`} className="flex items-center gap-1">
                <span className="input flex items-center">{index.snippets.find((x) => x.id === id)?.name ?? `snippet inconnu (${id.slice(0, 8)})`}</span>
                <button type="button" onClick={() => setStartupSnippets(move(startupSnippets, i, -1))} disabled={i === 0} aria-label="Monter" className="btn btn-ghost btn-sm btn-icon disabled:opacity-20">↑</button>
                <button type="button" onClick={() => setStartupSnippets(move(startupSnippets, i, 1))} disabled={i === startupSnippets.length - 1} aria-label="Descendre" className="btn btn-ghost btn-sm btn-icon disabled:opacity-20">↓</button>
                <button type="button" onClick={() => setStartupSnippets(startupSnippets.filter((_, j) => j !== i))} aria-label="Retirer" className="btn btn-ghost btn-sm btn-icon hover:text-[var(--c-danger)]"><IconClose size={11} /></button>
              </div>
            ))}
            <select value="" onChange={(e) => { if (e.target.value) setStartupSnippets([...startupSnippets, e.target.value]); }} className="input">
              <option value="">Ajouter un snippet…</option>
              {index.snippets.filter((x) => !startupSnippets.includes(x.id)).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          </div>
        </Field>
      )}

      {kind !== "rdp" && (
        <Field group label="Variables d'environnement" hint="Une variable secrète voit sa valeur chiffrée à part, jamais dans la définition de l'hôte.">
          <div className="space-y-1">
            {envVars.map((v, i) => (
              <div key={i} className="grid grid-cols-[1fr_1fr_auto_auto] items-center gap-1">
                <input value={v.key} onChange={(e) => setEnvVars(envVars.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} placeholder="NOM" className="input input-mono" />
                {v.secret ? (
                  <PasswordInput value={v.secretValue} onChange={(val) => setEnvVars(envVars.map((x, j) => (j === i ? { ...x, secretValue: val } : x)))} autoComplete="off" />
                ) : (
                  <input value={v.value} onChange={(e) => setEnvVars(envVars.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} placeholder="valeur" className="input input-mono" />
                )}
                <label className="flex items-center gap-1 text-[11px] text-[var(--c-text-muted)]" title="Valeur secrète">
                  <input type="checkbox" checked={!!v.secret} onChange={(e) => setEnvVars(envVars.map((x, j) => (j === i ? { ...x, secret: e.target.checked } : x)))} />
                  secret
                </label>
                <button type="button" onClick={() => setEnvVars(envVars.filter((_, j) => j !== i))} aria-label="Retirer" className="btn btn-ghost btn-sm btn-icon hover:text-[var(--c-danger)]"><IconClose size={11} /></button>
              </div>
            ))}
            <button type="button" onClick={() => setEnvVars([...envVars, { key: "", value: "", secret: false, secretValue: "" }])} className="btn btn-secondary btn-sm">Ajouter une variable</button>
          </div>
        </Field>
      )}

      {sshExtras && (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Keepalive (s, 0 = désactivé)">
            <input value={keepalive} onChange={(e) => setKeepalive(e.target.value)} inputMode="numeric" className="input" />
          </Field>
          <Field label="Session persistante">
            <select value={persistentShell} onChange={(e) => setPersistentShell(e.target.value as PersistentShellMode)} className="input">
              <option value="off">Désactivée</option>
              <option value="tmux">tmux</option>
            </select>
          </Field>
        </div>
      )}
    </FormShell>
  );
}
