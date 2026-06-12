create table if not exists agent_profiles (
    profile_id text primary key,
    display_name text not null,
    distribution_ref text,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint agent_profiles_id_len
        check (octet_length(profile_id) between 1 and 128),
    constraint agent_profiles_id_no_control
        check (profile_id !~ '[[:cntrl:]]'),
    constraint agent_profiles_display_name_len
        check (octet_length(display_name) between 1 and 512),
    constraint agent_profiles_distribution_ref_len
        check (distribution_ref is null or octet_length(distribution_ref) between 1 and 1024)
);

create table if not exists agent_boxes (
    box_id text primary key,
    profile_id text not null references agent_profiles(profile_id) on delete restrict,
    owner_scope text not null,
    owner_key text not null,
    state_volume_key text not null unique,
    active_sandbox_id text unique,
    egress_principal_id text,
    status text not null,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    last_used_at timestamptz not null default now(),
    constraint agent_boxes_id_len
        check (octet_length(box_id) between 1 and 128),
    constraint agent_boxes_id_no_control
        check (box_id !~ '[[:cntrl:]]'),
    constraint agent_boxes_owner_scope_supported
        check (owner_scope in ('user', 'team', 'channel', 'project', 'repo', 'thread', 'custom')),
    constraint agent_boxes_owner_key_len
        check (octet_length(owner_key) between 1 and 256),
    constraint agent_boxes_owner_key_no_control
        check (owner_key !~ '[[:cntrl:]]'),
    constraint agent_boxes_state_volume_key_len
        check (octet_length(state_volume_key) between 1 and 253),
    constraint agent_boxes_active_sandbox_id_len
        check (active_sandbox_id is null or octet_length(active_sandbox_id) between 1 and 253),
    constraint agent_boxes_egress_principal_len
        check (egress_principal_id is null or octet_length(egress_principal_id) between 1 and 256),
    constraint agent_boxes_status_supported
        check (status in ('active', 'suspended', 'failed'))
);

create unique index if not exists agent_boxes_owner_profile_idx
    on agent_boxes (owner_scope, owner_key, profile_id);

create index if not exists agent_boxes_status_last_used_idx
    on agent_boxes (status, last_used_at desc);

create index if not exists agent_boxes_active_sandbox_idx
    on agent_boxes (active_sandbox_id)
    where active_sandbox_id is not null;

create table if not exists agent_box_access_grants (
    box_id text not null references agent_boxes(box_id) on delete cascade,
    principal_id text not null,
    role text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (box_id, principal_id),
    constraint agent_box_access_principal_len
        check (octet_length(principal_id) between 1 and 256),
    constraint agent_box_access_principal_no_control
        check (principal_id !~ '[[:cntrl:]]'),
    constraint agent_box_access_role_supported
        check (role in ('owner', 'member', 'viewer', 'automation'))
);

create index if not exists agent_box_access_principal_idx
    on agent_box_access_grants (principal_id, role);
