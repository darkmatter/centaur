create table if not exists session_pipe_leases (
    sandbox_id text primary key,
    thread_key text not null references sessions(thread_key) on delete cascade,
    holder_id text not null,
    lease_expires_at timestamptz not null,
    updated_at timestamptz not null default now()
);

create index if not exists session_pipe_leases_expires_idx
    on session_pipe_leases (lease_expires_at);
