/** Le presse-papiers natif (`src/lib/platform.ts`) vers
 * `app-tauri/src/clipboard.rs` : posé seulement sous Windows. */
import { invoke } from "@tauri-apps/api/core";
import { setClipboardBridge } from "../../src/lib/platform";

export async function installClipboard(): Promise<void> {
  if (!(await invoke<boolean>("clipboard_native").catch(() => false))) return;
  setClipboardBridge({
    copySecret: (text, clearAfterMs) => invoke<void>("clipboard_copy_secret", { text, clearAfterMs }),
  });
}
