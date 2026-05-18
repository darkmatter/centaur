from __future__ import annotations

import json

from workflows.harmonic_job_change_monitor import (
    _extract_snapshot,
    _job_change_message,
    _load_monitors,
)


def test_load_monitors_filters_invalid_entries_and_normalizes_urls(tmp_path) -> None:
    config_path = tmp_path / "harmonic_job_change_monitors.json"
    config_path.write_text(
        json.dumps(
            {
                "monitors": [
                    {
                        "name": "Shu",
                        "linkedin_url": "linkedin.com/in/shu/",
                        "slack_channel": "#C0AEAL252BD",
                    },
                    {
                        "name": "Missing channel",
                        "linkedin_url": "https://www.linkedin.com/in/skip/",
                    },
                    "bad-entry",
                ]
            }
        )
    )

    monitors = _load_monitors(str(config_path))

    assert len(monitors) == 1
    assert monitors[0].linkedin_url == "https://linkedin.com/in/shu"
    assert monitors[0].slack_channel == "C0AEAL252BD"


def test_extract_snapshot_ignores_private_profiles_without_current_role() -> None:
    snapshot = _extract_snapshot(
        {
            "linkedin_profile_visibility_type": "PRIVATE_OR_NONEXISTENT",
            "experience": [],
        }
    )

    assert snapshot.comparable is False
    assert snapshot.display == "no current company/title"


def test_job_change_message_formats_old_to_new_transition() -> None:
    previous = _extract_snapshot(
        {
            "linkedin_profile_visibility_type": "PUBLIC",
            "experience": [
                {
                    "is_current": True,
                    "title": "VP Product",
                    "company": {"name": "OldCo"},
                }
            ],
        }
    )
    current = _extract_snapshot(
        {
            "linkedin_profile_visibility_type": "PUBLIC",
            "experience": [
                {
                    "is_current": True,
                    "title": "CEO",
                    "company_name": "NewCo",
                }
            ],
        }
    )

    message = _job_change_message(
        "Shu",
        "https://www.linkedin.com/in/shu/",
        previous,
        current,
    )

    assert message == (
        "Shu: OldCo / VP Product -> NewCo / CEO\n"
        "https://www.linkedin.com/in/shu/"
    )
