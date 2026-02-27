from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Literal

RunStatus = Literal[
    "queued",
    "researching",
    "planning",
    "clarifying",
    "implementing",
    "validating",
    "reviewing",
    "publishing",
    "completed",
    "failed",
    "waiting_for_user",
]


class Phase(StrEnum):
    RESEARCH = "research"
    PLAN = "plan"
    CLARIFY = "clarify"
    IMPLEMENT = "implement"
    REVIEW = "review"
    PUBLISH = "publish"
    DONE = "done"
    FAILED = "failed"


@dataclass
class ValidationStep:
    command: str
    success: bool
    output: str


@dataclass
class ValidationReport:
    success: bool
    steps: list[ValidationStep] = field(default_factory=list)

    def to_feedback(self) -> str:
        lines: list[str] = ["Validation failures:"]
        for step in self.steps:
            if step.success:
                continue
            lines.append(f"- {step.command}")
            if step.output:
                lines.append(step.output[:4000])
        return "\n".join(lines)


@dataclass
class EngineerResult:
    run_id: str
    success: bool
    status: RunStatus
    branch_name: str | None = None
    pr_url: str | None = None
    summary: str = ""
    error: str | None = None
