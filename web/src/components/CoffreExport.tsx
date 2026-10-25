/** Exporter le coffre local ouvert en une archive (`platform.ts` ›
 * `CoffreFileBridge`, Android) : Paramètres › Compte › Sauvegardes. */
import { useState } from "react";
import { errorMessage } from "../lib/api";
import { coffreFileBridge } from "../lib/platform";
import { InfoTip, SettingRow } from "./ui";

export function CoffreExport({ path, onDone, onError }: { path: string; onDone: (name: string) => void; onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  const bridge = coffreFileBridge();
  if (!bridge) return null;
  const run = async () => {
    setBusy(true);
    try {
      const name = await bridge.exportArchive(path);
      if (name) onDone(name);
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card">
      <SettingRow
        title={<>Exporter le coffre <InfoTip label="Pourquoi exporter" items={[
          { text: "Désinstaller l'application efface ses coffres.", tone: "warn" },
          { text: "L'archive est chiffrée : sans le mot de passe maître, illisible.", tone: "ok" },
          { text: "Elle s'importe ici, ou s'ouvre au bureau une fois décompressée." },
          { text: "Les sauvegardes de l'appareil n'y sont pas." },
        ]} /></>}
        desc="Une archive .zip à ranger hors du téléphone."
      >
        <button onClick={() => void run()} disabled={busy} className="btn btn-secondary">{busy ? "Export…" : "Exporter…"}</button>
      </SettingRow>
    </div>
  );
}
