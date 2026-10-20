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
