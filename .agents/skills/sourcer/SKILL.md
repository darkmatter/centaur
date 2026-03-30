---
name: sourcer
description: Talent sourcing agent that finds candidates matching a job description. Crawls LinkedIn, GitHub, and X/Twitter, then outputs a Google Sheet with candidate profiles. Use when asked to source candidates, find talent, or build a recruiting pipeline.
---

# Talent Sourcer Agent

Sources candidates from LinkedIn, GitHub, and X/Twitter based on a job description, then generates a Google Sheet with results.

## Workflow

### 0. Calibrate on Historical Winners

Before public sourcing, read `reference/outcome-calibration.md` and use `paradigmdb` to inspect the best prior introductions and hires with `rating >= 7` for the closest matching role or expertise. Extract 3-5 archetype signals, note market constraints, and label prior Paradigm touch in your output instead of suppressing it unless the user explicitly asks for net-new names only.

### 1. Parse Job Description

Extract key requirements:
- **Role type** (engineering, product, design, operations, etc.)
- **Seniority level** (junior, senior, staff, principal, etc.)
- **Required skills/technologies**
- **Industry context** (crypto, fintech, AI, etc.)
- **Location preferences** (if any)

### 2. Build Search Strategy

Create searches targeting high-signal profiles:

| Signal | How to Find |
|--------|-------------|
| Elite universities | Search profiles with Stanford, MIT, Caltech, Harvard, Princeton, Yale, CMU, Berkeley, Oxford, Cambridge, etc. |
| High-growth companies | People at early-stage Uber, Stripe, Coinbase, OpenAI, Anthropic, etc. before 2016-2018 |
| GitHub activity | Use browser-use to find contributors to relevant repos |
| Twitter/X influence | `ptwittercli search` for people tweeting about relevant topics |
| Trusted backchannel path | Search for people with strong mutuals, prior collaborators, or obvious operator reference paths |
| Technical taste | Prefer people with concrete project opinions, talks, writing, OSS work, or evidence they can speak credibly with technical users |

### 3. Location Filtering (Hard Requirement)

**If the job description specifies a location, only include candidates based in that location.**

- Check LinkedIn profile location field
- Check X/Twitter bio for city/region mentions
- Exclude candidates who don't match, regardless of other qualifications
- If JD says "Remote" or has no location, skip this filter
- If the location constraint clearly collapses the market, say so explicitly instead of padding the slate with weak local matches

### 4. Candidate Ranking Criteria

**After applying location as a hard filter, rank candidates in this priority order:**

1. **Archetype Fit & Reference Path** (25%)
   - How closely does the candidate match the strongest historical Paradigm introductions or hires for this role?
   - Prefer candidates with a clear trusted-backchannel path: respected operators, founders, hiring managers, or mutuals who would plausibly vouch for them.
   - Strong multi-hop references beat generic keyword overlap.

2. **Title Correspondence** (20%)
   - How closely does the candidate's current title match the target role?
   - Same function + same level = best match (e.g., "Trade Operations Associate" → "Trade Operations Manager")
   - Same function + different level = good match (e.g., "Senior Engineer" → "Staff Engineer")
   - Different function = poor match, even if skills align (e.g., "Trade Operations Associate" → "CFO" is a poor fit)
   - Weight functional alignment heavily over keyword/skill overlap

3. **Professional Trajectory** (20%)
   - Impact achieved relative to years of experience
   - 3 years with senior-level impact >>> 7 years at average pace
   - Look for promotions, title progressions, scope expansions, and unusually early leverage
   - Joining at the 5-50 person stage or building a function from scratch is a major positive signal
   - For engineering roles, concrete high-complexity project ownership beats generic logo prestige

4. **Technical Taste / Market Credibility** (15%)
   - Favor candidates with crisp opinions, named projects or people they follow, public writing, talks, OSS work, or clear evidence they can speak credibly with technical users.
   - For GTM, product, and talent roles, technical empathy and crypto-native fluency matter more than generic enterprise polish.
   - For engineering, security, and protocol roles, prioritize people who can clearly explain system constraints, tradeoffs, and what they actually shipped

5. **Talent Density of Organizations** (15%)
   - Evaluated **dynamically** — do not rely solely on the static elite list
   - For any company not in the known-elite cache, run the **Company Enrichment** step (see below) to score it
   - Signals: investor quality, funding stage, headcount, engineering reputation
   - Known-elite overrides (always score 20, skip enrichment): Jane Street, Two Sigma, Renaissance, Google Brain, DeepMind, Paradigm, a16z crypto
   - Early employees at hypergrowth startups get bonus points (fold into Professional Trajectory)

6. **Educational Foundation** (5%)
   - Elite university attendance (MIT, Stanford, CMU, Caltech, Harvard, Princeton, Yale, Berkeley, Oxford, Cambridge)
   - Consider admissions selectivity (< 10% acceptance = top tier)
   - Note: attendance matters less than actual slope, taste, and evidence of leverage

### Company Enrichment (Dynamic Talent Density Evaluation)

When a candidate's company is **not** in the known-elite list, evaluate it dynamically before scoring.
Cache results so each company is only looked up once per sourcing run.

**Step 1 — Web search:**
```bash
call websearch search '{"query":"<company_name> funding round investors headcount site:crunchbase.com OR site:pitchbook.com OR site:techcrunch.com"}'
```

**Step 2 — Extract signals and compute a company talent-density score (0–20):**

| Signal | Points | How to Assess |
|--------|--------|---------------|
| **Tier-1 VC backing** (Sequoia, a16z, Founders Fund, Paradigm, YC, Benchmark, Accel, Thrive, Ribbit) | +8 | Any tier-1 investor in any round |
| **Tier-2 VC backing** (other well-known VCs not in tier 1) | +4 | Known institutional lead, but not tier-1 |
| **Late-stage or public with strong eng reputation** | +6 | Series C+ or public, known for engineering excellence |
| **Early-stage with strong founding team** | +6 | Pre-Series B, founders from elite companies/schools |
| **Small headcount / high funding ratio** | +4 | < 100 employees with $20M+ raised = selective hiring |
| **Open-source presence** | +2 | Popular OSS projects (1k+ GitHub stars) |

Cap the total at 20. If the web search returns no meaningful results (stealth company, very new), default to a score of 5.

**Step 3 — Cache the result:**
Store `{company_name: {score, investors, headcount, stage, notes}}` in a dict and reuse for all candidates at that company.

**Known-elite cache (skip enrichment, always score 20):**
```python
ELITE_COMPANIES = {
    'jane street', 'two sigma', 'renaissance', 'citadel', 'de shaw',
    'google brain', 'google deepmind', 'deepmind', 'openai', 'anthropic',
    'paradigm', 'a16z crypto',
}
```

**Early-stage bonus companies (score 20 + timing bonus applies):**
```python
EARLY_STAGE_BONUS = {
    'stripe': 2016, 'coinbase': 2017, 'uber': 2014,
    'openai': 2020, 'anthropic': 2023, 'square': 2015,
    'plaid': 2018, 'figma': 2019, 'databricks': 2020,
}
# If candidate joined before the cutoff year, add +5 timing bonus (capped at 20 total for density, timing is separate 15% bucket)
```

### 4. Data Sources & Tools

#### LinkedIn (via browser-use)

```python
from browser_use import Agent, Browser, ChatBrowserUse
import asyncio

async def search_linkedin(query: str):
    browser = Browser(
        cloud_profile_id='paradigm-ai',
        cloud_proxy_country_code='us',
    )

    agent = Agent(
        task=f"""
        1. Navigate to https://www.linkedin.com
        2. Search for: {query}
        3. Filter by: People
        4. For each of the first 20 results, extract:
           - Full name
           - Current job title
           - Current company
           - Location/city
           - LinkedIn profile URL
           - Headline/summary
        5. Return as JSON
        """,
        browser=browser,
        llm=ChatBrowserUse(),
    )

    history = await agent.run(max_steps=50)
    return history.final_result()

asyncio.run(search_linkedin("software engineer stripe coinbase crypto"))
```

#### GitHub (via browser-use)

```python
async def search_github_contributors(repo: str):
    browser = Browser(
        cloud_profile_id='paradigm-ai',
        cloud_proxy_country_code='us',
    )

    agent = Agent(
        task=f"""
        1. Navigate to https://github.com/{repo}/graphs/contributors
        2. For top 30 contributors, extract:
           - GitHub username
           - Number of commits
        3. For each username, visit their profile and extract:
           - Full name (if available)
           - Location
           - Company
           - Email (if public)
           - Twitter handle (if linked)
        4. Return as JSON
        """,
        browser=browser,
        llm=ChatBrowserUse(),
    )

    history = await agent.run(max_steps=100)
    return history.final_result()
```

#### X/Twitter (via ptwittercli)

```bash
# Search for people discussing relevant topics
ptwittercli search "ethereum solidity from:* -filter:replies" -n 100

# Get profiles of influential accounts
ptwittercli user vitalik
ptwittercli followers paradigm -n 200
```

### 5. Email Discovery

Try these methods in order:

1. **GitHub profiles** - Often have public email
2. **Pattern matching** - firstname@company.com, firstname.lastname@company.com
3. **Hunter.io** (via browser-use) - Domain email patterns
4. **Apollo.io** (via browser-use) - Email enrichment

### 6. Output to Google Sheet

Create the sheet with `gsuite sheets create`:

```bash
# Create sheet with proper naming: "Sourcing target list: [role] [date]"
gsuite -a svc_ai@paradigm.xyz sheets create \
  --title "Sourcing target list: Senior Protocol Engineer 2026-02-04" \
  --share "dmccarthy@paradigm.xyz" \
  --role writer
```

**Required columns:**

| Column | Description |
|--------|-------------|
| Name | Full name |
| Title | Current job title |
| Company | Current company/organization |
| LinkedIn | Profile URL |
| Email | Email address (if found) |
| Location | City/geography |
| Score | Ranking score (1-100) |
| Notes | Key signals (university, prior companies, timing) |

Update the sheet with data:

```bash
gsuite -a svc_ai@paradigm.xyz sheets update \
  --spreadsheet-id "<SPREADSHEET_ID>" \
  --range "A1:H100" \
  --values '[["Name","Title","Company","LinkedIn","Email","Location","Score","Notes"],["Jane Doe","Staff Engineer","Stripe","https://linkedin.com/in/janedoe","jane@stripe.com","SF","95","MIT CS, Stripe 2015, ex-Google Brain"]]'
```

### 7. Example Full Workflow

```python
import asyncio
import subprocess
import json
from browser_use import Agent, Browser, ChatBrowserUse

async def source_candidates(job_description: str, role_name: str):
    """Full sourcing workflow"""

    # 1. Parse JD for search terms
    key_skills = extract_skills(job_description)  # Your parsing logic
    target_companies = ["stripe", "coinbase", "opensea", "uniswap", "paradigm"]

    candidates = []

    # 2. Search LinkedIn
    browser = Browser(cloud_profile_id='paradigm-ai', cloud_proxy_country_code='us')

    for company in target_companies:
        query = f"{key_skills[0]} {company} crypto blockchain"
        agent = Agent(
            task=f"Search LinkedIn for '{query}', extract first 20 profiles with name, title, company, location, LinkedIn URL",
            browser=browser,
            llm=ChatBrowserUse(),
        )
        history = await agent.run(max_steps=30)
        candidates.extend(parse_linkedin_results(history.final_result()))

    # 3. Search GitHub contributors
    relevant_repos = ["ethereum/go-ethereum", "paradigmxyz/reth", "foundry-rs/foundry"]
    for repo in relevant_repos:
        agent = Agent(
            task=f"Get top 20 contributors from github.com/{repo}/graphs/contributors with their profiles",
            browser=browser,
            llm=ChatBrowserUse(),
        )
        history = await agent.run(max_steps=40)
        candidates.extend(parse_github_results(history.final_result()))

    # 4. Search Twitter
    twitter_results = subprocess.run(
        ["ptwittercli", "search", f"{key_skills[0]} engineer building", "-n", "50"],
        capture_output=True, text=True
    )
    candidates.extend(parse_twitter_results(twitter_results.stdout))

    # 5. Score and dedupe
    scored = score_candidates(candidates)
    deduped = dedupe_by_name_or_email(scored)
    top_candidates = sorted(deduped, key=lambda x: x['score'], reverse=True)[:50]

    # 6. Create Google Sheet
    from datetime import date
    sheet_title = f"Sourcing target list: {role_name} {date.today()}"

    create_result = subprocess.run([
        "gsuite", "-a", "svc_ai@paradigm.xyz", "sheets", "create",
        "--title", sheet_title,
        "--share", "dmccarthy@paradigm.xyz",
        "--role", "writer"
    ], capture_output=True, text=True)

    spreadsheet_id = extract_spreadsheet_id(create_result.stdout)

    # 7. Populate sheet
    rows = [["Name", "Title", "Company", "LinkedIn", "Email", "Location", "Score", "Notes"]]
    for c in top_candidates:
        rows.append([
            c.get('name', ''),
            c.get('title', ''),
            c.get('company', ''),
            c.get('linkedin', ''),
            c.get('email', ''),
            c.get('location', ''),
            str(c.get('score', 0)),
            c.get('notes', '')
        ])

    subprocess.run([
        "gsuite", "-a", "svc_ai@paradigm.xyz", "sheets", "update",
        "--spreadsheet-id", spreadsheet_id,
        "--range", f"A1:H{len(rows)}",
        "--values", json.dumps(rows)
    ])

    return f"Created sheet: https://docs.google.com/spreadsheets/d/{spreadsheet_id}"

def score_candidates(candidates, target_title: str, target_location: str = None):
    """Score based on the 5 criteria, with location filtering and dynamic company enrichment."""
    elite_schools = {'mit', 'stanford', 'cmu', 'caltech', 'harvard', 'princeton', 'yale', 'berkeley', 'oxford', 'cambridge'}

    # Static elite companies — always score 20, skip enrichment
    ELITE_COMPANIES = {
        'jane street', 'two sigma', 'renaissance', 'citadel', 'de shaw',
        'google brain', 'google deepmind', 'deepmind', 'openai', 'anthropic',
        'paradigm', 'a16z crypto',
    }

    # Early-stage bonus companies — score 20 + timing bonus if joined before cutoff year
    EARLY_STAGE_BONUS = {
        'stripe': 2016, 'coinbase': 2017, 'uber': 2014,
        'openai': 2020, 'anthropic': 2023, 'square': 2015,
        'plaid': 2018, 'figma': 2019, 'databricks': 2020,
    }

    # Cache for dynamically enriched companies: {name: {score, investors, headcount, stage, notes}}
    company_cache = {}

    # Location filtering (hard requirement)
    if target_location and target_location.lower() not in ['remote', '']:
        candidates = [c for c in candidates if location_matches(c.get('location', ''), target_location)]

    for c in candidates:
        score = 25  # Base score
        notes = []

        # Title correspondence (25%) - functional alignment matters most
        title = (c.get('title', '') or '').lower()
        target_lower = target_title.lower()
        title_score = compute_title_match(title, target_lower)
        score += title_score
        if title_score >= 20:
            notes.append("title match")

        # Education (20%)
        edu = (c.get('education', '') or '').lower()
        for school in elite_schools:
            if school in edu:
                score += 20
                notes.append(f"{school.upper()}")
                break

        # Professional trajectory (20%) - infer from title vs years
        if 'staff' in title or 'principal' in title or 'director' in title:
            score += 18
            notes.append("senior title")
        elif 'senior' in title or 'lead' in title:
            score += 12

        # Talent density (20%) — dynamic enrichment for unknown companies
        company = (c.get('company', '') or '').lower()
        company_score = 0
        company_matched = False

        # Check static elite list first (fast path)
        for elite in ELITE_COMPANIES:
            if elite in company:
                company_score = 20
                notes.append(elite)
                company_matched = True
                break

        # Check early-stage bonus list
        if not company_matched:
            for co_name, cutoff_year in EARLY_STAGE_BONUS.items():
                if co_name in company:
                    company_score = 20
                    notes.append(f"{co_name} (early-stage)")
                    company_matched = True
                    break

        # Dynamic enrichment — websearch for unknown companies
        if not company_matched and company and company not in company_cache:
            # Run: call websearch search '{"query":"<company> funding round investors headcount"}'
            # Parse results for: tier-1 VC backing (+8), tier-2 VC (+4), late-stage eng rep (+6),
            # early-stage strong founders (+6), small headcount/high funding (+4), OSS presence (+2)
            # Cap at 20. Default to 5 if no data found.
            enrichment = enrich_company(company)  # See Company Enrichment section above
            company_cache[company] = enrichment

        if not company_matched and company in company_cache:
            enrichment = company_cache[company]
            company_score = enrichment['score']
            if enrichment.get('notes'):
                notes.append(enrichment['notes'])

        score += company_score

        c['score'] = min(score, 100)
        c['notes'] = ', '.join(notes)

    return candidates


def enrich_company(company_name: str) -> dict:
    """
    Dynamically evaluate a company's talent density via web search.
    Called via: call websearch search '{"query":"<company_name> funding round investors headcount"}'

    Returns: {score: int (0-20), investors: str, headcount: str, stage: str, notes: str}

    Scoring rubric:
      +8  Tier-1 VC backing (Sequoia, a16z, Founders Fund, Paradigm, YC, Benchmark, Accel, Thrive, Ribbit)
      +4  Tier-2 VC backing (other known institutional investors)
      +6  Late-stage/public with strong engineering reputation
      +6  Early-stage with strong founding team (founders from elite cos/schools)
      +4  Small headcount + high funding ratio (< 100 employees, $20M+ raised)
      +2  Open-source presence (1k+ GitHub stars)
      Cap at 20. Default to 5 if no meaningful data found.
    """
    # Implementation: use websearch tool, parse results, compute score
    # This is executed by the agent at runtime, not as literal Python
    pass

def location_matches(candidate_location: str, target_location: str) -> bool:
    """Check if candidate location matches target (case-insensitive, partial match)"""
    if not candidate_location:
        return False
    return target_location.lower() in candidate_location.lower()

def compute_title_match(candidate_title: str, target_title: str) -> int:
    """Score title correspondence (0-25 points)"""
    # Extract function words (operations, engineer, analyst, manager, etc.)
    functions = ['engineer', 'operations', 'analyst', 'manager', 'associate', 'director', 
                 'developer', 'designer', 'scientist', 'researcher', 'lead', 'head']
    
    candidate_funcs = [f for f in functions if f in candidate_title]
    target_funcs = [f for f in functions if f in target_title]
    
    # Same function = high score
    if set(candidate_funcs) & set(target_funcs):
        return 25
    # Adjacent functions (e.g., analyst/associate) = medium score
    adjacent_pairs = [{'analyst', 'associate'}, {'manager', 'director'}, {'lead', 'manager'}]
    for pair in adjacent_pairs:
        if (set(candidate_funcs) & pair) and (set(target_funcs) & pair):
            return 15
    # Different function = low score
    return 5
```

Before final sorting, manually apply the archetype, backchannel, and market-fit rules in `reference/outcome-calibration.md`. A smaller high-conviction slate is better than a padded one, but prior Paradigm touch should usually be called out rather than filtered away.

## Ideal Candidate Signals

- Extremely articulate communicator, can explain complex ideas in a way that is easy to understand (Strong signal)
- Multiple examples of solving complex problems (Strong signal)
- Followed by multiple people at Paradigm or by Paradigm founders/fellows on X/Twitter (Strong signal)
- Spend less than 1 year in each role over multiple companies (Yellow flag)

## Experience Level & "Juice" Heuristic (Learned from Andromeda VPE search, March 2026)

When sourcing for startup leadership roles (VP/Head of Eng at zero-to-one companies), calibrate for candidates who still have **builder energy**, not just seniority:

- **Sweet spot: ~10–18 years of experience.** Director or early VP level. Senior enough to lead, junior enough to still be hands-on and hungry.
- **Penalize "too senior":** SVPs, CTOs of large companies, or co-founders with 25+ year careers who have bounced across many companies are likely past the zero-to-one stage. They may lack the remaining juice for a startup run.
- **Reward trajectory over tenure:** A director at 12 years experience who has built teams from scratch at 2–3 companies is stronger than a VP at 25 years who climbed ladders at big cos.
- **Startup founding/building DNA matters:** Prior experience co-founding a startup, being a founding engineer, or scaling a team from zero at a high-growth company is a strong signal — even if the startup failed or was acqui-hired.
- **Avoid career bouncers:** 25+ year careers with short stints across many companies suggest a lack of commitment or impact at any single place. Yellow flag.
- **Never suggest duplicates across rounds.** Track previously suggested names and never re-suggest them, even if they were well-received.

## Sourcing Heuristics

- Look for candidates who work at companies funded by the most prestigious VCs (Sequoia, Andreessen Horowitz, Founders Fund, Y Combinator, etc.)
- Omit anyone who currently works at a Paradigm portfolio company, but use people at companies like Phantom, Uniswap, Zora, Magic Eden, OpenSea, Axiom, Coinbase, Privy, Kalshi, Monad and Coinbase as examples of exceptional talent, with some caveats
- For GTM and talent roles, prioritize candidates who can point to specific operators they know, markets they've personally covered, and hires or deals they personally closed
- For engineering, security, and protocol roles, prefer candidates with a crisp high-complexity build story, strong open-source or ecosystem taste, and evidence they can thrive in small technical teams
- For niche searches, return the best 10-15 names plus a market read rather than 50 weak fits
- By default, previously introduced or hired people can still be surfaced; clearly label prior Paradigm touch so the user can decide whether to reuse or prioritize net-new names

## Decision Framework

- Would Dan McCarthy or Chris Shu feel comfortable recommending this candidate to a Paradigm portfolio company?
- Would this person accelerate a portfolio company's trajectory?
- Would we be interested in staying in touch with this person for a future role?
- Can we explain the winning archetype match for this candidate in one sentence?

## Tips

- **Parallelize searches** - Run LinkedIn, GitHub, Twitter searches concurrently
- **Use `paradigmdb` first** - Calibrate on prior winners and linked notes before public search
- **Respect rate limits** - Space out browser-use requests to avoid blocks
- **Dedupe aggressively** - Same person may appear across platforms
- **Verify emails** - Pattern-matched emails should be marked as unverified
- **Prioritize recency** - More recent profiles have more accurate info

## Common Search Queries

| Role Type | LinkedIn Query | GitHub Repos | Twitter Search |
|-----------|---------------|--------------|----------------|
| Protocol Engineer | "solidity rust ethereum" | ethereum/*, paradigmxyz/*, foundry-rs/* | "solidity rust building" |
| Research Engineer | "machine learning crypto" | flashbots/*, paradigmxyz/* | "MEV research building" |
| Full-Stack Engineer | "react typescript crypto" | uniswap/*, opensea/* | "crypto frontend building" |
| Security Engineer | "smart contract audit" | crytic/*, trail-of-bits/* | "smart contract security" |
