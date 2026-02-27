from __future__ import annotations

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class EngineerSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    anthropic_api_key: str = Field(default="", alias="ANTHROPIC_API_KEY")
    anthropic_model: str = "claude-opus-4-6"
    anthropic_model_fallback: str = "claude-opus-4-6"
    anthropic_max_tokens: int = 16000
    anthropic_effort: str = "max"
    anthropic_request_timeout_seconds: int = 240

    github_token: str = Field(default="", alias="GITHUB_TOKEN")
    github_repo_owner: str = "paradigmxyz"
    github_repo_name: str = "ai_v2"
    github_base_branch: str = "main"

    slack_bot_token: str = Field(default="", alias="SLACK_BOT_TOKEN")
    slack_signing_secret: str = Field(default="", alias="SLACK_SIGNING_SECRET")
    slack_channel_id: str = Field(default="", alias="SLACK_CHANNEL_ID")
    authorized_user_ids: str = ""

    branch_prefix: str = "agent"
    max_iterations: int = 6
    max_turns_per_phase: int = 40
    max_tool_calls_total: int = 200
    max_wall_time_seconds: int = 1800
    max_consecutive_tool_failures: int = 5

    max_parallel_tool_calls: int = 4
    tool_call_timeout_seconds: int = 180
    research_parallel_branches_min: int = 3
    research_parallel_branches_max: int = 5
    plan_parallel_branches_min: int = 2
    plan_parallel_branches_max: int = 4
    parallel_min_completed_before_early_stop: int = 2
    branch_timeout_seconds: int = 360

    command_allowlist: str = "uv,ruff,pytest,mypy,python,python3,rg,ls,pwd"
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
