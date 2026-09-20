import { useCallback, useEffect, useState } from "react";
import { DEFAULT_GENERATOR, generate, type GeneratorOptions } from "../lib/generator";
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

/** Le générateur : ses réglages (gardés dans le navigateur), la valeur
 * produite, copier ou reprendre. `onUse` ajoute un bouton « Utiliser » pour
 * l'insérer dans un formulaire. */
export function GeneratorPanel({ onUse, compact }: { onUse?: (value: string) => void; compact?: boolean }) {
  const [opts, setOpts] = useState<GeneratorOptions>(loadOptions);
  const [value, setValue] = useState(() => generate(loadOptions()));

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

  return (
    <div className={compact ? "space-y-2.5" : "space-y-4"}>
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

      <div className="segmented">
        <button type="button" data-active={opts.mode === "password"} onClick={() => setOpts({ ...opts, mode: "password" })}>Mot de passe</button>
        <button type="button" data-active={opts.mode === "passphrase"} onClick={() => setOpts({ ...opts, mode: "passphrase" })}>Phrase de passe</button>
      </div>

      {opts.mode === "password" ? (
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
      <header className="flex shrink-0 items-center gap-2 border-b border-[var(--c-border)] px-4 py-2.5 max-md:pl-28">
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
