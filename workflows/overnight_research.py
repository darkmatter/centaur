"""Workflow: Overnight research flows.

Five automated research flows that run on schedule and deliver to Slack:
1. Portfolio Twitter Monitor (daily 6am PT)
2. Accelerator Batch Scanner (weekly Monday)
3. Stablecoin/Payments Diff (weekly Monday)
4. Crypto Ecosystem Pulse (weekly Monday)
5. GTM Opportunity Matcher (weekly Monday)

Ported from gtmskill's CLAUDE.md research flow definitions.
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field
from typing import Any
from zoneinfo import ZoneInfo

from api.workflow_engine import WorkflowContext

WORKFLOW_NAME = "overnight_research"


@dataclass
class Input:
    flow: str = "all"  # "twitter", "accelerator", "stablecoin", "ecosystem", "gtm", "all"
    slack_channel: str = "daily-news"
    timezone: str = "America/Los_Angeles"
    run_hour: int = 6
    run_minute: int = 0
    max_iterations: int = 1  # 0 = run forever on schedule
    portfolio_companies: list[str] = field(default_factory=lambda: [
        "Monad", "Noble", "Privy", "Harmonic", "Talarion", "Ellipsis",
        "D3", "Rift", "Temporal", "Unit",
    ])


FLOW_PROMPTS: dict[str, str] = {
    "twitter": """You are a portfolio Twitter/X monitoring agent for Paradigm.

Scan Twitter/X for signal from these portfolio company accounts and key ecosystem voices.
Produce a morning digest of what matters from the last 24 hours.

Portfolio accounts to monitor: {portfolio_companies}
Also check founder personal accounts where known.

Ecosystem signal accounts:
@aeyakovenko (Solana), @rajgokal (Solana), @VitalikButerin,
@StaniKulechov (Aave), @haydenzadams (Uniswap), @CryptoHayes,
@MessariCrypto, @TheBlock__

For each signal worth flagging, output:
- Account + tweet summary (do NOT reproduce full tweet text)
- Signal type: [PRODUCT LAUNCH] [PARTNERSHIP HINT] [HIRING SIGNAL] [COMMUNITY SENTIMENT] [COMPETITOR MENTION] [REGULATORY]
- Why it matters to Paradigm (1 sentence)
- [ACTION REQUIRED] if Ishan should respond or flag to the team

Filtering rules:
- Skip: retweets of generic crypto content, price commentary without insight, engagement farming
- Include: product news, BD implications, competitive intelligence, founder sentiment shifts
- Minimum bar: would Ishan want to know this before his first meeting of the day?

Group by: (1) Portfolio Company Activity, (2) Ecosystem Signal, (3) Action Items.
Keep total length under 600 words.""",

    "accelerator": """You are an accelerator batch scanning agent for Paradigm.

Search for the most recently announced accelerator batches from: Y Combinator, a16z Speedrun,
Sequoia Arc, Alliance DAO, and any other crypto-native accelerators.
Identify all companies operating in: crypto infrastructure, DeFi, stablecoin payments,
AI x crypto, robotics, or frontier tech.

For each qualifying company, output:
- Company name + one-line description
- Founders (names, prior companies, YC/technical background)
- Thesis fit score (1-5) against Paradigm mandate: crypto infra, DeFi, AI, robotics, payments
- Why it fits or doesn't fit (2 sentences max)
- Any known traction signals (users, revenue, on-chain activity, GitHub stars)
- Flag if founder has a warm path into Paradigm network [WARM PATH]

Output: Ranked table by thesis fit score, then a short memo on the top 3 companies.

Sources to check:
- news.ycombinator.com
- a16z.com/speedrun
- X/Twitter: search for current YC batch
- The Block, TechCrunch, Decrypt for batch announcement coverage""",

    "stablecoin": """You are a stablecoin/payments landscape monitoring agent for Paradigm.

Produce a weekly change log across the stablecoin and crypto payments infrastructure landscape.

Watch-list (always cover):
Issuers: Tether (USDT), Circle (USDC), PayPal (PYUSD), Ripple (RLUSD)
Infrastructure: Tempo (MPP), BVNK, Plasma, OpenFX, Bridge (acquired by Stripe),
Mastercard crypto partnerships, Visa crypto partnerships
Emerging: Any new stablecoin launches, regulatory approvals (OCC, NYDFS, EU MiCA),
or announced partnerships in the past 7 days

For each company/item with a change, output:
- What changed (product launch, partnership, fundraise, regulatory, executive hire)
- Why it matters to Paradigm (1-2 sentences)
- Competitive implication for portfolio companies [FLAG IF RELEVANT]
- Source + date

Group by: (1) Product/Launch, (2) Partnerships, (3) Fundraising/M&A, (4) Regulatory, (5) Personnel.
Omit items with no changes.""",

    "ecosystem": """You are a crypto ecosystem pulse agent for Paradigm.

Compile a weekly ecosystem intelligence brief covering Bitcoin, Ethereum, Solana, and Hyperliquid.

Bitcoin: Price + 7d change, dominance %, ETF flow data (BlackRock IBIT, Fidelity FBTC), notable L2 activity, macro/regulatory news
Ethereum: Price + 7d change, ETH/BTC ratio, ETF flows, L2 ecosystem (Arbitrum, Base, Optimism, zkSync), staking (Lido, EigenLayer), governance
Solana: Price + 7d change, SOL/ETH ratio, DEX volume (Raydium, Jupiter, Orca), block building (Jito vs Harmonic — Paradigm led Harmonic's seed), new deployments
Hyperliquid: HYPE price + 7d change, perp DEX volume, vault TVL, HyperEVM ecosystem, competitive dynamics vs dYdX/GMX

Use the mpp tool to get current prices for BTC, ETH, SOL, and HYPE.

Output: Four sections (BTC / ETH / SOL / HYPE), each with a 2-sentence headline summary
followed by bullet data points. End with a "Cross-Chain Signals" section.""",

    "gtm": """You are a GTM opportunity matching agent for Paradigm.

Identify new companies or protocols that have launched, raised, or become newly active
in the past 14 days and match these portfolio company ICPs:

Talarion: Crypto-native companies needing API access to prediction market infrastructure.
Targets: trading platforms, analytics tools, information markets, crypto-native apps.

Noble: DeFi protocols, yield products, and consumer crypto apps that could integrate
Noble's creator deposit product. Focus on: protocols with TVL >$10M, consumer apps.

Ellipsis / Phoenix: DeFi protocols and financial infrastructure companies
needing data or analytics tooling.

For each lead, output:
- Company/protocol name + one-line description
- Why it fits the ICP (1-2 sentences)
- Relevant signals: funding announced, product launch, hiring, on-chain activity
- Suggested portfolio company match: Talarion / Noble / Ellipsis
- Warm path if identifiable [WARM PATH]
- Suggested outreach angle (1 sentence)

Three sections (one per portfolio co), each with a ranked table of leads +
a 3-sentence memo on the highest-priority opportunity.

Sources: Crunchbase, Messari, The Block fundraise announcements, DefiLlama new protocols,
X/Twitter, GitHub trending crypto repos.""",
}


async def handler(inp: Input, ctx: WorkflowContext) -> dict[str, Any]:
    """Run one or more overnight research flows and deliver to Slack."""

    iteration = 0
    tz = ZoneInfo(inp.timezone)

    while True:
        iteration += 1

        flows_to_run = list(FLOW_PROMPTS.keys()) if inp.flow == "all" else [inp.flow]
        results: dict[str, str] = {}

        for flow_name in flows_to_run:
            prompt_template = FLOW_PROMPTS.get(flow_name)
            if not prompt_template:
                continue

            prompt = prompt_template.format(
                portfolio_companies=", ".join(inp.portfolio_companies),
            ) if "{portfolio_companies}" in prompt_template else prompt_template

            # Add instruction to use tools and post to Slack
            full_prompt = f"""{prompt}

Use web search, mpp tools (for market data), and any other available tools to gather real data.
Do not fabricate numbers or sources.

After producing the report, post it to #{inp.slack_channel} on Slack.
Prefix the message with the flow name (e.g. "Portfolio Twitter Monitor — Apr 23, 2026")."""

            result = await ctx.run_agent(
                f"research_{flow_name}_{iteration}",
                text=full_prompt,
            )
            result_text = result.get("result_text", "") if isinstance(result, dict) else str(result)
            results[flow_name] = result_text

        # Check if we should stop
        if inp.max_iterations > 0 and iteration >= inp.max_iterations:
            return {
                "status": "done",
                "iterations": iteration,
                "flows_run": list(results.keys()),
                "results": results,
            }

        # Sleep until next run
        now = dt.datetime.now(dt.timezone.utc).astimezone(tz)
        next_run = now.replace(
            hour=inp.run_hour,
            minute=inp.run_minute,
            second=0,
            microsecond=0,
        )
        if next_run <= now:
            next_run += dt.timedelta(days=1)

        await ctx.sleep(f"wait_{iteration + 1}", next_run - now)
