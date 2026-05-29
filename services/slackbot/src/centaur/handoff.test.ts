import { describe, expect, it, mock } from 'bun:test'
import { CentaurHandoff, slackEventFromChatMessage, type NormalizedSlackEvent } from './handoff'
import type { AppConfig } from '../config'

const config: AppConfig = {
  NODE_ENV: 'test',
  PORT: 3001,
  CENTAUR_API_URL: 'http://centaur-api.test',
  CENTAUR_SLACK_EVENTS_PATH: '/api/webhooks/slack',
  RUNTIME_ERROR_ALERT_CHANNEL: '',
  SLACK_EVENT_DEDUP_TTL_MS: 600000,
  SLACK_SIGNATURE_MAX_AGE_SECONDS: 300,
  SLACK_FEEDBACK_COMMANDS: ['/website-feedback'],
  SLACK_FEEDBACK_LINEAR_TEAM_ID: 'team-test',
  SLACK_FEEDBACK_LINEAR_PROJECT_ID: 'project-test',
  SLACK_FEEDBACK_ALLOWED_CHANNELS: [],
  SLACKBOT_EXTERNAL_ORG_ALLOWLIST: [],
  SLACKBOT_TRIGGER_BOT_ALLOWLIST: []
}

describe('CentaurHandoff', () => {
  it('omits envelope-specific Slack event metadata from idempotent workflow input', async () => {
    const originalFetch = globalThis.fetch
    let capturedInit: RequestInit | undefined
    const fetchMock = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      capturedInit = init
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })
    globalThis.fetch = fetchMock as any
    try {
      const handoff = new CentaurHandoff(config)
      const event: NormalizedSlackEvent = {
        thread_key: 'slack:T123:C123:1778883099.579529',
        message_id: 'slack:T123:C123:1778883099.579529',
        team_id: 'T123',
        user_id: 'U123',
        channel_id: 'C123',
        thread_ts: '1778883099.579529',
        is_mention: true,
        parts: [{ type: 'text', text: 'hello' }],
        slack: {
          event_id: 'Ev-envelope-one',
          event_ts: '1778883100.000000',
          message_ts: '1778883099.579529',
          enterprise_id: 'E123'
        }
      }

      await handoff.emit(event)

      expect(capturedInit).toBeDefined()
      expect(capturedInit?.headers).toMatchObject({
        'Content-Type': 'application/json',
        'X-Centaur-Thread-Key': event.thread_key
      })
      const bodyText = capturedInit?.body
      expect(typeof bodyText).toBe('string')
      if (typeof bodyText !== 'string') throw new Error('expected JSON request body')
      const body = JSON.parse(bodyText) as {
        trigger_key: string
        input: { metadata: { slack: unknown } }
      }
      expect(body.trigger_key).toBe(event.message_id)
      expect(body.input.metadata.slack).toEqual({
        message_ts: '1778883099.579529',
        enterprise_id: 'E123'
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('passes Slack attachment parts through workflow input', async () => {
    const originalFetch = globalThis.fetch
    let capturedInit: RequestInit | undefined
    const fetchMock = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      capturedInit = init
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })
    globalThis.fetch = fetchMock as any
    try {
      const handoff = new CentaurHandoff(config)
      const event: NormalizedSlackEvent = {
        thread_key: 'slack:T123:C123:1778883099.579529',
        message_id: 'slack:T123:C123:1778883099.579529',
        team_id: 'T123',
        user_id: 'U123',
        channel_id: 'C123',
        thread_ts: '1778883099.579529',
        is_mention: true,
        parts: [
          { type: 'text', text: 'review this' },
          {
            type: 'document',
            name: 'report.pdf',
            mime_type: 'application/pdf',
            size: 8,
            slack_file_id: 'F123',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: 'JVBERi0xLjQ='
            }
          }
        ],
        slack: {
          event_ts: '1778883100.000000',
          message_ts: '1778883099.579529'
        }
      }

      await handoff.emit(event)

      const bodyText = capturedInit?.body
      expect(typeof bodyText).toBe('string')
      if (typeof bodyText !== 'string') throw new Error('expected JSON request body')
      const body = JSON.parse(bodyText) as {
        input: { parts: NormalizedSlackEvent['parts'] }
      }
      expect(body.input.parts[1]).toMatchObject({
        type: 'document',
        name: 'report.pdf',
        mime_type: 'application/pdf',
        slack_file_id: 'F123',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: 'JVBERi0xLjQ='
        }
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('uses recipient_team_id for Slack Connect delivery routing', async () => {
    const originalFetch = globalThis.fetch
    let capturedInit: RequestInit | undefined
    const fetchMock = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      capturedInit = init
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })
    globalThis.fetch = fetchMock as any
    try {
      const handoff = new CentaurHandoff(config)
      const event: NormalizedSlackEvent = {
        thread_key: 'slack:THOME:C123:1778883099.579529',
        message_id: 'slack:THOME:C123:1778883099.579529',
        team_id: 'THOME',
        recipient_team_id: 'TEXTERNAL',
        user_id: 'UEXTERNAL',
        channel_id: 'C123',
        thread_ts: '1778883099.579529',
        is_mention: true,
        parts: [{ type: 'text', text: 'hello' }],
        slack: {
          event_ts: '1778883100.000000',
          message_ts: '1778883099.579529',
          user_team: 'TEXTERNAL'
        }
      }

      await handoff.emit(event)

      const bodyText = capturedInit?.body
      expect(typeof bodyText).toBe('string')
      if (typeof bodyText !== 'string') throw new Error('expected JSON request body')
      const body = JSON.parse(bodyText) as {
        input: { delivery: { recipient_team_id: string; recipient_user_id: string } }
      }
      expect(body.input.delivery).toMatchObject({
        recipient_team_id: 'TEXTERNAL',
        recipient_user_id: 'UEXTERNAL'
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('steers a running execution instead of starting a queued workflow run', async () => {
    const originalFetch = globalThis.fetch
    const calls: Array<{ path: string; init?: RequestInit; body?: unknown }> = []
    const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      calls.push({ path: url.pathname, init, body })
      if (url.pathname.endsWith('/executions')) {
        return new Response(
          JSON.stringify({
            thread_key: 'slack:T123:C123:1778883099.579529',
            executions: [{ execution_id: 'exe-running', status: 'running' }]
          }),
          { status: 200 }
        )
      }
      if (url.pathname.endsWith('/steer')) {
        return new Response(JSON.stringify({ ok: true, status: 'steered' }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: false, error: 'unexpected' }), { status: 500 })
    })
    globalThis.fetch = fetchMock as any
    try {
      const handoff = new CentaurHandoff({ ...config, CENTAUR_API_KEY: 'aiv2_test' })
      const event: NormalizedSlackEvent = {
        thread_key: 'slack:T123:C123:1778883099.579529',
        message_id: 'slack:T123:C123:1778883111.000000',
        team_id: 'T123',
        user_id: 'U123',
        channel_id: 'C123',
        thread_ts: '1778883099.579529',
        is_mention: true,
        parts: [{ type: 'text', text: 'actually do this instead' }],
        slack: {
          event_ts: '1778883111.000000',
          message_ts: '1778883111.000000'
        }
      }

      const result = await handoff.emit(event)

      expect(result.ok).toBe(true)
      expect(result.body).toMatchObject({
        steered: true,
        execution_id: 'exe-running',
        status: 'steered'
      })
      expect(calls.map(call => call.path)).toEqual([
        '/agent/threads/slack%3AT123%3AC123%3A1778883099.579529/executions',
        '/agent/executions/exe-running/steer'
      ])
      expect(calls[1]?.body).toMatchObject({
        content_blocks: [{ type: 'text', text: 'actually do this instead' }],
        history_messages: [],
        message_id: event.message_id,
        user_id: 'U123',
        metadata: {
          source: 'slackbot',
          steer_replacement: true
        }
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('paginates the Slack thread and includes every prior reply as history', async () => {
    const firstPage = [
      slackMessage('1778883099.579529', 'Original request', 'U123'),
      slackMessage('1778883100.000000', 'Assistant context', 'UBOT', true),
      slackMessage('1778883110.000000', 'Passive context', 'U456')
    ]
    const secondPage = [
      slackMessage('1778883110.500000', 'Prior clarification', 'U123'),
      slackMessage('1778883111.000000', '<@UBOT> retry', 'U123'),
      slackMessage('1778883112.000000', 'Newer message', 'U123')
    ]
    const fetchMessages = mock(async (_threadId: string, options: Record<string, unknown>) => {
      if (options.cursor === 'page-2') return { messages: secondPage, nextCursor: undefined }
      return { messages: firstPage, nextCursor: 'page-2' }
    })
    const thread: any = {
      id: 'slack:C123:1778883099.579529',
      isDM: false,
      adapter: { fetchMessages }
    }
    Object.defineProperty(thread, 'allMessages', {
      get() {
        throw new Error('allMessages should not be used for Slack handoff history')
      }
    })

    const event = await slackEventFromChatMessage({
      thread,
      message: secondPage[1],
      botUserId: 'UBOT'
    } as any)

    expect(fetchMessages).toHaveBeenCalledTimes(2)
    expect(fetchMessages.mock.calls.map(call => call[1])).toEqual([
      { limit: 200, direction: 'forward', cursor: undefined },
      { limit: 200, direction: 'forward', cursor: 'page-2' }
    ])
    expect(
      event.history_messages?.map(item =>
        item.parts[0]?.type === 'text' ? item.parts[0].text : undefined
      )
    ).toEqual([
      'Original request',
      'Assistant context',
      'Passive context',
      'Prior clarification'
    ])
  })

  it('returns Slack history oldest-first and marks mention messages', async () => {
    const messages = [
      slackMessage('1778883120.000000', 'Newer message', 'U123'),
      slackMessage('1778883111.000000', '<@UBOT> again', 'U123'),
      slackMessage('1778883110.000000', 'passive thread chatter', 'U123'),
      slackMessage('1778883100.000000', '<@UBOT> do call discover', 'U123'),
      slackMessage('1778883099.579529', '<@UBOT> Original request', 'U123')
    ]
    const fetchMessages = mock(async (_threadId: string, options: Record<string, unknown>) => {
      expect(options).toMatchObject({
        limit: 200,
        direction: 'forward'
      })
      return { messages, nextCursor: undefined }
    })
    const thread: any = {
      id: 'slack:C123:1778883099.579529',
      isDM: false,
      adapter: { fetchMessages }
    }

    const event = await slackEventFromChatMessage({
      thread,
      message: messages[1],
      botUserId: 'UBOT'
    } as any)

    expect(
      event.history_messages?.map(item =>
        item.parts[0]?.type === 'text' ? item.parts[0].text : undefined
      )
    ).toEqual(['Original request', 'do call discover', 'passive thread chatter'])
    expect(event.history_messages?.map(item => (item.metadata?.slack as any)?.is_mention)).toEqual([
      true,
      true,
      false
    ])
  })
})

function slackMessage(ts: string, text: string, user: string, isMe = false): any {
  return {
    id: ts,
    text,
    raw: {
      type: 'message',
      team: 'T123',
      channel: 'C123',
      ts,
      thread_ts: '1778883099.579529',
      text,
      user
    },
    author: {
      userId: user,
      userName: user,
      fullName: user,
      isBot: isMe,
      isMe
    },
    attachments: []
  }
}
