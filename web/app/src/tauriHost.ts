/** L'hôte du coffre local dans l'app : les commandes Tauri de
 * `app-tauri/src/main.rs`, qui passent tout à `guivault_local::rpc`. Une
 * erreur arrive telle que le serveur l'aurait rendue (`{ status, code,
 * message, … }`) — `localHost.ts` en refait une `ApiError`. */
import { invoke } from "@tauri-apps/api/core";
import type { LocalHost } from "../../src/lib/localHost";

export const tauriHost: LocalHost = {
  create: (path, coffre) => invoke("local_create", { path, coffre }),
  open: (path) => invoke("local_open", { path }),
  close: () => invoke("local_close"),
  call: (op, args) => invoke("local_call", { op, args }),
};

/** Le pair : un second coffre ouvert à côté de la session, pour la
 * synchroniser avec sa copie (`coffreSync.ts`). On n'en crée pas. */
export const tauriPeerHost: LocalHost = {
  create: () => Promise.reject({ status: 400, code: "local_unsupported", message: "on ne crée pas de coffre ici" }),
  open: (path) => invoke("peer_open", { path }),
  close: () => invoke("peer_close"),
  call: (op, args) => invoke("peer_call", { op, args }),
};
