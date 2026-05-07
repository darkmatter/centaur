"""Tests verifying the rt.busy guard has been removed.

The harness internally handles follow-on messages to stdin while still
working — the API should never block or gate inject_stdin based on busy state.
"""

import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest


# ── 1. RuntimeState no longer has a busy field ───────────────────────────────


class TestRuntimeStateNoBusy:
    def test_no_busy_attribute(self):
        """RuntimeState dataclass should not have a 'busy' field."""
        from api.sandbox.base import RuntimeState

        rt = RuntimeState()
        assert not hasattr(rt, "busy"), "busy field should be removed from RuntimeState"

    def test_runtime_fields(self):
        """RuntimeState tracks separate stdout/stdin stream handles."""
        from api.sandbox.base import RuntimeState

        rt = RuntimeState()
        field_names = {f.name for f in rt.__dataclass_fields__.values()}
        assert field_names == {
            "turn_counter",
            "stdout_stream",
            "stdin_stream",
            "attach_context",
            "prefetched_stdout",
            "stdout_read_lock",
            "last_result",
        }


# ── 2. inject_stdin never blocks on busy ─────────────────────────────────────


class TestInjectStdinNoBusy:
    @pytest.mark.asyncio
    async def test_back_to_back_inject_no_block(self):
        """Two rapid inject_stdin calls should both succeed without blocking."""
        from api.sandbox.base import RuntimeState, SandboxSession

        session = SandboxSession(
            sandbox_id="test-sandbox-1",
            thread_key="test:backtoback",
            harness="amp",
            engine="",
        )

        mock_backend = AsyncMock()
        mock_backend.attach = AsyncMock()
        mock_backend.write_stdin = AsyncMock()
        mock_backend.status = AsyncMock(return_value="running")

        mock_pool = AsyncMock()
        mock_pool.fetchrow = AsyncMock(return_value=None)
        mock_pool.fetch = AsyncMock(return_value=[])
        mock_pool.execute = AsyncMock()

        with (
            patch("api.agent._get_pool", return_value=mock_pool),
            patch("api.agent.get_backend", return_value=mock_backend),
            patch("api.agent._get_runtime") as mock_get_rt,
            patch("api.agent._insert_system_message", new_callable=AsyncMock),
            patch("api.agent._get_last_delivered_id", new_callable=AsyncMock, return_value=None),
            patch("api.agent._flush_pending", new_callable=AsyncMock, return_value=[]),
        ):
            rt = RuntimeState()
            mock_get_rt.return_value = rt

            from api.agent import inject_stdin

            # First call
            result1 = await inject_stdin(session, "message 1")
            assert result1["ok"] is True

            # Second call immediately — should NOT raise or block
            result2 = await inject_stdin(session, "message 2")
            assert result2["ok"] is True

            # turn_counter should have been incremented for each call
            assert rt.turn_counter == 2

    @pytest.mark.asyncio
    async def test_inject_empty_message_no_busy_set(self):
        """inject_stdin with no content should return without setting any busy state."""
        from api.sandbox.base import RuntimeState, SandboxSession

        session = SandboxSession(
            sandbox_id="test-sandbox-2",
            thread_key="test:empty",
            harness="amp",
            engine="",
        )

        mock_pool = AsyncMock()
        mock_pool.fetchrow = AsyncMock(return_value=None)
        mock_pool.fetch = AsyncMock(return_value=[])

        with (
            patch("api.agent._get_pool", return_value=mock_pool),
            patch("api.agent._get_runtime") as mock_get_rt,
            patch("api.agent._insert_system_message", new_callable=AsyncMock),
            patch("api.agent._get_last_delivered_id", new_callable=AsyncMock, return_value=None),
            patch("api.agent._flush_pending", new_callable=AsyncMock, return_value=[]),
        ):
            rt = RuntimeState()
            mock_get_rt.return_value = rt

            from api.agent import inject_stdin

            result = await inject_stdin(session, "")
            assert result == {"ok": True, "injected": False}
            assert not hasattr(rt, "busy")


# ── 3. get_status does not include busy ──────────────────────────────────────


class TestGetStatusNoBusy:
    @pytest.mark.asyncio
    async def test_status_response_no_busy_key(self):
        """get_status should not include a 'busy' key in the response."""
        from api.sandbox.base import RuntimeState, SandboxSession

        session = SandboxSession(
            sandbox_id="test-sandbox-3",
            thread_key="test:status",
            harness="amp",
            engine="",
            started_at=1000.0,
        )

        mock_backend = AsyncMock()
        mock_backend.status = AsyncMock(return_value="running")

        mock_pool = AsyncMock()
        mock_pool.fetchrow = AsyncMock(return_value={
            "thread_key": "test:status",
            "sandbox_id": "test-sandbox-3",
            "harness": "amp",
            "engine": "",
            "state": "running",
            "started_at": 1000.0,
        })

        rt = RuntimeState()
        rt.last_result = "some result"

        with (
            patch("api.agent._get_pool", return_value=mock_pool),
            patch("api.agent.get_backend", return_value=mock_backend),
            patch("api.agent._db_get_session", new_callable=AsyncMock, return_value=session),
            patch("api.agent._runtime", {"test-sandbox-3": rt}),
        ):
            from api.agent import get_status

            result = await get_status("test:status")
            assert "busy" not in result
            assert result["last_result"] == "some result"


# ── 4. _stream_stdout resets for next turn without busy ──────────────────────


class TestStreamStdoutTurnReset:
    def test_turn_done_resets_state(self):
        """Verify _stream_stdout's turn.done handler doesn't reference busy.

        We do a source-level check to confirm no rt.busy assignments remain
        in the _stream_stdout function.
        """
        import inspect
        from api.agent import _stream_stdout

        source = inspect.getsource(_stream_stdout)
        assert "rt.busy" not in source, (
            "_stream_stdout should not reference rt.busy"
        )

    def test_inject_stdin_no_busy_reference(self):
        """inject_stdin source should not reference rt.busy."""
        import inspect
        from api.agent import inject_stdin

        source = inspect.getsource(inject_stdin)
        assert "rt.busy" not in source, (
            "inject_stdin should not reference rt.busy"
        )

    def test_stream_connect_no_busy_reference(self):
        """stream_connect source should not reference rt.busy."""
        import inspect
        from api.agent import stream_connect

        source = inspect.getsource(stream_connect)
        assert "rt.busy" not in source, (
            "stream_connect should not reference rt.busy"
        )
