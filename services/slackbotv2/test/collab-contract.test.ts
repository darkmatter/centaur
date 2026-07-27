import { describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  startCollabRoom,
  statusCollabRoom,
  stopCollabRoom
} from '../src/session-api'
import {
  renderCollabJoinCommand,
  posixSingleQuoteEscape
} from '../src/collab-command'
import type {
  SlackbotV2CollabParticipant,
  SlackbotV2CollabRoomState,
  SlackbotV2StartCollabResponse,
  SlackbotV2StatusCollabResponse,
  SlackbotV2StopCollabResponse
} from '../src/types'

// ---------------------------------------------------------------------------
// Load the canonical contract fixture — the single source of truth shared
// between the Slack ingress (slackbotv2) and the api-rs lifecycle
// implementation (centaur-3w2.6). This test proves the client types and
// behaviour match the fixture exactly.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url))
const contractPath = join(here, 'fixtures', 'collab-contract.json')
const contract = JSON.parse(readFileSync(contractPath, 'utf-8')) as {
  routes: Record<string, {
    method: string
    path: string
    request: unknown
    response: { properties: Record<string, unknown> }
  }>
  roomState: { properties: Record<string, unknown> }
  ingress_rules: Record<string, string>
  sample_output: Record<string, string>
  errors: Record<string, unknown>
}

const baseOptions = {
  apiUrl: 'http://api.test',
  apiKey: 'test-key',
  botToken: 'xoxb-test',
  signingSecret: 'shss-test'
}

function stubFetch(json: unknown, status = 200) {
  const calls: { method: string; url: string; body?: string }[] = []
  const fetchFn = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof _input === 'string' ? _input : _input.toString()
    calls.push({
      method: init?.method ?? 'GET',
      url,
      body: init?.body ? String(init.body) : undefined
    })
    return new Response(JSON.stringify(json), {
      status,
      headers: { 'content-type': 'application/json' }
    })
  })
  return { calls, fetchFn }
}

const THREAD_KEY = 'slack:C123:1700000000.000100'
const JOIN_URL = 'https://relay.tailnet.test/r/room-abc.aGVsbG8='

const ACTIVE_ROOM: SlackbotV2CollabRoomState = {
  active: true,
  join_url: JOIN_URL,
  view_url: 'https://relay.tailnet.test/r/room-abc.aGVsbG8=?ro=1',
  web_url: 'https://console.test/collab/room-abc',
  participants: [{ name: 'host', role: 'host' }]
}

const START_OK: SlackbotV2StartCollabResponse = {
  ok: true,
  thread_key: THREAD_KEY,
  room: ACTIVE_ROOM
}

const STATUS_OK_ACTIVE: SlackbotV2StatusCollabResponse = {
  ok: true,
  thread_key: THREAD_KEY,
  room: ACTIVE_ROOM
}

const STATUS_OK_NULL: SlackbotV2StatusCollabResponse = {
  ok: true,
  thread_key: THREAD_KEY,
  room: null
}

const STOP_OK: SlackbotV2StopCollabResponse = {
  ok: true,
  thread_key: THREAD_KEY,
  stopped: true
}

describe('collab contract fixture — route paths', () => {
  test('start route matches contract', () => {
    expect(contract.routes.start!.method).toBe('POST')
    expect(contract.routes.start!.path).toBe('/api/session/{thread_key}/collab/start')
  })

  test('status route matches contract', () => {
    expect(contract.routes.status!.method).toBe('GET')
    expect(contract.routes.status!.path).toBe('/api/session/{thread_key}/collab/status')
  })

  test('stop route matches contract', () => {
    expect(contract.routes.stop!.method).toBe('POST')
    expect(contract.routes.stop!.path).toBe('/api/session/{thread_key}/collab/stop')
  })
})

describe('collab contract — room state fields are snake_case', () => {
  test('roomState has active, join_url?, view_url?, web_url?, participants', () => {
    const props = contract.roomState.properties
    expect(props).toHaveProperty('active')
    expect(props).toHaveProperty('join_url')
    expect(props).toHaveProperty('view_url')
    expect(props).toHaveProperty('web_url')
    expect(props).toHaveProperty('participants')
  })

  test('participant has name, role (host|guest), read_only?', () => {
    const participant = contract.roomState.properties.participants as {
      items: { properties: Record<string, { enum?: string[] }> }
    }
    expect(participant.items.properties).toHaveProperty('name')
    expect(participant.items.properties).toHaveProperty('role')
    expect(participant.items.properties.role!.enum).toEqual(['host', 'guest'])
  })

  test('TS type SlackbotV2CollabRoomState matches fixture fields', () => {
    // Compile-time check: the fixture's fields must exist on the TS type.
    const room: SlackbotV2CollabRoomState = {
      active: true,
      join_url: 'x',
      view_url: 'y',
      web_url: 'z',
      participants: [{ name: 'h', role: 'host', read_only: false }]
    }
    expect(room.active).toBe(true)
    expect(room.join_url).toBe('x')
    expect(room.view_url).toBe('y')
    expect(room.web_url).toBe('z')
  })

  test('TS type SlackbotV2CollabParticipant matches fixture fields', () => {
    const p: SlackbotV2CollabParticipant = { name: 'host', role: 'host', read_only: true }
    expect(p.role).toBe('host')
    const g: SlackbotV2CollabParticipant = { name: 'guest', role: 'guest' }
    expect(g.read_only).toBeUndefined()
  })
})

describe('collab contract — response shapes', () => {
  test('start response has ok, thread_key, room (non-null)', () => {
    const props = contract.routes.start!.response.properties
    expect(props).toHaveProperty('ok')
    expect(props).toHaveProperty('thread_key')
    expect(props).toHaveProperty('room')
  })

  test('status response has ok, thread_key, room (nullable)', () => {
    const props = contract.routes.status!.response.properties
    expect(props).toHaveProperty('ok')
    expect(props).toHaveProperty('thread_key')
    expect(props).toHaveProperty('room')
  })

  test('stop response has ok, thread_key, stopped', () => {
    const props = contract.routes.stop!.response.properties
    expect(props).toHaveProperty('ok')
    expect(props).toHaveProperty('thread_key')
    expect(props).toHaveProperty('stopped')
  })
})

describe('collab contract — client calls correct routes', () => {
  test('startCollabRoom POSTs to /collab/start', async () => {
    const { calls, fetchFn } = stubFetch(START_OK)
    await startCollabRoom({ ...baseOptions, fetch: fetchFn as never }, THREAD_KEY)
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.url).toBe(
      'http://api.test/api/session/slack%3AC123%3A1700000000.000100/collab/start'
    )
  })

  test('statusCollabRoom GETs /collab/status', async () => {
    const { calls, fetchFn } = stubFetch(STATUS_OK_ACTIVE)
    await statusCollabRoom({ ...baseOptions, fetch: fetchFn as never }, THREAD_KEY)
    expect(calls[0]!.method).toBe('GET')
    expect(calls[0]!.url).toBe(
      'http://api.test/api/session/slack%3AC123%3A1700000000.000100/collab/status'
    )
  })

  test('stopCollabRoom POSTs to /collab/stop', async () => {
    const { calls, fetchFn } = stubFetch(STOP_OK)
    await stopCollabRoom({ ...baseOptions, fetch: fetchFn as never }, THREAD_KEY)
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.url).toBe(
      'http://api.test/api/session/slack%3AC123%3A1700000000.000100/collab/stop'
    )
  })
})

describe('collab contract — ingress rules', () => {
  test('join_command rule matches omp join pattern', () => {
    expect(contract.ingress_rules.join_command).toBe("omp join '<join_url>'")
  })

  test('renderCollabJoinCommand produces the contract-specified format', () => {
    const rendered = renderCollabJoinCommand(JOIN_URL)
    expect(rendered).toBe(`omp join '${JOIN_URL}'`)
    // Matches the contract's sample output for start_normal.
    expect(rendered).toBe(contract.sample_output.start_normal!)
  })

  test('posix_escaping rule matches the four-char sequence', () => {
    expect(contract.ingress_rules.posix_escaping).toContain("'\\''")
    // The escaping function implements the contract rule.
    expect(posixSingleQuoteEscape("a'b")).toBe("a'\\''b")
    // Sample output with embedded quotes.
    const rendered = renderCollabJoinCommand("https://relay.test/r/x'y'z")
    expect(rendered).toBe(contract.sample_output.start_with_embedded_quotes!)
  })

  test('no_synthesis rule is stated', () => {
    expect(contract.ingress_rules.no_synthesis).toContain('never')
    expect(contract.ingress_rules.no_synthesis).toContain('relay prefix')
  })

  test('no_raw_control_url rule is stated', () => {
    expect(contract.ingress_rules.no_raw_control_url).toContain('omp join command')
  })

  test('no_agent_turn rule is stated', () => {
    expect(contract.ingress_rules.no_agent_turn).toContain('short-circuit')
  })

  test('exactly_one_command rule is stated', () => {
    expect(contract.ingress_rules.exactly_one_command).toContain('exactly one')
  })
})

describe('collab contract — error codes', () => {
  test('409 is ownership conflict', () => {
    const e = contract.errors as { '409': { description: string } }
    expect(e['409'].description).toContain('Ownership conflict')
  })

  test('400 is terminal session', () => {
    const e = contract.errors as { '400': { description: string } }
    expect(e['400'].description).toContain('Terminal')
  })
})

describe('collab contract — sample outputs match', () => {
  test('status_active sample matches rendered join command', () => {
    expect(contract.sample_output.status_active).toBe(`omp join '${JOIN_URL}'`)
  })

  test('status_inactive sample', () => {
    expect(contract.sample_output.status_inactive).toBe('No active collaboration room.')
  })

  test('stop_closed sample', () => {
    expect(contract.sample_output.stop_closed).toBe('Collaboration room closed.')
  })

  test('stop_idempotent sample', () => {
    expect(contract.sample_output.stop_idempotent).toBe(
      'No active collaboration room to close.'
    )
  })
})
