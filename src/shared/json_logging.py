"""Lightweight JSON logging for services that don't use structlog.

Outputs NDJSON to stdout with a consistent schema:
    {"timestamp": "...", "level": "info", "service": "...", "event": "...", "msg": "..."}

Usage:
    from shared.json_logging import configure_json_logger
    log = configure_json_logger("secret_manager", "secret_manager")
    log.info("secrets_loaded", extra={"event": "secrets_loaded", "count": 42})
"""

from __future__ import annotations

import json
import logging
import os
import sys
from datetime import datetime, timezone

_RESERVED = {
    "name", "msg", "args", "created", "relativeCreated", "exc_info", "exc_text",
    "stack_info", "lineno", "funcName", "pathname", "filename", "module",
    "levelno", "levelname", "msecs", "thread", "threadName", "process",
    "processName", "taskName", "message", "asctime",
}


class JsonFormatter(logging.Formatter):
    """Formats log records as single-line JSON objects."""

    def __init__(self, service: str) -> None:
        super().__init__()
        self.service = service

    def format(self, record: logging.LogRecord) -> str:
        event = getattr(record, "event", None) or record.funcName or record.name
        payload: dict[str, object] = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname.lower(),
            "service": self.service,
            "event": event,
            "msg": record.getMessage(),
        }
        for k, v in record.__dict__.items():
            if k not in _RESERVED and k not in payload:
                payload[k] = v
        if record.exc_info and record.exc_info[0] is not None:
            payload["stack"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


def configure_json_logger(
    name: str,
    service: str,
    *,
    isolate: bool = False,
) -> logging.Logger:
    """Configure a named logger that writes JSON to stdout.

    Args:
        name: Logger name (e.g. "firewall", "secret_manager").
        service: Value for the ``service`` field in every log line.
        isolate: If True, set propagate=False so parent/root loggers
                 don't duplicate or reformat our output.
    """
    logger = logging.getLogger(name)
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter(service))
    logger.handlers = [handler]
    logger.setLevel(os.getenv("LOG_LEVEL", "INFO").upper())
    logger.propagate = not isolate
    return logger
