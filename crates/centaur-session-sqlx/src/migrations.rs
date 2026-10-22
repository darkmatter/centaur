//! Embedded schema migrations.
//!
//! Core migrations work on any PostgreSQL server with pgvector. Keyword search
//! indexes come from exactly one text-search backend per database. Each
//! backend's migrations share the core version sequence and are merged into it
//! by version, so every search migration runs right after the core migrations
//! it was written against, on fresh and existing databases alike.
//!
//! Applied core migration files are immutable (`migrations/migrations.lock`).
//! Where a file's SQL must no longer run as written, the replacement lives in
//! `core-migration-overrides/` under the same file name and runs with the
//! original file's checksum, which is what existing databases recorded.

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

/// SQL that runs in place of an immutable core migration file, keeping that
/// file's checksum.
///
/// - 12, 28, 29, 30, 40, and 46 created ParadeDB BM25 indexes before keyword
///   search moved to the text-search backends (`search-migrations/*/0061_*`).
///   Their overrides only delete the `pg_search` statements.
/// - 54 arrived from upstream with a harness constraint that omits the fork's
///   `omp` harness, so applying it as written fails on databases with `omp`
///   sessions. Its override keeps `omp` in the allowed set.
const CORE_SQL_OVERRIDES: [(i64, &str); 7] = [
    (
        12,
        include_str!("../core-migration-overrides/0012_company_context_documents.sql"),
    ),
    (
        28,
        include_str!("../core-migration-overrides/0028_slack_dm_context_documents.sql"),
    ),
    (
        29,
        include_str!(
            "../core-migration-overrides/0029_slack_dm_conversation_context_documents.sql"
        ),
    ),
    (
        30,
        include_str!("../core-migration-overrides/0030_google_docs_oauth_sync_tables.sql"),
    ),
    (
        40,
        include_str!("../core-migration-overrides/0040_granola_sync_tables.sql"),
    ),
    (
        46,
        include_str!("../core-migration-overrides/0046_slack_private_channel_oauth_sync.sql"),
    ),
    (
        54,
        include_str!("../core-migration-overrides/0054_hermes_harness.sql"),
    ),
];

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
pub fn migration_list(backend: TextSearchBackend) -> Vec<Migration> {
    let mut migrations: Vec<Migration> = CORE_MIGRATOR
        .iter()
        .cloned()
        .map(|mut migration| {
            if let Some((_, sql)) = CORE_SQL_OVERRIDES
                .iter()
                .find(|(version, _)| *version == migration.version)
            {
                // `checksum` stays the file's, as databases recorded it.
                migration.sql = Cow::Borrowed(sql);
            }
            migration
        })
        .chain(backend.migrator().iter().cloned())
        .collect();
    migrations.sort_by_key(|migration| migration.version);
    migrations
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
    Migrator::new(MigrationList(migration_list(backend)))
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
            let merged = migration_list(backend);
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

    /// Core migrations that created BM25 indexes before the backends split.
    const BM25_CORE_VERSIONS: [i64; 6] = [12, 28, 29, 30, 40, 46];

    /// Whether any statement, ignoring `--` comment lines, needs ParadeDB.
    fn needs_paradedb(sql: &str) -> bool {
        sql.lines()
            .filter(|line| !line.trim_start().starts_with("--"))
            .map(str::to_ascii_lowercase)
            .any(|line| line.contains("bm25") || line.contains("pg_search"))
    }

    #[test]
    fn overrides_change_only_sql_of_their_core_migrations() {
        let overridden: BTreeSet<i64> = CORE_SQL_OVERRIDES
            .iter()
            .map(|(version, _)| *version)
            .collect();
        assert_eq!(overridden.len(), CORE_SQL_OVERRIDES.len());
        for backend in TextSearchBackend::ALL {
            let merged = migration_list(backend);
            let mut changed = BTreeSet::new();
            for original in CORE_MIGRATOR.iter() {
                let migration = merged
                    .iter()
                    .find(|migration| migration.version == original.version)
                    .expect("core migration is merged");
                assert_eq!(
                    migration.checksum, original.checksum,
                    "{backend} migration {} changes the checksum databases recorded",
                    original.version
                );
                if migration.sql != original.sql {
                    changed.insert(original.version);
                }
            }
            assert_eq!(changed, overridden, "{backend} overrides the wrong SQL");
        }
    }

    #[test]
    fn bm25_overrides_only_delete_paradedb_statements() {
        let merged = migration_list(TextSearchBackend::Postgres);
        for version in BM25_CORE_VERSIONS {
            let original = CORE_MIGRATOR
                .iter()
                .find(|migration| migration.version == version)
                .expect("BM25 core migration exists");
            let applied = merged
                .iter()
                .find(|migration| migration.version == version)
                .expect("BM25 core migration is merged");
            assert!(needs_paradedb(&original.sql));
            assert!(
                !needs_paradedb(&applied.sql),
                "override for {version} still needs ParadeDB"
            );
            // Every override line appears in the original, in order.
            let mut original_lines = original.sql.lines();
            for line in applied.sql.lines() {
                assert!(
                    original_lines.any(|original| original == line),
                    "override for {version} adds or reorders {line:?}"
                );
            }
        }
        for migration in merged {
            assert!(
                !needs_paradedb(&migration.sql),
                "core or postgres migration {} needs ParadeDB",
                migration.version
            );
        }
    }

    #[test]
    fn hermes_override_keeps_omp_sessions_valid() {
        let original = CORE_MIGRATOR
            .iter()
            .find(|migration| migration.version == 54)
            .expect("hermes migration exists");
        let (_, applied) = CORE_SQL_OVERRIDES
            .iter()
            .find(|(version, _)| *version == 54)
            .expect("hermes override exists");
        let upstream = "'codex', 'amp', 'claudecode', 'nanocodex', 'hermes'";
        let fork = "'codex', 'amp', 'claudecode', 'nanocodex', 'omp', 'hermes'";
        assert!(original.sql.contains(upstream));
        assert_eq!(*applied, original.sql.replacen(upstream, fork, 1));
    }
}
