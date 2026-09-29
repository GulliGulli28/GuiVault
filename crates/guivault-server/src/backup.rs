//! Sauvegardes intégrées et vérifiées.
//!
//! Une sauvegarde est un fichier gzip de lignes `table\tJSON`, où le JSON est
//! la ligne telle que PostgreSQL la rend (`row_to_json`) et la relit
//! (`json_populate_recordset`) : aucun type n'est réinterprété en Rust, un
//! `bytea`, un `inet` ou un `timestamptz` fait l'aller-retour à l'identique.
//! Première ligne : `GUIVAULT-BACKUP\t{format, version, schéma, date,
//! tables}` ; dernière : `END\t{par table : lignes, SHA-256}`. Tout est lu
//! dans un seul instantané (`REPEATABLE READ`) : la sauvegarde est cohérente
//! même quand le serveur écrit pendant ce temps.
//!
//! « Vérifiée » veut dire, selon ce qu'on a :
//! - `file` : le fichier est relu en entier — gzip (CRC), en-tête, chaque
//!   ligne un JSON, les tables dans l'ordre, nombres de lignes et empreintes
//!   égaux à ceux de la fin. Tronqué ou altéré, il est refusé ;
//! - `restore` : il est en plus restauré dans une base d'essai, elle-même
//!   re-sauvegardée : mêmes lignes, mêmes empreintes. La preuve qu'il se
//!   restaure, pas seulement qu'il se lit.
//!
//! Rien de secret dedans (le serveur n'en a pas), mais tout ce qu'a la base :
//! adresses, hachés d'authentification, chiffrés — à protéger comme elle.
//! `GUIVAULT_SECRET` n'y est pas : sans lui, les seconds facteurs TOTP
//! restaurés ne s'ouvrent plus (les comptes réenrôlent).
use crate::config::BackupConfig;
use anyhow::Context;
use chrono::{DateTime, Utc};
use flate2::Compression;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use futures_util::TryStreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::migrate::{Migration, MigrationSource, Migrator};
use sqlx::postgres::PgPoolOptions;
use sqlx::{Connection, PgConnection, PgPool};
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};

pub const FORMAT: u32 = 1;
const MAGIC: &str = "GUIVAULT-BACKUP";
const END: &str = "END";

/// Toutes les tables, dans l'ordre de restauration : chacune après celles
/// qu'elle référence. Une table du schéma qui n'est pas ici fait échouer la
/// sauvegarde (`dump`) : une migration qui en crée une doit l'y ajouter.
pub const TABLES: &[&str] = &[
    "users",
    "vaults",
    "vault_members",
    "items",
    "item_versions",
    "attachments",
    "attachment_chunks",
    "invitations",
    "sessions",
    "user_totp",
    "user_recovery_codes",
    "passkeys",
    "webauthn_challenges",
    "totp_challenges",
    "user_settings",
    "sends",
    "send_chunks",
    "send_downloads",
    "emergency_grants",
    "emergency_vault_keys",
    "registration_invites",
    "audit_log",
    "backup_runs",
];

/// La marque d'une base d'essai : sans elle, une base qui contient des
/// tables n'est jamais effacée.
const SCRATCH_MARK: &str = "guivault_restore_check";
/// Ce qui n'est pas une donnée : l'état des migrations (recréé à la
/// restauration) et la marque ci-dessus.
const NOT_DATA: &[&str] = &["_sqlx_migrations", SCRATCH_MARK];

/// Verrou consultatif (par base) : une seule sauvegarde à la fois, serveur
/// et `guivault backup` confondus.
pub const LOCK_KEY: i64 = 0x6776_6263; // « gvbc »

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Header {
    pub format: u32,
    pub server_version: String,
    /// Dernière migration appliquée à la base sauvegardée.
    pub schema: i64,
    pub created_at: DateTime<Utc>,
    pub tables: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TableCheck {
    pub rows: u64,
    pub sha256: String,
}

#[derive(Serialize, Deserialize)]
struct Trailer {
    tables: BTreeMap<String, TableCheck>,
}

/// Ce que la relecture d'un fichier a établi.
#[derive(Debug, Clone)]
pub struct Summary {
    pub header: Header,
    pub tables: BTreeMap<String, TableCheck>,
    pub bytes: u64,
    /// SHA-256 du fichier (hexadécimal), pour le reconnaître plus tard.
    pub sha256: String,
}

impl Summary {
    pub fn rows(&self) -> u64 {
        self.tables.values().map(|t| t.rows).sum()
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

async fn public_tables(conn: &mut PgConnection) -> sqlx::Result<Vec<String>> {
    sqlx::query_scalar("SELECT tablename::text FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")
        .fetch_all(conn)
        .await
}

/// L'ordre des lignes d'une table : sa clé primaire, les textes comparés
/// octet par octet (`COLLATE "C"`) pour que deux bases de collations
/// différentes rendent le même fichier.
async fn order_by(conn: &mut PgConnection, table: &str) -> sqlx::Result<String> {
    let cols: Vec<(String, String)> = sqlx::query_as(
        "SELECT a.attname::text, format_type(a.atttypid, a.atttypmod)
         FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
         WHERE i.indrelid = to_regclass('public.' || quote_ident($1)) AND i.indisprimary
         ORDER BY array_position(i.indkey::int2[], a.attnum)",
    )
    .bind(table)
    .fetch_all(conn)
    .await?;
    if cols.is_empty() {
        return Ok("r::text COLLATE \"C\"".into());
    }
    Ok(cols
        .iter()
        .map(|(c, ty)| match ty.as_str() {
            "text" | "citext" | "character varying" => format!("r.{}::text COLLATE \"C\"", ident(c)),
            _ => format!("r.{}", ident(c)),
        })
        .collect::<Vec<_>>()
        .join(", "))
}

/// Écrit toute la base dans `out` (en clair : l'appelant compresse), depuis
/// un seul instantané. Rend l'en-tête et les contrôles écrits.
pub async fn dump(db: &PgPool, out: &mut impl Write) -> anyhow::Result<(Header, BTreeMap<String, TableCheck>)> {
    let mut tx = db.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *tx)
        .await?;
    // Le texte d'une date dépend du fuseau de la session, celui d'un bytea
    // de `bytea_output` : fixés, deux bases rendent les mêmes octets.
    sqlx::query("SET LOCAL TimeZone = 'UTC'").execute(&mut *tx).await?;
    sqlx::query("SET LOCAL bytea_output = 'hex'").execute(&mut *tx).await?;
    let schema: i64 = sqlx::query_scalar("SELECT coalesce(max(version), 0) FROM _sqlx_migrations WHERE success")
        .fetch_one(&mut *tx)
        .await
        .context("pas de table _sqlx_migrations : ce n'est pas une base GuiVault")?;
    let present = public_tables(&mut tx).await?;
    if let Some(t) = present
        .iter()
        .find(|t| !TABLES.contains(&t.as_str()) && !NOT_DATA.contains(&t.as_str()))
    {
        anyhow::bail!("table « {t} » inconnue des sauvegardes (backup::TABLES) : sauvegarde incomplète refusée");
    }
    let tables: Vec<String> = TABLES
        .iter()
        .filter(|t| present.iter().any(|p| p == *t))
        .map(|t| t.to_string())
        .collect();
    let header = Header {
        format: FORMAT,
        server_version: env!("CARGO_PKG_VERSION").into(),
        schema,
        created_at: Utc::now(),
        tables: tables.clone(),
    };
    writeln!(out, "{MAGIC}\t{}", serde_json::to_string(&header)?)?;
    let mut checks = BTreeMap::new();
    for t in &tables {
        let order = order_by(&mut tx, t).await?;
        let sql = format!("SELECT row_to_json(r)::text FROM {} r ORDER BY {order}", ident(t));
        let mut hasher = Sha256::new();
        let mut rows = 0u64;
        let mut stream = sqlx::query_scalar::<_, String>(&sql).fetch(&mut *tx);
        while let Some(row) = stream.try_next().await? {
            writeln!(out, "{t}\t{row}")?;
            hasher.update(row.as_bytes());
            hasher.update(b"\n");
            rows += 1;
        }
        drop(stream);
        checks.insert(
            t.clone(),
            TableCheck {
                rows,
                sha256: hex(&hasher.finalize()),
            },
        );
    }
    writeln!(
        out,
        "{END}\t{}",
        serde_json::to_string(&Trailer { tables: checks.clone() })?
    )?;
    tx.rollback().await?;
    Ok((header, checks))
}

/// Écrit une sauvegarde dans `path` — d'abord à côté (`.part`), renommée une
/// fois complète et sur le disque —, puis la relit pour la vérifier.
pub async fn create_file(db: &PgPool, path: &Path) -> anyhow::Result<Summary> {
    let part = path.with_extension("part");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let file = options
        .open(&part)
        .with_context(|| format!("impossible d'écrire {}", part.display()))?;
    let mut gz = GzEncoder::new(BufWriter::new(file), Compression::default());
    // Écritures synchrones dans une tâche async : quelques Mio, bufferisés.
    if let Err(e) = dump(db, &mut gz).await {
        let _ = std::fs::remove_file(&part);
        return Err(e);
    }
    let file = gz.finish()?.into_inner().map_err(|e| e.into_error())?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&part, path)?;
    let p = path.to_path_buf();
    tokio::task::spawn_blocking(move || verify_file(&p)).await?
}

/// Relit un fichier en entier et le contrôle (voir le haut du module). Ne
/// touche à aucune base.
pub fn verify_file(path: &Path) -> anyhow::Result<Summary> {
    let bytes = std::fs::metadata(path)
        .with_context(|| format!("{} illisible", path.display()))?
        .len();
    let sha256 = {
        let mut h = Sha256::new();
        std::io::copy(&mut std::fs::File::open(path)?, &mut h)?;
        hex(&h.finalize())
    };
    let mut lines = BufReader::new(GzDecoder::new(std::fs::File::open(path)?)).lines();
    let first = lines
        .next()
        .ok_or_else(|| anyhow::anyhow!("fichier vide"))?
        .context("pas un fichier gzip lisible")?;
    let header: Header = match first.split_once('\t') {
        Some((MAGIC, json)) => serde_json::from_str(json).context("en-tête illisible")?,
        _ => anyhow::bail!("ce n'est pas une sauvegarde GuiVault"),
    };
    anyhow::ensure!(
        header.format == FORMAT,
        "format de sauvegarde {} inconnu (ce binaire lit le {FORMAT})",
        header.format
    );

    let mut seen: BTreeMap<String, (u64, Sha256)> = BTreeMap::new();
    let mut position = 0usize;
    let mut current: Option<String> = None;
    let mut trailer: Option<Trailer> = None;
    for (i, line) in lines.enumerate() {
        let n = i + 2;
        let line = line.with_context(|| format!("ligne {n} : fichier corrompu ou tronqué"))?;
        anyhow::ensure!(trailer.is_none(), "ligne {n} : du contenu après la fin");
        let (table, json) = line
            .split_once('\t')
            .ok_or_else(|| anyhow::anyhow!("ligne {n} : ligne mal formée"))?;
        if table == END {
            trailer = Some(serde_json::from_str(json).with_context(|| format!("ligne {n} : fin illisible"))?);
            continue;
        }
        if current.as_deref() != Some(table) {
            let index = header
                .tables
                .iter()
                .position(|t| t == table)
                .ok_or_else(|| anyhow::anyhow!("ligne {n} : table « {table} » absente de l'en-tête"))?;
            anyhow::ensure!(
                index >= position && !seen.contains_key(table),
                "ligne {n} : table « {table} » hors d'ordre"
            );
            position = index;
            current = Some(table.to_string());
        }
        serde_json::from_str::<serde::de::IgnoredAny>(json).with_context(|| format!("ligne {n} : JSON illisible"))?;
        let (rows, hasher) = seen.entry(table.to_string()).or_insert_with(|| (0, Sha256::new()));
        *rows += 1;
        hasher.update(json.as_bytes());
        hasher.update(b"\n");
    }
    let trailer = trailer.ok_or_else(|| anyhow::anyhow!("fin manquante : sauvegarde tronquée"))?;
    anyhow::ensure!(
        trailer.tables.len() == header.tables.len(),
        "la fin ne décrit pas les tables de l'en-tête"
    );
    let mut tables = BTreeMap::new();
    for t in &header.tables {
        let expected = trailer
            .tables
            .get(t)
            .ok_or_else(|| anyhow::anyhow!("table « {t} » absente de la fin"))?;
        let (rows, sha) = seen
            .remove(t)
            .map(|(n, h)| (n, hex(&h.finalize())))
            .unwrap_or_else(|| (0, hex(&Sha256::new().finalize())));
        anyhow::ensure!(
            rows == expected.rows,
            "table « {t} » : {rows} lignes pour {} annoncées",
            expected.rows
        );
        anyhow::ensure!(
            sha == expected.sha256,
            "table « {t} » : empreinte différente — contenu altéré"
        );
        tables.insert(t.clone(), expected.clone());
    }
    Ok(Summary {
        header,
        tables,
        bytes,
        sha256,
    })
}

/// Les migrations de ce binaire jusqu'à `version` : une sauvegarde se
/// restaure dans le schéma qui était le sien, puis monte avec les suivantes.
#[derive(Debug)]
struct UpTo(i64);

impl<'s> MigrationSource<'s> for UpTo {
    fn resolve(self) -> futures_util::future::BoxFuture<'s, Result<Vec<Migration>, sqlx::error::BoxDynError>> {
        Box::pin(async move {
            Ok(crate::MIGRATOR
                .iter()
                .filter(|m| m.version <= self.0)
                .cloned()
                .collect())
        })
    }
}

/// Monte le schéma de `db` jusqu'à `version` incluse.
pub async fn migrate_to(db: &PgPool, version: i64) -> anyhow::Result<()> {
    Migrator::new(UpTo(version)).await?.run(db).await?;
    Ok(())
}

/// La base cible doit être vide de données. Ses tables GuiVault vides (un
/// serveur y a démarré, sans plus) sont retirées, pour repartir du schéma
/// de la sauvegarde ; les autres tables ne sont pas touchées.
async fn clear_empty_target(conn: &mut PgConnection) -> anyhow::Result<()> {
    let ours: Vec<String> = public_tables(conn)
        .await?
        .into_iter()
        .filter(|t| TABLES.contains(&t.as_str()) || t == "_sqlx_migrations")
        .collect();
    for t in ours.iter().filter(|t| TABLES.contains(&t.as_str())) {
        let has: bool = sqlx::query_scalar(&format!("SELECT EXISTS (SELECT 1 FROM {})", ident(t)))
            .fetch_one(&mut *conn)
            .await?;
        anyhow::ensure!(
            !has,
            "la base cible contient déjà des données (table « {t} ») : restaurer dans une base vide"
        );
    }
    for t in &ours {
        sqlx::query(&format!("DROP TABLE IF EXISTS {} CASCADE", ident(t)))
            .execute(&mut *conn)
            .await?;
    }
    Ok(())
}

async fn insert_batch(conn: &mut PgConnection, table: &str, rows: &mut Vec<String>) -> anyhow::Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let json = format!("[{}]", rows.join(","));
    sqlx::query(&format!(
        "INSERT INTO {t} SELECT * FROM json_populate_recordset(NULL::{t}, $1::json)",
        t = ident(table)
    ))
    .bind(json)
    .execute(&mut *conn)
    .await
    .with_context(|| format!("restauration de la table « {table} »"))?;
    rows.clear();
    Ok(())
}

/// Restaure `path` dans `db`, qui doit être vide de données. Le fichier est
/// d'abord vérifié en entier ; le schéma est monté à la version de la
/// sauvegarde, les lignes chargées en une transaction, les compteurs remis
/// après, puis — `upgrade` — les migrations suivantes appliquées.
pub async fn restore(db: &PgPool, path: &Path, upgrade: bool) -> anyhow::Result<Summary> {
    let p = path.to_path_buf();
    let summary = tokio::task::spawn_blocking(move || verify_file(&p)).await??;
    let latest = crate::MIGRATOR.iter().map(|m| m.version).max().unwrap_or(0);
    anyhow::ensure!(
        summary.header.schema <= latest,
        "sauvegarde du schéma {}, ce binaire ne connaît que jusqu'au {latest} : restaurer avec une version plus récente de GuiVault",
        summary.header.schema
    );
    if let Some(t) = summary.header.tables.iter().find(|t| !TABLES.contains(&t.as_str())) {
        anyhow::bail!("table « {t} » inconnue de ce binaire");
    }

    let mut conn = db.acquire().await?;
    clear_empty_target(&mut conn).await?;
    migrate_to(db, summary.header.schema).await?;

    let mut tx = conn.begin().await?;
    const BATCH: usize = 500;
    let mut lines = BufReader::new(GzDecoder::new(std::fs::File::open(path)?)).lines();
    lines.next();
    let mut table = String::new();
    let mut batch: Vec<String> = Vec::with_capacity(BATCH);
    for line in lines {
        let line = line?;
        let Some((t, json)) = line.split_once('\t') else {
            continue;
        };
        if t == END {
            break;
        }
        if t != table || batch.len() >= BATCH {
            insert_batch(&mut tx, &table, &mut batch).await?;
            table = t.to_string();
        }
        batch.push(json.to_string());
    }
    insert_batch(&mut tx, &table, &mut batch).await?;
    // Les compteurs (`bigserial`) repartent après la plus grande valeur.
    let serials: Vec<(String, String)> = sqlx::query_as(
        "SELECT table_name::text, column_name::text FROM information_schema.columns
         WHERE table_schema = 'public' AND column_default LIKE 'nextval(%'",
    )
    .fetch_all(&mut *tx)
    .await?;
    for (t, c) in serials.iter().filter(|(t, _)| TABLES.contains(&t.as_str())) {
        sqlx::query(&format!(
            "SELECT setval(pg_get_serial_sequence($1, $2), coalesce((SELECT max({c}) FROM {t}), 0) + 1, false)",
            c = ident(c),
            t = ident(t)
        ))
        .bind(t)
        .bind(c)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    drop(conn);
    if upgrade {
        crate::MIGRATOR.run(db).await?;
    }
    Ok(summary)
}

/// La preuve par la restauration : `path` est restauré dans la base
/// d'essai `scratch_url` (effacée d'abord — seulement si elle est vide ou
/// marquée comme telle), qui est re-sauvegardée ; les lignes et empreintes
/// doivent être celles du fichier.
pub async fn restore_check(scratch_url: &str, path: &Path, expected: &Summary) -> anyhow::Result<()> {
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .connect(scratch_url)
        .await
        .context("base d'essai injoignable")?;
    let result = restore_check_on(&pool, path, expected).await;
    pool.close().await;
    result
}

async fn restore_check_on(pool: &PgPool, path: &Path, expected: &Summary) -> anyhow::Result<()> {
    {
        let mut conn = pool.acquire().await?;
        let tables = public_tables(&mut conn).await?;
        anyhow::ensure!(
            tables.is_empty() || tables.iter().any(|t| t == SCRATCH_MARK),
            "la base d'essai contient des tables et n'a jamais servi aux vérifications : refus de l'effacer \
             (il faut une base vide, réservée à ça)"
        );
        for t in &tables {
            sqlx::query(&format!("DROP TABLE IF EXISTS {} CASCADE", ident(t)))
                .execute(&mut *conn)
                .await?;
        }
        sqlx::query(&format!(
            "CREATE TABLE {SCRATCH_MARK} (at timestamptz NOT NULL DEFAULT now())"
        ))
        .execute(&mut *conn)
        .await?;
        sqlx::query(&format!("INSERT INTO {SCRATCH_MARK} DEFAULT VALUES"))
            .execute(&mut *conn)
            .await?;
    }
    restore(pool, path, false).await?;
    let (_, again) = dump(pool, &mut std::io::sink()).await?;
    for (t, check) in &expected.tables {
        let got = again.get(t);
        anyhow::ensure!(
            got == Some(check),
            "restaurée, la table « {t} » ne redonne pas les mêmes lignes ({} au lieu de {})",
            got.map_or(0, |g| g.rows),
            check.rows
        );
    }
    anyhow::ensure!(
        again.len() == expected.tables.len(),
        "restaurée, la base n'a pas les mêmes tables"
    );
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    Schedule,
    Admin,
    Shell,
}

impl Trigger {
    fn as_str(self) -> &'static str {
        match self {
            Trigger::Schedule => "schedule",
            Trigger::Admin => "admin",
            Trigger::Shell => "shell",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verified {
    File,
    Restore,
}

#[derive(Debug)]
pub struct Outcome {
    pub id: i64,
    pub path: PathBuf,
    pub summary: Summary,
    pub verified: Verified,
}

/// Une autre sauvegarde est en cours sur cette base.
#[derive(Debug, thiserror::Error)]
#[error("une sauvegarde est déjà en cours")]
pub struct Busy;

/// Une sauvegarde est-elle en cours sur cette base (le verrou est tenu) ?
pub async fn running(db: &PgPool) -> sqlx::Result<bool> {
    sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND granted
           AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
           AND classid = 0::oid AND objid = ($1::bigint)::oid AND objsubid = 1)",
    )
    .bind(LOCK_KEY)
    .fetch_one(db)
    .await
}

fn file_name(at: DateTime<Utc>) -> String {
    format!("guivault-{}.jsonl.gz", at.format("%Y%m%d-%H%M%S%3f"))
}

/// Les sauvegardes de ce dossier, de la plus récente à la plus ancienne (le
/// nom porte la date) — seulement celles que GuiVault a nommées.
fn backups_in(dir: &Path) -> std::io::Result<Vec<PathBuf>> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("guivault-") && n.ends_with(".jsonl.gz"))
        })
        .collect();
    files.sort();
    files.reverse();
    Ok(files)
}

/// Un passage complet : écrire, vérifier (le fichier, puis la restauration
/// si une base d'essai est configurée), le noter dans `backup_runs`, et
/// n'en garder que `keep`. Rien n'est effacé si ce passage a échoué.
pub async fn run(db: &PgPool, cfg: &BackupConfig, main_url: &str, trigger: Trigger) -> anyhow::Result<Outcome> {
    let mut lock = db.acquire().await?;
    let got: bool = sqlx::query_scalar("SELECT pg_try_advisory_lock($1)")
        .bind(LOCK_KEY)
        .fetch_one(&mut *lock)
        .await?;
    if !got {
        return Err(Busy.into());
    }
    // Un passage interrompu (arrêt du serveur) ne reste pas « en cours ».
    sqlx::query("UPDATE backup_runs SET finished_at = now(), error = 'interrompue' WHERE finished_at IS NULL")
        .execute(&mut *lock)
        .await?;
    let id: i64 = sqlx::query_scalar("INSERT INTO backup_runs (triggered_by) VALUES ($1) RETURNING id")
        .bind(trigger.as_str())
        .fetch_one(&mut *lock)
        .await?;
    let result = produce(db, cfg, main_url).await;
    let outcome = match result {
        Ok((path, summary, verified)) => {
            sqlx::query(
                "UPDATE backup_runs SET finished_at = now(), file = $2, bytes = $3, row_count = $4, sha256 = $5, verified = $6
                 WHERE id = $1",
            )
            .bind(id)
            .bind(path.file_name().map(|n| n.to_string_lossy().into_owned()))
            .bind(summary.bytes as i64)
            .bind(summary.rows() as i64)
            .bind(&summary.sha256)
            .bind(match verified {
                Verified::File => "file",
                Verified::Restore => "restore",
            })
            .execute(&mut *lock)
            .await?;
            for old in backups_in(&cfg.dir)?.into_iter().skip(cfg.keep) {
                if let Err(e) = std::fs::remove_file(&old) {
                    tracing::warn!(file = %old.display(), error = %e, "sauvegarde ancienne impossible à effacer");
                }
            }
            tracing::info!(file = %path.display(), bytes = summary.bytes, rows = summary.rows(), ?verified, "sauvegarde faite");
            Ok(Outcome {
                id,
                path,
                summary,
                verified,
            })
        }
        Err(e) => {
            tracing::error!(error = format!("{e:#}"), "sauvegarde échouée");
            sqlx::query("UPDATE backup_runs SET finished_at = now(), error = $2 WHERE id = $1")
                .bind(id)
                .bind(format!("{e:#}"))
                .execute(&mut *lock)
                .await?;
            Err(e)
        }
    };
    let _ = sqlx::query("SELECT pg_advisory_unlock($1)")
        .bind(LOCK_KEY)
        .execute(&mut *lock)
        .await;
    outcome
}

/// La base d'essai n'existe pas encore : on la crée sur le serveur
/// PostgreSQL de la base principale (même compte), si elle y est. C'est ce
/// qui rend la vérification par restauration sans réglage avec le
/// `docker-compose.yml` fourni.
async fn create_scratch_if_missing(db: &PgPool, url: &str) -> anyhow::Result<()> {
    use std::str::FromStr;
    let options = sqlx::postgres::PgConnectOptions::from_str(url).context("URL de la base d'essai invalide")?;
    match PgConnection::connect_with(&options).await {
        Ok(conn) => {
            conn.close().await?;
            Ok(())
        }
        Err(e) if e.as_database_error().and_then(|d| d.code()).as_deref() == Some("3D000") => {
            let name = options
                .get_database()
                .ok_or_else(|| anyhow::anyhow!("URL de la base d'essai sans nom de base"))?;
            sqlx::query(&format!("CREATE DATABASE {}", ident(name)))
                .execute(db)
                .await
                .with_context(|| format!("base d'essai « {name} » absente, et impossible à créer"))?;
            tracing::info!(base = name, "base d'essai des sauvegardes créée");
            Ok(())
        }
        Err(e) => Err(anyhow::Error::new(e).context("base d'essai injoignable")),
    }
}

/// Écrire et vérifier, sans rien noter (voir `run`).
async fn produce(db: &PgPool, cfg: &BackupConfig, main_url: &str) -> anyhow::Result<(PathBuf, Summary, Verified)> {
    std::fs::create_dir_all(&cfg.dir).with_context(|| format!("dossier {} impossible à créer", cfg.dir.display()))?;
    let path = cfg.dir.join(file_name(Utc::now()));
    let summary = create_file(db, &path).await?;
    let mut verified = Verified::File;
    if let Some(url) = &cfg.verify_database_url {
        anyhow::ensure!(url != main_url, "la base d'essai est la base du serveur : refusé");
        create_scratch_if_missing(db, url).await?;
        restore_check(url, &path, &summary).await?;
        verified = Verified::Restore;
    }
    Ok((path, summary, verified))
}

/// La boucle du serveur : toutes les dix minutes, une sauvegarde si la
/// dernière réussie a plus de `interval` — et si la dernière tentative a
/// plus d'une heure (ou de `interval`), pour qu'un échec ne se répète pas
/// en boucle.
pub async fn schedule(db: PgPool, cfg: BackupConfig, main_url: String) {
    let retry = cfg.interval.min(std::time::Duration::from_secs(3600));
    let mut tick = tokio::time::interval_at(
        tokio::time::Instant::now() + std::time::Duration::from_secs(60),
        std::time::Duration::from_secs(600),
    );
    loop {
        tick.tick().await;
        let due: sqlx::Result<bool> = sqlx::query_scalar(
            "SELECT NOT EXISTS (SELECT 1 FROM backup_runs WHERE error IS NULL AND finished_at IS NOT NULL
                                  AND started_at > now() - make_interval(secs => $1))
                AND NOT EXISTS (SELECT 1 FROM backup_runs WHERE started_at > now() - make_interval(secs => $2))",
        )
        .bind(cfg.interval.as_secs_f64())
        .bind(retry.as_secs_f64())
        .fetch_one(&db)
        .await;
        match due {
            Ok(true) => {
                // Échec déjà journalisé et noté par `run`.
                let _ = run(&db, &cfg, &main_url, Trigger::Schedule).await;
            }
            Ok(false) => {}
            Err(e) => tracing::warn!(error = %e, "sauvegardes : état illisible"),
        }
    }
}

pub const USAGE: &str = "usage :
  guivault backup create [<fichier ou dossier>]   (défaut : GUIVAULT_BACKUP_DIR, sinon le dossier courant)
  guivault backup verify <fichier> [--restore <url d'une base d'essai>]
  guivault backup restore <fichier>               (dans GUIVAULT_DATABASE_URL, qui doit être vide)";

fn database_url() -> anyhow::Result<String> {
    std::env::var("GUIVAULT_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .map_err(|_| anyhow::anyhow!("GUIVAULT_DATABASE_URL manquant"))
}

fn print_summary(s: &Summary) {
    println!(
        "schéma {} · GuiVault {} · {} · {} lignes · {} octets\nsha256 {}",
        s.header.schema,
        s.header.server_version,
        s.header.created_at.format("%Y-%m-%d %H:%M:%S UTC"),
        s.rows(),
        s.bytes,
        s.sha256
    );
    for (t, c) in &s.tables {
        println!("  {t:<22} {:>8}", c.rows);
    }
}

/// `guivault backup …` ; `args` : ce qui suit `backup`.
pub async fn cli(args: &[String]) -> anyhow::Result<()> {
    match args {
        [cmd, rest @ ..] if cmd == "create" && rest.len() <= 1 => {
            let url = database_url()?;
            let db = crate::connect_url(&url).await?;
            let target = rest
                .first()
                .map(PathBuf::from)
                .or_else(|| {
                    std::env::var("GUIVAULT_BACKUP_DIR")
                        .ok()
                        .filter(|d| !d.is_empty())
                        .map(PathBuf::from)
                })
                .unwrap_or_else(|| PathBuf::from("."));
            let path = if target.is_dir() {
                target.join(file_name(Utc::now()))
            } else {
                target
            };
            // Même verrou et même journal que le serveur, dossier choisi ici.
            let cfg = BackupConfig {
                dir: path
                    .parent()
                    .map(Path::to_path_buf)
                    .unwrap_or_else(|| PathBuf::from(".")),
                interval: std::time::Duration::from_secs(3600),
                keep: usize::MAX,
                verify_database_url: std::env::var("GUIVAULT_BACKUP_VERIFY_DATABASE_URL")
                    .ok()
                    .filter(|u| !u.is_empty()),
            };
            let out = run_to(&db, &cfg, &url, &path).await?;
            println!(
                "{} — vérifiée ({})",
                out.path.display(),
                match out.verified {
                    Verified::File => "fichier relu",
                    Verified::Restore => "restaurée dans la base d'essai",
                }
            );
            print_summary(&out.summary);
        }
        [cmd, file, rest @ ..] if cmd == "verify" => {
            let path = PathBuf::from(file);
            let summary = {
                let p = path.clone();
                tokio::task::spawn_blocking(move || verify_file(&p)).await??
            };
            match rest {
                [] => println!("{} : fichier intact", path.display()),
                [flag, url] if flag == "--restore" => {
                    restore_check(url, &path, &summary).await?;
                    println!("{} : fichier intact, et restauré à l'identique", path.display());
                }
                _ => anyhow::bail!(USAGE),
            }
            print_summary(&summary);
        }
        [cmd, file] if cmd == "restore" => {
            let url = database_url()?;
            let db = PgPoolOptions::new().max_connections(2).connect(&url).await?;
            let summary = restore(&db, Path::new(file), true).await?;
            println!("restaurée dans la base de GUIVAULT_DATABASE_URL, schéma mis à jour");
            print_summary(&summary);
        }
        _ => anyhow::bail!(USAGE),
    }
    Ok(())
}

/// `run`, mais vers un fichier précis (la ligne de commande).
async fn run_to(db: &PgPool, cfg: &BackupConfig, main_url: &str, path: &Path) -> anyhow::Result<Outcome> {
    // `run` nomme le fichier lui-même : on écrit sous ce nom, puis on
    // renomme si l'utilisateur en a choisi un autre.
    let out = run(db, cfg, main_url, Trigger::Shell).await?;
    if out.path != path {
        std::fs::rename(&out.path, path)?;
        sqlx::query("UPDATE backup_runs SET file = $2 WHERE id = $1")
            .bind(out.id)
            .bind(path.file_name().map(|n| n.to_string_lossy().into_owned()))
            .execute(db)
            .await?;
    }
    Ok(Outcome {
        path: path.to_path_buf(),
        ..out
    })
}
