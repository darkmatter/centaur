from __future__ import annotations

from workflows.json_payloads import extract_json_payload


def test_extract_json_payload_prefers_contract_matching_root_object() -> None:
    text = """
    Here is the result:
    {
      "tasks_reviewed": 20,
      "below_bar_count": 5,
      "below_bar_rate": 0.25,
      "task_reviews": [
        {
          "task_id": "task-1",
          "thread_key": "C1:1",
          "overall": "below_bar",
          "composite_score": 5,
          "confidence": "high",
          "dominant_failure_mode": "long_task_noncompletion",
          "scores": {"completion": 0},
          "reasoning": {"completion": "missed"},
          "binary_subquestions": {"completion": {"attempted": false}}
        }
      ],
      "top_failure_modes": [],
      "selected_fixes": [
        {"title": "Use handoff earlier"}
      ]
    }
    """

    payload = extract_json_payload(
        text,
        preferred_keys=(
            "tasks_reviewed",
            "below_bar_count",
            "below_bar_rate",
            "task_reviews",
            "top_failure_modes",
            "selected_fixes",
        ),
    )

    assert payload["tasks_reviewed"] == 20
    assert payload["selected_fixes"] == [{"title": "Use handoff earlier"}]
    assert "task_id" not in payload


def test_extract_json_payload_prefers_earliest_dict_without_contract_keys() -> None:
    text = """
    {"phase":"plan","status":"ok"}

    {"phase":"nested","status":"ok","extra":"value","details":{"x":1}}
    """

    payload = extract_json_payload(text)

    assert payload == {"phase": "plan", "status": "ok"}


def test_extract_json_payload_reads_fenced_json_block() -> None:
    text = """
    Sure, here is the JSON:

    ```json
    {
      "replies": [
        {"pr_number": 1, "thread_key": "C1:1", "message": "Fixed and live."}
      ]
    }
    ```
    """

    payload = extract_json_payload(text, preferred_keys=("replies",))

    assert payload["replies"][0]["thread_key"] == "C1:1"
