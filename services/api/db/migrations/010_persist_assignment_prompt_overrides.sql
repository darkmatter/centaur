-- migrate:up

ALTER TABLE agent_runtime_assignments
    ADD COLUMN IF NOT EXISTS agents_md_override TEXT;

-- migrate:down

ALTER TABLE agent_runtime_assignments
    DROP COLUMN IF EXISTS agents_md_override;
