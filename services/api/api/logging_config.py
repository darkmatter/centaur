"""Shared structlog configuration for API and CLI."""

from __future__ import annotations

import os
import sys

import structlog

_LOG_LEVELS = {"critical": 50, "error": 40, "warning": 30, "info": 20, "debug": 10}


def _add_default_service(logger, method_name, event_dict):
    """Ensure API logs always carry a service name for downstream queries."""
    event_dict.setdefault("service", os.getenv("CENTAUR_SERVICE_NAME", "api"))
    return event_dict


def _add_vlogs_msg(logger, method_name, event_dict):
    """Copy event to _msg for VictoriaLogs compatibility."""
    event_dict.setdefault("_msg", event_dict.get("msg") or event_dict.get("event", ""))
    return event_dict


def configure_structlog() -> int:
    """Configure structlog with JSON (prod) or console (dev) rendering.

    Returns the resolved log level integer.
    """
    log_level = _LOG_LEVELS.get(
        (os.getenv("CENTAUR_LOG_LEVEL") or os.getenv("LOG_LEVEL") or "info").lower(), 20
    )
    is_dev = sys.stderr.isatty()
    processors = [
        structlog.contextvars.merge_contextvars,
        _add_default_service,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso", key="timestamp"),
    ]
    if is_dev:
        processors.append(structlog.dev.ConsoleRenderer())
    else:
        processors.append(_add_vlogs_msg)
        processors.append(structlog.processors.JSONRenderer())
    structlog.configure(
        logger_factory=structlog.PrintLoggerFactory(file=sys.stdout),
        wrapper_class=structlog.make_filtering_bound_logger(log_level),
        processors=processors,
    )
    return log_level
