---
name: policy-gigabrain
description: "Policy team intelligence system for Hill briefings, staffer tracking, bill analysis, vote prediction, and legislative trend detection. Use when asked about congressional meetings, staffers, legislation, regulatory actions, rulemakings, whip counts, policy team workflows, any question about OCC, SEC, CFTC, FDIC, FinCEN, Treasury guidance, stablecoins, GENIUS Act, market structure bills, crypto regulation, OR any question about a Member of Congress (Senator, Representative, their staff, their donors, their voting record, their committee assignments, or their positions on issues). Triggers on: policy question, regulatory impact, bill analysis, legislation impact on portfolio, Member of Congress inquiry, congressional staffer lookup, campaign finance question, voting record question."
---

# Policy Gigabrain

Centralized intelligence system for government affairs. Generates meeting briefers, tracks staffers and legislators, monitors legislation, predicts votes, and surfaces portfolio-relevant regulatory actions.

## ⚠️ MANDATORY FIRST STEP: Policy Explainer Index

**Before answering ANY policy or regulatory question — before running web searches or reading external sources — you MUST first check the Paradigm Policy team's internal analysis.**

```bash
call gsuite docs_read '{"doc_id":"1yiKL4NgJfT0cAXehqHvaYC1mMezKdDhxwnr8Gm8aa6c"}'
```

This is the **Policy Explainer Index** ([link](https://docs.google.com/document/d/1yiKL4NgJfT0cAXehqHvaYC1mMezKdDhxwnr8Gm8aa6c/edit?tab=t.0)), maintained by the Policy team. It contains Paradigm's internal analysis and takes on major regulatory developments (GENIUS Act, FDIC rulemakings, SEC actions, etc.).

**Why this matters:** The Policy team's analysis includes Paradigm-specific context, portfolio impact assessments, and strategic framing that external sources cannot provide. External web searches should only supplement — never replace — the team's own work.

**Workflow:**
1. Read the Policy Explainer Index to check if the topic has been analyzed
2. If an explainer exists, read the linked analysis doc for full detail
3. Pull recent posts from **#gigabrain-feed** for additional policy intel:
   ```bash
   call slack get_channel_history '{"channel":"C0AM0TR8N91","limit":50}'
   ```
4. Only then supplement with external sources (OCC/SEC/CFTC websites, Federal Register, etc.) if needed
5. Always cite the internal analysis as the primary source

## Core Capabilities

| Function | Description |
|----------|-------------|
| **Meeting Briefers** | Auto-generate one-pagers for Hill meetings |
| **Staffer Tracking** | Track congressional/regulatory staff careers and relationships |
| **Bill Tracking** | Monitor legislation with momentum scores and status |
| **Vote Prediction** | Maintain whip sheets with stance, confidence, rationale |
| **Trend Detection** | Surface emerging patterns across jurisdictions |
| **Portfolio Impact** | Flag legislation affecting portfolio companies |

---

## Data Sources

### External APIs

| Source | Tool | Purpose |
|--------|------|---------|
| **Congress.gov** | `call congress` | Bills, members, committees, hearings, votes, amendments |
| **Federal Register** | `call fedreg` | Regulatory dockets, comment periods, rulemakings |
| **OpenFEC** | `call openfec` | Campaign contributions, candidates, committees, filings |
| **LegiStorm** | `call legistorm` | Congressional staff (`get_staff`), members (`get_members`), hearings (`get_hearings`), offices (`get_offices`), caucuses (`get_caucuses`), town halls (`get_townhalls`), privately funded travel (`get_trips`). All list endpoints require `updated_from`/`updated_to` date params (YYYY-MM-DD). |
| **Plural (Open States)** | `call plural` | State-level legislation (`search_bills`, `get_bill`), legislators (`search_people`), committees (`list_committees`), and legislative events (`list_events`). Use `jurisdiction` param (e.g. `"New York"`, `"California"`). Covers all 50 states + territories. |

### Internal Sources

| Source | Tool | Use For |
|--------|------|---------|
| **Shift / paradigmdb** | `call paradigmdb` | Portfolio companies, prior interactions, notes |
| **Slack** | `call slack search_messages` | Policy team discussions, intel |
| **#gigabrain-feed** | `call slack get_channel_history '{"channel":"C0AM0TR8N91"}'` | Curated policy intel feed — regulatory updates, legislative signals, policy analysis, and `#touchpoint` posts. Search this channel early in any policy workflow and use it as the primary source of substantive office intel for briefers. |
| **Google Sheet touchpoint log** | `call gsuite sheets_read` | Minimal backup log for office touchpoints. Stores only canonical office/member name, date, and meeting type. Use this first for recency/frequency questions like "when did we last meet with X?" and "how many times have we met with Y?". |
| **GSuite** | `call gsuite` | Meeting notes, Hill interaction logs, Drive docs |
| **Archived docs / notes** | `call gsuite`, `call slack search_messages`, `call websearch search` | Archived policy documents, notes, and discussion |

---

## Workflows

### 1. Meeting Briefer Generation

Generate a policy briefing memo before Hill meetings.

**Trigger Phrases** (from Madison, Alex G., Justin, Stefan, Katie, or Caitlin):
- "Write a policy briefing memo for [Name, Title]"
- "Briefing memo for [Name]"
- "Policy briefer for [Name]"
- "Meeting brief for [Name]"
- "Write a Hill memo for [Name]"
- "Prepare a one-pager for my meeting with [Name]"

**Input:** Member/staffer name, meeting context, date

**Steps:**
1. Read the Policy Explainer Index first.
2. For office recency/frequency questions, read the Google Sheet touchpoint log first:
   ```bash
   call gsuite drive_search '{"query":"Policy Touchpoint Log","max_results":10}'
   call gsuite sheets_read '{"spreadsheet_id":"[touchpoint_sheet_id]","range_notation":"A:C"}'
   ```
3. Search `#gigabrain-feed` for all relevant posts about the office or member, with special weight on `#touchpoint` messages:
   ```bash
   call slack search_messages '{"query":"in:#gigabrain-feed [office_name]"}'
   call slack search_messages '{"query":"in:#gigabrain-feed #touchpoint [office_name]"}'
   call slack search_messages '{"query":"from:#policy [member_name]"}'
   call gsuite gmail_search '{"query":"[member_name]"}'
   call paradigmdb notes_search '{"query":"[member_name]"}'
   ```
4. Use those `#gigabrain-feed` results to extract the office's substantive intel — positions, concerns, asks, openings, and framing that landed or failed. Most recent intel should lead unless older intel is clearly more probative.
5. Look up the member profile via web search and LegiStorm:
   ```bash
   # LegiStorm member profile, committee assignments, staff
   call legistorm get_members '{"updated_from":"2025-01-01","updated_to":"2026-12-31","state_id":"[XX]"}'
   ```
6. Find relevant pending legislation:
   ```bash
   call congress bills '{"congress":119}'
   call congress bill '{"congress":119,"type":"s","number":123}'
   ```
7. Check FEC for campaign contribution context:
   ```bash
   call openfec candidates '{"name":"[member_name]"}'
   call openfec contributions '{"contributor_name":"[member_name]"}'
   ```
8. Cross-reference with paradigmdb for portfolio company relevance:
   ```bash
   call paradigmdb db_query '{"query":"SELECT * FROM \"Organization\" WHERE name ILIKE '\''%relevant_company%'\'';"}'
   ```
9. Generate the briefer using the format and style rules below.
10. Before delivering the memo, run the pre-delivery checklist below and cut anything that pushes the draft into an issue-deck format.

**Audience**
- Write for a Paradigm executive with deep fluency in crypto, DeFi, and relevant legislation.
- Do not explain crypto concepts, market structure basics, or Paradigm's positions from first principles.

**Tone & Voice**
- Write in a direct, declarative briefing memo style.
- Keep the prose punchy and synthesized, like a well-prepared staff briefing for a senior executive.
- State facts as facts. Do not narrate sourcing with phrases like "According to his official bio," "per public disclosures," or "research shows."
- Use present tense for current roles and positions and past tense for historical facts.
- Avoid filler transitions like "it is worth noting," "additionally," or "it should be mentioned."

**Length Target**
- Default to a tight principal-ready memo of roughly 900-1100 words, usually about 3 pages.
- When choosing between the approved Schumer and Cruz examples, follow Cruz for length and restraint, and use Schumer only as a model for member-specific political intelligence.
- Only exceed the default length when the user explicitly asks for a longer memo or the office is unusually central to an active negotiation.

**Inclusion Standard**
- Write an operator brief, not a comprehensive research memo.
- Include only facts or judgments that help the meeting team understand how the member thinks or how to run the conversation.
- Prefer tailored analysis over generic issue background. Cut any sentence that could appear unchanged in dozens of memos.
- Do not pad thin sections with generic talking points or mini white papers on crypto, AI, defense tech, or prediction markets.
- Do not include tactical sidebars such as fundraising context, access notes, or ally-labeling unless the user explicitly asks for them.

**Handling Gaps**
- Do not narrate the absence of research.
- Never write "I could not find."
- If a directly relevant category has no public record, make a short editorial statement and move on, for example: "No public stances on prediction markets."
- If a section has no meaningful available information, include the header and a single brief editorial sentence rather than omitting the section.

**Uncertain Or Unverified Claims**
- One soft hedge per claim is acceptable when needed, for example: "reportedly," "said to," or "believed to."
- Do not stack hedges or over-qualify.

**Structure Rules**
- Use exactly these sections in this order and do not add, rename, or reorder them:
  1. `Landscape Summary`
  2. `Biography`
  3. `Goals`
  4. `Crypto Knowledge`
  5. `Stance on Prediction Markets`
  6. `Stance on Defense Tech`
  7. `Stance on AI`
- Do not generate a `Specific Topics to Address` section.
- Do not generate a `Touchpoints` section.
- If the user wants talking points, issue notes, or a live legislative walkthrough, treat that as a separate deliverable rather than adding another memo section.
- Fold prior office touchpoint intel into `Landscape Summary` and the relevant stance sections instead.
- `Landscape Summary` and `Biography` should be short prose sections.
- `Goals`, `Crypto Knowledge`, `Stance on Prediction Markets`, `Stance on Defense Tech`, and `Stance on AI` should use concise full-sentence bullets.
- `Goals` should use plain bullets with no `Primary Ask`, `Secondary Objectives`, or `Success Criteria` labels.

**Touchpoint Intel Rules**
- Search `#gigabrain-feed` broadly for the office or member, not just `#touchpoint` posts. `#touchpoint` posts usually carry the highest weight, but other relevant posts in `#gigabrain-feed` can also inform the briefer.
- Use the Google Sheet touchpoint log for recency and frequency. Use Slack posts for substance.
- Inject substantive office intel directly into `Landscape Summary` and the relevant stance sections (`Crypto Knowledge`, `Stance on Prediction Markets`, `Stance on Defense Tech`, `Stance on AI`).
- Present that intel as synthesized analysis, not attributed sourcing. Do not write phrases like "per my meeting with" or "in a recent touchpoint."
- Lead with the most recent office intel unless an older signal is more probative.

**Landscape Summary Rules**
- Open with committee assignments and relevant subcommittees.
- Then define the member's core policy identity.
- Then provide the strategic read on where Paradigm's issues fit for that member.
- Do not open with a negative, a gap, or a statement that the member is not important on crypto.
- If crypto is not central to the member, frame it as focus, not absence, for example: "Digital assets are not a primary focus" or "He has not engaged on crypto legislation."
- Do not use internal strategy language such as "persuasion pitch," "productive lane," or "wrong lane."
- State conclusions as intelligence, not as meeting tactics.

**Biography Rules**
- Keep `Biography` short and functional.
- Use it to explain how the member thinks, not to inventory every prior job or credential.
- Default to one short paragraph. Use two short paragraphs only when the extra context clearly sharpens the political read.

**Goals Rules**
- Write short, plain-English bullets describing what we want to get done, what we want to learn, or what framing we want to land.
- Keep the bullets specific to the member and the meeting.
- Avoid generic relationship-building filler.
- Use 3-4 bullets by default.
- Favor bullets that describe an action, question, or strategic point to land. Good patterns: "Press for Schumer's read on the path for CLARITY" or "Establish that Paradigm's AI work fits his competitiveness agenda."
- Avoid generic bullets like "Introduce Paradigm" unless the office genuinely does not know us or the relationship reset is itself a meeting objective.

**Stance Section Rules**
- Each bullet should be member-specific and additive.
- Do not turn these sections into generic explainers on the underlying issue.
- If there is not enough tailored material for a full section, use one short editorial bullet rather than padding.
- Use 1-3 bullets per stance section. One strong bullet is better than three generic ones.

**Section Density Rules**
- `Landscape Summary`: 1-2 short paragraphs.
- `Biography`: 1 short paragraph by default, 2 only if needed.
- `Goals`: 3-4 bullets.
- `Crypto Knowledge`, `Stance on Prediction Markets`, `Stance on Defense Tech`, and `Stance on AI`: usually 1-3 bullets each.
- If the draft starts to read like a combined memo plus issue deck, cut rather than expand.

**Paradigm Perspective**
- Layer in Paradigm's views where relevant, especially in `Landscape Summary`, the stance sections, and `Goals`.
- For prediction markets, treat the issue as federally regulated market infrastructure under CFTC jurisdiction, not as a gambling-side issue.

**Style Reference**
- Default to a specific, clean, no-throat-clearing style, for example: "McCormick first ran for the U.S. Senate in 2022, narrowly losing the Pennsylvania Republican primary to Mehmet Oz by a margin of 0.1 percent."
- Use the format and section guidance in this template when in doubt: `https://docs.google.com/document/d/1jAEVUbvZHZZ09D6LBxU5jbyIx4e-YuXyDfLT-BL5Vpc/edit?usp=sharing`

**Briefer Pre-Delivery Checklist**
- The draft is roughly within the 900-1100 word target unless the user asked for more.
- The memo contains only the seven required sections, in order.
- There is no `Specific Topics to Address`, `Touchpoints`, or standalone issue-deck section.
- `Goals` contains 3-4 specific, outcome-driven bullets rather than generic relationship filler.
- Each stance section contains only member-specific points; generic background has been cut.
- Any request for talking points or legislative detail has been handled as a separate deliverable, not appended to the memo.

**Briefer Template:**
```
## Landscape Summary
Write 1-2 short paragraphs that open with committee assignments and relevant subcommittees, then define the member's core policy identity, then explain where Paradigm's issues fit for that member. Keep this analytical and compact.

## Biography
Write 1 short paragraph by default, or 2 short paragraphs only when needed, in reverse chronological order. Cover only the career milestones, prior offices, and background that help explain how the member thinks.

## Goals
- [Concrete meeting objective]
- [Question to press or intel to gather]
- [Paradigm framing to land]
- [Optional fourth bullet only if it is truly meeting-critical]

## Crypto Knowledge
Use 1-3 full-sentence bullets covering only the most relevant material: familiarity with crypto and digital assets, notable public statements, legislative engagement, whether crypto is a core issue or a competitiveness issue for them, and any relevant staff sophistication.

## Stance on Prediction Markets
Use 1-3 full-sentence bullets covering: public record if any, likely entry point, relevant current events, and how the member is likely to see the issue. Frame this around Paradigm's position that prediction markets and all event contracts should be regulated by the CFTC under exclusive federal jurisdiction.

## Stance on Defense Tech
Use 1-3 full-sentence bullets covering: defense-industrial priorities, acquisition reform views, state or district defense ties, and how the member thinks about innovation, deterrence, and competition.

## Stance on AI
Use 1-3 full-sentence bullets covering: philosophy of regulation, innovation posture, national-security framing, and whether the member prefers congressional action versus agency action.
```

### 1a. `#touchpoint` Capture

Use this workflow when a user posts `#touchpoint [freeform text]` in `#gigabrain-feed` (`C0AM0TR8N91`).

**Capture behavior**
1. Reply in thread with exactly: `got it.`
2. Treat the Slack post itself as the full capture step.
3. Do not ask for staffer names or any additional structure.
4. Canonicalize the office/member name from the message text.
5. Default the date to the Slack message timestamp unless the text clearly specifies another date.
6. Normalize `meeting_type` to one of `coffee`, `call`, `event`, `meeting`, or `other`. Default to `meeting` when unclear.
7. Extract and store only:
   - `office`
   - `date`
   - `meeting_type`

**Google Sheet backup**
1. Silently append the minimal row to a Google Sheet named `Policy Touchpoint Log`.
2. If the sheet does not exist yet, create it with columns `office`, `date`, and `meeting_type`.
3. Share the sheet only with the requesting user and post the sheet link in-thread once when it is first created.
4. After the sheet exists, continue writing to it silently in the background. Do not mention the sheet on subsequent `#touchpoint` captures.

**Tool pattern**
```bash
call gsuite drive_search '{"query":"Policy Touchpoint Log","max_results":10}'
call gsuite sheets_create '{"title":"Policy Touchpoint Log","content":[["office","date","meeting_type"]]}'
call gsuite sheets_read '{"spreadsheet_id":"[touchpoint_sheet_id]","range_notation":"A:C"}'
call gsuite sheets_update '{"spreadsheet_id":"[touchpoint_sheet_id]","range_notation":"A[append_row]:C[append_row]","values":[["[office]","[date]","[meeting_type]"]]}'
call gsuite drive_share '{"file_id":"[touchpoint_sheet_id]","email":"[requester_email]","role":"writer","send_notification":false}'
```

### 2. Staffer Tracking

Track congressional and regulatory staffers relevant to crypto policy.

**Key Roles to Track:**
- Legislative Directors (LD)
- Committee Counsel (especially Banking, Finance, Agriculture)
- Personal Office Chiefs of Staff
- Leadership Staff
- Executive branch personnel rotating to legislative

**Data Points:**
- Current role and office
- Committee assignments
- Policy areas covered
- Career trajectory
- Paradigm touchpoints
- Alma mater (for relationship mapping)

**Flags to Surface:**
- Junior staff moving to senior roles (build relationships early)
- Committee transfers (new jurisdictional exposure)
- Executive → legislative rotations
- Departures from key offices

**Search Commands:**
```bash
# Find prior interactions with staffer
call slack search_messages '{"query":"[staffer_name]"}'
call gsuite gmail_search '{"query":"[staffer_name]"}'

# Check if mentioned in notes
call paradigmdb notes_search '{"query":"[staffer_name]"}'

# LegiStorm lookup — get_staff requires date range; use a wide window to find current staff
call legistorm get_staff '{"updated_from":"2025-01-01","updated_to":"2026-12-31","member_id":[member_id]}'
# Or search all recent staff updates
call legistorm get_staff '{"updated_from":"2026-01-01","updated_to":"2026-12-31","limit":20}'
```

### 2b. Member of Congress Research

Answer any question about a Member of Congress — their staff, donors, voting record, committee assignments, positions on issues, or ties to specific industries/interests.

**Trigger Phrases:**
- "What are [Member]'s ties to [industry/interest]?"
- "Who are [Member]'s top donors?"
- "What is [Member]'s position on [issue]?"
- "Who are the senior staffers for [Member]?"
- "How much money has [Member] received from [industry]?"
- Any question naming a Senator or Representative

**Steps:**
1. **Identify the member** — resolve name, state, party, and chamber:
   ```bash
   call openfec search_candidates '{"name":"[member_name]","state":"[XX]","per_page":5}'
   call congress get_member '{"bioguide_id":"[bioguide_id]"}'
   ```
2. **Get committee assignments** — check Senate.gov or Congress.gov:
   ```bash
   # Read committee assignments page for jurisdictional context
   read_web_page https://www.senate.gov/general/committee_assignments/assignments.htm
   ```
3. **Pull staff roster from LegiStorm:**
   ```bash
   # First find the member_id
   call legistorm get_members '{"updated_from":"2024-01-01","updated_to":"2026-12-31","state_id":"[XX]","limit":20}'
   # Then get their staff
   call legistorm get_staff '{"updated_from":"2025-01-01","updated_to":"2026-12-31","member_id":[member_id],"limit":20}'
   ```
4. **Pull campaign finance data from OpenFEC:**
   ```bash
   # Get candidate IDs and committee IDs
   call openfec search_candidates '{"name":"[member_name]","per_page":5}'
   # Search for specific industry/interest contributions
   call openfec get_contributions '{"committee_id":"[committee_id]","contributor_name":"[industry keyword]","min_date":"2016-01-01","per_page":20}'
   # Get aggregate totals
   call openfec get_candidate_totals '{"candidate_id":"[candidate_id]"}'
   ```
5. **Check OpenSecrets for industry-level aggregation:**
   ```bash
   # Top recipients for a specific industry (e.g., Indian Gaming = G6550)
   read_web_page https://www.opensecrets.org/industries/recips?cycle=2024&ind=[industry_code]&recipdetail=A&mem=Y&sortorder=U
   # Member's industry breakdown
   read_web_page https://www.opensecrets.org/members-of-congress/[member-slug]/industries/[member_id]
   ```
6. **Search internal Slack and email for prior interactions:**
   ```bash
   call slack search_messages '{"query":"[member_name]"}'
   call gsuite gmail_search '{"query":"[member_name]"}'
   call paradigmdb notes_search '{"query":"[member_name]"}'
   ```
7. **Check #gigabrain-feed for recent policy intel:**
   ```bash
   call slack get_channel_history '{"channel":"C0AM0TR8N91","limit":50}'
   ```
8. **Search Congress.gov for sponsored/cosponsored legislation:**
   ```bash
   call congress get_member '{"bioguide_id":"[bioguide_id]"}'
   # Also check via web for full bill list
   read_web_page https://www.congress.gov/member/[member-name]/[bioguide_id]
   ```

**Output format:** Structured response covering:
- Background (committees, party, state, seniority)
- Campaign finance data with cycle-over-cycle trends
- Specific donor breakdown (itemized FEC records where relevant)
- Senior staff with roles and issue coverage areas
- Legislative activity relevant to the question
- Internal Paradigm touchpoints (Slack, email, notes)

### 2c. Hill Staff Map

Maintain standing intelligence on current staff across the Senate Banking Committee and House Financial Services Committee (HFSC). This is part of the Gigabrain's persistent context — not a one-off report. Once built, the agent draws on it to answer any question about these people: who covers crypto for a given member, who's rising, who would be a strong hire for a portfolio company, who's the right door for a specific issue. The map is built once, stored in a Google Sheet as a memory layer, and refreshed weekly in the background.

**LegiStorm office IDs (hardcoded):**
- Senate Banking, Housing and Urban Affairs Committee: `office_id = 676`
- House Financial Services Committee: `office_id = 1200`

**Stored sheet name:** `Hill Staff Map`

---

**Trigger Phrases:**
- "Who's the lead staffer for crypto on Senate Banking?"
- "Who covers fintech / financial regulation for [member]?"
- "Who on HFSC would be a strong hire for a portfolio company?"
- "Who's up and coming on Senate Banking?"
- "Hill staff map" / "HFSC bench" / "Banking Committee staff"
- "Who's doing what on Senate Banking / HFSC?"
- "Build the Hill Staff Map" / "Refresh the Hill Staff Map"
- Any question about a specific staffer on Senate Banking or HFSC

---

**What this map is for**

Three connected uses — answered from the same knowledge base, no mode-switching:

1. **Issue mapping** — who is the lead staffer on crypto (and eventually AI and defense tech) for each member and on the committee staff itself. When someone asks "who's the right door on Senate Banking for stablecoin legislation," this is what the agent draws on.

2. **Talent intelligence** — who is up-and-coming (strong trajectory, committee exposure, early career), and who is experienced enough to be a strong hire for a portfolio company Head of Policy or similar role. Trajectory matters more than current title — titles are inconsistent across offices.

3. **Landscape awareness** — who's doing what, who's moving, who just joined, who has depth on financial regulation vs. crypto vs. broader economic policy.

These are not separate views. They are different questions answered from the same stored context.

---

**Data to capture per staffer**

| Field | Source | Notes |
|-------|--------|-------|
| Name | `staff.preferred_first_name` + `preferred_last_name` | |
| Office / member | `positions[].office` or member name | Committee staff vs. personal office |
| Committee | Senate Banking or HFSC | |
| Side | `bio_details.party_name` + `maj_min` | Republican/Democrat, majority/minority |
| Current title | `positions[is_current=true].position_title` | Metadata only — not used for ranking |
| Hill years | Earliest `positions[].start_date` → today | Primary ranking signal |
| Committee staff flag | Whether current position is office_id 676 or 1200 | Committee staff ranked above personal office |
| Issue coverage | Inferred from title, committee, web search if needed | Crypto / fintech / financial regulation — flag as primary if apparent |
| Trajectory signal | Junior + committee exposure = up-and-coming; 7+ years + policy depth = senior/hireable | Computed, not stored as a note |

**Do not store evaluative notes.** Issue coverage and trajectory are structured fields, not written assessments.

---

#### Build the Map (run once, then weekly)

**Step B1. Check for existing sheet:**
```bash
call gsuite drive_search '{"query":"Hill Staff Map","max_results":5}'
```
If found, note the `spreadsheet_id`. If not, create it:
```bash
call gsuite sheets_create '{"title":"Hill Staff Map","content":[["name","office","member","committee","side","party","title","hill_years","earliest_start","committee_staff","crypto_coverage","staff_id"]]}'
```

**Step B2. Pull committee professional staff directly:**
```bash
call legistorm get_staff '{"updated_from":"2025-01-01","updated_to":"2026-12-31","office_id":676,"limit":100}'
call legistorm get_staff '{"updated_from":"2025-01-01","updated_to":"2026-12-31","office_id":1200,"limit":100}'
```
These are the professional committee staff — the people who actually draft legislation. Mark `committee_staff = true`.

**Step B3. Get current committee membership:**
```bash
read_web_page https://www.banking.senate.gov/about/members
read_web_page https://financialservices.house.gov/about/members.htm
```

**Step B4. Resolve members to LegiStorm IDs:**
```bash
call legistorm get_members '{"updated_from":"2025-01-01","updated_to":"2026-12-31","limit":100}'
```
Match by name and state.

**Step B5. Pull personal office policy staff for each committee member:**
```bash
call legistorm get_staff '{"updated_from":"2025-01-01","updated_to":"2026-12-31","member_id":[member_id],"limit":50}'
```
Filter to policy-relevant titles: `Legislative Assistant`, `Senior Legislative Assistant`, `Legislative Correspondent`, `Legislative Director`, `Policy Advisor`, `Counsel`, `Professional Staff Member`, `Staff Director`. Skip schedulers, press, and casework staff. Mark `committee_staff = false`.

**Step B6. Flag crypto/fintech coverage.**
For committee staff, check `positions[].position_title` and the committee's known issue jurisdictions. For personal office staff, check title and — where not obvious — run a targeted web search:
```bash
call websearch search '{"query":"[member name] legislative assistant crypto fintech financial services"}'
```
Mark `crypto_coverage = true` where apparent.

**Step B7. Write to the sheet:**
```bash
call gsuite sheets_update '{"spreadsheet_id":"[sheet_id]","range_notation":"A2:L[N]","values":[[...rows...]]}'
```

**Step B8. Share with requesting user (first build only):**
```bash
call gsuite drive_share '{"file_id":"[sheet_id]","email":"[requester_email]","role":"writer","send_notification":false}'
```

---

#### Answer Questions from the Map

When any question triggers this section, read the stored sheet first — do not re-pull from LegiStorm:

```bash
call gsuite drive_search '{"query":"Hill Staff Map","max_results":5}'
call gsuite sheets_read '{"spreadsheet_id":"[sheet_id]","range_notation":"A:L"}'
```

Then join against the broader Gigabrain context as needed — `#gigabrain-feed`, touchpoint log, paradigmdb — the same way any other Gigabrain workflow does. Use the combined context to answer the question. Do not just dump the table. Answer like someone who knows these people.

**Issue questions** ("who covers crypto for Lummis?"): filter by member, flag `crypto_coverage = true`, return name + title + context.

**Talent questions** ("who would be strong for a Head of Policy hire?"): sort by `hill_years` descending, filter `crypto_coverage = true`, surface people with 5+ years and committee exposure. Up-and-coming means 2–5 years, committee staff flag, or strong trajectory visible from career history.

**Landscape questions** ("who's doing what on Senate Banking?"): return the full roster sorted by `committee_staff` first, then `hill_years` descending, with issue coverage noted.

---

**Weekly Refresh**

Silently re-run the build steps in the background. No notification unless:

- **New staffer** enters the universe: post to the policy Slack channel:
  > "New staffer added to your bench — do you know them?" [name, office, committee side]
- **Staffer departs**: brief ping with name and office.

Do not ping for title changes, intra-office transfers, or data corrections.

```bash
call legistorm get_staff '{"updated_from":"[last_refresh_date]","updated_to":"[today]","office_id":676,"limit":100}'
call legistorm get_staff '{"updated_from":"[last_refresh_date]","updated_to":"[today]","office_id":1200,"limit":100}'
```

**Notes policy (scoped to this section)**

Do not write evaluative or comparative assessments about individual staffers. Issue coverage and trajectory are structured fields. Notes, if any, must be positive, observational, concrete, and professional — limited to what you would say directly to the person.

### 3. Bill Tracking & Analysis

Monitor crypto-relevant legislation across federal and state jurisdictions.

**Federal Focus:**
- Senate Banking Committee
- House Financial Services Committee
- Agriculture Committees (CFTC jurisdiction)
- Judiciary Committees (DOJ, IP)

**State Priorities:** NY, TX, CA, WY, IL (active crypto agendas)

**Track Per Bill:**
- Bill number and title
- Sponsors and cosponsors
- Committee referral and status
- Hearing schedule
- Markup dates
- Floor action timeline
- Amendment activity
- Paradigm position (support/oppose/monitor)

**Search Commands:**
```bash
# Search federal bills via Congress.gov API
call congress bills '{"congress":119,"limit":50}'
call congress bill '{"congress":119,"type":"hr","number":4763,"detail":"summaries"}'

# Search federal hearings
call congress hearings '{"congress":119,"chamber":"senate"}'
call legistorm get_hearings '{"updated_from":"2026-01-01","updated_to":"2026-12-31","chamber":"S"}'
call legistorm get_townhalls '{"updated_from":"2026-01-01","updated_to":"2026-12-31"}'

# Search STATE-LEVEL bills via Plural (Open States)
call plural search_bills '{"jurisdiction":"New York","q":"cryptocurrency","sort":"updated_desc"}'
call plural search_bills '{"jurisdiction":"California","q":"digital assets"}'
# Get specific state bill details
call plural get_bill '{"jurisdiction":"New York","session":"2025-2026","bill_id":"S1234"}'

# Search for internal discussions
call slack search_messages '{"query":"[bill number]"}'
```

### 4. Vote Prediction / Whip Sheet

Maintain running vote counts for priority legislation.

**Whip Sheet Fields:**
| Field | Values |
|-------|--------|
| Stance | Support / Lean Support / Uncommitted / Lean Oppose / Oppose |
| Strength | Firm / Soft |
| Rationale | Why we believe this |
| Key Influencer | Who can move them |
| The Ask | What we need from them |
| Next Action | Follow-up task |
| Owner | Paradigm team member |
| Last Verified | Date of last confirmation |
| Evidence | Meeting notes, public statements |

**Prediction Inputs:**
- Historical voting patterns (VoteSmart, GovTrack)
- Cosponsor networks
- Public statements
- Committee behavior
- Party leadership signals
- Direct intelligence from meetings

**Update Process:**
1. After each Hill interaction, log stance update
2. Flag inconsistencies between public statements and private positions
3. Surface members whose stance has shifted

### 5. Coalition & Opposition Mapping

Track who is lobbying on which bills.

**Entities to Track:**
- Industry groups (Chamber, trade associations)
- Advocacy organizations
- Companies (competitors, allies)
- Think tanks
- Other crypto firms

**Per Entity:**
- Position on key bills
- Lobbying intensity (high/medium/low)
- Key contacts
- Coalition membership

### 6. Trend Detection

Surface emerging patterns before they become consensus.

**Signals to Monitor:**
- Bill introduction clusters (3+ states with similar language)
- Hearing topic frequency
- Floor statement themes
- Regulatory action patterns
- Model legislation from ALEC, ULC

**State AG Actions:**
- Enforcement actions in priority states
- Settlement patterns
- New investigation announcements

**Search Commands:**
```bash
# Search Federal Register for crypto-related regulatory actions
call fedreg search '{"query":"cryptocurrency","agency":"securities-and-exchange-commission"}'
call fedreg search '{"query":"digital assets","agency":"commodity-futures-trading-commission"}'
call fedreg search '{"query":"stablecoin","type":"PRORULE"}'

# State-level legislation via Plural (Open States) — check priority states
call plural search_bills '{"jurisdiction":"New York","q":"cryptocurrency","action_since":"2026-01-01"}'
call plural search_bills '{"jurisdiction":"Texas","q":"digital assets","action_since":"2026-01-01"}'
call plural search_bills '{"jurisdiction":"California","q":"blockchain","action_since":"2026-01-01"}'
call plural search_bills '{"jurisdiction":"Wyoming","q":"digital assets","action_since":"2026-01-01"}'
call plural search_bills '{"jurisdiction":"Illinois","q":"cryptocurrency","action_since":"2026-01-01"}'

# State-level events (hearings, floor sessions)
call plural list_events '{"jurisdiction":"New York","after":"2026-01-01","require_bills":true}'

# LegiStorm for congressional hearing trends
call legistorm get_hearings '{"updated_from":"2026-01-01","updated_to":"2026-12-31","limit":20}'

# Supplement with web search
call websearch search '{"query":"state cryptocurrency legislation 2026"}'
```

### 7. Regulatory Docket Monitoring

Track SEC, CFTC, FinCEN, OCC, Treasury rulemakings.

**Per Docket:**
- Agency and docket number
- Proposed rule summary
- Comment deadline
- Paradigm response status (draft/submitted/none)
- Portfolio company impact

**Search Commands:**
```bash
# Open comment periods
call fedreg comments-open '{"agency":"securities-and-exchange-commission"}'
call fedreg comments-open '{"agency":"commodity-futures-trading-commission"}'

# Search regulatory dockets
call fedreg search '{"query":"cryptocurrency","type":"RULE"}'
call fedreg search '{"query":"digital assets","type":"PRORULE","agency":"treasury-department"}'

# Get specific document details
call fedreg document '{"document_number":"2026-01234"}'
```

### 8. Portfolio Impact Flagging

Automatically surface legislation affecting portfolio companies.

**Process:**
1. When analyzing new legislation, check if any provisions affect:
   - Stablecoin issuers
   - DeFi protocols
   - Custody providers
   - Exchange operators
   - Any specific portfolio company sector
2. Query paradigmdb for relevant holdings:
   ```bash
   call paradigmdb notes_search '{"query":"[sector keyword]"}'
   call paradigmdb db_query '{"query":"SELECT o.name, o.description FROM \"Organization\" o WHERE o.description ILIKE '\''%stablecoin%'\'';"}'
   ```
3. Flag with explanation of potential impact

---

## Jurisdiction Mapping

### Who Has the Pen?

| Issue | Primary Jurisdiction | Key Committees |
|-------|---------------------|----------------|
| Market structure | SEC | Senate Banking, House Financial Services |
| Derivatives | CFTC | Senate/House Agriculture |
| Stablecoins | Mixed (SEC/OCC/Fed) | Banking + Financial Services |
| AML/KYC | FinCEN | Banking, Homeland Security |
| Sanctions | OFAC/Treasury | Banking, Foreign Affairs |
| Tax | Treasury/IRS | Finance, Ways & Means |

### Committee Staff Routing

For a given issue, route to the right staffer:
1. **Committee Counsel** for legislative drafting
2. **Personal Office LD** for member positioning
3. **Leadership Staff** for floor scheduling and whip operations

---

## Internal Accountability

### Log All Hill Interactions

For lightweight capture after a Hill meeting or call:
1. Default to a `#touchpoint` post in `#gigabrain-feed`.
2. Reply with `got it.` and treat the Slack post as the full capture step.
3. Silently write the minimal backup row to the Google Sheet touchpoint log.
4. Do not store staffer names in that backup log.
5. Only create a separate formal note, whip update, or structured follow-up log when the user explicitly asks for it.

### Periodic Reports

**Weekly:** Policy team activity summary
**Monthly:** Legislative landscape shifts, whip sheet changes
**Quarterly:** Strategic assessment for leadership

---

## Natural Language Queries

The system should answer questions like:

- "What is Senator X's likely position on the GENIUS Act and why?"
- "Which bills introduced this session could affect our stablecoin portfolio companies?"
- "Who are the key staffers on Senate Banking covering crypto?"
- "What have we heard about stablecoin reserve requirements in the last 90 days?"
- "When did we last meet with Dingell's office?"
- "How many touchpoints have we had with Warner's office this year?"
- "What has Dingell's office been saying recently about prediction markets?"
- "Generate a briefer for my meeting with Rep Y tomorrow"
- "Generate a briefer for my meeting with Rep Y tomorrow using recent `#gigabrain-feed` intel"
- "What is the current whip count on [bill]?"
- "Which states have introduced DeFi-related bills this year?"

---

## Example Session

**User:** Policy briefer for Senator Lummis — meeting tomorrow about stablecoin legislation.

**Agent:**
1. Read Policy Explainer Index first for internal analysis
2. Check the Google Sheet touchpoint log first for recency and frequency:
   ```bash
   call gsuite drive_search '{"query":"Policy Touchpoint Log","max_results":10}'
   call gsuite sheets_read '{"spreadsheet_id":"[touchpoint_sheet_id]","range_notation":"A:C"}'
   ```
3. Search `#gigabrain-feed` for all recent Lummis intel, with special weight on `#touchpoint` posts:
   ```bash
   call slack search_messages '{"query":"in:#gigabrain-feed Lummis"}'
   call slack search_messages '{"query":"in:#gigabrain-feed #touchpoint Lummis"}'
   ```
4. Look up Senator Lummis via LegiStorm and web search:
   ```bash
   call legistorm get_members '{"updated_from":"2025-01-01","updated_to":"2026-12-31","state_id":"WY"}'
   call legistorm get_staff '{"updated_from":"2025-01-01","updated_to":"2026-12-31","member_id":[lummis_member_id]}'
   ```
5. Search other internal sources:
   ```bash
   call slack search_messages '{"query":"Lummis"}'
   call gsuite gmail_search '{"query":"Lummis"}'
   call paradigmdb notes_search '{"query":"Lummis"}'
   ```
6. Find current stablecoin legislation — federal and state:
   ```bash
   call congress bills '{"congress":119}'
   call plural search_bills '{"q":"stablecoin","action_since":"2026-01-01"}'
   ```
7. Check portfolio companies in stablecoin space
8. Weave the most relevant `#gigabrain-feed` intel directly into `Landscape Summary` and the relevant stance sections without creating a standalone touchpoints section
9. Generate briefer using template

---

### 9. Regulatory Filing Analysis

> **⚠️ ISOLATION NOTICE**: This workflow has its own style, format, and process rules. Do NOT import conventions from other Policy Gigabrain workflows (briefers, whip sheets, bill tracking). A policy brief is different from a regulatory analysis. Learn from each other, but keep them separate.

Process new regulatory documents (rules, guidance, no-action letters, NPRMs/ANPRMs, etc.) into a concise index entry and Slack message for the I&R team. The agent works in a strict five-step feedback loop with the user. **Do not skip steps or rush to a final deliverable before receiving user feedback.**

**Trigger Phrases** (from Stefan, Alex G., Madison, Justin, Katie, or Caitlin):
- "Process this filing" / "New regulatory action"
- "Ingest this rule/guidance/order"
- A link to a PDF, uploaded document, or regulatory filing URL

#### Step 1: Receive the Document

The user provides a link, uploaded PDF, or document file. Before doing anything else:

1. **Confirm access.** If you cannot open and parse the full document (scanned PDF without OCR, password-protected, login-walled URL), stop immediately and tell the user. Do not attempt workarounds. Do not proceed.
2. **Identify and note:** issuing agency or agencies; document type (final rule, interpretive guidance, ANPRM, NPRM, no-action letter, etc.); date of issuance; docket/release number; effective date and comment deadline, if any.
3. **Read the entire document, including all footnotes.** Important definitional language, limiting conditions, and novel holdings are frequently buried in footnotes. Never treat a footnote as a throwaway.
4. **Check the Policy Explainer Index** for existing entries this document supersedes, modifies, or cross-references:
   ```bash
   call gsuite docs_read '{"doc_id":"1yiKL4NgJfT0cAXehqHvaYC1mMezKdDhxwnr8Gm8aa6c"}'
   ```
5. **Check portfolio relevance** — query for companies that may be affected:
   ```bash
   call paradigmdb db_query '{"query":"SELECT name, description FROM \"Organization\" WHERE relevance = 1 ORDER BY name;"}'
   ```

#### Step 2: Generate an Initial Summary (.docx)

Before the user reads the document, produce a **2–3 page Word document (.docx)** summarizing the key issues. This summary helps the user read smarter — it is not a substitute for their reading. Generally follow the flow of the source document so the summary helps the reader read along; reorganize by topic only if there is a clear structural reason.

**The summary must cover:**
- What the document holds and what, if anything, changed from prior law or guidance
- Any assets, transaction types, companies, parties, or individuals explicitly named (these are the most actionable items for the investment team)
- Portfolio relevance: which portfolio companies or holdings appear most directly affected
- Effective date and any comment deadline, called out prominently
- Areas of legal uncertainty or apparent internal inconsistency in the source document (flag clearly, without alarmism)

**Summary style:**
- Plain English for a sophisticated non-lawyer reader
- No Latin, no jargon without explanation
- No condescending explanations of what things are — assume a sophisticated reader
- TNR 12pt, justified, single-spaced, 6pt/12pt paragraph spacing, 1-inch margins, black text only

**After delivering the .docx, say exactly:**
> "I have summarized the document above. Please read the source with this summary as context, then tell me: (1) what you think is most important or most relevant to the portfolio, and (2) anything you want added, removed, or reframed in the index entry. I will draft the entry once I have your feedback."

#### Step 3: Wait

**Wait for the user's feedback.** Do not draft the index entry yet. Do not ask follow-up questions unless the user's feedback is genuinely ambiguous.

The user has read the document and generally gets deference on what matters. That said, make suggestions and push back if you disagree — you may catch things the user missed, or the user may be wrong. Flag disagreements clearly, explain your reasoning, and let the user decide.

#### Step 4: Receive Feedback

- Take careful note of what the user identifies as most important, most relevant to the portfolio, or most worth highlighting. The user's feedback shapes emphasis and framing.
- If the user flags something you missed, acknowledge and incorporate it without debate (don't debate importance, do debate accuracy).
- If the user's feedback includes language you believe is legally imprecise or substantively incorrect, flag it clearly and respectfully, explain why, and let the user decide. Do not silently incorporate language you believe is wrong. Do not override the user's decision once made.
- Calibrate emphasis based on feedback. If the user says a point is secondary, treat it as secondary even if you find it analytically interesting.
- When the user returns a commented/edited document, treat it as a directive: apply the comments and re-upload immediately. No confirmation loop needed.

#### Step 5: Write the Index Entry and Slack Message

Produce two deliverables:
1. **Index entry** as a .docx file (format below)
2. **Slack message** in the chat (format below)

---

#### Index Entry Format

The index entry has five structural components. The first three (Title, BLUF, Our View) are non-negotiable. The remaining components should follow this pattern but may be adapted where the document's structure gives good reason.

**1. Title** (Heading 1)
- Format: `Analysis: [Agency] [Short Title] ([Date])`
- Example: `Analysis: SEC/CFTC Crypto Asset Securities Law Guidance (3/17/26)`
- Reflects the full scope of the document. Should almost always fit on a single line.

**2. BLUF** (Bold paragraph, labeled)
- Begins with "BLUF:" followed by 2–4 sentences. Maximum 4 sentences, no exceptions.
- What happened, why it matters, what changed.
- The document name or a clear reference should be a hyperlink to the source.
- Other contextual hyperlinks are permitted where they genuinely add value (e.g., a link to a superseded rule or comparable guidance from another agency).
- Write as if the reader has 20 seconds.

**3. Our View** (Bold paragraph, immediately after BLUF)
- A standalone bold paragraph with Paradigm's strategic read on the regulatory action.
- Covers impact on Paradigm or portfolio companies, with any input from the user.
- This is a second bold paragraph directly after the BLUF — no separate heading. Matches the ANPRM example format.

**4. Summary** (Bold label "Summary", plain body)
- Explains the document's scope and structure: what topics it covers, enumerated.
- Orients the reader to the Key Aspects that follow.

**5. Connector Paragraph** (Plain text, no heading)
- Procedural context: where the document comes from, what process led to it, effective date, whether it invites comments, what it supersedes.

**6. Key Aspects** (Heading 3, standalone line, bulleted list)
- "Key Aspects" as a standalone Heading 3 line (not inline label).
- Adapt the heading when warranted (e.g., "Key Questions" for an ANPRM).
- Each bullet has:
  - An **underlined** sub-header (NOT bold+underline) followed by plain prose
  - 2–3 sentences per bullet; substantive, not one-liners
  - Nesting permitted in moderation where it genuinely aids clarity
  - No hanging indents — first line and subsequent lines flush
- Page number references throughout, citing source document pages.
- Lead with substantive provisions in order of importance; close with procedural/effective-date matters.
- Selectively quote the filing for emphasis, but never copy in large chunks. Summarize and identify key points.
- When the source has a long list of unchanged items, condense to a brief summary (2–3 sentences) rather than copying verbatim.

**Total entry length:** 2–3 pages maximum. Every sentence must earn its place.

**File naming:** `[Agency] [Short Title] [MM.DD.YYYY].docx` — no underscores, date at end in MM.DD.YYYY format.

**Formatting:**
- TNR 12pt, justified, single-spaced, 1-inch margins, black text only
- Bold/underline stops BEFORE the colon (e.g., "Summary:" where only "Summary" is bold)
- Smart (curly) quotes throughout
- No hanging indents on bullets

---

#### Slack Message Format

3–5 sentences. No bullet points (exception: multiple companion documents in one message may use bullets). The audience is non-lawyers on the I&R team.

Answer three questions: What happened? What changed? Why does it matter for the portfolio or the industry?

Include the effective date or comment deadline if material to investment decisions.

**Always close with:** "Our full index entry is [here]." (user will add the actual link) or "We'll have a full index entry later today." if the entry is not yet finalized.

Do not editorialize beyond what the source document supports. Do not use legal citations.

**Slack-specific style guidance:**
- Prefer simple, plain words over legal jargon: "request" over "proposed rule change," "approval" over "regulatory approval."
- Do not include operational or structural details that belong in the index entry (e.g., same order book, execution priority, shareholder rights). The Slack message is a signal, not a summary.
- Do not use throat-clearing phrases like "the order is significant because" or "notably" — let the substance speak for itself.
- Do not editorialize with adjectives like "incremental," "landmark," or "sweeping" unless the source document uses them. State what happened and let the reader draw conclusions.

---

#### Style Rules (Scoped to This Workflow)

- **Plain English.** Write for a sophisticated investor, not a court. No Latin. No jargon without brief explanation. Active voice where possible.
- **No condescending explanations.** Assume the reader is sophisticated. Do not explain what well-known institutions, legal concepts, or market structures are.
- **Em dashes: absolute minimum.** Before using one, ask whether a comma, period, or parentheses would work instead. They almost always will.
- **Pithiness.** Cut any sentence that repeats a point already made or provides background the reader already knows.
- **Legal precision.** Use the precise legal characterization the source document uses. Never conflate terms: "final rule" ≠ "interpretive guidance"; "no-action letter" ≠ "safe harbor"; "proposed rule" ≠ "final rule."
- **Named assets and parties.** If the document names specific assets, companies, or individuals, call them out. Verify portfolio company status against the Organization table before claiming relevance.
- **Footnotes get proportionate treatment.** Read them all. Cite footnote numbers. Important definitions and exceptions often live in footnotes, but do not overstate their importance.
- **Effective dates and comment deadlines.** Always include. Put in connector paragraph. If a meaningful comment deadline exists, consider giving it a dedicated Key Aspects bullet.
- **Supersession.** If the document supersedes prior guidance, identify what is superseded with precision. Do not overstate scope.
- **Page references.** Include page number citations from the source document throughout.
- **Hyperlinks.** Link to the source filing, any superseded documents, and any directly referenced companion documents (e.g., no-action letters, related orders).

---

#### Pre-Delivery Checklist

Before delivering the index entry, check for and address each of the following:

- [ ] Internal inconsistency in your draft (e.g., characterizing the same holding differently in BLUF vs Key Aspects)
- [ ] Legal imprecision in your own language (e.g., calling interpretive guidance a "rule")
- [ ] Anything the user said that you incorporated but believe may be legally incorrect — flag it, explain why, let the user decide
- [ ] Named assets, parties, or transaction types the investment team should know about that were not highlighted in user feedback
- [ ] Anything that supersedes or modifies prior indexed guidance
- [ ] Internal inconsistencies or drafting errors in the source document itself (note as observations, not conclusions)
- [ ] Portfolio company references verified against Organization table (relevance=1, not ex-portfolio)

---

#### What to Never Do

- Do not draft the index entry before receiving user feedback at Step 4
- Do not write a BLUF longer than 4 sentences
- Do not use bold within bullet bodies; underlined sub-header is the primary formatting element
- Do not use em dashes liberally — default to commas, periods, or parentheses
- Do not conflate legal terms of art — use the term the source document uses
- Do not make the Slack message sound like a legal brief
- Do not skip footnotes
- Do not proceed if you cannot parse the full document
- Do not include ex-portfolio companies as current portfolio references
- Do not copy large chunks of source text verbatim — summarize and identify key points
- Do not pack the Slack message with structural details (execution mechanics, shareholder rights, operational specifics) — keep those for the index entry

---

#### Example Index Entry Structure (SEC/CFTC Crypto Taxonomy)

```
Analysis: SEC/CFTC Crypto Asset Securities Law Guidance (3/17/26)

BLUF: [2-4 bold sentences — what happened, why it matters, what changed. Document name hyperlinked to source.]

[Bold paragraph — Our View on impact to Paradigm/portfolio. No heading.]

Summary: [Plain text — scope and structure of the document, enumerated topics.]

[Connector paragraph — procedural context, effective date, comment period, supersession.]

Key Aspects

• Not Securities: [underlined sub-header, plain prose, 2-3 sentences, page refs]
• Securities: [underlined sub-header, plain prose]
• Sometimes Securities: [underlined sub-header, plain prose]
  ...
```

#### Example Slack Messages

**Single document (Phantom No-Action Letter):**
> CFTC staff issued a no action letter to Phantom this morning, which says that CFTC will not take enforcement action against Phantom for providing access to Kalshi's prediction markets through their UI without registering as a derivatives broker. The letter highlights the fact that Phantom would not "hold, control, or take into custody" assets, and is merely "passively providing software" as the basis for the no-action decision. While not binding on the CFTC, the letter is consistent with other developer protections for neutral, non-custodial software providers, including those in the BRCA, and the fact that Agency staff have now taken this position in writing is a significant (and welcome) development. We'll have a full index entry later today.

**Single document with link (SEC/CFTC Taxonomy):**
> SEC and CFTC jointly issued final guidance for applying federal securities laws to crypto today. The release explicitly names more than fifteen tokens (including BTC, ETH, SOL, and XRP) that are *not* securities (and the list is not exhaustive), and confirms that mining, staking, wrapping, and retroactive airdrops do not constitute securities transactions. The guidance will be effective as soon as it is published (which will be soon), and supersedes prior, inconsistent staff guidance. Our full index entry is [here].

**Multiple companion documents (CFTC Prediction Markets):**
> As Alex mentioned above, CFTC issued two documents this morning related to prediction markets:
> • **First**, CFTC staff issued a guidance document with a series of "reminders" about existing swaps regulations…
> • **Second**, CFTC issued an Advanced Notice of Proposed Rulemaking. Our full index entry is [here]…

**Exchange approval (SEC Nasdaq Tokenized Securities):**
> The SEC approved Nasdaq's request to allow certain securities to trade in tokenized form, the first time a major U.S. exchange has received approval for tokenized trading of traditional equities. The approval is limited to a DTC pilot program covering Russell 1000 stocks and major index ETFs. While the scope is narrow and the pilot must still stand up DTC's settlement infrastructure before trading can begin, the SEC approved it entirely within existing market structure rather than requiring new rulemaking, which suggests a potential path for broader tokenization through exchange-level rule changes. Our full index entry is [here].

---

## Future Integrations

| Integration | Purpose | Priority |
|-------------|---------|----------|
| Shift direct integration | Portfolio cross-reference | Medium |
| Regulations.gov API | Docket comments, rulemaking tracking | Medium |
