from __future__ import annotations

from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class EngineerSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    anthropic_api_key: str = Field(default="", alias="ANTHROPIC_API_KEY")
    anthropic_model: str = "claude-opus-4-6"
    anthropic_model_fallback: str = "claude-opus-4-6"
    anthropic_max_tokens: int = 16000
    anthropic_effort: str = "high"
    anthropic_request_timeout_seconds: int = 600

    github_token: str = Field(default="", alias="GITHUB_TOKEN")
    github_repo_owner: str = "paradigmxyz"
    github_repo_name: str = "ai_v2"
    github_base_branch: str = "main"

    slack_bot_token: str = Field(default="", alias="SLACK_BOT_TOKEN")
    slack_signing_secret: str = Field(default="", alias="SLACK_SIGNING_SECRET")
    slack_channel_id: str = Field(default="", alias="SLACK_CHANNEL_ID")
    authorized_user_ids: str = ""

    branch_prefix: str = "agent"
    budget_preset: Literal["simple", "auto", "complex"] = "auto"
    slack_budget_preset: Literal["simple", "auto", "complex"] | None = None
    cli_budget_preset: Literal["simple", "auto", "complex"] | None = None
    max_iterations: int = 6
    max_turns_per_phase: int = 60
    max_tool_calls_total: int = 200
    max_wall_time_seconds: int = 1800
    max_consecutive_tool_failures: int = 5
    no_diff_exit_after: int = 2

    max_parallel_tool_calls: int = 4
    tool_call_timeout_seconds: int = 180
    # Favor broad parallel exploration by default; bounded by subagent_max_concurrency.
    research_parallel_branches_min: int = 5
    research_parallel_branches_max: int = 8
    research_max_turns: int = 80
    adaptive_turn_budgets_enabled: bool = True
    turn_budget_score_full_scale: int = 8
    turn_budget_research_floor: int = 30
    turn_budget_research_cap: int = 100
    turn_budget_plan_floor: int = 3
    turn_budget_plan_cap: int = 8
    turn_budget_review_floor: int = 8
    turn_budget_review_cap: int = 24
    turn_budget_implement_floor: int = 40
    turn_budget_implement_cap: int = 120
    turn_budget_fail_soft: bool = True
    plan_parallel_branches_min: int = 3
    plan_parallel_branches_max: int = 5
    subagent_max_concurrency: int = 6
    parallel_min_completed_before_early_stop: int = 2
    branch_timeout_seconds: int = 1200

    command_allowlist: str = "uv,ruff,pytest,mypy,python,python3,rg,fd,tree,ls,pwd,jq,yq,timeout"
    protected_write_paths: str = ".github/workflows,.env,.env.example"
    cleanup_worktree: bool = True

    @property
    def authorized_user_id_set(self) -> set[str]:
        return {item.strip() for item in self.authorized_user_ids.split(",") if item.strip()}

    @property
    def command_allowlist_set(self) -> set[str]:
        return {item.strip() for item in self.command_allowlist.split(",") if item.strip()}

    @property
    def protected_write_path_list(self) -> list[str]:
        return [item.strip() for item in self.protected_write_paths.split(",") if item.strip()]


engineer_settings = EngineerSettings()
