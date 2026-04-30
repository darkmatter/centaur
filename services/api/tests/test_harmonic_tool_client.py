from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

from centaur_sdk import ToolContext, reset_tool_context, set_tool_context


REPO_ROOT = Path(__file__).resolve().parents[3]
HARMONIC_CLIENT_PATH = REPO_ROOT / "tools" / "research" / "harmonic" / "client.py"


def _load_harmonic_module():
    spec = importlib.util.spec_from_file_location("test_harmonic_client_module", HARMONIC_CLIENT_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_harmonic_client_factory_seeds_and_cleans_tool_context_secret() -> None:
    token = set_tool_context(
        ToolContext(
            name="harmonic",
            secrets={"HARMONIC_API_KEY": "=== Harmonic ===\nreal-harmonic-key\n# copied from 1Password"},
        )
    )
    try:
        module = _load_harmonic_module()
        client = module._client()
    finally:
        reset_tool_context(token)

    assert client._get_api_key() == "real-harmonic-key"


def test_search_people_recruiting_filters_and_normalizes_candidates(monkeypatch: pytest.MonkeyPatch) -> None:
    module = _load_harmonic_module()
    client = module.HarmonicClient(api_key="test-key")

    saved_searches = [
        {
            "name": "Operator Recruiting",
            "type": "PEOPLE_LIST",
            "entity_urn": "urn:harmonic:saved_search:operators",
        },
        {
            "name": "Founders",
            "type": "PEOPLE_LIST",
            "entity_urn": "urn:harmonic:saved_search:founders",
        },
        {
            "name": "Growth Companies",
            "type": "COMPANIES_LIST",
            "entity_urn": "urn:harmonic:saved_search:companies",
        },
    ]
    people_results = {
        "count": 8,
        "page_info": {"next": "cursor-2", "has_next": True},
        "results": [
            {
                "full_name": "Ada Lovelace",
                "location": {"city": "New York", "region": "NY", "country": "United States"},
                "linkedin_headline": "Chief of Staff",
                "socials": {"linkedin": {"url": "https://linkedin.com/in/ada"}},
                "experience": [
                    {
                        "title": "Chief of Staff",
                        "is_current": True,
                        "company": {"name": "Northstar"},
                    },
                    {"title": "Operations", "company": {"name": "Stripe"}},
                    {"title": "BizOps", "company": {"name": "Shopify"}},
                ],
                "education": [{"school": {"name": "Harvard"}, "degree": "Economics"}],
                "entity_urn": "urn:harmonic:person:1",
            },
            {
                "full_name": "Ben Bitdiddle",
                "location": {"display_name": "San Francisco, CA, United States"},
                "linkedin_headline": "Operations Lead",
                "socials": {"linkedin": {"url": "https://linkedin.com/in/ben"}},
                "experience": [
                    {
                        "title": "Operations Lead",
                        "is_current": True,
                        "company": {"name": "Atlas"},
                    },
                    {"title": "Operator", "company": {"name": "Plaid"}},
                ],
                "entity_urn": "urn:harmonic:person:2",
            },
            {
                "full_name": "Claire Redfield",
                "location": {"display_name": "London, United Kingdom"},
                "linkedin_headline": "Head of Operations",
                "experience": [
                    {
                        "title": "Head of Operations",
                        "is_current": True,
                        "company": {"name": "Beacon"},
                    },
                    {"title": "Senior Manager", "company": {"name": "Ramp"}},
                ],
                "entity_urn": "urn:harmonic:person:3",
            },
            {
                "full_name": "Dana Scully",
                "location": {"display_name": "Remote, United States"},
                "linkedin_headline": "Senior Director, Operations",
                "experience": [
                    {
                        "title": "Senior Director, Operations",
                        "is_current": True,
                        "company": {"name": "Orbit"},
                    },
                    {"title": "VP Strategy", "company": {"name": "Ramp"}},
                ],
                "entity_urn": "urn:harmonic:person:4",
            },
            {
                "full_name": "Eve Polastri",
                "location": {"display_name": "Chicago, IL, United States"},
                "linkedin_headline": "People Operations Manager",
                "experience": [
                    {
                        "title": "People Operations Manager",
                        "is_current": True,
                        "company": {"name": "Mercury"},
                    },
                    {"title": "Talent Lead", "company": {"name": "Stripe"}},
                ],
                "entity_urn": "urn:harmonic:person:5",
            },
            {
                "full_name": "Frank Underwood",
                "location": {"display_name": "New York, NY, United States"},
                "linkedin_headline": "COO",
                "experience": [
                    {
                        "title": "COO",
                        "is_current": True,
                        "company": {"name": "Vector"},
                    },
                    {"title": "VP Operations", "company": {"name": "Square"}},
                ],
                "entity_urn": "urn:harmonic:person:6",
            },
            {
                "full_name": "Grace Hopper",
                "location": {"display_name": "Seattle, WA, United States"},
                "linkedin_headline": "Senior Software Engineer",
                "experience": [
                    {
                        "title": "Senior Software Engineer",
                        "is_current": True,
                        "company": {"name": "Kernel"},
                    },
                    {"title": "Engineer", "company": {"name": "Stripe"}},
                ],
                "entity_urn": "urn:harmonic:person:7",
            },
            {
                "full_name": "Hank Scorpio",
                "location": {"display_name": "Austin, TX, United States"},
                "linkedin_headline": "Management Consultant",
                "experience": [
                    {
                        "title": "Management Consultant",
                        "is_current": True,
                        "company": {"name": "Independent"},
                    },
                    {"title": "Consultant", "company": {"name": "McKinsey"}},
                ],
                "entity_urn": "urn:harmonic:person:8",
            },
        ],
    }

    def fake_request(method: str, endpoint: str, params=None, json_body=None):
        assert method == "GET"
        assert json_body is None
        if endpoint == "/savedSearches":
            return saved_searches
        if endpoint == "/savedSearches:results/urn:harmonic:saved_search:operators":
            assert params == {"size": 25}
            return people_results
        raise AssertionError(f"Unexpected request: {endpoint}")

    monkeypatch.setattr(client, "_request", fake_request)

    by_name = client.search_people_recruiting(saved_search_name="operator recruiting")
    returned_names = [person["full_name"] for person in by_name["results"]]
    assert returned_names == [
        "Ada Lovelace",
        "Ben Bitdiddle",
        "Claire Redfield",
        "Dana Scully",
        "Eve Polastri",
        "Frank Underwood",
        "Grace Hopper",
        "Hank Scorpio",
    ]
    assert by_name["saved_search"]["name"] == "Operator Recruiting"
    assert by_name["page_info"]["next"] == "cursor-2"
    assert by_name["results"][0]["current_title"] == "Chief of Staff"
    assert by_name["results"][0]["prior_employers"] == ["Stripe", "Shopify"]
    assert by_name["results"][0]["seniority"] == "director"
    assert by_name["results"][0]["profile_urls"]["linkedin"] == "https://linkedin.com/in/ada"
    assert by_name["results"][0]["location"] == "New York, NY, United States"

    # Positive recruiting matches
    assert [p["full_name"] for p in client.search_people_recruiting(
        saved_search_name="Operator Recruiting", role_query="chief of staff"
    )["results"]] == ["Ada Lovelace"]
    assert [p["full_name"] for p in client.search_people_recruiting(
        saved_search_name="Operator Recruiting", role_query="operations lead"
    )["results"]] == ["Ben Bitdiddle"]
    assert [p["full_name"] for p in client.search_people_recruiting(
        saved_search_name="Operator Recruiting", role_query="head of operations"
    )["results"]] == ["Claire Redfield"]
    assert [p["full_name"] for p in client.search_people_recruiting(
        saved_search_name="Operator Recruiting", background_query="stripe"
    )["results"]] == ["Ada Lovelace", "Eve Polastri", "Grace Hopper"]
    assert [p["full_name"] for p in client.search_people_recruiting(
        saved_search_name="Operator Recruiting", prior_employers=["ramp"]
    )["results"]] == ["Claire Redfield", "Dana Scully"]

    # Additional filter coverage, including off-target rejection.
    assert [p["full_name"] for p in client.search_people_recruiting(
        saved_search_name="Operator Recruiting", seniority=["executive"]
    )["results"]] == ["Frank Underwood"]
    assert [p["full_name"] for p in client.search_people_recruiting(
        saved_search_name="Operator Recruiting", role_query="consultant"
    )["results"]] == ["Hank Scorpio"]
    assert client.search_people_recruiting(
        saved_search_name="Operator Recruiting",
        role_query="chief of staff",
        locations=["london"],
    )["results"] == []


def test_search_people_recruiting_requires_a_people_saved_search(monkeypatch: pytest.MonkeyPatch) -> None:
    module = _load_harmonic_module()
    client = module.HarmonicClient(api_key="test-key")

    def fake_request(method: str, endpoint: str, params=None, json_body=None):
        assert method == "GET"
        if endpoint == "/savedSearches":
            return [
                {
                    "name": "Growth Companies",
                    "type": "COMPANIES_LIST",
                    "entity_urn": "urn:harmonic:saved_search:companies",
                }
            ]
        raise AssertionError(f"Unexpected request: {endpoint}")

    monkeypatch.setattr(client, "_request", fake_request)

    with pytest.raises(RuntimeError, match="No people saved search matched"):
        client.search_people_recruiting(saved_search_name="Growth Companies")
