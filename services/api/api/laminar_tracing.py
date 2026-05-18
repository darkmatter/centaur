from __future__ import annotations

import os
import inspect
import uuid
from contextlib import contextmanager, nullcontext
from typing import Any

import structlog

log = structlog.get_logger().bind(component="laminar")

_initialized = False
_available = True


def install_laminar_compat() -> None:
    """Keep optional tool dependencies compatible with the PyPI Laminar SDK.

    Some optional tool dependencies call lmnr.observe with newer keyword
    arguments than the current public lmnr package accepts. Drop unsupported
    kwargs so tool discovery still succeeds.
    """
    try:
        import lmnr
    except Exception:
        return

    observe = getattr(lmnr, "observe", None)
    if not callable(observe) or getattr(observe, "_centaur_compat", False):
        return
    supported_kwargs = set(inspect.signature(observe).parameters)
    if {"metadata", "tags"}.issubset(supported_kwargs):
        return

    def observe_compat(*args: Any, **kwargs: Any):
        kwargs = {key: value for key, value in kwargs.items() if key in supported_kwargs}
        return observe(*args, **kwargs)

    observe_compat._centaur_compat = True  # type: ignore[attr-defined]
    lmnr.observe = observe_compat


def laminar_enabled() -> bool:
    return bool((os.getenv("LMNR_PROJECT_API_KEY") or "").strip())


def _optional_int_env(name: str) -> int | None:
    value = (os.getenv(name) or "").strip()
    if not value:
        return None
    try:
        return int(value)
    except ValueError:
        log.warning("laminar_invalid_port", env=name, value=value)
        return None


def initialize_laminar(*, service: str) -> None:
    global _available, _initialized
    install_laminar_compat()
    if _initialized or not laminar_enabled():
        return
    try:
        from lmnr import Instruments, Laminar
    except Exception as exc:
        _available = False
        log.warning("laminar_import_failed", service=service, error=str(exc))
        return

    try:
        Laminar.initialize(
            project_api_key=os.getenv("LMNR_PROJECT_API_KEY"),
            base_url=os.getenv("LMNR_BASE_URL") or "https://api.lmnr.ai",
            http_port=_optional_int_env("LMNR_HTTP_PORT"),
            grpc_port=_optional_int_env("LMNR_GRPC_PORT"),
            instruments={Instruments.OPENAI, Instruments.ANTHROPIC},
        )
        _initialized = True
        log.info("laminar_initialized", service=service)
    except Exception as exc:
        log.warning("laminar_initialize_failed", service=service, error=str(exc))


def start_span(
    *,
    name: str,
    span_type: str = "DEFAULT",
    metadata: dict[str, Any] | None = None,
    trace_id: str | None = None,
    ignore_input: bool = True,
    ignore_output: bool = True,
):
    if not (_available and _initialized):
        return nullcontext()
    try:
        from lmnr import Laminar

        @contextmanager
        def _span_context():
            with _synthetic_parent_trace(trace_id):
                with Laminar.start_as_current_span(name=name, span_type=span_type) as span:
                    if metadata:
                        span.set_attributes(
                            {
                                f"centaur.metadata.{key}": value
                                for key, value in metadata.items()
                            }
                        )
                    yield span

        return _span_context()
    except Exception as exc:
        log.debug("laminar_start_span_failed", span=name, error=str(exc))
        return nullcontext()


@contextmanager
def _synthetic_parent_trace(trace_id: str | None):
    if not trace_id:
        yield
        return
    try:
        parsed = uuid.UUID(trace_id)
        if parsed.int == 0:
            yield
            return
        from opentelemetry import context as otel_context
        from opentelemetry import trace
        from opentelemetry.trace import (
            NonRecordingSpan,
            SpanContext,
            TraceFlags,
            TraceState,
        )

        current = trace.get_current_span()
        if current and current.get_span_context().is_valid:
            yield
            return
        parent = NonRecordingSpan(
            SpanContext(
                trace_id=parsed.int,
                span_id=int.from_bytes(os.urandom(8), "big") or 1,
                is_remote=True,
                trace_flags=TraceFlags(TraceFlags.SAMPLED),
                trace_state=TraceState(),
            )
        )
        token = otel_context.attach(trace.set_span_in_context(parent))
        try:
            yield
        finally:
            otel_context.detach(token)
    except Exception as exc:
        log.debug("laminar_parent_trace_failed", error=str(exc))
        yield


def set_trace_context(
    *,
    user_id: str | None = None,
    session_id: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> None:
    if not (_available and _initialized):
        return
    try:
        from lmnr import Laminar

        if session_id:
            Laminar.set_session(session_id=session_id)
        trace_metadata = {key: str(value) for key, value in (metadata or {}).items()}
        if user_id:
            trace_metadata.setdefault("user_id", user_id)
        if trace_metadata:
            Laminar.set_metadata(trace_metadata)
    except Exception as exc:
        log.debug("laminar_set_trace_context_failed", error=str(exc))


def set_span_attributes(attributes: dict[str, Any]) -> None:
    if not (_available and _initialized):
        return
    try:
        from opentelemetry import trace

        span = trace.get_current_span()
        if not span or span == trace.INVALID_SPAN:
            return
        for key, value in attributes.items():
            if isinstance(value, (str, int, float, bool)):
                span.set_attribute(key, value)
            else:
                span.set_attribute(key, str(value))
    except Exception as exc:
        log.debug("laminar_set_span_attributes_failed", error=str(exc))
