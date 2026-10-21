import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { PageContext } from "../App";
import { api, errorMessage } from "../lib/api";
import { allSecrets, checkPwned, findExpiring, findMissingTotp, findOld, findReused, findWeak, type HealthEntry } from "../lib/health";
import { navigate } from "../lib/route";
import { loadItems, payloadName } from "../lib/session";
import { KIND_LABELS, type TwoFactorSite } from "../lib/types";
import { tileHue, tileInitial } from "../lib/tiles";
import { HealthBar } from "./HomePage";
import { Page } from "./Page";
import { IconInfo } from "./secret-icons";
import { IconCheck, IconSearch } from "./ui-icons";
import { Loading, useDelayed } from "./ui";

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
  const [tab, setTab] = useState<Tab>("all");
  const [info, setInfo] = useState(false);
  const slow = useDelayed(entries === null);
  const vaultsKey = session.vaults.map((v) => `${v.id}:${v.revision}`).join(",");
  const offline = !!session.offline;
  const local = !!session.local;

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

  /** Tout ce qui est à traiter, une ligne par problème, le plus grave d'abord. */
  const issues = useMemo<Issue[]>(() => {
    if (!report) return [];
    const out: Issue[] = [];
    for (const s of leaked ?? []) out.push({ kind: "leaked", entry: s.entry, detail: `${capitalize(s.label)} vu ${(pwned!.get(s.value) ?? 0).toLocaleString("fr-FR")} fois dans des fuites` });
    for (const g of report.reused) for (const s of g) {
      const others = g.filter((o) => o !== s).map((o) => payloadName(o.entry.item.payload) || "(sans nom)");
      out.push({ kind: "reused", entry: s.entry, detail: `Même ${s.label} que ${others.length > 1 ? `${others.length} autres éléments` : `« ${others[0]} »`}` });
    }
    for (const s of report.weak) out.push({ kind: "weak", entry: s.entry, detail: `${capitalize(s.label)} facile à deviner` });
    for (const m of report.missingTotp ?? []) out.push({ kind: "totp", entry: m.entry, detail: `${m.site.name} accepte un code TOTP`, link: m.site.documentation ?? undefined });
    for (const o of report.old) out.push({ kind: "old", entry: o.entry, detail: `Mot de passe du ${o.since.toLocaleDateString("fr-FR")}` });
    for (const x of report.expiring) out.push({ kind: "expiring", entry: x.entry, detail: `${capitalize(x.what)} ${x.expired ? "expirée le" : "expire le"} ${x.date.toLocaleDateString("fr-FR", { timeZone: "UTC" })}` });
    return out;
  }, [report, leaked, pwned]);

  const bad = useMemo(() => {
    if (!report) return { weak: 0, reused: 0, healthy: 0, score: 100 };
    const reused = new Set(report.reused.flat());
    const weak = new Set(report.weak.filter((s) => !reused.has(s)));
    const leakedSet = new Set((leaked ?? []).filter((s) => !reused.has(s) && !weak.has(s)));
    const total = report.secrets.length;
    const healthy = total - reused.size - weak.size - leakedSet.size;
    return { weak: weak.size + leakedSet.size, reused: reused.size, healthy, score: total === 0 ? 100 : Math.round((100 * healthy) / total) };
  }, [report, leaked]);

  const counts = (k: IssueKind) => issues.filter((i) => i.kind === k).length;
  const shown = tab === "all" ? issues.filter((i) => i.kind !== "old") : issues.filter((i) => i.kind === tab);
  const next = !report ? null
    : counts("leaked") > 0 ? `Changer ${counts("leaked")} mot${counts("leaked") > 1 ? "s" : ""} de passe fuité${counts("leaked") > 1 ? "s" : ""}`
    : counts("reused") > 0 ? `Changer ${counts("reused")} secrets réutilisés`
    : counts("weak") > 0 ? `Renforcer ${counts("weak")} secret${counts("weak") > 1 ? "s" : ""} faible${counts("weak") > 1 ? "s" : ""}`
    : counts("totp") > 0 ? `Ajouter la 2FA sur ${counts("totp")} site${counts("totp") > 1 ? "s" : ""}`
    : null;
  const lookupsOff = lookups === false ? (local ? "Coffre local : sans serveur pour relayer" : offline ? "Hors ligne" : "Désactivé sur ce serveur") : null;

  return (
    <Page
      title="Santé du coffre"
      sub={
        <span className="relative inline-flex flex-wrap items-center gap-1.5">
          Analysée sur cet appareil · {session.vaults.length} {session.vaults.length > 1 ? "coffres" : "coffre"}{report ? ` · ${report.secrets.length} secrets` : ""}
          <button onClick={() => setInfo((o) => !o)} aria-expanded={info} className="btn btn-ghost btn-icon h-6 w-6" title="Comment l'analyse est faite" aria-label="Comment l'analyse est faite"><IconInfo size={15} /></button>
          {info && (
            <>
              <span className="fixed inset-0 z-10" onClick={() => setInfo(false)} />
              <span role="tooltip" className="popover absolute left-0 top-8 z-20 flex w-[320px] max-w-[calc(100vw-2rem)] flex-col gap-2 p-3.5 text-[13px] text-[var(--c-text-secondary)]">
                <span className="flex gap-2"><IconCheck size={15} className="mt-0.5 shrink-0 text-[var(--c-ok)]" />Calculée ici, le serveur ne voit pas ce rapport</span>
                <span className="flex gap-2"><IconCheck size={15} className="mt-0.5 shrink-0 text-[var(--c-ok)]" />Fuites : seuls 5 caractères de l'empreinte partent, à la demande</span>
                <span className="flex gap-2"><IconCheck size={15} className="mt-0.5 shrink-0 text-[var(--c-ok)]" />Sites 2FA : liste publique relayée par le serveur</span>
              </span>
            </>
          )}
        </span>
      }
      actions={lookups !== false && report && leaked === null ? (
        <button onClick={() => void runPwned()} disabled={progress !== null || lookups === null || report.secrets.length === 0} className="btn btn-secondary btn-lg">
          <IconSearch size={15} /> {progress ? `Recherche… ${progress.done}/${progress.total || "?"}` : "Vérifier les fuites"}
        </button>
      ) : undefined}
    >
      {!report ? (slow ? <Loading /> : null) : (
        <>
          <section aria-label="Score" className="card flex flex-wrap items-center gap-x-8 gap-y-5 px-7 py-6 max-sm:px-5">
            <div className="whitespace-nowrap"><span className="text-[56px] font-semibold leading-none tracking-[-0.04em]">{bad.score}</span><span className="text-[16px] text-[var(--c-text-muted)]"> / 100</span></div>
            <div className="flex min-w-[240px] flex-1 flex-col gap-3">
              <HealthBar total={report.secrets.length} weak={bad.weak} reused={bad.reused} />
              <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-[13px] text-[var(--c-text-secondary)]">
                <Legend color="var(--c-ok)">{bad.healthy} sains</Legend>
                <Legend color="var(--c-warn)">{bad.weak} faibles{leaked && leaked.length > 0 ? " ou fuités" : ""}</Legend>
                <Legend color="var(--c-danger)">{bad.reused} réutilisés</Legend>
                <span className="text-[var(--c-text-muted)]">{lookupsOff ? `Fuites : ${lookupsOff.toLowerCase()}` : leaked === null ? "Fuites : pas encore vérifié" : leaked.length === 0 ? "Aucune fuite connue" : `${leaked.length} fuité${leaked.length > 1 ? "s" : ""}`}</span>
              </div>
            </div>
            {next && (
              <div className="flex min-w-[200px] flex-col gap-0.5 border-l border-[var(--c-border)] pl-7 max-sm:border-l-0 max-sm:pl-0">
                <span className="text-[13px] text-[var(--c-text-muted)]">Le plus utile maintenant</span>
                <span className="text-[15px] font-medium">{next}</span>
              </div>
            )}
          </section>

          <section aria-label="À traiter" className="flex flex-col gap-3.5">
            <div className="tabs" role="tablist" aria-label="Filtrer">
              {(["all", "leaked", "reused", "weak", "totp", "old", "expiring"] as Tab[]).map((t) => {
                const n = t === "all" ? issues.filter((i) => i.kind !== "old").length : counts(t);
                if (t !== "all" && n === 0) return null;
                return <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className="tab">{TAB_LABELS[t]} <span className="text-[var(--c-text-muted)]">{n}</span></button>;
              })}
            </div>
            {shown.length === 0 ? (
              <div className="card empty text-[13.5px] text-[var(--c-text-muted)]">
                <IconCheck size={20} className="text-[var(--c-ok)]" />
                Rien à traiter.
              </div>
            ) : (
              <div className="card divide-y divide-[var(--c-border)] overflow-hidden">
                {shown.map((i, n) => <IssueRow key={n} issue={i} />)}
              </div>
            )}
            <div className="flex flex-wrap gap-2.5">
              {report.old.length === 0 && <span className="pill"><IconCheck size={15} /> Aucun mot de passe de plus d'un an</span>}
              {report.expiring.length === 0 && <span className="pill"><IconCheck size={15} /> Rien n'expire ce mois</span>}
              {lookupsOff && <span className="pill">{lookupsOff} : fuites et sites 2FA indisponibles</span>}
            </div>
          </section>
        </>
      )}
    </Page>
  );
}

type IssueKind = "leaked" | "reused" | "weak" | "totp" | "old" | "expiring";
type Tab = "all" | IssueKind;
interface Issue {
  kind: IssueKind;
  entry: HealthEntry;
  detail: string;
  link?: string;
}

const TAB_LABELS: Record<Tab, string> = { all: "À traiter", leaked: "Fuités", reused: "Réutilisés", weak: "Faibles", totp: "2FA possible", old: "Plus d'un an", expiring: "Expirations" };
const CHIPS: Record<IssueKind, { label: string; tone: string; action: string }> = {
  leaked: { label: "Fuité", tone: "tag-danger", action: "Changer" },
  reused: { label: "Réutilisé", tone: "tag-danger", action: "Changer" },
  weak: { label: "Faible", tone: "tag-warn", action: "Changer" },
  totp: { label: "2FA possible", tone: "tag-accent", action: "Ajouter la 2FA" },
  old: { label: "Ancien", tone: "", action: "Ouvrir" },
  expiring: { label: "Expire", tone: "tag-warn", action: "Ouvrir" },
};

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function Legend({ color, children }: { color: string; children: ReactNode }) {
  return <span className="inline-flex items-center gap-2 whitespace-nowrap"><i className="inline-block h-2 w-2 rounded-sm" style={{ background: color }} />{children}</span>;
}

/** Une ligne de la file : l'élément, ce qui ne va pas, et y aller. */
function IssueRow({ issue }: { issue: Issue }) {
  const p = issue.entry.item.payload;
  const name = payloadName(p) || KIND_LABELS[p.kind];
  const chip = CHIPS[issue.kind];
  const open = () => navigate({ page: "vault", id: issue.entry.vault.id, item: issue.entry.item.id });
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3.5 gap-y-2 px-[18px] py-3.5 hover:bg-[var(--c-hover)]">
      <span className="tile" style={{ "--tile-size": "36px", "--tile-h": tileHue(name) } as React.CSSProperties}>{tileInitial(name)}</span>
      <span className="flex min-w-0 flex-[1_1_200px] flex-col">
        <span className="truncate font-medium">{name}</span>
        <span className="truncate text-[12.5px] text-[var(--c-text-muted)]">
          {issue.detail}
          {issue.link && <> · <a href={issue.link} target="_blank" rel="noreferrer noopener">comment</a></>}
        </span>
      </span>
      <span className={`tag ${chip.tone}`}>{chip.label}</span>
      <span className="w-[130px] truncate text-[12.5px] text-[var(--c-text-muted)] max-lg:hidden">{issue.entry.vault.name}{issue.entry.vault.role === "reader" ? " · lecture" : ""}</span>
      <button onClick={open} className="btn btn-secondary ml-auto">{chip.action}</button>
    </div>
  );
}
