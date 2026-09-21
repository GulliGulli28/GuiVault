import { useCallback, useEffect, useState } from "react";
import { DEFAULT_GENERATOR, generate, type GeneratorOptions } from "../lib/generator";
import { DEFAULT_SSH_KEY, generateSshKey, type SshKeyOptions, type SshKeyPair } from "../lib/sshkey";
import { PasswordStrength } from "./PasswordStrength";
import { IconRefresh } from "./ui-icons";
import { CopyButton } from "./ui";

const KEY = "guivault.generator";

function loadOptions(): GeneratorOptions {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_GENERATOR;
    const o = JSON.parse(raw) as Partial<GeneratorOptions>;
    return { mode: o.mode === "passphrase" ? "passphrase" : "password", password: { ...DEFAULT_GENERATOR.password, ...o.password }, passphrase: { ...DEFAULT_GENERATOR.passphrase, ...o.passphrase } };
  } catch {
    return DEFAULT_GENERATOR;
  }
}

type Mode = GeneratorOptions["mode"] | "sshkey";

/** Le générateur : ses réglages (gardés dans le navigateur), la valeur
 * produite, copier ou reprendre. `onUse` ajoute un bouton « Utiliser » pour
 * l'insérer dans un formulaire ; `onUseKey` fait de même pour une clé SSH
 * (et, seul, restreint le panneau à ce mode). */
export function GeneratorPanel({ onUse, onUseKey, compact, initialMode }: { onUse?: (value: string) => void; onUseKey?: (key: SshKeyPair, options: SshKeyOptions) => void; compact?: boolean; initialMode?: Mode }) {
  const [opts, setOpts] = useState<GeneratorOptions>(loadOptions);
  const [value, setValue] = useState(() => generate(loadOptions()));
  const [mode, setMode] = useState<Mode>(initialMode ?? (onUseKey && !onUse ? "sshkey" : loadOptions().mode));

  const regenerate = useCallback((o: GeneratorOptions) => setValue(generate(o)), []);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(opts));
    } catch {
      // Sans stockage, les réglages valent pour la session.
    }
    regenerate(opts);
  }, [opts, regenerate]);

  const pw = opts.password;
  const pp = opts.passphrase;
  const setPw = (patch: Partial<typeof pw>) => setOpts({ ...opts, password: { ...pw, ...patch } });
  const setPp = (patch: Partial<typeof pp>) => setOpts({ ...opts, passphrase: { ...pp, ...patch } });
  const pick = (m: Mode) => {
    setMode(m);
    if (m !== "sshkey") setOpts({ ...opts, mode: m });
  };
  const lockedToKey = !!onUseKey && !onUse;

  return (
    <div className={compact ? "space-y-2.5" : "space-y-4"}>
      {!lockedToKey && (
        <div className="segmented">
          <button type="button" data-active={mode === "password"} onClick={() => pick("password")}>Mot de passe</button>
          <button type="button" data-active={mode === "passphrase"} onClick={() => pick("passphrase")}>Phrase de passe</button>
          {!onUse && <button type="button" data-active={mode === "sshkey"} onClick={() => pick("sshkey")}>Clé SSH</button>}
        </div>
      )}
      {mode === "sshkey" ? (
        <SshKeyGenerator compact={compact} onUse={onUseKey} />
      ) : (
        <>
      <div className="card p-3">
        <div className="flex items-start gap-2">
          <output className="min-w-0 flex-1 break-all font-mono text-[14px] leading-relaxed text-[var(--c-text)]" aria-live="polite">
            {Array.from(value).map((ch, i) => (
              <span key={i} style={{ color: /\d/.test(ch) ? "var(--c-accent-text)" : /[^A-Za-z0-9]/.test(ch) ? "var(--c-danger)" : undefined }}>{ch}</span>
            ))}
          </output>
          <button type="button" onClick={() => regenerate(opts)} className="btn btn-ghost btn-sm btn-icon" title="Regénérer" aria-label="Regénérer"><IconRefresh size={12} /></button>
          <CopyButton value={value} label="Copier" />
        </div>
        <div className="mt-2 flex items-center justify-between gap-2">
          <PasswordStrength password={value} />
          {onUse && <button type="button" onClick={() => onUse(value)} className="btn btn-primary btn-sm">Utiliser</button>}
        </div>
      </div>

      {mode === "password" ? (
        <div className="space-y-2.5">
          <label className="block">
            <span className="field-label">Longueur : {pw.length}</span>
            <input type="range" min={8} max={64} value={pw.length} onChange={(e) => setPw({ length: Number(e.target.value) })} className="w-full" />
          </label>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
            <Check label="Minuscules (a-z)" checked={pw.lowercase} onChange={(v) => setPw({ lowercase: v })} />
            <Check label="Majuscules (A-Z)" checked={pw.uppercase} onChange={(v) => setPw({ uppercase: v })} />
            <Check label="Chiffres (0-9)" checked={pw.digits} onChange={(v) => setPw({ digits: v })} />
            <Check label="Symboles (!@#$…)" checked={pw.symbols} onChange={(v) => setPw({ symbols: v })} />
            <Check label="Éviter les ambigus (l, 1, I, O, 0)" checked={pw.avoidAmbiguous} onChange={(v) => setPw({ avoidAmbiguous: v })} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="block"><span className="field-label">Chiffres minimum</span><input type="number" min={0} max={10} value={pw.minDigits} disabled={!pw.digits} onChange={(e) => setPw({ minDigits: Number(e.target.value) })} className="input" /></label>
            <label className="block"><span className="field-label">Symboles minimum</span><input type="number" min={0} max={10} value={pw.minSymbols} disabled={!pw.symbols} onChange={(e) => setPw({ minSymbols: Number(e.target.value) })} className="input" /></label>
          </div>
        </div>
      ) : (
        <div className="space-y-2.5">
          <label className="block">
            <span className="field-label">Mots : {pp.words}</span>
            <input type="range" min={3} max={12} value={pp.words} onChange={(e) => setPp({ words: Number(e.target.value) })} className="w-full" />
          </label>
          <label className="block"><span className="field-label">Séparateur</span><input value={pp.separator} maxLength={3} onChange={(e) => setPp({ separator: e.target.value })} className="input input-mono w-20" /></label>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
            <Check label="Majuscule initiale" checked={pp.capitalize} onChange={(v) => setPp({ capitalize: v })} />
            <Check label="Ajouter un chiffre" checked={pp.includeNumber} onChange={(v) => setPp({ includeNumber: v })} />
          </div>
          <p className="help-text">Mots tirés de la grande liste de l'EFF (7 776 mots, ≈ 12,9 bits par mot).</p>
        </div>
      )}
        </>
      )}
    </div>
  );
}

const SSH_KEY = "guivault.sshkey";

function loadSshOptions(): SshKeyOptions {
  try {
    const raw = localStorage.getItem(SSH_KEY);
    return raw ? { ...DEFAULT_SSH_KEY, ...(JSON.parse(raw) as Partial<SshKeyOptions>) } : DEFAULT_SSH_KEY;
  } catch {
    return DEFAULT_SSH_KEY;
  }
}

/** Une paire de clés SSH : type, taille, commentaire ; la privée à copier ou
 * à utiliser, la publique (ligne `authorized_keys`) et l'empreinte à
 * donner aux serveurs. */
export function SshKeyGenerator({ compact, onUse }: { compact?: boolean; onUse?: (key: SshKeyPair, options: SshKeyOptions) => void }) {
  const [opts, setOpts] = useState<SshKeyOptions>(loadSshOptions);
  const [key, setKey] = useState<SshKeyPair | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (o: SshKeyOptions) => {
    setBusy(true);
    setError(null);
    try {
      setKey(await generateSshKey(o));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(SSH_KEY, JSON.stringify(opts));
    } catch {
      // idem
    }
  }, [opts]);

  // Une clé dès l'ouverture, comme le mot de passe.
  useEffect(() => {
    void run(loadSshOptions());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = (patch: Partial<SshKeyOptions>) => setOpts({ ...opts, ...patch });
  const sizes = opts.type === "rsa" ? [2048, 3072, 4096] : opts.type === "ecdsa" ? [256, 384] : [];

  return (
    <div className={compact ? "space-y-2.5" : "space-y-3"}>
      <div className="grid grid-cols-[1fr_auto] gap-2">
        <label className="block">
          <span className="field-label">Type</span>
          <select value={opts.type} onChange={(e) => { const type = e.target.value as SshKeyOptions["type"]; set({ type, bits: type === "rsa" ? 3072 : 256 }); }} className="input">
            <option value="ed25519">Ed25519 (recommandé)</option>
            <option value="rsa">RSA</option>
            <option value="ecdsa">ECDSA</option>
          </select>
        </label>
        {sizes.length > 0 && (
          <label className="block">
            <span className="field-label">Taille</span>
            <select value={opts.bits} onChange={(e) => set({ bits: Number(e.target.value) })} className="input w-24">
              {sizes.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </label>
        )}
      </div>
      <label className="block">
        <span className="field-label">Commentaire</span>
        <input value={opts.comment} onChange={(e) => set({ comment: e.target.value })} placeholder="alice@portable" className="input input-mono" />
      </label>
      <div className="flex items-center justify-between gap-2">
        <span className="help-text">Sans passphrase : c'est le coffre qui protège la clé. Ed25519 est court, rapide et sans paramètre à choisir.</span>
        <button type="button" onClick={() => void run(opts)} disabled={busy} className="btn btn-secondary btn-sm shrink-0"><IconRefresh size={12} /> {busy ? "Génération…" : key ? "Regénérer" : "Générer"}</button>
      </div>
      {error && <p className="callout callout-danger">{error}</p>}
      {key && (
        <div className="card space-y-2 p-3">
          <div className="flex items-start gap-2">
            <span className="min-w-0 flex-1">
              <span className="block text-[11px] font-medium text-[var(--c-text-secondary)]">Clé publique ({key.type})</span>
              <code className="block break-all font-mono text-[11px] leading-snug text-[var(--c-text)]">{key.publicKey.trim()}</code>
            </span>
            <CopyButton value={key.publicKey} label="Copier la clé publique" />
          </div>
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1">
              <span className="block text-[11px] font-medium text-[var(--c-text-secondary)]">Empreinte</span>
              <code className="block break-all font-mono text-[11px] text-[var(--c-text)]">{key.fingerprint}</code>
            </span>
            <CopyButton value={key.fingerprint} label="Copier l'empreinte" />
          </div>
          <div className="flex items-center justify-end gap-1.5 border-t border-[var(--c-border)] pt-2">
            <CopyButton value={key.privateKey} label="Copier la clé privée" />
            <span className="mr-auto text-[11px] text-[var(--c-text-muted)]">clé privée</span>
            {onUse && <button type="button" onClick={() => onUse(key, opts)} className="btn btn-primary btn-sm">Utiliser</button>}
          </div>
        </div>
      )}
    </div>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-[var(--c-text)]">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export function GeneratorPage() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-[var(--c-border)] px-4 py-2.5 max-md:pl-11">
        <h1 className="text-[14px] font-semibold text-[var(--c-text)]">Générateur</h1>
      </header>
      <div className="sidebar-scroll min-h-0 flex-1 overflow-y-auto p-4">
        <div className="max-w-xl">
          <GeneratorPanel />
        </div>
      </div>
    </div>
  );
}
