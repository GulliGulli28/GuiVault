/** L'agent SSH de l'application (bureau, `app-tauri/src/ssh_agent/`) :
 * `ssh`, `git`, `scp`… lancés sur le poste signent avec les clés du coffre
 * ouvert, après confirmation. Trois morceaux :
 *
 * - `SshAgentFeeder` confie à l'agent les clés cochées tant que le coffre
 *   est ouvert, et les lui retire au verrouillage (démonté avec la session) ;
 * - `SshAgentPrompt` pose la question à chaque demande de signature ;
 * - `SshAgentSettings` : Paramètres › Agent SSH (marche, clés).
 *
 * Les éléments protégés (`reprompt`) ne sont pas confiés : l'agent signerait
 * sans redemander le mot de passe maître. Ni les vaults d'un accès
 * d'urgence. */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { PageContext } from "../App";
import { useAllItems, type VaultItem } from "../lib/allItems";
import { loadSshAgent, saveSshAgent, SSH_AGENT_CHANGED, type SshAgentSettings as Settings } from "../lib/appSettings";
import { errorMessage } from "../lib/api";
import { sshAgentBridge, type SshAgentKeyStatus, type SshAgentRequest } from "../lib/platform";
import { isProtected } from "../lib/reprompt";
import { InfoTip, Modal, SettingRow } from "./ui";
import { t } from "../lib/i18n";

function useSettings(): [Settings, (s: Settings) => void] {
  const [settings, setSettings] = useState(loadSshAgent);
  useEffect(() => {
    const on = () => setSettings(loadSshAgent());
    window.addEventListener(SSH_AGENT_CHANGED, on);
    return () => window.removeEventListener(SSH_AGENT_CHANGED, on);
  }, []);
  return [settings, saveSshAgent];
}

/** Ce que l'agent a dit des clés confiées, et s'il écoute. */
let statuses: SshAgentKeyStatus[] = [];
let agentError: string | null = null;
const STATUS_CHANGED = "guivault-ssh-agent-status";
function setStatus(s: SshAgentKeyStatus[], error: string | null) {
  statuses = s;
  agentError = error;
  window.dispatchEvent(new Event(STATUS_CHANGED));
}

function useStatus() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const on = () => setTick((t) => t + 1);
    window.addEventListener(STATUS_CHANGED, on);
    return () => window.removeEventListener(STATUS_CHANGED, on);
  }, []);
  return { statuses, error: agentError };
}

/** Les clés SSH du coffre ouvert qu'on peut confier à l'agent. */
function sshKeys(items: VaultItem[]): VaultItem[] {
  return items.filter((v) => !v.vault.emergency && v.item.payload.kind === "key");
}

function offerable(v: VaultItem): boolean {
  const p = v.item.payload;
  return p.kind === "key" && !!p.content?.trim() && !isProtected(p);
}

export function SshAgentFeeder({ ctx }: { ctx: Pick<PageContext, "session" | "error"> }) {
  const [settings] = useSettings();
  const { items, loading } = useAllItems(ctx.session, ctx.error);
  const chosen = useMemo(() => sshKeys(items).filter((v) => offerable(v) && settings.keys.includes(v.item.id)), [items, settings.keys]);
  // Ce qui a changé : les clés cochées et leurs révisions, pas leur texte.
  const signature = chosen.map((v) => `${v.item.id}:${v.item.revision}`).join(",");

  useEffect(() => {
    const b = sshAgentBridge();
    if (!b) return;
    if (!settings.enabled) {
      void b.setKeys([]).then(() => b.stop()).then(() => setStatus([], null));
      return;
    }
    b.start().then(() => setStatus(statuses, null), (e) => setStatus([], errorMessage(e)));
  }, [settings.enabled]);

  useEffect(() => {
    const b = sshAgentBridge();
    if (!b || !settings.enabled || loading) return;
    const keys = chosen.map((v) => {
      const p = v.item.payload as Extract<typeof v.item.payload, { kind: "key" }>;
      return { id: v.item.id, name: p.key.name, content: p.content ?? "", passphrase: p.passphrase ?? null };
    });
    b.setKeys(keys).then((s) => setStatus(s, agentError), (e) => setStatus([], errorMessage(e)));
    // `chosen` suit `signature`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, settings.enabled, loading]);

  // Verrouillage (la session se démonte) : l'agent oublie tout.
  useEffect(() => () => void sshAgentBridge()?.setKeys([]).then(() => setStatus([], agentError)), []);
  return null;
}

function describe(r: SshAgentRequest): string {
  switch (r.purpose.kind) {
    case "sshLogin":
      return t("Connexion SSH en tant que « {0} »", r.purpose.user);
    case "gitSignature":
      return t("Signer un commit ou une étiquette Git");
    case "sshsig":
      return t("Signer des données (espace « {0} »)", r.purpose.namespace);
    default:
      return t("Une signature d'un type inconnu");
  }
}

/** La question, une demande à la fois ; les suivantes attendent. */
export function SshAgentPrompt() {
  const [queue, setQueue] = useState<SshAgentRequest[]>([]);
  const [remember, setRemember] = useState(false);
  useEffect(() => {
    const b = sshAgentBridge();
    if (!b) return;
    const offRequest = b.onRequest((r) => setQueue((q) => [...q, r]));
    const offCancel = b.onCancel((id) => setQueue((q) => q.filter((r) => r.id !== id)));
    return () => {
      offRequest();
      offCancel();
    };
  }, []);
  const current = queue[0];
  const answer = useCallback((allow: boolean) => {
    if (!current) return;
    void sshAgentBridge()?.answer(current.id, allow, allow && remember && !current.forwarded);
    setQueue((q) => q.slice(1));
    setRemember(false);
  }, [current, remember]);
  const refuse = useCallback(() => answer(false), [answer]);
  if (!current) return null;
  const who = current.client.program ? `${current.client.program}${current.client.pid ? t(" (pid {0})", current.client.pid) : ""}` : t("Un programme de ce poste");
  return (
    <Modal title={t("Agent SSH : autoriser ?")} onClose={refuse}>
      <div className="flex flex-col gap-4">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13px]">
          <dt className="text-[var(--c-text-muted)]">{t("Demande")}</dt>
          <dd className="min-w-0 truncate font-medium">{describe(current)}</dd>
          {current.purpose.kind === "sshLogin" && current.purpose.fingerprint && (
            <>
              <dt className="text-[var(--c-text-muted)]">{t("Serveur")}</dt>
              <dd className="min-w-0 truncate font-mono text-[12px]" title={current.purpose.fingerprint}>{current.purpose.fingerprint}</dd>
            </>
          )}
          <dt className="text-[var(--c-text-muted)]">{t("Clé")}</dt>
          <dd className="min-w-0 truncate" title={current.keyFingerprint}>{current.keyName}</dd>
          <dt className="text-[var(--c-text-muted)]">{t("Programme")}</dt>
          <dd className="min-w-0 truncate">{who}</dd>
        </dl>
        {current.forwarded && <p className="callout callout-warn">{t("Par un agent transféré sur un serveur distant : demandé à chaque fois.")}</p>}
        {!current.forwarded && (
          <label className="flex items-center gap-2 text-[13px]">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            {t("Ne plus demander pour cette clé pendant 10 minutes")}
          </label>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={refuse} className="btn btn-ghost">{t("Refuser")}</button>
          <button type="button" onClick={() => answer(true)} className="btn btn-primary" autoFocus>{t("Autoriser")}</button>
        </div>
      </div>
    </Modal>
  );
}

/** Paramètres › Agent SSH. */
export function SshAgentSettings({ ctx }: { ctx: Pick<PageContext, "session" | "error"> }) {
  const [settings, save] = useSettings();
  const { statuses, error } = useStatus();
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const { items, loading } = useAllItems(ctx.session, ctx.error);
  const keys = sshKeys(items);
  useEffect(() => {
    sshAgentBridge()?.status().then((s) => setEndpoint(s.endpoint), () => setEndpoint(null));
  }, []);
  const toggleKey = (id: string, on: boolean) => save({ ...settings, keys: on ? [...settings.keys, id] : settings.keys.filter((k) => k !== id) });

  return (
    <>
      <section className="flex flex-col gap-2.5">
        <h2 className="eyebrow">{t("Agent")}</h2>
        <div className="card">
          <SettingRow
            title={<>{t("Agent SSH")} <InfoTip label={t("Ce que fait l'agent SSH")} items={[
              { text: t("ssh, git et scp signent avec les clés cochées, sans fichier sur le disque."), tone: "ok" },
              { text: t("Chaque signature est confirmée ici, ou une fois pour 10 minutes par clé.") },
              { text: t("Au verrouillage, l'agent oublie toutes les clés.") },
              { text: t("Windows : le service « OpenSSH Authentication Agent » doit être arrêté.") },
            ]} /></>}
            desc={error ?? (settings.enabled ? t("Écoute sur {0}", endpoint ?? "…") : t("Les clés du coffre pour ssh et git, sur ce poste"))}
          >
            <button type="button" role="switch" aria-checked={settings.enabled} aria-label={t("Agent SSH")} onClick={() => save({ ...settings, enabled: !settings.enabled })} className="switch" />
          </SettingRow>
        </div>
      </section>
      <section className="flex flex-col gap-2.5">
        <h2 className="eyebrow">{t("Clés confiées")}</h2>
        <div className="card divide-y divide-[var(--c-border)]">
          {!loading && keys.length === 0 && <p className="px-5 py-4 text-[13px] text-[var(--c-text-muted)]">{t("Aucune clé SSH dans vos vaults.")}</p>}
          {keys.map((v) => {
            const p = v.item.payload as Extract<typeof v.item.payload, { kind: "key" }>;
            const can = offerable(v);
            const on = can && settings.keys.includes(v.item.id);
            const status = statuses.find((s) => s.id === v.item.id);
            const desc = !p.content?.trim()
              ? t("Pas de contenu dans le coffre (fichier sur un autre poste)")
              : isProtected(p)
                ? t("Élément protégé : pas confié à l'agent")
                : status?.error ?? (on && status?.fingerprint ? status.fingerprint : v.vault.name);
            return (
              <SettingRow key={v.item.id} title={p.key.name} desc={desc}>
                <button type="button" role="switch" aria-checked={on} aria-label={t("Confier « {0} » à l'agent", p.key.name)} disabled={!can} onClick={() => toggleKey(v.item.id, !on)} className="switch" />
              </SettingRow>
            );
          })}
        </div>
      </section>
    </>
  );
}
