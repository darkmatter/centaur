# Outcome Calibration

Use this reference before public sourcing when the role resembles work Paradigm has already done. Unless the user says otherwise, use a cutoff of `rating >= 7` when learning from historical outcomes.

## Query Historical Winners

### 1. Find the strongest prior introductions and hires for the same role or expertise

Run via `call paradigmdb db_query`:

```sql
SELECT
  ts.type,
  ts.role,
  ts.expertise,
  p."fullName",
  o.name AS organization_name,
  MAX(pr.rating) AS max_rating,
  AVG(pr.rating)::numeric(10,2) AS avg_rating,
  COUNT(pr.id) AS rating_count
FROM "TalentSupport" ts
JOIN "Person" p ON p.id = ts."candidatePersonId"
LEFT JOIN "Organization" o ON o.id = ts."organizationId"
JOIN "PersonRating" pr ON pr."personId" = ts."candidatePersonId"
WHERE ts.type IN ('CANDIDATE_INTRODUCTION', 'HIRE')
  AND pr.rating >= 7
  AND (
    LOWER(ts.role) LIKE LOWER('%<role keyword>%')
    OR LOWER(COALESCE(ts.expertise, '')) LIKE LOWER('%<expertise keyword>%')
  )
GROUP BY ts.type, ts.role, ts.expertise, p."fullName", o.name
HAVING COUNT(pr.id) > 0
ORDER BY max_rating DESC, avg_rating DESC, rating_count DESC, MAX(ts.date) DESC
LIMIT 15;
```

### 2. Read the notes behind those outcomes

```sql
SELECT
  p."fullName",
  pr.rating,
  n.title,
  n."noteType",
  LEFT(REGEXP_REPLACE(COALESCE(n.notes, ''), '<[^>]+>', ' ', 'g'), 2000) AS note_excerpt
FROM "PersonRating" pr
JOIN "Person" p ON p.id = pr."personId"
LEFT JOIN "Notes" n ON n.id = pr."noteId"
WHERE pr."personId" IN ('<person_id_1>', '<person_id_2>')
ORDER BY pr.rating DESC, pr."createdAt" DESC;
```

### 3. Check whether Paradigm already touched the person

By default, still surface strong prior Paradigm touches. Just label them clearly in the sheet or notes so the user knows whether the person is net-new, previously introduced, or previously hired.

```sql
SELECT
  ts.type,
  ts.date,
  ts.role,
  ts.expertise,
  o.name AS organization_name
FROM "TalentSupport" ts
LEFT JOIN "Organization" o ON o.id = ts."organizationId"
WHERE ts."candidatePersonId" = '<person_id>'
ORDER BY ts.date DESC;
```

### 4. Extract a role archetype before external search

Boil the notes into 3-5 things that keep recurring. Source against those signals, not just the JD keywords.

## Patterns From `rating >= 7` Outcomes

Reviewed `rating >= 7` introductions and hires included engineering and security candidates such as Riyaz Faizullabhoy, Lucas Manuel, Danno Ferrin, Srijith Poduval, Neil Cox, Joshua Kim, Sammy Harris, Keyne Leuyckx, Michael Oren, Robert Sun, and Yash Patil, alongside business and talent candidates such as Vijay Chetty, Verity Coltman, Austen Yueh, Andrew St. Germain, Travis Shimizu, William Lipovsky, Jisi Guo, and Linus Chung.

### Across roles

- Trusted referral paths matter. Many of the strongest notes start with a specific recommendation from a respected operator, founder, or prior collaborator.
- Early leverage matters more than tenure. The top candidates often joined at very small teams, built a function from scratch, or owned consequential systems unusually early.
- Technical taste shows up even outside engineering. The strongest candidates can name concrete projects, people, tools, or market shifts they care about and explain why.
- Clear stage fit matters. The best notes explain exactly why the person wants an early-stage, high-agency role now.
- Integrity and judgment matter. High-rated notes repeatedly call out high-integrity teams, strong judgment, and the ability to navigate ambiguity.
- Prior Paradigm touch is usually a positive signal to surface, not a reason to hide the candidate. Just be explicit about that history.

### GTM / Growth / BD

- Prefer crypto-native operators who can sell to technical buyers, not generic SaaS sellers.
- Strong candidates usually have explicit opinions on market structure, product strategy, or how customers make money.
- Good GTM candidates often combine relationship strength with product taste and can translate founder ideas into specific commercial motions.

### Recruiting / Talent

- The best talent hires are strategic counselors, not just pipeline managers.
- Strong notes emphasize high-touch relationship building in very small talent markets, closing discipline, and the ability to advise founders or hiring managers.
- Favor recruiters who want to stay hands-on, enjoy the scrappy stage, and have a personal network they can actually activate.
- Be skeptical of candidates who mainly want to build a team under themselves before proving IC impact.

### Engineering / Security / Protocol

- Prefer builders with deep systems or protocol credibility, not just recognizable logos.
- Strong candidates usually have crisp technical opinions, evidence of self-directed learning, and proof they can operate in ambiguous frontier environments.
- The best notes contain a specific hard-project story: performance wins, protocol design, infra scaling, cross-chain coordination, smart contract architecture, security systems, or developer tooling built under real constraints.
- Small-team leverage matters a lot: youngest engineer on a critical team, sole frontend owner, early protocol engineer, or someone who kept core systems running after attrition.
- Self-directed ecosystem depth is high signal: OSS work, hackathons, research groups, bounty work, side projects, or strong stated affinity for specific tools and teams.
- Early protocol, infra, or security ownership is a stronger signal than generic big-tech seniority.
- For senior security or engineering leaders, hands-on relevance still matters. If the role is operator-heavy, be careful with candidates who now look better suited to broad org design than direct building.

### Product / Design

- Strong product and design candidates are structured communicators with sharp product taste and enough technical fluency to work well with founder-led teams.
- Prefer people who can articulate tradeoffs clearly and show evidence of driving alignment, not just polishing interfaces.

## Market-Shape Rules

- If the best historical winners for a niche role cluster outside the requested geography, say that early.
- In thin markets, return a small high-conviction slate plus a market map instead of padding the sheet.
- If Paradigm has already introduced or hired the obvious names, still surface them when they remain top fits, but add adjacent net-new names around them: coworkers, collaborators, manager reports, and close peers of prior winners.
- When a role is especially relationship-driven, spend more effort mapping the reference graph than broadening the raw search results.

## Yellow Flags Seen In Notes

- Generic operators who sound polished but lack concrete opinions or named examples
- Low-energy candidates who do not seem likely to uplevel the function
- Candidates whose stage preference is mismatched with the company
- People who want advisory scope or large-team leverage more than hands-on building
- Senior engineering or security candidates who are no longer hands-on enough for the actual role
- Location mismatches in markets where conviction is already fragile
