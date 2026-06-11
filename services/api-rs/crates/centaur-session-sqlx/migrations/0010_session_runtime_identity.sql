alter table session_executions
    add column if not exists base_image_ref text,
    add column if not exists base_image_hash text,
    add column if not exists overlay_hash text,
    add column if not exists model text,
    add column if not exists harness_run_id text;
