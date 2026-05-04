#!/usr/bin/env python3
"""Score sourced candidates and publish them to Google Sheets."""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
from pathlib import Path
from typing import Any
from urllib import error, request


WEIGHTS = {
    "title_correspondence": 0.25,
    "educational_foundation": 0.20,
    "professional_trajectory": 0.20,
    "talent_density": 0.20,
    "timing_window": 0.15,
}

HEADERS = [
    "Name",
    "Title",
    "Company",
    "LinkedIn",
    "Email",
    "Location",
    "Score",
    "Notes",
]

CRITERION_ALIASES = {
    "title_correspondence": ["title_correspondence", "title_match", "title"],
    "educational_foundation": [
        "educational_foundation",
        "education",
        "education_foundation",
    ],
    "professional_trajectory": [
        "professional_trajectory",
        "trajectory",
        "career_trajectory",
    ],
    "talent_density": [
        "talent_density",
        "talent_density_of_prior_orgs",
        "prior_orgs",
        "prior_org_density",
    ],
    "timing_window": ["timing_window", "timing", "readiness"],
}

MAX_SUBSCORE = 5.0


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    score_parser = subparsers.add_parser("score", help="Compute weighted scores locally")
    score_parser.add_argument("--input", required=True, help="Path to candidate JSON")
    score_parser.add_argument("--output", help="Optional output path for scored JSON")
    score_parser.add_argument("--top-n", type=int, help="Optional cap after sorting")

    publish_parser = subparsers.add_parser("publish", help="Create and share a Google Sheet")
    publish_parser.add_argument("--input", required=True, help="Path to candidate JSON")
    publish_parser.add_argument("--title", required=True, help="Spreadsheet title")
    publish_parser.add_argument("--share-with", required=True, help="Requester email")
    publish_parser.add_argument("--tab-name", default="Candidates", help="Worksheet tab title")
    publish_parser.add_argument("--top-n", type=int, help="Optional cap after sorting")
    publish_parser.add_argument("--dry-run", action="store_true", help="Do not call gsuite")
    publish_parser.add_argument(
        "--api-url",
        default=os.environ.get("CENTAUR_API_URL", "http://api:8000"),
        help="Centaur API URL",
    )
    publish_parser.add_argument(
        "--api-key",
        default=os.environ.get("CENTAUR_API_KEY"),
        help="Centaur API key",
    )

    return parser


def _fail(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(1)


def _load_candidates(path: str) -> list[dict[str, Any]]:
    payload = json.loads(Path(path).read_text())
    if isinstance(payload, list):
        candidates = payload
    elif isinstance(payload, dict) and isinstance(payload.get("candidates"), list):
        candidates = payload["candidates"]
    else:
        _fail("Candidate JSON must be a list or an object with a 'candidates' array.")

    normalized: list[dict[str, Any]] = []
    for candidate in candidates:
        if not isinstance(candidate, dict):
            _fail("Each candidate must be a JSON object.")
        normalized.append(candidate)
    return normalized


def _coerce_number(value: Any) -> float | None:
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        cleaned = value.strip().rstrip("%")
        if not cleaned:
            return None
        try:
            return float(cleaned)
        except ValueError:
            return None
    return None


def _get_nested_score(candidate: dict[str, Any], key: str) -> float | None:
    pools: list[dict[str, Any]] = [candidate]
    nested_scores = candidate.get("scores")
    if isinstance(nested_scores, dict):
        pools.insert(0, nested_scores)

    for pool in pools:
        for alias in CRITERION_ALIASES[key]:
            value = _coerce_number(pool.get(alias))
            if value is not None:
                return value
    return None


def _extract_breakdown(candidate: dict[str, Any]) -> dict[str, float] | None:
    breakdown: dict[str, float] = {}
    for key in WEIGHTS:
        value = _get_nested_score(candidate, key)
        if value is None:
            return None
        if value < 0 or value > MAX_SUBSCORE:
            _fail(
                f"Candidate '{candidate.get('name', 'unknown')}' has {key}={value}. "
                f"Expected a 0-{MAX_SUBSCORE:g} subscore."
            )
        breakdown[key] = value
    return breakdown


def _compute_weighted_score(candidate: dict[str, Any]) -> tuple[float, dict[str, float] | None, str]:
    breakdown = _extract_breakdown(candidate)
    if breakdown is not None:
        score = sum((breakdown[key] / MAX_SUBSCORE) * WEIGHTS[key] * 100 for key in WEIGHTS)
        return round(score, 1), breakdown, "weighted"

    explicit_score = _coerce_number(candidate.get("score"))
    if explicit_score is None:
        _fail(
            "Every candidate needs either a full 5-part 'scores' object or a numeric 'score'. "
            f"Missing score for '{candidate.get('name', 'unknown')}'."
        )
    return round(explicit_score, 1), None, "provided"


def _field(candidate: dict[str, Any], *names: str, default: str = "") -> str:
    for name in names:
        value = candidate.get(name)
        if value is None:
            continue
        if isinstance(value, str):
            cleaned = value.strip()
            if cleaned:
                return cleaned
        elif value != "":
            return str(value)
    return default


def _normalize_candidate(candidate: dict[str, Any]) -> dict[str, Any]:
    score, breakdown, score_method = _compute_weighted_score(candidate)
    normalized = {
        "name": _field(candidate, "name", "full_name", default="Unknown"),
        "title": _field(candidate, "title", "current_title"),
        "company": _field(candidate, "company", "current_company"),
        "linkedin": _field(candidate, "linkedin", "linkedin_url"),
        "email": _field(candidate, "email"),
        "location": _field(candidate, "location"),
        "notes": _field(candidate, "notes"),
        "score": score,
        "score_method": score_method,
    }
    if breakdown is not None:
        normalized["score_breakdown"] = breakdown
    return normalized


def _prepare_candidates(candidates: list[dict[str, Any]], top_n: int | None) -> list[dict[str, Any]]:
    normalized = [_normalize_candidate(candidate) for candidate in candidates]
    normalized.sort(key=lambda candidate: (-candidate["score"], candidate["name"].lower()))
    if top_n is not None:
        return normalized[:top_n]
    return normalized


def _sheet_rows(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "Name": candidate["name"],
            "Title": candidate["title"],
            "Company": candidate["company"],
            "LinkedIn": candidate["linkedin"],
            "Email": candidate["email"],
            "Location": candidate["location"],
            "Score": candidate["score"],
            "Notes": candidate["notes"],
        }
        for candidate in candidates
    ]


class ToolClient:
    def __init__(self, api_url: str, api_key: str | None):
        self.api_url = api_url.rstrip("/")
        self.api_key = api_key

    def call(self, tool: str, method: str, payload: dict[str, Any]) -> Any:
        req = request.Request(
            f"{self.api_url}/tools/{tool}/{method}",
            data=json.dumps(payload).encode(),
            headers={
                "Content-Type": "application/json",
                **(
                    {"Authorization": f"Bearer {self.api_key}"}
                    if self.api_key
                    else {}
                ),
            },
            method="POST",
        )
        try:
            with request.urlopen(req) as response:
                data = json.loads(response.read().decode())
        except error.HTTPError as exc:
            detail = exc.read().decode()
            raise RuntimeError(f"{tool}.{method} failed: HTTP {exc.code} {detail}") from exc

        if isinstance(data, dict) and data.get("error"):
            raise RuntimeError(f"{tool}.{method} failed: {data['error']}")
        if isinstance(data, dict) and {"tool", "method", "result"}.issubset(data):
            return _parse_toon_result(data["result"])
        return data


def _parse_toon_result(result: Any) -> Any:
    if not isinstance(result, str):
        return result

    stripped = result.strip()
    if not stripped:
        return ""

    if stripped[0] in "[{":
        try:
            return json.loads(stripped)
        except json.JSONDecodeError:
            pass

    lines = stripped.splitlines()
    table_match = re.match(r"^\[(?P<count>\d+)]\{(?P<columns>[^}]*)}:$", lines[0])
    if table_match:
        columns = [column.strip() for column in table_match.group("columns").split(",")]
        rows = []
        for line in lines[1:]:
            if not line.startswith("  "):
                continue
            values = next(csv.reader([line[2:]]))
            rows.append({column: value for column, value in zip(columns, values, strict=False)})
        return rows

    object_lines = []
    for line in lines:
        if re.match(r"^[A-Za-z0-9_]+(?:\[\d+])?:", line):
            object_lines.append(line)
        else:
            object_lines = []
            break
    if object_lines:
        parsed: dict[str, Any] = {}
        for line in object_lines:
            key_part, value_part = line.split(":", 1)
            value = value_part.strip().strip('"')
            indexed_match = re.match(r"^(?P<key>[A-Za-z0-9_]+)\[(?P<index>\d+)]$", key_part)
            if indexed_match:
                parsed.setdefault(indexed_match.group("key"), [])
                cast_value = parsed[indexed_match.group("key")]
                assert isinstance(cast_value, list)
                cast_value.append(value)
            else:
                parsed[key_part] = value
        return parsed

    return stripped


def _extract_spreadsheet_id(payload: Any) -> str:
    if isinstance(payload, dict):
        for key in ("spreadsheet_id", "spreadsheetId", "id", "file_id"):
            value = payload.get(key)
            if value:
                return str(value)
    _fail(f"Could not determine spreadsheet id from response: {json.dumps(payload, indent=2)}")


def _extract_sheet_url(payload: Any, spreadsheet_id: str) -> str:
    if isinstance(payload, dict):
        for key in ("url", "spreadsheet_url", "webViewLink", "web_view_link", "link"):
            value = payload.get(key)
            if value:
                return str(value)
    return f"https://docs.google.com/spreadsheets/d/{spreadsheet_id}"


def _command_score(args: argparse.Namespace) -> int:
    candidates = _load_candidates(args.input)
    prepared = _prepare_candidates(candidates, args.top_n)
    output = {"candidates": prepared, "count": len(prepared)}
    rendered = json.dumps(output, indent=2)
    if args.output:
        Path(args.output).write_text(rendered + "\n")
    else:
        print(rendered)
    return 0


def _command_publish(args: argparse.Namespace) -> int:
    candidates = _load_candidates(args.input)
    prepared = _prepare_candidates(candidates, args.top_n)
    rows = _sheet_rows(prepared)

    manifest = {
        "title": args.title,
        "share_with": args.share_with,
        "tab_name": args.tab_name,
        "count": len(prepared),
        "top_candidates": [candidate["name"] for candidate in prepared[:5]],
        "rows": rows,
    }
    if args.dry_run:
        print(json.dumps(manifest, indent=2))
        return 0

    client = ToolClient(api_url=args.api_url, api_key=args.api_key)
    created = client.call("gsuite", "sheets_create", {"title": args.title})
    spreadsheet_id = _extract_spreadsheet_id(created)

    if args.tab_name != "Sheet1":
        client.call(
            "gsuite",
            "sheets_add_tab",
            {"spreadsheet_id": spreadsheet_id, "title": args.tab_name},
        )

    client.call(
        "gsuite",
        "sheets_write_table",
        {
            "spreadsheet_id": spreadsheet_id,
            "sheet_title": args.tab_name,
            "headers": HEADERS,
            "rows": rows,
            "start_cell": "A1",
        },
    )
    client.call(
        "gsuite",
        "drive_share",
        {"file_id": spreadsheet_id, "email": args.share_with, "role": "writer"},
    )

    print(
        json.dumps(
            {
                **manifest,
                "spreadsheet_id": spreadsheet_id,
                "url": _extract_sheet_url(created, spreadsheet_id),
            },
            indent=2,
        )
    )
    return 0


def main() -> int:
    args = _build_parser().parse_args()
    if args.command == "score":
        return _command_score(args)
    if args.command == "publish":
        return _command_publish(args)
    _fail(f"Unsupported command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())
