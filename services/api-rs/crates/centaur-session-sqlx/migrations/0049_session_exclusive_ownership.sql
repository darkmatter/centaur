-- Durable single-owner boundary for an OMP session.
--
-- A resident collaboration host and the one-shot Slack/API harness must never
-- concurrently resume or write the same session. This row is the atomic fence:
-- exactly one owner holds the session at a time, with a fencing (generation)
-- value that stale owners cannot match after a loss/reacquire cycle.
--
-- The boundary is session-scoped (one row per thread_key) and independent of
-- per-execution stdout-owner leases: stdout ownership serializes output pumping
-- for a single execution, while session ownership serializes *acquisition*
-- itself — a normal one-shot execution cannot start against a resident-owned
-- session, and a resident host cannot reclaim a session whose lease another
-- resident has already taken over.

create table if not exists session_owners (
    thread_key text primary key references sessions(thread_key) on delete cascade,
    owner_id text not null,
    generation bigint not null,
    mode text not null,
    lease_expires_at timestamptz not null,
    acquired_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint session_owners_mode_supported
        check (mode in ('resident', 'oneshot'))
);

-- Fast lookup of expired/resident leases for adoption scans.
create index if not exists session_owners_lease_expires_idx
    on session_owners (lease_expires_at);
