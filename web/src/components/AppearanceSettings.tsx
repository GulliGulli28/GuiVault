import { useEffect, useState } from "react";
import {
  ACCENT_COLORS, BG_THEMES, bgThemeLabel, applyPreferences, hostGroupMetrics, hostRowMetrics, loadPreferences, resolvedMode, savePreferences,
  HOST_GROUP_ICON_MAX, HOST_GROUP_ICON_MIN, HOST_GROUP_SIZE_MAX, HOST_GROUP_SIZE_MIN, HOST_ROW_ICON_MAX, HOST_ROW_ICON_MIN, HOST_ROW_SIZE_MAX, HOST_ROW_SIZE_MIN,
  UI_FONT_FAMILIES, type AppPreferences, type ColorModeChoice, type UiAccent, type UiBg,
} from "../lib/preferences";
import { onSettingsApplied, setSettingsSyncEnabled, settingsChanged, settingsSyncEnabled } from "../lib/syncedSettings";
import { EntityRow, EntityMono, EntityTags, GroupRow } from "./EntityRow";
import { IconLogin } from "./secret-icons";
import { IconCheck, IconFolder, IconMonitor, IconMoon, IconSun } from "./ui-icons";

/** Synchroniser ou non les réglages de cet appareil avec le compte — un
 * choix propre à l'appareil. */
export function SettingsSyncToggle() {
  const [on, setOn] = useState(settingsSyncEnabled);
  return (
    <div>
      <label className="flex cursor-pointer items-start gap-2 text-[12.5px] text-[var(--c-text)]">
        <input type="checkbox" checked={on} onChange={(e) => { setOn(e.target.checked); setSettingsSyncEnabled(e.target.checked); }} className="mt-0.5" />
        <span>Synchroniser les réglages entre mes appareils</span>
      </label>
      <p className="help-text pl-[22px]">Apparence, générateur, remplissage de l'extension : chiffrés avec votre compte, retrouvés sur chaque appareil où vous vous connectez. Le délai de verrouillage reste propre à chaque appareil.</p>
    </div>
  );
}

/** La section « Apparence » des paramètres de Guiterm, telle quelle : mode,
 * fond, accent, police, tailles des lignes d'entité et de dossier. Les
 * réglages s'appliquent à la frappe et se retiennent dans ce navigateur.
 * `compact` pour le popup de l'extension : les mêmes réglages, sans les
 * aperçus de ligne, en une colonne. */
export function AppearanceSettings({ compact = false }: { compact?: boolean }) {
  const [prefs, setPrefs] = useState<AppPreferences>(loadPreferences);
  const update = (next: AppPreferences) => {
    setPrefs(next);
    savePreferences(next);
    applyPreferences(next);
    settingsChanged("appearance");
  };
  // Changés depuis un autre appareil pendant qu'on regarde.
  useEffect(() => onSettingsApplied(() => setPrefs(loadPreferences())), []);
  const mode = resolvedMode(prefs.colorMode);
  const modes: [ColorModeChoice, string, typeof IconMoon][] = [["dark", "Sombre", IconMoon], ["light", "Clair", IconSun], ["system", "Système", IconMonitor]];

  return (
    <div className={compact ? "space-y-4" : "space-y-6"}>
      <section className="space-y-2">
        <p className="eyebrow">Mode d'affichage</p>
        <div className="segmented">
          {modes.map(([m, label, Icon]) => (
            <button
              key={m}
              type="button"
              onClick={() => update({ ...prefs, colorMode: m })}
              data-active={prefs.colorMode === m ? "true" : undefined}
              className={`flex items-center justify-center gap-1.5 ${compact ? "min-w-[4.5rem]" : "min-w-[6rem]"}`}
            >
              <Icon size={13} /> {label}
            </button>
          ))}
        </div>
      </section>

      <section className="space-y-2">
        <p className="eyebrow">Fond de l'interface</p>
        {/* Un échantillon par fond : les trois tons de surface tels qu'ils se
            superposent, pas une pilule colorée. Les fonds clairs ont leur
            teinte et leur nom propres — ce ne sont pas les fonds sombres
            éclaircis. */}
        <div className="flex flex-wrap gap-2">
          {(Object.entries(BG_THEMES) as [UiBg, typeof BG_THEMES[UiBg]][]).map(([key, bg]) => {
            const active = prefs.uiBg === key;
            const shade = bg[mode];
            return (
              <button
                key={key}
                type="button"
                title={bgThemeLabel(bg, mode)}
                aria-pressed={active}
                onClick={() => update({ ...prefs, uiBg: key })}
                className={`flex w-[4.5rem] flex-col items-center gap-1.5 rounded-md p-1.5 transition-colors ${active ? "bg-[var(--c-accent-dim)]" : "hover:bg-[var(--c-hover)]"}`}
              >
                <span
                  className={`flex h-9 w-full overflow-hidden rounded border ${active ? "border-[var(--c-accent)]" : "border-[var(--c-border-strong)]"}`}
                  style={{ backgroundColor: shade.bg }}
                >
                  <span className="h-full w-1/3" style={{ backgroundColor: shade.bg2, borderRight: `1px solid ${shade.border}` }} />
                  <span className="m-1.5 h-2.5 flex-1 rounded-sm" style={{ backgroundColor: shade.bg3 }} />
                </span>
                <span className={`text-[11px] ${active ? "font-medium text-[var(--c-text)]" : "text-[var(--c-text-secondary)]"}`}>{bgThemeLabel(bg, mode)}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="space-y-2">
        <p className="eyebrow">Couleur d'accent</p>
        <div className="flex flex-wrap items-center gap-2">
          {(Object.entries(ACCENT_COLORS) as [UiAccent, typeof ACCENT_COLORS[UiAccent]][]).map(([key, color]) => {
            const active = prefs.uiAccent === key;
            return (
              <button
                key={key}
                type="button"
                title={color.label}
                aria-label={color.label}
                aria-pressed={active}
                onClick={() => update({ ...prefs, uiAccent: key })}
                className={`flex h-7 w-7 items-center justify-center rounded-full text-white transition-transform hover:scale-110 ${active ? "ring-2 ring-[var(--c-text)] ring-offset-2 ring-offset-[var(--c-bg2)]" : ""}`}
                style={{ backgroundColor: color.c600 }}
              >
                {active && <IconCheck size={13} />}
              </button>
            );
          })}
          {/* N'importe quelle couleur : le sélecteur natif, derrière une
              pastille qui montre la couleur choisie. Choisir dans le
              sélecteur active la couleur libre. */}
          <label
            title="Couleur personnalisée"
            className={`relative flex h-7 w-7 cursor-pointer items-center justify-center rounded-full text-white transition-transform hover:scale-110 ${prefs.uiAccent === "custom" ? "ring-2 ring-[var(--c-text)] ring-offset-2 ring-offset-[var(--c-bg2)]" : ""}`}
            style={{ background: prefs.uiAccent === "custom" ? prefs.uiAccentCustom : "conic-gradient(#ef4444, #f59e0b, #22c55e, #06b6d4, #2563eb, #a855f7, #ef4444)" }}
          >
            <input
              type="color"
              value={prefs.uiAccentCustom}
              onChange={(e) => update({ ...prefs, uiAccent: "custom", uiAccentCustom: e.target.value })}
              aria-label="Couleur personnalisée"
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            />
            {prefs.uiAccent === "custom" && <IconCheck size={13} />}
          </label>
          <span className="ml-1 flex items-center gap-2 text-[12px] text-[var(--c-text-secondary)]">
            {prefs.uiAccent === "custom"
              ? <><span>Personnalisée</span><span className="kbd">{prefs.uiAccentCustom.toUpperCase()}</span></>
              : ACCENT_COLORS[prefs.uiAccent].label}
          </span>
        </div>
      </section>

      <section className="space-y-2">
        <p className="eyebrow">Police de l'interface</p>
        <select
          value={prefs.uiFontFamily}
          onChange={(e) => update({ ...prefs, uiFontFamily: e.target.value })}
          aria-label="Police de l'interface"
          className="input w-full max-w-xs"
        >
          {UI_FONT_FAMILIES.map((f) => (
            <option key={f.value} value={f.value}>{f.label}</option>
          ))}
        </select>
        {!compact && <p className="help-text">Les valeurs (adresses, mots de passe, clés) restent en JetBrains Mono, comme dans Guiterm.</p>}
      </section>

      <section className="space-y-3">
        <p className="eyebrow">Lignes de la liste</p>
        <div className={`grid gap-4 ${compact ? "grid-cols-2" : "max-w-md grid-cols-2"}`}>
          <Slider
            label="Texte"
            value={prefs.hostRowSize}
            shown={hostRowMetrics(prefs.hostRowSize, prefs.hostRowIconSize).font}
            min={HOST_ROW_SIZE_MIN}
            max={HOST_ROW_SIZE_MAX}
            step={0.5}
            aria="Taille du texte des lignes"
            onChange={(v) => update({ ...prefs, hostRowSize: v })}
          />
          <Slider
            label="Icône"
            value={prefs.hostRowIconSize}
            shown={hostRowMetrics(prefs.hostRowSize, prefs.hostRowIconSize).icon}
            min={HOST_ROW_ICON_MIN}
            max={HOST_ROW_ICON_MAX}
            step={1}
            aria="Taille de l'icône des lignes"
            onChange={(v) => update({ ...prefs, hostRowIconSize: v })}
          />
        </div>
        {!compact && (
          <>
            {/* Une vraie ligne, aux tailles réglées — le même composant que
                dans les listes, pas une imitation. */}
            <div className="card max-w-md px-2 py-1.5">
              <EntityRow
                icon={<IconLogin size={13} />}
                title="GitHub"
                secondary={<><EntityMono>alice@github.com</EntityMono><EntityTags tags={["travail"]} /></>}
              />
            </div>
            <p className="help-text">Vaut pour toutes les lignes : identifiants, notes, cartes, hôtes, clés, bases. La même préférence que « Hôtes de la liste » dans Guiterm.</p>
          </>
        )}
      </section>

      <section className="space-y-3">
        <p className="eyebrow">Dossiers de la liste</p>
        <div className={`grid gap-4 ${compact ? "grid-cols-2" : "max-w-md grid-cols-2"}`}>
          <Slider
            label="Texte"
            value={prefs.hostGroupSize}
            shown={hostGroupMetrics(prefs.hostGroupSize, prefs.hostGroupIconSize).font}
            min={HOST_GROUP_SIZE_MIN}
            max={HOST_GROUP_SIZE_MAX}
            step={0.5}
            aria="Taille du texte des dossiers"
            onChange={(v) => update({ ...prefs, hostGroupSize: v })}
          />
          <Slider
            label="Icône"
            value={prefs.hostGroupIconSize}
            shown={hostGroupMetrics(prefs.hostGroupSize, prefs.hostGroupIconSize).icon}
            min={HOST_GROUP_ICON_MIN}
            max={HOST_GROUP_ICON_MAX}
            step={1}
            aria="Taille de l'icône des dossiers"
            onChange={(v) => update({ ...prefs, hostGroupIconSize: v })}
          />
        </div>
        {!compact && (
          <div className="card max-w-md px-2 py-1.5">
            <GroupRow depth={0} expanded onToggle={() => {}} icon={<IconFolder />} name="Production" count={12} />
            <GroupRow depth={1} expanded={false} onToggle={() => {}} icon={<IconFolder />} name="Frontaux web" count={4} />
          </div>
        )}
      </section>
    </div>
  );
}

function Slider({ label, value, shown, min, max, step, aria, onChange }: {
  label: string; value: number; shown: string; min: number; max: number; step: number; aria: string; onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <span className="field-label">
        {label} : <span className="font-mono text-[var(--c-text)]">{shown}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label={aria} className="w-full" />
      <span className="flex justify-between text-[11px] text-[var(--c-text-faint)]">
        <span>{min} px</span><span>{max} px</span>
      </span>
    </label>
  );
}
