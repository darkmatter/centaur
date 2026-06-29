"""Workflow-owned runtime helpers for Slack ETL.

Slack ETL should be importable without the legacy Python ``api`` package. Metric
helpers forward to the workflow host when it provides ``api.vm_metrics`` and
otherwise become no-ops, which keeps local import/discovery paths lightweight.
"""

from __future__ import annotations

import json
from typing import Any


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def _call_metric(name: str, *args: Any, **kwargs: Any) -> None:
    try:
        from api import vm_metrics  # type: ignore
    except ImportError:
        return

    metric = getattr(vm_metrics, name, None)
    if metric is None:
        return
    try:
        metric(*args, **kwargs)
    except Exception:
        return


def observe_slack_retention_run_duration(*args: Any, **kwargs: Any) -> None:
    _call_metric("observe_slack_retention_run_duration", *args, **kwargs)


def record_etl_items_deleted(*args: Any, **kwargs: Any) -> None:
    _call_metric("record_etl_items_deleted", *args, **kwargs)


def record_etl_items_enqueued(*args: Any, **kwargs: Any) -> None:
    _call_metric("record_etl_items_enqueued", *args, **kwargs)


def record_etl_items_failed(*args: Any, **kwargs: Any) -> None:
    _call_metric("record_etl_items_failed", *args, **kwargs)


def record_etl_items_seen(*args: Any, **kwargs: Any) -> None:
    _call_metric("record_etl_items_seen", *args, **kwargs)


def record_etl_items_upserted(*args: Any, **kwargs: Any) -> None:
    _call_metric("record_etl_items_upserted", *args, **kwargs)


def record_slack_etl_rate_limit(*args: Any, **kwargs: Any) -> None:
    _call_metric("record_slack_etl_rate_limit", *args, **kwargs)


def record_slack_retention_api_rate_limited(*args: Any, **kwargs: Any) -> None:
    _call_metric("record_slack_retention_api_rate_limited", *args, **kwargs)


def record_slack_retention_api_request(*args: Any, **kwargs: Any) -> None:
    _call_metric("record_slack_retention_api_request", *args, **kwargs)


def record_slack_retention_backfill_job(*args: Any, **kwargs: Any) -> None:
    _call_metric("record_slack_retention_backfill_job", *args, **kwargs)


def record_slack_retention_backfill_job_failure(*args: Any, **kwargs: Any) -> None:
    _call_metric("record_slack_retention_backfill_job_failure", *args, **kwargs)


def record_slack_retention_backfill_terminal_skip(*args: Any, **kwargs: Any) -> None:
    _call_metric("record_slack_retention_backfill_terminal_skip", *args, **kwargs)


def record_slack_retention_channel_failure(*args: Any, **kwargs: Any) -> None:
    _call_metric("record_slack_retention_channel_failure", *args, **kwargs)


def record_slack_retention_failure(*args: Any, **kwargs: Any) -> None:
    _call_metric("record_slack_retention_failure", *args, **kwargs)


def record_slack_retention_messages_processed(*args: Any, **kwargs: Any) -> None:
    _call_metric("record_slack_retention_messages_processed", *args, **kwargs)


def record_slack_retention_run(*args: Any, **kwargs: Any) -> None:
    _call_metric("record_slack_retention_run", *args, **kwargs)


def set_etl_active_scopes(*args: Any, **kwargs: Any) -> None:
    _call_metric("set_etl_active_scopes", *args, **kwargs)


def set_etl_backfill_job_age_seconds(*args: Any, **kwargs: Any) -> None:
    _call_metric("set_etl_backfill_job_age_seconds", *args, **kwargs)


def set_etl_backfill_jobs(*args: Any, **kwargs: Any) -> None:
    _call_metric("set_etl_backfill_jobs", *args, **kwargs)


def set_etl_failed_scopes(*args: Any, **kwargs: Any) -> None:
    _call_metric("set_etl_failed_scopes", *args, **kwargs)


def set_etl_scope_sync_freshness_seconds(*args: Any, **kwargs: Any) -> None:
    _call_metric("set_etl_scope_sync_freshness_seconds", *args, **kwargs)


def set_slack_retention_last_failure_timestamp(*args: Any, **kwargs: Any) -> None:
    _call_metric("set_slack_retention_last_failure_timestamp", *args, **kwargs)


def set_slack_retention_watermark_lag_seconds(*args: Any, **kwargs: Any) -> None:
    _call_metric("set_slack_retention_watermark_lag_seconds", *args, **kwargs)
