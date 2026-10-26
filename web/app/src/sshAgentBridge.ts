/** Le pont de l'agent SSH (`src/lib/platform.ts`) vers les commandes de
 * `app-tauri/src/ssh_agent/` : posé seulement au bureau (les commandes
 * n'existent pas sur Android). Une demande de signature arrivée sans
 * personne pour la poser est refusée. */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { setSshAgentBridge, type SshAgentRequest } from "../../src/lib/platform";

type Question = { id: number; request: Omit<SshAgentRequest, "id"> };

export async function installSshAgent(): Promise<void> {
  const ok = await invoke("ssh_agent_status").then(() => true, () => false);
  if (!ok) return;
  const requests = new Set<(r: SshAgentRequest) => void>();
  const cancels = new Set<(id: number) => void>();
  const answer = (id: number, allow: boolean, remember: boolean) => invoke<void>("ssh_agent_answer", { id, decision: { allow, remember } });
  void listen<Question>("ssh-agent-confirm", (e) => {
    const r = { id: e.payload.id, ...e.payload.request };
    if (requests.size === 0) void answer(r.id, false, false);
    for (const h of requests) h(r);
  });
  void listen<number>("ssh-agent-cancel", (e) => {
    for (const h of cancels) h(e.payload);
  });
  setSshAgentBridge({
    status: () => invoke("ssh_agent_status"),
    start: () => invoke<{ running: boolean; endpoint: string }>("ssh_agent_start").catch((e) => {
      throw Object.assign(new Error(e === "agent_busy" ? "Le tube de l'agent OpenSSH est déjà pris : arrêtez le service « OpenSSH Authentication Agent » de Windows." : String(e)), { code: e === "agent_busy" ? "agent_busy" : undefined });
    }),
    stop: () => invoke<void>("ssh_agent_stop"),
    setKeys: (keys) => invoke("ssh_agent_set_keys", { keys }),
    onRequest(handler) {
      requests.add(handler);
      return () => requests.delete(handler);
    },
    onCancel(handler) {
      cancels.add(handler);
      return () => cancels.delete(handler);
    },
    answer,
  });
}
