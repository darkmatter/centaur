#!/usr/bin/env python3
"""Rename 1Password vault items to standardized ENV_VAR names.

Connects to 1Password via the `op` CLI, lists all items in the AI vault,
and renames items whose titles don't match the canonical ENV_VAR_NAME format.

Usage:
    # Dry run (default) — shows what would change:
    python scripts/rename-vault-items.py

    # Apply changes:
    python scripts/rename-vault-items.py --apply
"""

import json
import re
import subprocess
import sys

VAULT = "Paradigm AI Secrets & API Keys"
ACCOUNT = "paradigmoperationslp"

# Explicit overrides: current 1Password title → desired ENV_VAR name.
# These handle cases where the standard name differs from a simple
# normalization of the title (e.g. vendor name ≠ env var convention).
OVERRIDES: dict[str, str] = {
    "Claude API": "ANTHROPIC_API_KEY",
    "ChatGPT API": "OPENAI_API_KEY",
    "Github": "GITHUB_TOKEN",
    "svc-paradigm Github": "SVC_PARADIGM_GITHUB_TOKEN",
    "Dune API": "DUNE_API_KEY",
    "Coingecko API": "COINGECKO_API_KEY",
    "Coinmetrics": "COINMETRICS_API_KEY",
    "Alchemy": "ALCHEMY_API_KEY",
    "Affinity": "AFFINITY_API_KEY",
    "Nansen API Key": "NANSEN_API_KEY",
    "Linear API key": "LINEAR_API_KEY",
    "Notion API": "NOTION_API_KEY",
    "RocketReach API Key": "ROCKETREACH_API_KEY",
    "Harmonic API": "HARMONIC_API_KEY",
    "Ironclad API": "IRONCLAD_API_KEY",
    "Legistorm API": "LEGISTORM_API_KEY",
    "Bloomberg API": "BLOOMBERG_API_KEY",
    "Bloomberg Client_ID + Secret": "BLOOMBERG_CLIENT_SECRET",
    "Pitchbook API": "PITCHBOOK_API_KEY",
    "Crunchbase API": "CRUNCHBASE_API_KEY",
    "SimilarWeb API": "SIMILARWEB_API_KEY",
    "Coinbase API keys": "COINBASE_API_KEY",
    "ScraperAPI": "SCRAPER_API_KEY",
    "SensorTower": "SENSORTOWER_API_KEY",
    "Messari": "MESSARI_API_KEY",
    "BitGo": "BITGO_API_KEY",
    "Unit410": "UNIT410_API_KEY",
    "Figma": "FIGMA_API_KEY",
    "Figma API": "FIGMA_API_KEY",
    "Facebook": "FACEBOOK_API_KEY",
    "Instagram": "INSTAGRAM_API_KEY",
    "Tardis.Dev": "TARDIS_DEV_API_KEY",
    "AlphaSense API (Trial)": "ALPHASENSE_API_KEY",
    "defillama": "DEFILLAMA_API_KEY",
    "synoptic api": "SYNOPTIC_API_KEY",
    "browser use api": "BROWSER_USE_API_KEY",
    "x.com perry daim ai": "X_COM_PERRY_DAIM_AI",
    "Shift BigQuery credential": "SHIFT_BIGQUERY_CREDENTIAL",
    "Ashby API Readonly": "ASHBY_API_KEY",
    "Granola API Credentials": "GRANOLA_API_KEY",
    "Refractor Bot - Okta": "REFRACTOR_BOT_OKTA",
    "svc_ai - 1Password": "SVC_AI_1PASSWORD",
    "svc_ai Google/Okta": "SVC_AI_GOOGLE_OKTA",
    "1Password Service Account Token": "OP_SERVICE_ACCOUNT_TOKEN",
    "quicknode - arbitrum rpc": "QUICKNODE_ARBITRUM_RPC",
    "quicknode - base rpc": "QUICKNODE_BASE_RPC",
    "quicknode - bitcoin rpc": "QUICKNODE_BITCOIN_RPC",
    "quicknode - ethereum rpc": "QUICKNODE_ETHEREUM_RPC",
    "quicknode - polygon rpc": "QUICKNODE_POLYGON_RPC",
    "quicknode - tron rpc": "QUICKNODE_TRON_RPC",
    "Slack": "SLACK_BOT_TOKEN",
    "Standard Metrics": "STANDARD_METRICS_API_KEY",
    "Sigma": "SIGMA_API_KEY",
    "Anchorage": "ANCHORAGE_API_KEY",
    "FalconX": "FALCONX_API_KEY",
}


def normalize(title: str) -> str:
    """Convert a human-readable title to an ENV_VAR_NAME."""
    return re.sub(r"[^A-Z0-9]", "_", title.upper()).strip("_")


def desired_name(title: str) -> str:
    """Get the desired standardized name for a vault item."""
    if title in OVERRIDES:
        return OVERRIDES[title]
    norm = normalize(title)
    # If already looks like an ENV_VAR (all uppercase+underscore), keep it
    if title == norm:
        return title
    return norm


def op_list_items() -> list[dict]:
    """List all items in the vault via `op` CLI."""
    result = subprocess.run(
        ["op", "item", "list", "--vault", VAULT, "--account", ACCOUNT, "--format", "json"],
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(result.stdout)


def op_rename_item(item_id: str, new_title: str) -> None:
    """Rename an item in 1Password."""
    subprocess.run(
        ["op", "item", "edit", item_id, f"title={new_title}", "--vault", VAULT, "--account", ACCOUNT],
        capture_output=True,
        text=True,
        check=True,
    )


def main() -> None:
    apply = "--apply" in sys.argv

    print(f"Vault: {VAULT}")
    print(f"Mode: {'APPLY' if apply else 'DRY RUN (use --apply to execute)'}\n")

    items = op_list_items()
    print(f"Found {len(items)} items\n")

    renames: list[tuple[str, str, str]] = []  # (id, old_title, new_title)
    already_good: list[str] = []
    conflicts: dict[str, list[str]] = {}  # new_name → [old_titles]

    for item in items:
        item_id = item["id"]
        title = item["title"]
        new_name = desired_name(title)

        if title == new_name:
            already_good.append(title)
        else:
            renames.append((item_id, title, new_name))
            conflicts.setdefault(new_name, []).append(title)

    # Report items already correct
    if already_good:
        print(f"✅ Already standardized ({len(already_good)}):")
        for name in sorted(already_good):
            print(f"   {name}")
        print()

    # Check for conflicts (multiple items mapping to same name)
    dupes = {k: v for k, v in conflicts.items() if len(v) > 1}
    if dupes:
        print("⚠️  CONFLICTS (multiple items → same name, will skip):")
        for new_name, old_titles in sorted(dupes.items()):
            print(f"   {new_name} ← {old_titles}")
        print()

    # Show and apply renames
    safe_renames = [(i, old, new) for i, old, new in renames if len(conflicts[new]) == 1]
    if not safe_renames:
        print("Nothing to rename.")
        return

    print(f"{'🔧 Will rename' if apply else '📋 Would rename'} ({len(safe_renames)}):")
    for _, old_title, new_name in sorted(safe_renames, key=lambda x: x[1]):
        print(f"   {old_title:45s} → {new_name}")
    print()

    if not apply:
        print("Run with --apply to execute these renames.")
        return

    import concurrent.futures
    import time as _time

    def do_rename(item: tuple[str, str, str]) -> tuple[str, str, str | None]:
        item_id, old_title, new_name = item
        for attempt in range(4):
            try:
                op_rename_item(item_id, new_name)
                return (old_title, new_name, None)
            except subprocess.CalledProcessError as e:
                if "409" in e.stderr and attempt < 3:
                    _time.sleep(1.5 * (attempt + 1))
                    continue
                return (old_title, new_name, e.stderr.strip())
        return (old_title, new_name, "max retries exceeded")

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(do_rename, safe_renames))

    success = 0
    failed = 0
    for old_title, new_name, err in results:
        if err:
            print(f"   ❌ {old_title} → {new_name}: {err}")
            failed += 1
        else:
            print(f"   ✅ {old_title} → {new_name}")
            success += 1

    print(f"\nDone: {success} renamed, {failed} failed")


if __name__ == "__main__":
    main()
