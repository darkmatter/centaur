---
name: sourcer
description: "Sources and ranks candidates against a job description by parsing the JD, searching LinkedIn, GitHub, and X, enforcing hard location and portfolio-company filters, and publishing a Google Sheet shortlist. Use when asked to source candidates, build a recruiting list, or rank prospects for an open role."
---

# Sourcer

Finds high-signal candidates for a single role and publishes a ranked Google Sheet shared with the requesting user.

## Use This Skill When

- The user asks to source candidates from a job description.
- The user wants a recruiting shortlist, talent map, or ranked prospect list.
- The user wants LinkedIn, GitHub, and X/Twitter signals combined into one sheet.

## Required Inputs

- A full JD or enough role context to reconstruct one.
- The requesting Slack user ID if the sheet must be shared automatically.
- Optional: target count, excluded companies, preferred school backgrounds, or specific search seeds.

If the user does not specify a target count, default to 25 ranked candidates.

## Output

Produce a Google Sheet with exactly these columns:

- `Name`
- `Title`
- `Company`
- `LinkedIn`
- `Email`
- `Location`
- `Score`
- `Notes`

Share the sheet with the requesting user.

## Tooling Rules

1. Prefer browser automation for LinkedIn and GitHub when the deployment exposes `browser-use` or an equivalent browser tool.
2. Prefer `ptwittercli` for X/Twitter when it is installed; otherwise use the live `twitter` tool.
3. If tool contracts are unclear, run `call discover gsuite`, `call discover twitter`, `call discover harmonic`, `call discover slack`, and `call discover paradigmdb` once before proceeding.
4. Do not claim a source was crawled if you only inferred it from secondary search results.

## Workflow

1. Parse the JD into a structured search spec.

Capture:
- role type
- seniority
- must-have skills
- nice-to-have skills
- industry context
- hard location rules
- compensation or timing clues if present

Write the spec in the working notes before searching. If the location is ambiguous, ask one short clarifying question before sourcing.

2. Identify the requester email.

If the request came from Slack, run:

```bash
call slack get_user_email '{"user_id":"<requester_slack_user_id>"}'
```

If Slack user ID is unavailable, ask for the sharing email before creating the sheet.

3. Build the search plan.

Create search strings for each source:
- LinkedIn title + company background + location
- GitHub language/domain + role keywords + location
- X/Twitter bio keywords + employer history + location

Prefer multiple narrow searches over one broad search. Start with the JD's must-have constraints, then layer in high-signal background filters such as:
- elite CS / math / engineering programs
- early employee windows at hypergrowth companies
- direct domain adjacency

4. Gather candidates from multiple sources.

LinkedIn:
- Use `browser-use` if available to search profiles and capture current title, company, location, and LinkedIn URL.
- If browser automation is unavailable, use public web search and Harmonic as a fallback, but mark the source confidence lower in notes.

GitHub:
- Use browser automation if available to inspect profiles, pinned repos, contribution recency, and obvious location clues.
- Otherwise use `call websearch search` to find public GitHub profiles and repositories, then read the linked public pages directly.

X/Twitter:
- Use `ptwittercli` if installed.
- Otherwise use `call twitter search_tweets`, `call twitter get_user`, `call twitter get_timeline`, `call twitter get_following`, and `call twitter get_followers` as needed.

Structured supplement:
- Use `call harmonic search_people_recruiting` when you need a fast candidate pool for a role/location combination.
- Use `call harmonic enrich_person` for finalists when you need cleaner work-history or education data.

5. Normalize every candidate into one record.

For each candidate, collect:
- `name`
- `title`
- `company`
- `linkedin`
- `email`
- `location`
- `x_handle`
- `github_url`
- `notes`
- `scores.title_correspondence`
- `scores.educational_foundation`
- `scores.professional_trajectory`
- `scores.talent_density`
- `scores.timing_window`

Keep the notes factual. Include why the person is interesting, key evidence, and any uncertainty.

6. Enforce hard filters before scoring.

Location:
- If the JD has a hard location requirement, exclude anyone clearly outside it.
- If the candidate location is ambiguous and you cannot resolve it quickly from profile evidence, exclude the candidate instead of guessing.

Paradigm portfolio exclusion:
- Pull the current portfolio company list from `call paradigmdb db_organizations '{"limit":200}'`.
- Exclude anyone whose current employer is a Paradigm portfolio company.
- Do not exclude former employees of portfolio companies unless the user asked for that.

7. Add the Paradigm follow signal.

This signal is a priority boost, not an inclusion requirement.

- If the user supplies Paradigm team X handles, use those.
- Otherwise, use any locally maintained handle list if one already exists.
- If no handle list is available, do not invent one. Mark the signal as unknown and do not penalize the candidate.

When you do have handles, compare the candidate's X handle against Paradigm-team following lists using `twitter.get_following`. Add the evidence to notes, for example: `Followed by 2 Paradigm team accounts on X.`

8. Score every candidate on the five weighted criteria.

Use a 0-5 subscore for each criterion.

- Title correspondence: 25%
- Educational foundation: 20%
- Professional trajectory: 20%
- Talent density of prior orgs: 20%
- Timing window: 15%

Scoring rubric:

- `title_correspondence`
  - 5: exact role and scope match
  - 3: adjacent role or one step above/below
  - 1: weak title match despite some relevant skills
- `educational_foundation`
  - 5: exceptional technical or analytical foundation, including elite universities or equivalent proof of depth
  - 3: strong but not standout foundation
  - 1: limited evidence
- `professional_trajectory`
  - 5: repeated promotions, strong scope expansion, founder or early builder patterns
  - 3: solid trajectory with moderate evidence of growth
  - 1: flat or unclear trajectory
- `talent_density`
  - 5: prior orgs are unusually high-signal and include early hypergrowth windows such as Stripe pre-2016 or Coinbase pre-2017
  - 3: good companies, but less concentrated talent density
  - 1: little signal from prior org set
- `timing_window`
  - 5: obvious transition window, such as post-acquisition, recent team change, or 2-4 years into current role
  - 3: plausible but not obvious timing
  - 1: likely difficult to move now

Prioritize elite university alumni, early employees at hypergrowth startups, and candidates followed by Paradigm team members on X when the evidence supports it.

9. Publish the shortlist.

Write the normalized candidate list to JSON, then run:

```bash
uv run .agents/skills/sourcer/scripts/sourcer.py publish \
  --input /tmp/sourcer-candidates.json \
  --title "<Role> Sourcer Shortlist" \
  --share-with "<requester_email>"
```

The script computes the weighted score, sorts the candidates, creates the Google Sheet, writes the `Candidates` tab, and shares it with the requester.

Use `--top-n <count>` if you want to cap the exported set.

10. Report back with the artifact.

Return:
- the Google Sheet link
- how many candidates made the final sheet
- the top 3-5 names with one-line reasons
- any hard blockers such as missing location data or unavailable browser automation

## Candidate JSON Shape

The publishing script accepts either a bare array or an object with `candidates`.

```json
{
  "candidates": [
    {
      "name": "Jane Doe",
      "title": "Staff Backend Engineer",
      "company": "Example",
      "linkedin": "https://www.linkedin.com/in/jane-doe",
      "email": "jane@example.com",
      "location": "New York, NY",
      "notes": "Ex-Stripe 2015 hire. Followed by 2 Paradigm team accounts on X.",
      "scores": {
        "title_correspondence": 4.5,
        "educational_foundation": 4,
        "professional_trajectory": 4.5,
        "talent_density": 5,
        "timing_window": 3.5
      }
    }
  ]
}
```

## Guardrails

- Never include someone currently at a Paradigm portfolio company.
- Never relax a hard JD location constraint.
- Do not guess an email address.
- Do not use private or non-consensual data sources.
- Do not treat missing Paradigm-follow data as a negative signal.
- Keep notes concise and evidence-based.
- If browser automation is unavailable, say so explicitly and continue with the best public-web and tool-backed fallback.
