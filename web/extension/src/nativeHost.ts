/** Le coffre local de l'application GuiVault, depuis l'extension
 * (`docs/EXTENSION.md`, « Coffre local ») : par l'hôte natif
 * `dev.guivault.client` (l'exécutable de l'app, `app-tauri/src/native_host.rs`),
 * qui ne sert que des blobs — l'extension déchiffre elle-même, avec le mot
 * de passe maître, exactement comme face à un serveur (`localTransport`).
 *
 * Un canal durable (`connectNative`) : lancer l'hôte coûte plus d'une
 * seconde, une ouverture de coffre enchaîne plusieurs appels. Chaque réponse
 * arrive en parties (`{ id, part, of, data }`, le navigateur refuse plus de
 * 1 Mo par message), recollées ici. */
import type { LocalHost, LocalOp } from "../../src/lib/localHost";

export const NATIVE_HOST = "dev.guivault.client";

/** Ce que l'on montre quand l'hôte manque : c'est un réglage de l'app. */
const NOT_LINKED = "L'application GuiVault n'est pas reliée à ce navigateur : dans l'app, Paramètres › Application › « Extension de navigateur ».";

interface Pending {
  parts: string[];
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

let port: chrome.runtime.Port | null = null;
const pending = new Map<number, Pending>();
let nextId = 1;

function friendly(message: string | undefined): Error {
  if (!message || /not found|forbidden|introuvable/i.test(message)) return new Error(NOT_LINKED);
  if (/exited/i.test(message)) return new Error("L'hôte de l'application GuiVault s'est arrêté.");
  return new Error(message);
}

function connect(): chrome.runtime.Port {
  if (port) return port;
  const p = chrome.runtime.connectNative(NATIVE_HOST);
  p.onMessage.addListener((msg: { id: number; part: number; of: number; data: string }) => {
    const w = pending.get(msg.id);
    if (!w) return;
    w.parts[msg.part] = msg.data;
    if (w.parts.filter((x) => x !== undefined).length < msg.of) return;
    pending.delete(msg.id);
    try {
      const body = JSON.parse(w.parts.join("")) as { ok: boolean; value?: unknown; error?: unknown };
      if (body.ok) w.resolve(body.value);
      else w.reject(body.error);
    } catch (e) {
      w.reject(e);
    }
  });
  p.onDisconnect.addListener(() => {
    const e = friendly(chrome.runtime.lastError?.message);
    port = null;
    for (const w of pending.values()) w.reject(e);
    pending.clear();
  });
  port = p;
  return p;
}

function send(req: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { parts: [], resolve, reject });
    try {
      connect().postMessage({ id, ...req });
    } catch (e) {
      pending.delete(id);
      reject(friendly(e instanceof Error ? e.message : String(e)));
    }
  });
}

/** Les coffres que l'application a ouverts sur cet ordinateur : ceux que
 * l'hôte accepte d'ouvrir. */
export async function knownCoffres(): Promise<string[]> {
  return (await send({ op: "coffres" })) as string[];
}

/** L'hôte du coffre `path`, pour `localTransport` et `session.openLocal`. */
export function nativeCoffre(path: string): LocalHost {
  return {
    create: () => Promise.reject(new Error("Créer un coffre se fait dans l'application GuiVault.")),
    open: async () => {
      await send({ op: "open", path });
    },
    // Le canal sert à tous les coffres : rien à fermer ici.
    close: async () => {},
    call: (op: LocalOp, args: Record<string, unknown>) => send({ op: "call", path, call: op, args }),
  };
}

/** Le nom d'un coffre, d'après son dossier. */
export function coffreLabel(path: string): string {
  return (path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path).replace(/\.guivault$/i, "");
}
