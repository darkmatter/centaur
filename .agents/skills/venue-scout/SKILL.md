---
name: venue-scout
description: "Finds and ranks venues for Paradigm events. When invoked without a concrete brief, sends the Venue Scout web app for the full intake flow; when a brief is provided in chat, researches and returns a ranked shortlist. Use when asked to scout a venue, shortlist private dining rooms, compare buyout options, or match a venue to an event brief with city, neighborhood, guest count, and vibe constraints. Triggers on: venue scout, find me a venue, private dining, full buyout, offsite, fellow dinner, cocktail party, flagship event."
---

# Venue Scout

Centaur-native port of the `krgxyz/venue-scout` skill. Route users to the Venue Scout web app for the full intake flow, or research and return a ranked shortlist directly in chat when the brief is already provided.

## How To Invoke

```text
@Centaur open venue scout
@Centaur venue scout
@Centaur find me a venue
```

## Use When

- The user asks for a venue shortlist for a Paradigm dinner, happy hour, cocktail party, workshop, conference, offsite, or flagship event.
- The user wants venue recommendations constrained by city, neighborhood, guest count, vibe, private dining, or buyout needs.
- The user wants a ranked comparison of venue options rather than a generic restaurant list.
- The user wants new or under-the-radar options, not just obvious staples.

Do not use this skill for travel planning, hotel room blocks without event programming, or generic restaurant recommendations that do not involve an event brief.

## Behavior

When this skill is invoked without a concrete brief, respond with the Venue Scout intake URL so the user can complete the full intake flow in the browser.

```text
Venue Scout is ready.
Open the full intake flow here: https://svc-ai.dayno.xyz/apps/venue-scout

Or give me a quick brief here and I will return a shortlist right in chat:
city · event type · guest count · vibe · budget
```

If the web app is unavailable, respond with:

```text
Venue Scout is ready.
The web app is temporarily unavailable, so send me a quick brief here and I will return a shortlist right in chat:
city · event type · guest count · vibe · budget
```

If the user provides a brief directly in chat, do not bounce them to the app first. Research venues and return a ranked shortlist in chat using the workflow and scoring rubric below.

## Paradigm Defaults

- Bias toward Michelin-caliber or craft-driven kitchens, design-forward rooms, strong neighborhood feel, and spaces that feel intentional rather than corporate.
- Prefer private dining rooms, semi-private spaces, or full buyouts over generic banquet setups.
- Avoid hotel ballrooms unless the brief is a true resort offsite or flagship property buyout.
- Prioritize Paradigm's pre-vetted venues from `reference/curated-venues.md` when they fit the brief.
- Still surface at least 1 or 2 strong new or under-the-radar options whenever possible.

## Paradigm Venue Database

Start with `reference/curated-venues.md` for the pre-vetted venue set by city and event archetype. Treat it as the first pass, not the automatic final answer.

## Required Inputs

Capture these from the brief or infer them:

- event type
- city and neighborhood
- guest count
- vibe or aesthetic
- private dining vs semi-private vs full buyout
- budget sensitivity, if stated
- any must-haves like natural light, A/V, outdoor space, or walkability

If a missing detail would materially change the answer, ask at most 2 short questions. Otherwise, proceed with explicit assumptions.

## Event-Type Guidance

Infer the event shape first and use it to screen venues:

- `dinner` or `fellow dinner`: intimate, celebratory, restaurant-led, usually 12 to 60 guests.
- `happy hour` or `cocktail party`: standing format, bar, rooftop, wine bar, lounge, or restaurant buyout, usually up to 150 guests.
- `workshop`: quiet room, natural light, comfortable seating, low noise, usually up to 40 guests.
- `conference`: event-capable private space or club, typically 50 to 200 guests, A/V matters.
- `offsite`: multi-day resort or hotel, often wine country or mountain, group rooming and meeting flow matter.
- `flagship` or `tentpole`: marquee event, typically resort buyout or large-format venue with premium hospitality.
- `team lunch`: casual but high-quality, easy logistics, walkable neighborhood, usually up to 30 guests.

## Workflow

### 1. Resolve the brief

- Identify event type, city, guest count, vibe, and privacy level.
- Detect whether the user is asking for a restaurant, bar, event venue, club, or resort.
- If the city is ambiguous, ask once. If the neighborhood is missing, proceed with the strongest neighborhoods implied by the brief.

### 2. Start with the curated Paradigm venue set

- Open `reference/curated-venues.md`.
- Pull the relevant city or resort section first.
- Treat those venues as the first-pass shortlist, not an automatic final answer.
- If a curated venue is not a fit, say why a newer or more specific option outranks it.

### 3. Run current-market search

Run at least 5 searches, ideally 6 to 8 when the brief is important or high-budget. Use a mix of these patterns and adapt them to the city, neighborhood, and event type.

```bash
call websearch search '{"query":"site:eater.com <city> best private dining rooms 2026","num_results":5,"synthesize":true}'
call websearch search '{"query":"site:theinfatuation.com <city> intimate restaurant private dining","num_results":5,"synthesize":true}'
call websearch search '{"query":"site:resy.com <city> private dining restaurants events","num_results":5,"synthesize":true}'
call websearch search '{"query":"site:opentable.com <city> private dining buyout events","num_results":5,"synthesize":true}'
call websearch search '{"query":"site:beliapp.com <city> private dining restaurants events","num_results":5,"synthesize":true}'
call websearch search '{"query":"reddit <city> best private dining event space 2026","num_results":5,"synthesize":true}'
call websearch search '{"query":"site:yelp.com <city> private dining room event space highly rated","num_results":5,"synthesize":true}'
call websearch search '{"query":"site:instagram.com <city> restaurant private dining events","num_results":5,"synthesize":true}'
call websearch search '{"query":"<city> under the radar restaurant hidden gem 2026 private dining","num_results":5,"synthesize":true}'
call websearch search '{"query":"<neighborhood> <city> best restaurant private dining 2026","num_results":5,"synthesize":true}'
```

Favor these source types because they map closely to the original skill:

- Eater for new openings and editor-curated roundups
- Infatuation for vibe matching and neighborhood picks
- Resy and OpenTable for event-readiness and reservation signals
- Beli for current diner signal
- Reddit for local edge and hidden gems
- Yelp for private-dining and event-space operational signal
- Instagram for real-world visual signal and recent activity
- local press for freshness and opening status

### 4. Verify the venue is real and live

Before recommending a venue:

- confirm it is currently operating
- confirm it plausibly supports the event format
- confirm there is evidence of private dining, events, buyouts, or room flexibility when that matters

Do not recommend a venue based on stale listicles alone.

### 5. Score the finalists

Score each finalist on the original 5-dimension rubric, from 1 to 10:

- `food_quality`
- `private_dining`
- `neighborhood_feel`
- `design_aesthetic`
- `logistics`

Then assign an `overall` score that reflects the brief, not just the average.

Use these interpretations:

- `food_quality`: chef reputation, kitchen quality, ingredient rigor, consistency.
- `private_dining`: quality of PDR or buyout setup, privacy, event friendliness, flexibility.
- `neighborhood_feel`: walkability, local character, lack of tourist or corporate feel.
- `design_aesthetic`: interior design, lighting, natural light when relevant, texture, visual cohesion, photography value.
- `logistics`: capacity fit, accessibility, noise, A/V, booking practicality, price realism.

### 6. Return a ranked shortlist

Default to 5 recommendations unless the user asks otherwise.

For each venue include:

- `name`
- `location`
- `overall`
- `fit summary`
- `verdict`
- `watch-out`
- `scores`
- `outreach hook`

## Slack Output Format

Default to a human-readable shortlist, not raw JSON.

Structure:

1. One-sentence answer first with the top recommendation and why it wins.
2. Ranked list of the top venues.
3. A compact code-block table with the score breakdown.
4. Assumptions and source freshness.

For each ranked venue, use this shape:

```text
1. Venue Name — Neighborhood, City — 9.2/10
Fit: Short evocative phrase
Verdict: 2-3 specific sentences on why it fits this exact brief.
Watch-out: One honest concern.
Scores: Food 9 | Private 8 | Neighborhood 9 | Design 8 | Logistics 7
Outreach hook: One venue-specific sentence to open the outreach email.
```

Then add a compact comparison block:

```text
Venue                  Overall  Food  Private  Hood  Design  Logistics
Atomix                 9.2      10    8        9     9       7
Manhatta               8.8       8    9        7     9       9
...
```

## JSON Compatibility Mode

If the user explicitly asks for JSON, CSV, or wants output for the venue-scout web app, return the original structured schema from the source repo:

```json
[
  {
    "name": "Venue Name",
    "location": "Neighborhood, City",
    "overall": 9.2,
    "fit_summary": "Short evocative phrase",
    "verdict": "2-3 sentences on fit",
    "watch_out": "One honest concern",
    "scores": {
      "food_quality": 9,
      "private_dining": 8,
      "neighborhood_feel": 9,
      "design_aesthetic": 8,
      "logistics": 7
    },
    "outreach_hook": "One venue-specific sentence to open an outreach email"
  }
]
```

In JSON mode, return only the JSON array.

## Answering Rules

- Lead with the answer, not the search process.
- Do not recommend generic hotel ballrooms unless the event type clearly requires a resort or flagship format.
- Include at least 1 fresh or under-the-radar option whenever the market supports it.
- Use honest caveats. If private dining is unclear, say so.
- Do not fabricate event capacities, buyout minimums, or room names.
- If the brief is too constrained, say what tradeoff is binding: neighborhood, privacy, capacity, or vibe.

## Booking Feedback Mode

If the user says they booked a venue or shares post-event feedback:

- summarize the venue, brief, and feedback cleanly
- call out what should be reused or avoided next time
- if the user explicitly asks to persist or share it, use the appropriate Slack or Docs tool

Do not claim durable memory storage unless you actually wrote the note somewhere.

## Reference

Use `reference/curated-venues.md` for Paradigm's pre-vetted venue list by city and event archetype.
