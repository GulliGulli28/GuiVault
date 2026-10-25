/** « Bien démarrer », en tête de l'accueil tant qu'il reste une étape : ce
 * qu'un nouveau compte (ou un nouveau coffre) gagne à faire d'abord. Une
 * étape se coche d'elle-même quand l'interface sait la voir faite (des
 * éléments importés, la double authentification, la biométrie), sinon à la
 * main ; la carte se masque. Retenu par compte et par appareil
 * (`localStorage`) : rien n'en part au serveur. */
import { useEffect, useState } from "react";
import { api, supports } from "../lib/api";
import { localBiometricId, serverBiometricId, useBiometricState } from "../lib/biometric";
import { biometricBridge, coffreFileBridge } from "../lib/platform";
import { navigate, type Route } from "../lib/route";
import type { SessionState } from "../lib/session";
import { canWrite } from "../lib/types";
import { IconCheck, IconClose } from "./ui-icons";

const EXTENSION_DOC = "https://github.com/GulliGulli28/GuiVault/blob/main/docs/EXTENSION.md";

interface Stored {
  hidden?: boolean;
  done?: string[];
}

const storageKey = (s: SessionState) => `guivault.onboarding.${s.local ? `local:${s.local.path}` : s.user.id}`;

function load(s: SessionState): Stored {
  try {
    return JSON.parse(localStorage.getItem(storageKey(s)) ?? "{}") as Stored;
  } catch {
    return {};
  }
}

function save(s: SessionState, v: Stored) {
  try {
    localStorage.setItem(storageKey(s), JSON.stringify(v));
  } catch {
    // Navigation privée : la carte reviendra, rien de grave.
  }
}

interface Step {
  id: string;
  title: string;
  desc: string;
  /** Vu fait par l'interface : pas de case à cocher. */
  detected: boolean;
  action: { label: string; route?: Route; href?: string };
}

export function GettingStarted({ session, secrets, mobile }: { session: SessionState; secrets: number | null; mobile?: boolean }) {
  const [stored, setStored] = useState<Stored>(() => load(session));
  const [totp, setTotp] = useState<boolean | null>(null);
  const bio = useBiometricState(biometricBridge() ? (session.local ? localBiometricId(session.local.path) : serverBiometricId(session.user.id)) : null);
  useEffect(() => {
    if (!session.offline && supports("totpStatus")) api.totpStatus().then((s) => setTotp(s.enabled)).catch(() => setTotp(null));
  }, [session]);
  if (stored.hidden || secrets === null) return null;

  const target = session.vaults.find((v) => v.kind === "personal" && canWrite(v.role)) ?? session.vaults.find((v) => canWrite(v.role));
  const steps: Step[] = [];
  if (target && !session.offline) {
    steps.push({ id: "import", title: "Importer vos mots de passe", desc: "Bitwarden, KeePass, Chrome, Firefox, LastPass…", detected: secrets >= 5, action: { label: "Importer", route: { page: "vault-tools", id: target.id } } });
  }
  if (supports("totpStatus") && !session.offline) {
    steps.push({ id: "2fa", title: "Activer la double authentification", desc: "Un code en plus du mot de passe maître.", detected: totp === true, action: { label: "Activer", route: { page: "settings", section: "securite" } } });
  }
  if (biometricBridge() && bio !== undefined) {
    steps.push({ id: "bio", title: "Déverrouiller par biométrie", desc: "Empreinte ou visage, au lieu de taper le mot de passe.", detected: bio !== null, action: { label: "Activer", route: { page: "settings", section: "securite" } } });
  }
  if (session.local && coffreFileBridge()) {
    steps.push({ id: "export", title: "Exporter le coffre", desc: "Désinstaller l'application l'effacerait.", detected: false, action: { label: "Exporter", route: { page: "settings", section: "compte" } } });
  }
  steps.push({ id: "extension", title: "Installer l'extension de navigateur", desc: "Remplir les sites en un clic.", detected: false, action: { label: "Comment", href: EXTENSION_DOC } });
  if (session.vaults.some((v) => v.kind === "shared")) {
    const shared = session.vaults.find((v) => v.kind === "shared")!;
    steps.push({ id: "fingerprint", title: "Vérifier les empreintes de l'équipe", desc: "Par un autre canal, avant de partager.", detected: false, action: { label: "Voir", route: { page: "vault-settings", id: shared.id } } });
  }

  const doneIds = new Set(stored.done ?? []);
  const isDone = (s: Step) => s.detected || doneIds.has(s.id);
  const left = steps.filter((s) => !isDone(s)).length;
  if (left === 0) return null;
  const update = (v: Stored) => {
    setStored(v);
    save(session, v);
  };
  const mark = (id: string) => update({ ...stored, done: [...doneIds, id] });

  return (
    <section aria-labelledby="getting-started" className={`${mobile ? "m-card" : "card"} flex flex-col gap-1 px-4 pb-2 pt-3.5`}>
      <div className="flex items-center gap-2">
        <h2 id="getting-started" className="section-title min-w-0 flex-1 truncate">Bien démarrer</h2>
        <span className="text-[12.5px] text-[var(--c-text-muted)]">{steps.length - left} sur {steps.length}</span>
        <button onClick={() => update({ ...stored, hidden: true })} className="btn btn-ghost btn-icon btn-sm" title="Masquer" aria-label="Masquer « Bien démarrer »"><IconClose size={13} /></button>
      </div>
      <ul className="divide-y divide-[var(--c-border)]">
        {steps.map((s) => {
          const done = isDone(s);
          return (
            <li key={s.id} className="flex min-w-0 items-center gap-3 py-2.5">
              <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border ${done ? "border-transparent bg-[var(--c-ok)] text-white" : "border-[var(--c-border-strong)]"}`} aria-hidden="true">
                {done && <IconCheck size={13} />}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className={`truncate text-[13.5px] font-medium ${done ? "text-[var(--c-text-muted)] line-through" : ""}`}>{s.title}</span>
                {!done && <span className="truncate text-[12.5px] text-[var(--c-text-muted)]">{s.desc}</span>}
              </span>
              {!done && (
                <>
                  {!s.detected && <button onClick={() => mark(s.id)} className="btn btn-ghost btn-sm max-sm:hidden" title="C'est fait">C'est fait</button>}
                  {s.action.href
                    ? <a href={s.action.href} target="_blank" rel="noopener noreferrer" className="btn btn-secondary btn-sm hover:no-underline" onClick={() => mark(s.id)}>{s.action.label}</a>
                    : <button onClick={() => navigate(s.action.route!)} className="btn btn-secondary btn-sm">{s.action.label}</button>}
                </>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
