from __future__ import annotations

import json
from typing import Any


def to_assistant_blocks(content_blocks: list[Any]) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = []
    for block in content_blocks:
        block_type = getattr(block, "type", "")
        if block_type == "thinking":
            blocks.append({
                "type": "thinking",
                "thinking": getattr(block, "thinking", ""),
                "signature": getattr(block, "signature", ""),
            })
        elif block_type == "text":
            blocks.append({"type": "text", "text": getattr(block, "text", "")})
        elif block_type == "tool_use":
            blocks.append(
                {
                    "type": "tool_use",
                    "id": getattr(block, "id", ""),
                    "name": getattr(block, "name", ""),
                    "input": getattr(block, "input", {}),
                }
            )
    return blocks


def extract_tool_uses(content_blocks: list[Any]) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []
    for block in content_blocks:
        if getattr(block, "type", "") != "tool_use":
            continue
        calls.append(
            {
                "id": getattr(block, "id", ""),
                "name": getattr(block, "name", ""),
                "input": getattr(block, "input", {}),
            }
        )
    return calls


def build_tool_result_blocks(results: list[tuple[str, str]]) -> list[dict[str, str]]:
    return [
        {
            "type": "tool_result",
            "tool_use_id": tool_use_id,
            "content": output,
        }
        for tool_use_id, output in results
    ]


def tool_signature(name: str, tool_input: dict[str, Any]) -> str:
    return f"{name}:{json.dumps(tool_input, sort_keys=True)}"
