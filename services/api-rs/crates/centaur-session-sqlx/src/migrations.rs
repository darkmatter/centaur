//! Embedded schema migrations.
//!
//! Core migrations work on any PostgreSQL server with pgvector. Keyword search
//! indexes come from exactly one text-search backend per database. Each
//! backend's migrations share the core version sequence and are merged into it
//! by version, so every search migration runs right after the core migrations
//! it was written against, on fresh and existing databases alike.

use std::{borrow::Cow, fmt, future::Future, pin::Pin, str::FromStr};

use sqlx::{
    PgConnection,
    error::BoxDynError,
    migrate::{Migration, MigrationSource, Migrator},
};

use crate::SessionStoreError;

// The API binary embeds these migrations at compile time.
static CORE_MIGRATOR: Migrator = sqlx::migrate!("./migrations");
static PARADEDB_MIGRATOR: Migrator = sqlx::migrate!("./search-migrations/paradedb");
static POSTGRES_MIGRATOR: Migrator = sqlx::migrate!("./search-migrations/postgres");

/// Core migrations whose ParadeDB statements moved to the `paradedb`
/// text-search backend, as they run today. Files under `./migrations` stay
/// byte-identical (`migrations/migrations.lock`), so every migration keeps the
/// checksum databases recorded before the backends split; only the SQL that a
/// pending migration runs comes from here.
const CORE_REWRITES: [(i64, &str); 6] = [
    (
        12,
        include_str!("../core-migration-rewrites/0012_company_context_documents.sql"),
    ),
    (
        28,
        include_str!("../core-migration-rewrites/0028_slack_dm_context_documents.sql"),
    ),
    (
        29,
        include_str!("../core-migration-rewrites/0029_slack_dm_conversation_context_documents.sql"),
    ),
    (
        30,
        include_str!("../core-migration-rewrites/0030_google_docs_oauth_sync_tables.sql"),
    ),
    (
        40,
        include_str!("../core-migration-rewrites/0040_granola_sync_tables.sql"),
    ),
    (
        46,
        include_str!("../core-migration-rewrites/0046_slack_private_channel_oauth_sync.sql"),
    ),
];

const HERMES_HARNESS_MIGRATION_VERSION: i64 = 54;
const UPSTREAM_HERMES_HARNESS_SET: &str = "'codex', 'amp', 'claudecode', 'nanocodex', 'hermes'";
const FORK_HERMES_HARNESS_SET: &str = "'codex', 'amp', 'claudecode', 'nanocodex', 'omp', 'hermes'";

/// Tables that core migrations gave BM25 indexes before the backends split.
const LEGACY_BM25_TABLES: [&str; 5] = [
    "company_context_documents",
    "google_docs_context_documents",
    "granola_context_documents",
    "slack_private_context_documents",
    "slack_private_conversation_context_documents",
];

/// Keyword search implementation installed in a database.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TextSearchBackend {
    /// ParadeDB `pg_search` BM25 indexes.
    Paradedb,
    /// Built-in PostgreSQL full-text search (`tsvector` and GIN).
    Postgres,
}

impl TextSearchBackend {
    pub const ALL: [Self; 2] = [Self::Paradedb, Self::Postgres];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Paradedb => "paradedb",
            Self::Postgres => "postgres",
        }
    }

    fn migrator(self) -> &'static Migrator {
        match self {
            Self::Paradedb => &PARADEDB_MIGRATOR,
            Self::Postgres => &POSTGRES_MIGRATOR,
        }
    }
}

impl fmt::Display for TextSearchBackend {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for TextSearchBackend {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|backend| backend.as_str() == value)
            .ok_or_else(|| {
                format!("unknown text search backend {value:?}; expected paradedb or postgres")
            })
    }
}

/// Core migrations merged with one text-search backend, in version order.
///
/// Every migration keeps the checksum of its locked file; rewritten core
/// migrations and the fork's version 54 only change the SQL a pending
/// migration runs.
pub fn migration_list(backend: TextSearchBackend) -> Result<Vec<Migration>, SessionStoreError> {
    let mut migrations: Vec<Migration> = CORE_MIGRATOR
        .iter()
        .cloned()
        .map(|mut migration| {
            if let Some((_, sql)) = CORE_REWRITES
                .iter()
                .find(|(version, _)| *version == migration.version)
            {
                migration.sql = Cow::Borrowed(sql);
            }
            migration
        })
        .chain(backend.migrator().iter().cloned())
        .collect();
    patch_hermes_harness_migration(&mut migrations)?;
    migrations.sort_by_key(|migration| migration.version);
    Ok(migrations)
}

/// Version 54 came from upstream before the fork-only `omp` harness was
/// upstreamed. Keep its immutable checksum, but preserve `omp` when SQLx
/// applies that still-pending migration. Already-applied version 54 rows are
/// checksum-validated and skipped by SQLx as usual.
fn patch_hermes_harness_migration(migrations: &mut [Migration]) -> Result<(), SessionStoreError> {
    let migration = migrations
        .iter_mut()
        .find(|migration| migration.version == HERMES_HARNESS_MIGRATION_VERSION)
        .ok_or_else(|| {
            SessionStoreError::InvalidMigration(format!(
                "missing version {HERMES_HARNESS_MIGRATION_VERSION}"
            ))
        })?;
    let patched_sql =
        migration
            .sql
            .replacen(UPSTREAM_HERMES_HARNESS_SET, FORK_HERMES_HARNESS_SET, 1);
    if patched_sql == migration.sql {
        return Err(SessionStoreError::InvalidMigration(format!(
            "version {HERMES_HARNESS_MIGRATION_VERSION} no longer contains the upstream harness constraint"
        )));
    }
    migration.sql = Cow::Owned(patched_sql);
    Ok(())
}

/// Apply pending migrations for `backend`.
///
/// Fails without changing the database when it was migrated with another
/// text-search backend, or when `postgres` is configured for a database that
/// still has BM25 indexes.
pub async fn migrate(
    conn: &mut PgConnection,
    backend: TextSearchBackend,
) -> Result<(), SessionStoreError> {
    ensure_text_search_backend(conn, backend).await?;
    Migrator::new(MigrationList(migration_list(backend)?))
        .await?
        .run(conn)
        .await?;
    Ok(())
}

async fn ensure_text_search_backend(
    conn: &mut PgConnection,
    backend: TextSearchBackend,
) -> Result<(), SessionStoreError> {
    if backend == TextSearchBackend::Postgres {
        // Databases migrated before the backends split carry BM25 indexes from
        // core migrations. They can be large, so never drop them implicitly;
        // such a database keeps the paradedb backend.
        let indexes: Vec<String> = sqlx::query_scalar(
            "select index.relname::text
             from pg_index
             join pg_class index on index.oid = pg_index.indexrelid
             join pg_class tables on tables.oid = pg_index.indrelid
             join pg_am am on am.oid = index.relam
             where am.amname = 'bm25'
               and tables.relnamespace = current_schema()::regnamespace
               and tables.relname = any($1)
             order by 1",
        )
        .bind(&LEGACY_BM25_TABLES[..])
        .fetch_all(&mut *conn)
        .await?;
        if !indexes.is_empty() {
            return Err(SessionStoreError::Bm25IndexesPresent { indexes });
        }
    }
    let tracked: bool = sqlx::query_scalar("select to_regclass('_sqlx_migrations') is not null")
        .fetch_one(&mut *conn)
        .await?;
    if !tracked {
        return Ok(());
    }
    let applied: Vec<(i64, Vec<u8>)> =
        sqlx::query_as("select version, checksum from _sqlx_migrations")
            .fetch_all(&mut *conn)
            .await?;
    for (version, checksum) in applied {
        let matches = |candidate: TextSearchBackend| {
            candidate
                .migrator()
                .iter()
                .any(|migration| migration.version == version && *migration.checksum == *checksum)
        };
        if matches(backend) {
            continue;
        }
        if let Some(applied) = TextSearchBackend::ALL
            .into_iter()
            .find(|candidate| *candidate != backend && matches(*candidate))
        {
            return Err(SessionStoreError::TextSearchBackendMismatch {
                configured: backend,
                applied,
            });
        }
    }
    Ok(())
}

#[derive(Debug)]
struct MigrationList(Vec<Migration>);

impl<'s> MigrationSource<'s> for MigrationList {
    fn resolve(
        self,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<Migration>, BoxDynError>> + Send + 's>> {
        Box::pin(async move { Ok(self.0) })
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;

    fn versions(migrator: &Migrator) -> BTreeSet<i64> {
        migrator.iter().map(|migration| migration.version).collect()
    }

    #[test]
    fn search_versions_do_not_collide_with_core_versions() {
        let core = versions(&CORE_MIGRATOR);
        assert_eq!(core.len(), CORE_MIGRATOR.iter().count());
        for backend in TextSearchBackend::ALL {
            let search = versions(backend.migrator());
            assert_eq!(search.len(), backend.migrator().iter().count());
            let collisions: Vec<_> = core.intersection(&search).collect();
            assert!(
                collisions.is_empty(),
                "{backend} migrations reuse core versions {collisions:?}"
            );
        }
    }

    #[test]
    fn every_backend_carries_every_search_version() {
        let [first, rest @ ..] = TextSearchBackend::ALL;
        for backend in rest {
            assert_eq!(
                versions(first.migrator()),
                versions(backend.migrator()),
                "{first} and {backend} migrations must share versions; add a no-op migration where nothing changes"
            );
        }
    }

    #[test]
    fn merged_list_is_ordered_and_complete() {
        for backend in TextSearchBackend::ALL {
            let merged = migration_list(backend).expect("migration list");
            assert!(
                merged
                    .windows(2)
                    .all(|pair| pair[0].version < pair[1].version)
            );
            assert_eq!(
                merged.len(),
                CORE_MIGRATOR.iter().count() + backend.migrator().iter().count()
            );
        }
    }

    #[test]
    fn rewrites_change_only_the_sql_of_core_migrations() {
        let core = versions(&CORE_MIGRATOR);
        for (version, _) in CORE_REWRITES {
            assert!(
                core.contains(&version),
                "rewritten version {version} is not a core migration"
            );
        }
        let merged = migration_list(TextSearchBackend::Postgres).expect("migration list");
        for (migration, original) in merged
            .iter()
            .filter(|migration| core.contains(&migration.version))
            .zip(CORE_MIGRATOR.iter())
        {
            assert_eq!(migration.version, original.version);
            assert_eq!(
                migration.checksum, original.checksum,
                "core migration {} must keep its recorded checksum",
                migration.version
            );
            let rewritten = CORE_REWRITES
                .iter()
                .any(|(version, _)| *version == migration.version)
                || migration.version == HERMES_HARNESS_MIGRATION_VERSION;
            assert_eq!(migration.sql != original.sql, rewritten);
        }
    }

    #[test]
    fn rewrites_drop_every_paradedb_statement() {
        for (version, sql) in CORE_REWRITES {
            let sql = sql.to_ascii_lowercase();
            assert!(
                !sql.contains("bm25") && !sql.contains("pg_search") && !sql.contains("paradedb."),
                "rewritten core migration {version} still requires ParadeDB"
            );
        }
    }

    #[test]
    fn hermes_migration_keeps_the_fork_harness() {
        let merged = migration_list(TextSearchBackend::Postgres).expect("migration list");
        let hermes = merged
            .iter()
            .find(|migration| migration.version == HERMES_HARNESS_MIGRATION_VERSION)
            .expect("hermes migration");
        assert!(hermes.sql.contains(FORK_HERMES_HARNESS_SET));
    }
}
