create table if not exists attachments (
    id text primary key,
    thread_key text not null references sessions(thread_key) on delete cascade,
    name text not null,
    mime_type text not null,
    data bytea not null,
    source_url text,
    created_at timestamptz not null default now(),
    constraint attachments_id_len check (octet_length(id) between 1 and 128),
    constraint attachments_name_len check (octet_length(name) between 1 and 512),
    constraint attachments_mime_type_len check (octet_length(mime_type) between 1 and 255)
);

create index if not exists attachments_thread_created_idx
    on attachments (thread_key, created_at desc, id);
