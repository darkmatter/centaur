from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field


class GuardrailStopError(RuntimeError):
    pass


@dataclass
class LoopGuardState:
    max_turns: int
    max_tool_calls_total: int
    max_wall_time_seconds: int
    max_consecutive_tool_failures: int
    started_at: float = field(default_factory=time.monotonic)
    turns: int = 0
    tool_calls: int = 0
    consecutive_tool_failures: int = 0
    recent_signatures: deque[str] = field(default_factory=lambda: deque(maxlen=4))

    def check_turn(self) -> None:
        self.turns += 1
        if self.turns > self.max_turns:
            raise GuardrailStopError("Exceeded max turns")
        if time.monotonic() - self.started_at > self.max_wall_time_seconds:
            raise GuardrailStopError("Exceeded max wall time")

    def add_tool_call(self, signature: str) -> None:
        self.tool_calls += 1
        self.recent_signatures.append(signature)
        if self.tool_calls > self.max_tool_calls_total:
            raise GuardrailStopError("Exceeded max tool calls")
        if len(self.recent_signatures) == self.recent_signatures.maxlen:
            values = list(self.recent_signatures)
            if len(set(values)) == 1:
                raise GuardrailStopError("Detected repeated tool-call stagnation")

    def mark_tool_success(self) -> None:
        self.consecutive_tool_failures = 0

    def mark_tool_failure(self) -> None:
        self.consecutive_tool_failures += 1
        if self.consecutive_tool_failures >= self.max_consecutive_tool_failures:
            raise GuardrailStopError("Exceeded max consecutive tool failures")
