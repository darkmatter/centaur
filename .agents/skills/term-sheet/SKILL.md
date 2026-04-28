---
name: term-sheet
description: "Generates Paradigm form term sheets for venture investments. Use when asked to draft a term sheet, create a term sheet, generate term sheet, or prepare term sheet for a deal."
---

# Term Sheet Generator

Generates a Paradigm-standard term sheet as a Word document (.docx) for a new venture investment. Assumes Paradigm is the lead investor.

## When To Use

Use when the user asks to:
- "draft a term sheet for X"
- "generate a term sheet for [Company] Series [X]"
- "create a term sheet — $10M at $100M post"
- "prepare term sheet for [deal]"

## Required Deal Inputs (DRI)

Gather these from the user before generating. If the user provides them upfront, don't re-ask:

| Input | Example | Notes |
|-------|---------|-------|
| **Company name** | Acme Corp | Legal entity name |
| **Series** | A, B, C, etc. | Round designation |
| **Investment amount** | $10,000,000 | Paradigm's check size (total aggregate proceeds) |
| **Post-money valuation** | $100,000,000 | Always post-money |
| **Option pool** | 10% | Percentage of post-money cap |
| **Board seat** | Yes / No | Whether Paradigm gets a board seat |
| **Observer seat** | Yes / No | Whether Paradigm gets a board observer |
| **Crypto company** | Yes / No | If No, all token provisions are removed |

## Optional Inputs (have defaults)

| Input | Default | Notes |
|-------|---------|-------|
| **No-shop period** | 45 days | Exclusivity window |
| **Counsel fee cap** | $75,000 | Paradigm counsel expense cap |
| **Token floor %** | 50% | Only relevant for crypto companies |

## Paradigm Standard Positions (Baked into Template)

These come from the Paradigm form template and are **not** configurable:

- **Dividends**: Non-cumulative, in preference to Common
- **Liquidation preference**: 1x non-participating
- **Anti-dilution**: Broad-based weighted average
- **Redemption**: None
- **Conversion**: Automatic on IPO >$100M net proceeds or majority preferred vote
- **Documentation**: 2025 NVCA forms
- **ROFR/Co-Sale**: 1% Common stockholders, 2% carveout
- **Drag-along**: Board + preferred majority
- **Pro rata rights**: Including overallotment, for Major Investors (Paradigm only)
- **Vesting**: Standard 4-year monthly with 1-year cliff (founder vesting subject to DD)

The template is the Paradigm form — deviations require editing the output document.

## Steps

### Step 1: Gather Inputs

Ask the user for the required DRI inputs above. Accept them in any format — a single message with all details, a deal memo, or conversationally. Parse what's provided and only ask for what's missing.

### Step 2: Confirm Parameters

Before generating, show a summary table of all inputs (DRI + defaults) and ask the user to confirm or adjust:

```
## Term Sheet Parameters
| Parameter | Value |
|-----------|-------|
| Company | Acme Corp |
| Series | A |
| Investment Amount | $10,000,000 |
| Post-Money Valuation | $100,000,000 |
| Option Pool | 10% |
| Board Seat | Yes |
| Observer Seat | Yes |
| Crypto Company | No |
| No-Shop Period | 30 days |
| Counsel Fee Cap | $75,000 |
| ... | ... |

Confirm or adjust?
```

### Step 3: Generate the Document

Run the generation script with the confirmed parameters:

```bash
python3 scripts/generate.py '<JSON parameters>'
```

The JSON parameter object:
```json
{
  "company_name": "Acme Corp",
  "series": "A",
  "investment_amount": 10000000,
  "post_money_valuation": 100000000,
  "option_pool_percent": 10,
  "board_seat": true,
  "observer_seat": true,
  "is_crypto": false,
  "no_shop_days": 45,
  "counsel_fee_cap": 75000,
  "token_floor_percent": 50
}
```

The script outputs the path to the generated `.docx` file.

### Step 4: Upload the .docx to Slack

⚠️ **CRITICAL — Do not skip this step.** The user must receive the actual .docx file in Slack. Do NOT just print the file path.

**Step 4a: Get the Slack channel**

The channel name or ID comes from the thread metadata (the `metadata` field in the user message, e.g. `metadata.channel`). If you don't have it, check the environment or ask the user. Common channel names: `deals`, `legal`, or the DM channel.

**Step 4b: Upload the file using the slack tool**

```bash
curl -s -X POST http://api:8000/tools/slack/upload_file \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $CENTAUR_API_KEY" \
  -d '{
    "channel": "<channel_name_or_id>",
    "file_path": "<absolute path to generated .docx>",
    "filename": "Term Sheet - <Company> Series <X>.docx",
    "title": "Term Sheet - <Company> Series <X>",
    "comment": "Here is the generated term sheet."
  }'
```

If the request came from a Slack thread, include `"thread_ts": "<thread_ts>"` to upload in the thread.

### Step 5: Deliver

Confirm the file was uploaded and the user can download it. Offer:
- "Want me to review this term sheet against the Paradigm playbook?"
- "Want me to adjust any terms?"
- "Want me to generate a version with different economics?"

## Review Mode

If the user provides an **incoming** term sheet (from a counterparty) and asks to review it, use the `reviewing-financing-documents` skill instead — it handles full redline review. This skill is for **generation**.

However, if the user asks to "review" a term sheet that this skill just generated, re-read the output file and verify all terms match the confirmed parameters.

## Output Rules

- Always output a `.docx` file — never markdown-only
- File name format: `Term Sheet - [Company] Series [X].docx`
- Always upload the .docx directly to the Slack thread so the user can download it
- If Slack upload fails, tell the user and offer to retry
