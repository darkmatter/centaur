from __future__ import annotations

NON_RETRYABLE_ERROR_CLASSES = frozenset({
    "invalid_destination",
    "restricted_destination",
    "invalid_payload",
    "duplicate_or_conflict",
})


def normalize_error_class(error_class: str | None) -> str | None:
    if not error_class:
        return None
    normalized = error_class.strip().lower()
    return normalized or None


def should_dead_letter_failure(
    *,
    non_retryable: bool,
    error_class: str | None,
    attempt_count: int,
    max_attempts: int,
) -> bool:
    normalized = normalize_error_class(error_class)
    return (
        non_retryable
        or (normalized in NON_RETRYABLE_ERROR_CLASSES)
        or attempt_count >= max_attempts
    )


def requires_delivery_lease(*, non_retryable: bool, error_class: str | None) -> bool:
    normalized = normalize_error_class(error_class)
    return non_retryable or normalized in NON_RETRYABLE_ERROR_CLASSES


def format_last_error(error: str, error_class: str | None) -> str:
    normalized = normalize_error_class(error_class)
    if not normalized:
        return error
    return f"{normalized}: {error}"
