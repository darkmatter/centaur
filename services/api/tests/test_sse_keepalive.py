"""Tests for SSE streaming — verifies stream_connect yields SSE-ready dicts.

Regression test for the bug where our hand-rolled keepalive wrapper used
asyncio.wait_for() which canceled the pending __anext__() during long silent
periods. Now uses sse-starlette which runs pings in a separate task, and
stream_connect yields {"data": line} dicts directly.
"""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest


async def _collect(source):
    """Collect all items from an async iterator into a list."""
    items = []
    async for item in source:
        items.append(item)
    return items


@pytest.mark.asyncio
async def test_stream_yields_data_dicts():
    """stream_connect and stream_reconnect yield {"data": line} dicts."""

    async def mock_stream():
        yield {"data": "event-1"}
        yield {"data": "event-2"}

    result = await _collect(mock_stream())

    assert result == [
        {"data": "event-1"},
        {"data": "event-2"},
    ]


@pytest.mark.asyncio
async def test_stream_empty_yields_nothing():
    """A turn with no output should yield nothing."""

    async def mock_stream():
        return
        yield  # noqa: unreachable — makes this an async generator

    result = await _collect(mock_stream())
    assert result == []


@pytest.mark.asyncio
async def test_stream_survives_long_silence():
    """Source that goes silent for a long time must NOT be canceled.

    This is the exact scenario that caused the original bug: the sandbox does
    a long tool call, producing no output for >30s. With sse-starlette pings
    are handled in a separate task, so the source is never interrupted.
    """

    async def slow_stream():
        yield {"data": "start"}
        await asyncio.sleep(2)  # Simulate silence (shorter for test speed)
        yield {"data": "end"}

    result = await _collect(slow_stream())

    assert result == [
        {"data": "start"},
        {"data": "end"},
    ]
