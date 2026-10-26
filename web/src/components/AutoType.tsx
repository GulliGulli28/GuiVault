/** La saisie automatique dans l'interface (`lib/autotype.ts`) : seulement
 * quand l'application l'offre (`autoTypeBridge()`), rien dans le web.
 *
 * - `AutoTypeHost` répond au raccourci global : un seul identifiant pour la
 *   fenêtre, il est tapé tout de suite ; sinon GuiVault revient au premier
 *   plan avec un choix (et une recherche dans tous les identifiants).
 * - `performAutoType` : « Saisie automatique » sur une fiche.
 * - `AutoTypeFields` : la section du formulaire d'un identifiant.
 * - `AutoTypeSettings` : Paramètres › Saisie automatique. */
import { useReprompt } from "./Reprompt";
import { needsReprompt } from "../lib/reprompt";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PageContext } from "../App";
import { errorMessage } from "../lib/api";
import { DEFAULT_SEQUENCE, loadAutoTypeSettings, matchWindow, resolveSequence, saveAutoTypeSettings, sequenceError, sequenceOf, type AutoTypeMatch } from "../lib/autotype";
import { autoTypeBridge, type AutoTypeRequest } from "../lib/platform";
import { loadItems, type VaultView } from "../lib/session";
import { touchWebSession } from "../lib/persist";
import type { AutoType, Login } from "../lib/types";
import { Eyebrow, Field, Modal } from "./ui";
import { IconClose, IconPlus } from "./ui-icons";
import { t } from "../lib/i18n";

interface Candidate {
  vault: VaultView;
  login: Login;
}

/** Tous les identifiants des vaults de la session, déchiffrés. Relus à
 * chaque demande : une saisie automatique ne doit pas taper un mot de passe
 * d'avant sa dernière modification. */
async function allLogins(vaults: VaultView[], onError: (m: string) => void): Promise<Candidate[]> {
  const out: Candidate[] = [];
  await Promise.all(
    vaults.map(async (vault) => {
      try {
        for (const it of (await loadItems(vault)).items) {
          if (it.ok && it.payload.kind === "login") out.push({ vault, login: it.payload.login });
        }
      } catch (e) {
        onError(`${vault.name} : ${errorMessage(e)}`);
      }
    }),
  );
  return out;
}

/** Résout puis tape. Les erreurs (séquence, champ manquant, focus perdu)
 * remontent telles quelles. */
async function typeLogin(login: Login, sequence: string, target?: string) {
  const bridge = autoTypeBridge();
  if (!bridge) throw new Error(t("La saisie automatique n'est disponible que dans l'application."));
  await bridge.type(await resolveSequence(sequence, login), target);
}

/** « Saisie automatique » sur une fiche : GuiVault se réduit, et la
 * séquence est tapée dans la fenêtre qui reprend le premier plan. */
export async function performAutoType(login: Login): Promise<void> {
  await typeLogin(login, sequenceOf(login.autoType, loadAutoTypeSettings().defaultSequence));
}

export function AutoTypeHost({ ctx }: { ctx: PageContext }) {
  const [picker, setPicker] = useState<{ request: AutoTypeRequest; matches: AutoTypeMatch<Candidate>[]; all: Candidate[] } | null>(null);
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  // Un identifiant protégé (`reprompt`) : GuiVault revient au premier plan
  // et demande le mot de passe maître avant de taper.
  const ask = useReprompt();
  const askRef = useRef(ask);
  askRef.current = ask;

  useEffect(() => {
    const bridge = autoTypeBridge();
    if (!bridge) return;
    return bridge.onRequest((request) => {
      // Se servir du raccourci, c'est se servir de GuiVault : le délai
      // d'inactivité repart.
      touchWebSession();
      void (async () => {
        const { session, error } = ctxRef.current;
        const all = await allLogins(session.vaults, error);
        const matches = matchWindow(request.title, all, (c) => c.login, loadAutoTypeSettings().defaultSequence);
        if (matches.length === 1) {
          const login = matches[0].item.login;
          if (needsReprompt({ kind: "login", login })) {
            await bridge.focusApp();
            if (!(await askRef.current({ kind: "login", login }))) return;
          }
          try {
            await typeLogin(login, matches[0].sequence, request.target);
          } catch (e) {
            await bridge.focusApp();
            error(t("Saisie automatique : {0}", errorMessage(e)));
          }
          return;
        }
        setPicker({ request, matches, all });
        await bridge.focusApp();
      })();
    });
  }, []);

  const close = useCallback(() => setPicker(null), []);
  if (!picker) return null;
  return (
    <AutoTypePicker
      request={picker.request}
      matches={picker.matches}
      all={picker.all}
      onClose={close}
      onPick={(c, sequence) => {
        setPicker(null);
        void ask({ kind: "login", login: c.login }).then((go) => {
          if (go) typeLogin(c.login, sequence, picker.request.target).catch((e) => ctx.error(t("Saisie automatique : {0}", errorMessage(e))));
        });
      }}
    />
  );
}

function AutoTypePicker({ request, matches, all, onClose, onPick }: {
  request: AutoTypeRequest;
  matches: AutoTypeMatch<Candidate>[];
  all: Candidate[];
  onClose: () => void;
  onPick: (c: Candidate, sequence: string) => void;
}) {
  const [query, setQuery] = useState("");
  const defaultSequence = loadAutoTypeSettings().defaultSequence;
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return matches.map((m) => ({ c: m.item, sequence: m.sequence }));
    return all
      .filter((c) => c.login.autoType?.enabled !== false && (c.login.name.toLowerCase().includes(q) || c.login.username.toLowerCase().includes(q)))
      .slice(0, 30)
      .map((c) => ({ c, sequence: sequenceOf(c.login.autoType, defaultSequence) }));
  }, [query, matches, all, defaultSequence]);
  return (
    <Modal title={t("Saisie automatique")} onClose={onClose}>
      <div className="space-y-3">
        <p className="text-[12.5px] text-[var(--c-text-secondary)]">
          {t("Pour la fenêtre")} <span className="font-medium text-[var(--c-text)]">« {request.title || t("sans titre")} »</span>
          {matches.length === 0 ? t(" : aucun identifiant ne correspond. Cherchez-en un.") : ` : ${matches.length} identifiants correspondent.`}
        </p>
        <input value={query} onChange={(e) => setQuery(e.target.value)} autoFocus placeholder={t("Chercher un identifiant…")} aria-label={t("Chercher un identifiant")} className="input" />
        <ul className="max-h-72 overflow-y-auto">
          {shown.map(({ c, sequence }) => (
            <li key={`${c.vault.id}/${c.login.id}`}>
              <button onClick={() => onPick(c, sequence)} className="list-row w-full py-1.5 text-left">
                <span className="flex min-w-0 flex-1 flex-col leading-tight">
                  <span className="truncate text-[12.5px] text-[var(--c-text)]">{c.login.name}</span>
                  <span className="truncate text-[11px] text-[var(--c-text-muted)]">{c.login.username || "—"} · {c.vault.name}</span>
                </span>
              </button>
            </li>
          ))}
          {shown.length === 0 && <li className="px-2 py-1.5 text-[12px] text-[var(--c-text-muted)]">{t("Aucun identifiant.")}</li>}
        </ul>
        <p className="help-text">{t("Choisi, il est tapé dans cette fenêtre — GuiVault se réduit d'abord.")}</p>
      </div>
    </Modal>
  );
}

/** La section « Saisie automatique » du formulaire d'un identifiant. */
export function AutoTypeFields({ value, onChange }: { value: AutoType | undefined; onChange: (v: AutoType | undefined) => void }) {
  const at = value ?? {};
  const defaultSequence = loadAutoTypeSettings().defaultSequence;
  const set = (patch: Partial<AutoType>) => {
    const next: AutoType = { ...at, ...patch };
    for (const k of ["enabled", "sequence", "windows"] as const) if (next[k] === undefined) delete next[k];
    onChange(Object.keys(next).length ? next : undefined);
  };
  const windows = at.windows ?? [];
  const setWindow = (i: number, patch: { title?: string; sequence?: string }) =>
    set({
      windows: windows.map((w, j) => {
        if (j !== i) return w;
        const next = { ...w, ...patch };
        if (!next.sequence) delete next.sequence;
        return next;
      }),
    });
  const seqError = at.sequence ? sequenceError(at.sequence) : null;
  return (
    <section className="space-y-2">
      <Eyebrow>{t("Saisie automatique")}</Eyebrow>
      <label className="flex items-center gap-2 text-[12.5px] text-[var(--c-text)]">
        <input type="checkbox" checked={at.enabled !== false} onChange={(e) => set({ enabled: e.target.checked ? undefined : false })} />
        {t("Le taper dans une autre fenêtre (raccourci global, ou depuis la fiche)")}
      </label>
      {at.enabled !== false && (
        <>
          <Field label={t("Séquence")} hint={t("Vide : celle de l'application, {0}. Champs et touches : Paramètres › Saisie automatique.", defaultSequence)}>
            <input value={at.sequence ?? ""} onChange={(e) => set({ sequence: e.target.value || undefined })} placeholder={defaultSequence} spellCheck={false} className="input input-mono" />
          </Field>
          {seqError && <p className="help-text text-[var(--c-warn)]">{seqError}</p>}
          <div role="group" aria-label={t("Fenêtres associées")} className="space-y-1.5">
            <span className="field-label">{t("Fenêtres associées")}</span>
            {windows.map((w, i) => (
              <div key={i} className="flex gap-1.5">
                <input value={w.title} onChange={(e) => setWindow(i, { title: e.target.value })} placeholder="*Connexion*Firefox" aria-label={t("Titre de la fenêtre {0}", i + 1)} className="input min-w-0 flex-1" />
                <input value={w.sequence ?? ""} onChange={(e) => setWindow(i, { sequence: e.target.value })} placeholder={t("séquence (facultatif)")} aria-label={t("Séquence pour la fenêtre {0}", i + 1)} spellCheck={false} className="input input-mono min-w-0 flex-1" />
                <button type="button" onClick={() => set({ windows: windows.filter((_, j) => j !== i).length ? windows.filter((_, j) => j !== i) : undefined })} className="btn btn-ghost btn-sm btn-icon" aria-label={t("Retirer la fenêtre {0}", i + 1)}><IconClose size={11} /></button>
              </div>
            ))}
            <button type="button" onClick={() => set({ windows: [...windows, { title: "" }] })} className="btn btn-ghost btn-sm"><IconPlus size={11} /> {t("Ajouter une fenêtre")}</button>
          </div>
          <p className="help-text">{t("Proposé pour une fenêtre dont le titre contient son nom, son domaine, ou un de ces motifs (* : n'importe quoi).")}</p>
        </>
      )}
    </section>
  );
}

/** Paramètres › Saisie automatique (cet appareil). */
export function AutoTypeSettings({ notify }: { notify: (m: string) => void }) {
  const [settings, setSettings] = useState(loadAutoTypeSettings);
  const [hotkey, setHotkey] = useState(settings.hotkey);
  const [hotkeyError, setHotkeyError] = useState<string | null>(null);
  const [sequence, setSequence] = useState(settings.defaultSequence);
  const seqError = sequenceError(sequence);

  const applyHotkey = async (value: string) => {
    const bridge = autoTypeBridge();
    if (!bridge) return;
    setHotkeyError(null);
    try {
      await bridge.setHotkey(value.trim());
      const next = { ...settings, hotkey: value.trim() };
      setSettings(next);
      saveAutoTypeSettings(next);
      notify(value.trim() ? t("Raccourci global : {0}", value.trim()) : t("Raccourci global désactivé."));
    } catch (e) {
      setHotkeyError(errorMessage(e));
    }
  };

  return (
    <section className="max-w-2xl space-y-4">
      <div className="card space-y-3 p-3">
        <div>
          <label htmlFor="autotype-hotkey" className="text-[12.5px] text-[var(--c-text)]">{t("Raccourci global")}</label>
          <p className="help-text">{t("Dans n'importe quelle fenêtre, GuiVault tape l'identifiant qui correspond.")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <input id="autotype-hotkey" value={hotkey} onChange={(e) => setHotkey(e.target.value)} placeholder={t("Ctrl+Alt+A")} spellCheck={false} className="input input-mono w-48" />
          <button onClick={() => void applyHotkey(hotkey)} disabled={hotkey.trim() === settings.hotkey} className="btn btn-secondary btn-sm">{t("Appliquer")}</button>
          {settings.hotkey && <button onClick={() => { setHotkey(""); void applyHotkey(""); }} className="btn btn-ghost btn-sm">{t("Désactiver")}</button>}
        </div>
        {hotkeyError && <p className="callout callout-danger">{hotkeyError}</p>}
      </div>

      <div className="card space-y-2 p-3">
        <div>
          <label htmlFor="autotype-sequence" className="text-[12.5px] text-[var(--c-text)]">{t("Séquence par défaut")}</label>
          <p className="help-text">{t("Celle des identifiants qui n'en ont pas.")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <input id="autotype-sequence" value={sequence} onChange={(e) => setSequence(e.target.value)} spellCheck={false} className="input input-mono min-w-0 flex-1" />
          <button
            onClick={() => { const next = { ...settings, defaultSequence: sequence }; setSettings(next); saveAutoTypeSettings(next); notify(t("Séquence par défaut enregistrée.")); }}
            disabled={!!seqError || sequence === settings.defaultSequence}
            className="btn btn-secondary btn-sm"
          >
            {t("Enregistrer")}
          </button>
          {sequence !== DEFAULT_SEQUENCE && <button onClick={() => setSequence(DEFAULT_SEQUENCE)} className="btn btn-ghost btn-sm">{t("Par défaut")}</button>}
        </div>
        {seqError && <p className="help-text text-[var(--c-warn)]">{seqError}</p>}
      </div>

      <div className="space-y-1.5">
        <Eyebrow>{t("Séquences")}</Eyebrow>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px]">
          <dt className="font-mono text-[var(--c-text)]">{t("{USERNAME} {PASSWORD}")}</dt><dd className="text-[var(--c-text-secondary)]">{t("l'utilisateur, le mot de passe")}</dd>
          <dt className="font-mono text-[var(--c-text)]">{t("{TITLE} {URL} {NOTES}")}</dt><dd className="text-[var(--c-text-secondary)]">{t("le nom, la première adresse, les notes")}</dd>
          <dt className="font-mono text-[var(--c-text)]">{"{TOTP}"}</dt><dd className="text-[var(--c-text-secondary)]">{t("le code à usage unique du moment")}</dd>
          <dt className="font-mono text-[var(--c-text)]">{"{S:nom}"}</dt><dd className="text-[var(--c-text-secondary)]">{t("un champ personnalisé")}</dd>
          <dt className="font-mono text-[var(--c-text)]">{t("{TAB} {ENTER} {SPACE} {ESC}")}</dt><dd className="text-[var(--c-text-secondary)]">{t("des touches — aussi")} {t("{BACKSPACE} {DELETE} {UP} {DOWN} {LEFT} {RIGHT} {HOME} {END} {PGUP} {PGDN}")} ; {t("{TAB 3}")} {t("répète")}</dd>
          <dt className="font-mono text-[var(--c-text)]">{t("{DELAY 500}")}</dt><dd className="text-[var(--c-text-secondary)]">{t("une pause, en millisecondes")}</dd>
          <dt className="font-mono text-[var(--c-text)]">{"{{} {}}"}</dt><dd className="text-[var(--c-text-secondary)]">{t("les accolades elles-mêmes ; le reste est tapé tel quel")}</dd>
        </dl>
        <p className="help-text">{t("S'arrête si la fenêtre perd le focus : rien n'est tapé ailleurs.")}</p>
      </div>
    </section>
  );
}
