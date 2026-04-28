import express from 'express'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

const app = express()
const __dirname = dirname(fileURLToPath(import.meta.url))

app.use(express.json())
app.use(express.static(__dirname))

// Internal API when deployed on Centaur infra, external for local dev
const CENTAUR_API = process.env.CENTAUR_API_URL || 'https://svc-ai.dayno.xyz'
const CENTAUR_KEY = process.env.CENTAUR_API_KEY || ''
const CENTAUR_HARNESS = process.env.CENTAUR_HARNESS || 'amp'
const THREAD_KEY = process.env.CENTAUR_THREAD_KEY || ''

function centaurHeaders(json = false) {
  const headers = {}
  if (json) headers['Content-Type'] = 'application/json'
  if (CENTAUR_KEY) headers['X-Api-Key'] = CENTAUR_KEY
  return headers
}

async function centaurFetch(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${CENTAUR_API}${path}`, {
    method,
    headers: centaurHeaders(Boolean(body)),
    ...(body ? { body: JSON.stringify(body) } : {}),
  })

  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data.detail || data.error || `Centaur API error ${response.status}`)
  }

  return data
}

function nextThreadKey(prefix) {
  if (THREAD_KEY && CENTAUR_KEY) return THREAD_KEY
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function runAgentPrompt(prompt, prefix = 'venue-scout-web') {
  const threadKey = nextThreadKey(prefix)
  const spawn = await centaurFetch('/agent/spawn', {
    method: 'POST',
    body: {
      thread_key: threadKey,
      harness: CENTAUR_HARNESS,
    },
  })

  await centaurFetch('/agent/message', {
    method: 'POST',
    body: {
      thread_key: threadKey,
      assignment_generation: spawn.assignment_generation,
      role: 'user',
      parts: [{ type: 'text', text: prompt }],
    },
  })

  const execution = await centaurFetch('/agent/execute', {
    method: 'POST',
    body: {
      thread_key: threadKey,
      assignment_generation: spawn.assignment_generation,
      harness: CENTAUR_HARNESS,
      delivery: { platform: 'dev' },
    },
  })

  for (let attempt = 0; attempt < 180; attempt += 1) {
    const status = await centaurFetch(`/agent/executions/${execution.execution_id}`)
    if (status.status === 'completed') {
      return status.result_text || ''
    }
    if (status.status === 'failed' || status.status === 'cancelled') {
      throw new Error(status.error_text || `Agent execution ${status.status}`)
    }
    await sleep(2000)
  }

  throw new Error('Venue Scout timed out waiting for the Centaur agent')
}

function extractJSON(text) {
  if (!text) return null
  const trimmed = text.trim()

  try {
    return JSON.parse(trimmed)
  } catch {}

  const match = trimmed.match(/\{[\s\S]*\}|\[[\s\S]*\]/)
  if (!match) return null

  try {
    return JSON.parse(match[0])
  } catch {
    return null
  }
}

function buildScoutPrompt(brief) {
  return `Act as Venue Scout for Paradigm, a design-forward crypto and technology investment firm. Research current live venues using web search and return a shortlist tailored to the brief below.

Requirements:
- Bias toward Michelin-caliber or craft-driven kitchens, design-forward rooms, strong neighborhood feel, and spaces that feel intentional rather than corporate.
- Prefer private dining rooms, semi-private spaces, and thoughtful buyouts over generic banquet setups.
- Avoid hotel ballrooms unless the brief clearly requires a resort or flagship-scale venue.
- Search current sources before answering. Use at least 5 searches across sources like Eater, The Infatuation, Resy, OpenTable, Reddit, Yelp, Instagram, and local press.
- Verify that each venue appears to be currently operating and plausibly supports the event format.
- Surface at least 1 under-the-radar or newer option when possible.
- Make reasonable assumptions instead of asking follow-up questions.

Return only valid JSON with this shape:
{
  "venues": [
    {
      "name": "Venue Name",
      "location": "Neighborhood, City",
      "overall": 9.2,
      "fit_summary": "Short evocative phrase",
      "verdict": "2-3 sentences on why it fits this brief",
      "watch_out": "One honest concern",
      "scores": {
        "food_quality": 9,
        "private_dining": 8,
        "neighborhood_feel": 9,
        "design_aesthetic": 8,
        "logistics": 7
      },
      "outreach_hook": "One venue-specific sentence for an outreach email"
    }
  ],
  "sources_checked": ["search query 1", "search query 2"]
}

Return exactly 5 venues. No markdown fences. No prose outside the JSON.

Brief:
${brief}`
}

function buildBookingPrompt({ venueName, brief, feedback }) {
  return `Summarize this venue booking update as JSON only.

Return only:
{
  "status": "recorded",
  "venue": "Venue Name",
  "summary": "One sentence summary of the booking and feedback"
}

Venue: ${venueName}
Brief: ${brief}
Feedback: ${feedback || 'No feedback provided.'}`
}

// ── Venue scout endpoint ───────────────────────────────────────────────────
// Receives the brief from the web app and runs it through a Centaur agent turn.
app.post('/api/scout', async (req, res) => {
  const { brief } = req.body
  if (!brief) return res.status(400).json({ error: 'brief required' })

  try {
    const resultText = await runAgentPrompt(buildScoutPrompt(brief), 'venue-scout-search')
    const payload = extractJSON(resultText)
    if (!payload) throw new Error('Could not parse venue results from the Centaur agent')
    res.json(payload)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Record booking (feedback loop for Centaur memory) ─────────────────────
app.post('/api/booking', async (req, res) => {
  const { venue_name, brief, feedback } = req.body
  if (!venue_name) return res.status(400).json({ error: 'venue_name required' })

  try {
    const resultText = await runAgentPrompt(
      buildBookingPrompt({ venueName: venue_name, brief, feedback }),
      'venue-scout-booking'
    )
    const payload = extractJSON(resultText)
    if (!payload) throw new Error('Could not parse booking confirmation from the Centaur agent')
    res.json(payload)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`Venue Scout running on :${PORT}`))
