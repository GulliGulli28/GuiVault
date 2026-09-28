import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { PageContext } from "../App";
import { api, errorMessage } from "../lib/api";
import { allSecrets, checkPwned, findExpiring, findMissingTotp, findOld, findReused, findWeak, type HealthEntry, type SecretRef } from "../lib/health";
import { navigate } from "../lib/route";
import { loadItems, payloadName } from "../lib/session";
import { KIND_LABELS, type TwoFactorSite } from "../lib/types";
import { KIND_ICONS } from "./ItemTree";
import { Eyebrow, formatWhen, Loading, useDelayed } from "./ui";

/** Le rapport de santé : ce qui mérite d'être changé dans le coffre, calculé
 * dans ce navigateur. Les fuites seulement sur demande (k-anonymat, relayé
 * par le serveur) ; la liste des sites qui acceptent un code TOTP, si le
 * serveur la relaie. */
export function HealthPage({ ctx }: { ctx: PageContext }) {
  const { session } = ctx;
  const [entries, setEntries] = useState<HealthEntry[] | null>(null);
  const [lookups, setLookups] = useState<boolean | null>(null);
  const [sites, setSites] = useState<TwoFactorSite[] | null>(null);
  const [pwned, setPwned] = useState<Map<string, number> | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const slow = useDelayed(entries === null);
  const vaultsKey = session.vaults.map((v) => `${v.id}:${v.revision}`).join(",");
  const offline = !!session.offline;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const out: HealthEntry[] = [];
      for (const v of session.vaults) {
        try {
          const page = await loadItems(v);
          for (const it of page.items) if (it.ok) out.push({ vault: { id: v.id, name: v.name, role: v.role }, item: it });
        } catch (e) {
          ctx.error(errorMessage(e));
        }
      }
      if (!cancelled) setEntries(out);
    })();
    return () => { cancelled = true; };
    // Relu quand un vault change de révision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultsKey]);

  // Ce que le serveur relaie, et la liste 2FA (elle ne dit rien du coffre :
  // on la demande d'emblée).
  useEffect(() => {
    if (offline) return setLookups(false);
    api.health().then((h) => {
      setLookups(!!h.health_lookups);
      if (h.health_lookups) api.twoFactorDirectory().then(setSites).catch(() => setSites([]));
    }).catch(() => setLookups(false));
  }, [offline]);

  const report = useMemo(() => {
    if (!entries) return null;
    const secrets = allSecrets(entries);
    const now = new Date();
    return {
      secrets,
      weak: findWeak(secrets),
      reused: findReused(secrets),
      old: findOld(entries, now),
      expiring: findExpiring(entries, now),
      missingTotp: sites ? findMissingTotp(entries, sites) : null,
    };
  }, [entries, sites]);

  const runPwned = async () => {
    if (!report) return;
    setProgress({ done: 0, total: 0 });
    try {
      setPwned(await checkPwned(report.secrets.map((s) => s.value), (p) => api.pwnedRange(p), (done, total) => setProgress({ done, total })));
    } catch (e) {
      ctx.error(errorMessage(e));
    } finally {
      setProgress(null);
    }
  };

  const leaked = report && pwned ? report.secrets.filter((s) => (pwned.get(s.value) ?? 0) > 0) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-[var(--c-border)] px-4 py-2.5 max-md:pl-14">
        <h1 className="text-[14px] font-semibold text-[var(--c-text)]">Santé du coffre</h1>
        <span className="text-[11px] text-[var(--c-text-faint)]">{report ? `${report.secrets.length} secret(s) examiné(s)` : ""}</span>
      </header>
      <div className="sidebar-scroll min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
        <p className="help-text max-w-2xl">
          Calculé dans ce navigateur, sur les éléments de vos vaults : le serveur ne voit rien de ce rapport. Seule la recherche de fuites interroge Have I Been Pwned — sur demande, par k-anonymat : les 5 premiers caractères de l'empreinte SHA-1 de chaque mot de passe, jamais le mot de passe ni son empreinte entière, relayés par le serveur.
        </p>
        {!report ? (slow ? <Loading /> : null) : (
          <>
            <div className="grid max-w-3xl grid-cols-2 gap-2 sm:grid-cols-3">
              <Stat label="Fuités" value={leaked ? leaked.length : null} hint={leaked ? undefined : "à vérifier"} danger />
              <Stat label="Réutilisés" value={report.reused.reduce((n, g) => n + g.length, 0)} danger />
              <Stat label="Faibles" value={report.weak.length} danger />
              <Stat label="2FA possible, non enregistrée" value={report.missingTotp ? report.missingTotp.length : null} hint={lookups === false ? "indisponible" : undefined} />
              <Stat label="Inchangés depuis plus d'un an" value={report.old.length} />
              <Stat label="Expirent ou expirés" value={report.expiring.length} />
            </div>

            <Section title="Fuites connues (Have I Been Pwned)" count={leaked?.length ?? null}>
              {lookups === false ? (
                <p className="help-text">{offline ? "Hors ligne : la recherche de fuites passe par le serveur." : "Désactivée sur ce serveur (GUIVAULT_HEALTH_LOOKUPS=false)."}</p>
              ) : leaked === null ? (
                <div className="flex flex-wrap items-center gap-2">
                  <button onClick={() => void runPwned()} disabled={progress !== null || lookups === null || report.secrets.length === 0} className="btn btn-secondary btn-sm">
                    {progress ? `Recherche… ${progress.done}/${progress.total || "?"}` : "Rechercher les fuites"}
                  </button>
                  <span className="help-text">{new Set(report.secrets.map((s) => s.value)).size} mot(s) de passe distinct(s).</span>
                </div>
              ) : leaked.length === 0 ? (
                <p className="text-[12.5px] text-[var(--c-text-muted)]">Aucun de vos mots de passe n'apparaît dans les fuites connues.</p>
              ) : (
                leaked.map((s, i) => <SecretRow key={i} s={s} detail={`${s.label} vu ${(pwned!.get(s.value) ?? 0).toLocaleString("fr-FR")} fois dans des fuites — à changer en priorité`} danger />)
              )}
            </Section>

            <Section title="Réutilisés" count={report.reused.length}>
              {report.reused.length === 0 ? <Empty /> : report.reused.map((g, i) => (
                <div key={i} className="card space-y-0.5 p-2">
                  <p className="px-1 text-[11px] text-[var(--c-text-muted)]">Le même secret à {g.length} endroits :</p>
                  {g.map((s, j) => <SecretRow key={j} s={s} detail={s.label} bare />)}
                </div>
              ))}
            </Section>

            <Section title="Faibles" count={report.weak.length}>
              {report.weak.length === 0 ? <Empty /> : report.weak.map((s, i) => <SecretRow key={i} s={s} detail={`${s.label} facile à deviner`} />)}
            </Section>

            <Section title="Deux facteurs possibles, pas de code enregistré" count={report.missingTotp?.length ?? null}>
              {lookups === false ? (
                <p className="help-text">La liste des sites qui acceptent un code TOTP (2fa.directory) est relayée par le serveur : {offline ? "hors ligne" : "désactivée ici"}.</p>
              ) : report.missingTotp === null ? (
                <Loading label="Liste des sites…" />
              ) : report.missingTotp.length === 0 ? <Empty /> : report.missingTotp.map((m, i) => (
                <Row key={i} entry={m.entry} detail={<>{m.site.name} accepte un code TOTP{m.site.documentation && <> — <a href={m.site.documentation} target="_blank" rel="noreferrer noopener" className="underline">comment l'activer</a></>}</>} />
              ))}
            </Section>

            <Section title="Inchangés depuis plus d'un an" count={report.old.length}>
              {report.old.length === 0 ? <Empty /> : report.old.map((o, i) => <Row key={i} entry={o.entry} detail={`mot de passe du ${formatWhen(o.since.toISOString())} (${Math.floor(o.days / 365)} an${o.days >= 730 ? "s" : ""})`} />)}
            </Section>

            <Section title="Expirent dans le mois, ou expirés" count={report.expiring.length}>
              {report.expiring.length === 0 ? <Empty /> : report.expiring.map((x, i) => (
                <Row key={i} entry={x.entry} detail={`${x.what} ${x.expired ? "expirée le" : "expire le"} ${x.date.toLocaleDateString("fr-FR", { timeZone: "UTC" })}`} danger={x.expired} />
              ))}
            </Section>
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, hint, danger }: { label: string; value: number | null; hint?: string; danger?: boolean }) {
  const bad = danger && value !== null && value > 0;
  return (
    <div className="card p-3">
      <p className="text-[20px] font-semibold leading-none" style={{ color: bad ? "var(--c-danger)" : value === 0 ? "var(--c-ok)" : "var(--c-text)" }}>{value ?? "—"}</p>
      <p className="mt-1 text-[11.5px] text-[var(--c-text-muted)]">{label}{hint ? ` · ${hint}` : ""}</p>
    </div>
  );
}

function Section({ title, count, children }: { title: string; count: number | null; children: ReactNode }) {
  return (
    <section className="max-w-3xl space-y-1.5">
      <Eyebrow>{title}{count !== null && count > 0 ? ` · ${count}` : ""}</Eyebrow>
      <div className="space-y-1">{children}</div>
    </section>
  );
}

function Empty() {
  return <p className="text-[12.5px] text-[var(--c-text-muted)]">Rien à signaler.</p>;
}

/** Une ligne qui mène à l'élément, dans son vault. */
function Row({ entry, detail, danger, bare }: { entry: HealthEntry; detail: ReactNode; danger?: boolean; bare?: boolean }) {
  const p = entry.item.payload;
  const Icon = KIND_ICONS[p.kind];
  return (
    <button
      onClick={() => navigate({ page: "vault", id: entry.vault.id, item: entry.item.id })}
      className={`list-row w-full text-left ${bare ? "" : "card"} min-h-0 gap-2 px-2.5 py-1.5`}
      title={`Ouvrir dans « ${entry.vault.name} »`}
    >
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--c-bg3)] text-[var(--c-text-secondary)]"><Icon size={12} /></span>
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-[12.5px] text-[var(--c-text)]">{payloadName(p) || KIND_LABELS[p.kind]} <span className="text-[11px] text-[var(--c-text-faint)]">· {entry.vault.name}{entry.vault.role === "reader" ? " (lecture)" : ""}</span></span>
        <span className="truncate text-[11px]" style={{ color: danger ? "var(--c-danger)" : "var(--c-text-muted)" }}>{detail}</span>
      </span>
    </button>
  );
}

function SecretRow({ s, detail, danger, bare }: { s: SecretRef; detail: string; danger?: boolean; bare?: boolean }) {
  return <Row entry={s.entry} detail={detail} danger={danger} bare={bare} />;
}
