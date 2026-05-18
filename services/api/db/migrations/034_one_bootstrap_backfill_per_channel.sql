-- migrate:up

CREATE UNIQUE INDEX IF NOT EXISTS uq_slack_sync_channel_bootstrap_backfill
    ON slack_sync_backfill_jobs (channel_id)
    WHERE job_type = 'channel_bootstrap';

-- migrate:down

DROP INDEX IF EXISTS uq_slack_sync_channel_bootstrap_backfill;
