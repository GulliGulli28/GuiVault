import { useEffect, useMemo, useState } from "react";
import type { PageContext } from "../App";
import { errorMessage } from "../lib/api";
import { indexItems } from "../lib/entities";
import { download, exportCsv, exportEncrypted, exportJson } from "../lib/exporters";
import { importFile, NeedsPassword, resolveFolders, type ImportResult } from "../lib/importers";
import { navigate } from "../lib/route";
import { loadItems, putPayload, type DecodedItem, type VaultView } from "../lib/session";
import { canWrite, KIND_LABELS_PLURAL, type ItemKind } from "../lib/types";
import { PasswordStrength } from "./PasswordStrength";
import { GroupSelect } from "./forms/common";
import { Eyebrow, Field, PasswordInput } from "./ui";

/** Import et export d'un vault. L'import lit le fichier dans le navigateur,
 * montre ce qu'il contient, puis chiffre et envoie item par item ; l'export
 * déchiffre tout ici et produit un fichier — en clair (à manier comme tel)
 * ou protégé par un mot de passe. */
export function ToolsPage({ ctx, vaultId }: { ctx: PageContext; vaultId: string }) {
  const vault = ctx.session.vaults.find((v) => v.id === vaultId);
  if (!vault) return <p className="p-6 text-[12.5px] text-[var(--c-text-muted)]">Ce vault n'existe pas (ou plus).</p>;
  return <Body key={vault.id} ctx={ctx} vault={vault} />;
}

function Body({ ctx, vault }: { ctx: PageContext; vault: VaultView }) {
  const [items, setItems] = useState<DecodedItem[] | null>(null);
  const reload = () => loadItems(vault).then((p) => setItems(p.items)).catch((e) => ctx.error(errorMessage(e)));
  // Chargement initial ; `ctx` change à chaque notification.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void reload(); }, [vault.id]);
  const index = useMemo(() => indexItems(items ?? []), [items]);
  const writable = canWrite(vault.role);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--c-border)] px-4 py-2.5 max-md:pl-28">
        <button onClick={() => navigate({ page: "vault", id: vault.id })} className="btn btn-ghost btn-sm">← {vault.name}</button>
        <h1 className="text-[14px] font-semibold text-[var(--c-text)]">Importer / exporter</h1>
      </header>
      <div className="sidebar-scroll min-h-0 flex-1 space-y-8 overflow-y-auto p-4">
        {writable ? (
          <ImportSection ctx={ctx} vault={vault} groups={index.groups} onDone={reload} />
        ) : (
          <p className="callout max-w-2xl">Vous êtes lecteur de ce vault : pas d'import possible, l'export reste disponible.</p>
        )}
        <ExportSection ctx={ctx} vault={vault} items={items} />
      </div>
    </div>
  );
}

function ImportSection({ ctx, vault, groups, onDone }: { ctx: PageContext; vault: VaultView; groups: ReturnType<typeof indexItems>["groups"]; onDone: () => Promise<void> }) {
  const [text, setText] = useState<string | null>(null);
  const [filename, setFilename] = useState("");
  const [password, setPassword] = useState("");
  const [needsPassword, setNeedsPassword] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rootId, setRootId] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const parse = async (content: string, pw?: string) => {
    setError(null);
    try {
      setResult(await importFile(content, pw || undefined));
      setNeedsPassword(false);
    } catch (e) {
      setResult(null);
      if (e instanceof NeedsPassword) setNeedsPassword(true);
      else setError(errorMessage(e));
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setFilename(file.name);
    setPassword("");
    setNeedsPassword(false);
    const content = await file.text();
    setText(content);
    await parse(content);
  };

  const counts = useMemo(() => {
    const c = new Map<ItemKind, number>();
    for (const it of result?.items ?? []) c.set(it.payload.kind, (c.get(it.payload.kind) ?? 0) + 1);
    return c;
  }, [result]);

  const run = async () => {
    if (!result) return;
    const { groups: created, payloads } = resolveFolders(result, groups, rootId);
    const all = [...created.map((g) => ({ kind: "group" as const, group: g })), ...payloads];
    setProgress({ done: 0, total: all.length });
    let failed = 0;
    for (let i = 0; i < all.length; i++) {
      try {
        await putPayload(vault, all[i]);
      } catch (e) {
        failed++;
        if (failed === 1) ctx.error(errorMessage(e));
      }
      setProgress({ done: i + 1, total: all.length });
    }
    setProgress(null);
    setResult(null);
    setText(null);
    ctx.notify(`${payloads.length} élément(s) importé(s)${created.length ? ` (${created.length} dossier(s) créé(s))` : ""}${failed ? `, ${failed} écriture(s) en échec` : ""}.`);
    await onDone();
  };

  return (
    <section className="max-w-2xl space-y-3">
      <Eyebrow>Importer dans « {vault.name} »</Eyebrow>
      <p className="help-text">Bitwarden (JSON, en clair ou protégé par mot de passe, et CSV), Chrome, Firefox, LastPass, KeePassXC (CSV), ou un export GuiVault. Le fichier est lu ici, dans le navigateur : rien n'en part en clair.</p>
      <input type="file" accept=".json,.csv,.txt,application/json,text/csv" aria-label="Fichier à importer" onChange={(e) => void onFile(e.target.files?.[0])} className="block text-[12px] text-[var(--c-text-secondary)]" />
      {needsPassword && text !== null && (
        <form onSubmit={(e) => { e.preventDefault(); void parse(text, password); }} className="callout space-y-2">
          <p>« {filename} » est protégé par un mot de passe.</p>
          <div className="flex gap-2">
            <PasswordInput value={password} onChange={setPassword} autoFocus autoComplete="off" className="flex-1" />
            <button type="submit" disabled={!password} className="btn btn-primary btn-sm">Déchiffrer</button>
          </div>
        </form>
      )}
      {error && <p className="callout callout-danger">{error}</p>}
      {result && (
        <div className="card space-y-3 p-3">
          <p className="text-[12.5px] text-[var(--c-text)]">
            <span className="font-medium">{filename}</span> — {result.format} : {result.items.length} élément(s)
            {counts.size > 0 && <span className="text-[var(--c-text-muted)]"> ({Array.from(counts).map(([k, n]) => `${n} ${KIND_LABELS_PLURAL[k].toLowerCase()}`).join(", ")})</span>}
          </p>
          {result.warnings.length > 0 && (
            <ul className="callout callout-warn list-inside list-disc space-y-0.5">
              {result.warnings.slice(0, 10).map((w, i) => <li key={i}>{w}</li>)}
              {result.warnings.length > 10 && <li>… et {result.warnings.length - 10} autre(s)</li>}
            </ul>
          )}
          <Field label="Sous le dossier" hint="Les dossiers du fichier sont recréés en dessous, ou réutilisés s'ils existent déjà.">
            <GroupSelect groups={groups} value={rootId} onChange={setRootId} />
          </Field>
          <div className="flex items-center justify-end gap-2">
            {progress && <span className="text-[11.5px] text-[var(--c-text-muted)]">{progress.done} / {progress.total}</span>}
            <button onClick={() => { setResult(null); setText(null); }} disabled={progress !== null} className="btn btn-ghost btn-sm">Annuler</button>
            <button onClick={() => void run()} disabled={progress !== null || result.items.length === 0} className="btn btn-primary btn-sm">{progress ? "Import…" : "Importer"}</button>
          </div>
        </div>
      )}
    </section>
  );
}

function ExportSection({ ctx, vault, items }: { ctx: PageContext; vault: VaultView; items: DecodedItem[] | null }) {
  const [format, setFormat] = useState<"json" | "encrypted" | "csv">("encrypted");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const payloads = useMemo(() => (items ?? []).flatMap((i) => (i.ok ? [i.payload] : [])), [items]);
  const unreadable = (items ?? []).filter((i) => !i.ok).length;
  const stamp = new Date().toISOString().slice(0, 10);
  const base = `guivault-${vault.name.replace(/[^\w-]+/g, "_")}-${stamp}`;
  const csvSkipped = useMemo(() => (format === "csv" ? exportCsv(payloads).skipped : 0), [format, payloads]);

  const run = async () => {
    setBusy(true);
    try {
      if (format === "json") download(`${base}.json`, exportJson(vault, payloads));
      else if (format === "encrypted") download(`${base}.encrypted.json`, await exportEncrypted(vault, payloads, password));
      else download(`${base}.csv`, exportCsv(payloads).csv, "text/csv");
      ctx.notify("Export téléchargé.");
    } catch (e) {
      ctx.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const ready = items !== null && (format !== "encrypted" || (password.length >= 8 && password === confirm));

  return (
    <section className="max-w-2xl space-y-3">
      <Eyebrow>Exporter « {vault.name} »</Eyebrow>
      <p className="help-text">{items ? `${payloads.length} élément(s)` : "Chargement…"}{unreadable ? `, ${unreadable} illisible(s) laissé(s) de côté` : ""}. Tout est déchiffré dans le navigateur au moment de l'export.</p>
      <div className="segmented">
        <button type="button" data-active={format === "encrypted"} onClick={() => setFormat("encrypted")}>JSON chiffré</button>
        <button type="button" data-active={format === "json"} onClick={() => setFormat("json")}>JSON en clair</button>
        <button type="button" data-active={format === "csv"} onClick={() => setFormat("csv")}>CSV</button>
      </div>
      {format === "encrypted" && (
        <div className="space-y-2">
          <p className="help-text">Argon2id + XChaCha20-Poly1305, réimportable ici avec ce mot de passe. Il n'a rien à voir avec le mot de passe maître et ne peut pas être retrouvé.</p>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Mot de passe du fichier"><PasswordInput value={password} onChange={setPassword} autoComplete="new-password" /></Field>
            <Field label="Confirmer"><PasswordInput value={confirm} onChange={setConfirm} autoComplete="new-password" /></Field>
          </div>
          <PasswordStrength password={password} />
        </div>
      )}
      {format === "json" && <p className="callout callout-warn">Fichier en clair : tous les secrets y sont lisibles. À chiffrer ou à détruire après usage.</p>}
      {format === "csv" && <p className="callout callout-warn">CSV compatible Bitwarden, en clair : identifiants et notes seulement{csvSkipped ? ` — ${csvSkipped} élément(s) d'autres types ne seront pas exportés` : ""}. Préférez le JSON pour tout emporter.</p>}
      <div className="flex justify-end">
        <button onClick={() => void run()} disabled={!ready || busy} className="btn btn-primary btn-sm">{busy ? "Préparation…" : "Télécharger"}</button>
      </div>
    </section>
  );
}
