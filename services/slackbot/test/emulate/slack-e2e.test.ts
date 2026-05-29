import { createHmac } from 'node:crypto'
import { connect } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { createEmulator, type Emulator } from 'emulate'
import { createPatchedSlackApi } from './slack-patches'

const IMPLEMENTATION = 'vercel-chat-sdk-slack-adapter'
const BOT_TOKEN = 'xoxb-centaur-emulate'
const USER_TOKEN = 'xoxp-centaur-user'
const API_KEY = 'aiv2_slackbot_emulate'
const SIGNING_SECRET = 'emulate-signing-secret'
const BOT_USER_ID = 'U000000001'
const USER_ID = 'UEMULATEUSER'
const TEAM_ID = 'T000000001'
const CHANNEL_ID = 'C000000001'

type WorkflowRunRequest = {
  workflow_name: string
  trigger_key: string
  input: {
    thread_key: string
    parts: Array<{ type: string; text?: string }>
    history_messages?: Array<{ role: string; parts: Array<{ type: string; text?: string }> }>
    message_id: string
    user_id: string
    metadata: { is_mention?: boolean; slack?: Record<string, unknown> }
    delivery: {
      platform: string
      channel: string
      thread_ts: string
      recipient_user_id: string
      recipient_team_id: string
    }
  }
}

let emulator: Emulator
let patchedSlack: Awaited<ReturnType<typeof createPatchedSlackApi>>
let centaur: Awaited<ReturnType<typeof createFakeCentaur>>
let app: Awaited<typeof import('../../src/index')>['app']
let slackApiUrl: string

beforeAll(async () => {
  const slackPort = await preferredPort(4003)
  emulator = await createEmulator({
    service: 'slack',
    port: slackPort,
    seed: {
      tokens: {
        [BOT_TOKEN]: {
          login: BOT_USER_ID,
          scopes: ['chat:write', 'channels:read', 'users:read', 'reactions:write']
        },
        [USER_TOKEN]: {
          login: USER_ID,
          scopes: ['chat:write', 'channels:read', 'users:read', 'reactions:write']
        }
      },
      slack: {
        team: { name: 'Centaur E2E', domain: 'centaur-e2e' },
        users: [{ name: 'tester', real_name: 'Test User', email: 'tester@example.com' }],
        channels: [{ name: 'centaur-e2e', topic: 'Slackbot E2E tests' }],
        bots: [{ name: 'centaur' }],
        signing_secret: SIGNING_SECRET
      }
    }
  })
  patchedSlack = await createPatchedSlackApi(emulator)
  centaur = await createFakeCentaur()
  slackApiUrl = `${patchedSlack.url}/api/`

  Object.assign(process.env, {
    NODE_ENV: 'test',
    SLACK_BOT_TOKEN: BOT_TOKEN,
    SLACK_API_URL: slackApiUrl,
    SLACK_SIGNING_SECRET: SIGNING_SECRET,
    SLACKBOT_API_KEY: API_KEY,
    CENTAUR_API_URL: centaur.url,
    SLACK_EVENT_DEDUP_TTL_MS: '600000',
    SLACKBOT_TRIGGER_BOT_ALLOWLIST: 'app:AALERTMANAGER',
    RUNTIME_ERROR_ALERT_CHANNEL: ''
  })

  ;({ app } = await import('../../src/index'))
})

beforeEach(async () => {
  emulator.reset()
  patchedSlack.reset()
  centaur.reset()
})

afterAll(async () => {
  await patchedSlack?.close()
  await emulator?.close()
  await centaur?.close()
})

describe(`Slack Emulate E2E (${IMPLEMENTATION})`, () => {
  it('dispatches an app_mention into a slack_thread_turn workflow with Slack metadata', async () => {
    const parent = await postUserMessage(`<@${BOT_USER_ID}> summarize this incident`)
    const waits: Promise<unknown>[] = []
    const response = await app.request(
      '/api/webhooks/slack',
      signedSlackEvent({
        event_id: 'Ev-emulate-mention',
        event: {
          type: 'app_mention',
          user: USER_ID,
          channel: CHANNEL_ID,
          ts: parent.ts,
          text: `<@${BOT_USER_ID}> summarize this incident`
        }
      }),
      {},
      waitUntilContext(waits)
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('ok')
    await Promise.all(waits)

    const run = onlyRun()
    expect(run.workflow_name).toBe('slack_thread_turn')
    expect(run.trigger_key).toBe(`slack:${TEAM_ID}:${CHANNEL_ID}:${parent.ts}`)
    expect(run.input.thread_key).toBe(`slack:${TEAM_ID}:${CHANNEL_ID}:${parent.ts}`)
    expect(run.input.message_id).toBe(`slack:${TEAM_ID}:${CHANNEL_ID}:${parent.ts}`)
    expect(run.input.parts).toEqual([{ type: 'text', text: 'summarize this incident' }])
    expect(run.input.user_id).toBe(USER_ID)
    expect(run.input.metadata.is_mention).toBe(true)
    expect(run.input.metadata.slack?.message_ts).toBe(parent.ts)
    expect(run.input.delivery).toMatchObject({
      platform: 'slack',
      channel: CHANNEL_ID,
      thread_ts: parent.ts,
      recipient_user_id: USER_ID,
      recipient_team_id: TEAM_ID
    })
  })

  it('includes prior Slack thread replies as history for reply mentions', async () => {
    const parent = await postUserMessage('Original request')
    await postBotMessage('Earlier assistant context', parent.ts)
    await postUserMessage('Passive thread chatter', parent.ts)
    await postUserMessage('Prior user clarification', parent.ts)
    const current = await postUserMessage(`<@${BOT_USER_ID}> retry`, parent.ts)
    const waits: Promise<unknown>[] = []

    await app.request(
      '/api/webhooks/slack',
      signedSlackEvent({
        event_id: 'Ev-emulate-thread-reply',
        event: {
          type: 'app_mention',
          user: USER_ID,
          channel: CHANNEL_ID,
          ts: current.ts,
          thread_ts: parent.ts,
          text: `<@${BOT_USER_ID}> retry`
        }
      }),
      {},
      waitUntilContext(waits)
    )
    await Promise.all(waits)

    const history = onlyRun().input.history_messages ?? []
    expect(history.map(item => item.role)).toEqual(['user', 'assistant', 'user', 'user'])
    expect(history.flatMap(item => item.parts.map(part => part.text))).toContain('Original request')
    expect(history.flatMap(item => item.parts.map(part => part.text))).toContain(
      'Earlier assistant context'
    )
    expect(history.flatMap(item => item.parts.map(part => part.text))).toContain(
      'Passive thread chatter'
    )
    expect(history.flatMap(item => item.parts.map(part => part.text))).toContain(
      'Prior user clarification'
    )
  })

  it('dispatches an Alertmanager-style bot-authored mention into a Slack workflow', async () => {
    const waits: Promise<unknown>[] = []
    const response = await app.request(
      '/api/webhooks/slack',
      signedSlackEvent({
        event_id: 'Ev-emulate-alertmanager-bot',
        event: {
          type: 'message',
          subtype: 'bot_message',
          bot_id: 'BALERTMANAGER',
          app_id: 'AALERTMANAGER',
          bot_profile: {
            user_id: 'UALERTMANAGER',
            app_id: 'AALERTMANAGER',
            name: 'Alertmanager'
          },
          channel: CHANNEL_ID,
          ts: '1779620985.044779',
          text: `<@${BOT_USER_ID}>`,
          attachments: [
            {
              title: 'ValidatorConsensusFailure',
              text: 'consensus test is failing on prd-nae',
              fields: [
                { title: 'cluster', value: 'prd-nae' },
                { title: 'severity', value: 'critical' }
              ]
            }
          ]
        }
      }),
      {},
      waitUntilContext(waits)
    )

    expect(response.status).toBe(200)
    await Promise.all(waits)

    const run = onlyRun()
    expect(run.workflow_name).toBe('slack_thread_turn')
    expect(run.trigger_key).toBe(`slack:${TEAM_ID}:${CHANNEL_ID}:1779620985.044779`)
    expect(run.input.parts).toEqual([
      {
        type: 'text',
        text: [
          'ValidatorConsensusFailure',
          'consensus test is failing on prd-nae',
          'cluster: prd-nae',
          'severity: critical'
        ].join('\n')
      }
    ])
    expect(run.input.user_id).toBe('UALERTMANAGER')
    expect(run.input.metadata.is_mention).toBe(true)
    expect(run.input.metadata.slack?.bot_id).toBe('BALERTMANAGER')
    expect(run.input.metadata.slack?.app_id).toBe('AALERTMANAGER')
    expect(run.input.delivery).toMatchObject({
      platform: 'slack',
      channel: CHANNEL_ID,
      thread_ts: '1779620985.044779',
      recipient_user_id: 'UALERTMANAGER',
      recipient_team_id: TEAM_ID
    })
  })

  it('ignores self bot-originated events and duplicate Slack event IDs', async () => {
    const botMessage = await postBotMessage(`<@${BOT_USER_ID}> bot echo`)
    const waits: Promise<unknown>[] = []
    await app.request(
      '/api/webhooks/slack',
      signedSlackEvent({
        event_id: 'Ev-emulate-bot',
        event: {
          type: 'app_mention',
          bot_id: 'BEMULATE',
          user: BOT_USER_ID,
          channel: CHANNEL_ID,
          ts: botMessage.ts,
          text: `<@${BOT_USER_ID}> bot echo`
        }
      }),
      {},
      waitUntilContext(waits)
    )
    await Promise.all(waits)
    expect(centaur.workflowRuns).toHaveLength(0)

    const message = await postUserMessage(`<@${BOT_USER_ID}> once`)
    const payload = signedSlackEvent({
      event_id: 'Ev-emulate-duplicate',
      event: {
        type: 'app_mention',
        user: USER_ID,
        channel: CHANNEL_ID,
        ts: message.ts,
        text: `<@${BOT_USER_ID}> once`
      }
    })
    const firstWaits: Promise<unknown>[] = []
    const first = await app.request(
      '/api/webhooks/slack',
      payload,
      {},
      waitUntilContext(firstWaits)
    )
    await Promise.all(firstWaits)
    const secondWaits: Promise<unknown>[] = []
    const second = await app.request(
      '/api/webhooks/slack',
      payload,
      {},
      waitUntilContext(secondWaits)
    )
    await Promise.all(secondWaits)

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(await second.text()).toBe('ok')
    expect(centaur.workflowRuns).toHaveLength(1)
  })

  it('records reactions in Emulate without handing reaction events to Centaur', async () => {
    const message = await postUserMessage('Please react to this')
    const reaction = await slackCall(USER_TOKEN, 'reactions.add', {
      channel: CHANNEL_ID,
      timestamp: message.ts,
      name: 'eyes'
    })
    expect(reaction.ok).toBe(true)

    const response = await app.request(
      '/api/webhooks/slack',
      signedSlackEvent({
        event_id: 'Ev-emulate-reaction',
        event: {
          type: 'reaction_added',
          user: USER_ID,
          reaction: 'eyes',
          item: { type: 'message', channel: CHANNEL_ID, ts: message.ts }
        }
      })
    )

    expect(response.status).toBe(200)
    expect(centaur.workflowRuns).toHaveLength(0)
    const reactions = await slackCall(USER_TOKEN, 'reactions.get', {
      channel: CHANNEL_ID,
      timestamp: message.ts
    })
    expect(reactions.message?.reactions?.[0]).toMatchObject({ name: 'eyes', count: 1 })
  })

  it('streams API-normalized Chat SDK chunks through Slack stream endpoints into Emulate history', async () => {
    const parent = await postUserMessage(`<@${BOT_USER_ID}> render all rich chunks`)
    const waits: Promise<unknown>[] = []
    const response = await app.request(
      '/api/webhooks/slack',
      signedSlackEvent({
        event_id: 'Ev-emulate-chat-sdk-stream',
        event: {
          type: 'app_mention',
          user: USER_ID,
          channel: CHANNEL_ID,
          ts: parent.ts,
          text: `<@${BOT_USER_ID}> render all rich chunks`
        }
      }),
      {},
      waitUntilContext(waits)
    )

    expect(response.status).toBe(200)
    await Promise.all(waits)

    expect(centaur.chatStreams).toEqual(['exe-wfr-1'])
    expect(centaur.delivered).toEqual(['exe-wfr-1'])
    expect(
      patchedSlack.requests.some(request => request.path === '/api/assistant.threads.setStatus')
    ).toBe(true)

    const streamBodies = patchedSlack.requests
      .filter(request =>
        ['/api/chat.startStream', '/api/chat.appendStream', '/api/chat.stopStream'].includes(
          request.path
        )
      )
      .map(request => request.body)
    const chunkBodies = streamBodies.flatMap(body =>
      Array.isArray(body.chunks) ? (body.chunks as Array<Record<string, unknown>>) : []
    )
    const structuredChunks = chunkBodies.filter(chunk => chunk.type !== 'markdown_text')
    expect(structuredChunks.map(chunk => chunk.type)).toEqual([
      'plan_update',
      'task_update',
      'task_update',
      'task_update',
      'task_update'
    ])
    const markdownText = chunkBodies
      .filter(chunk => chunk.type === 'markdown_text')
      .map(chunk => String(chunk.text ?? ''))
      .join('\n')
    expect(markdownText).toContain(fakeMarkdownOne())
    expect(markdownText).toContain(fakeMarkdownTwo())

    const stopBody = patchedSlack.requests.find(
      request => request.path === '/api/chat.stopStream'
    )?.body
    expect(stopBody?.blocks).toEqual(fakeStopBlocks())

    const text = await threadText(parent.ts)
    expect(text).toContain('Execution plan')
    expect(text).toContain('Thinking')
    expect(text).toContain('Command execution')
    expect(text).toContain('[the run](https://example.com/run/123)')
    expect(text).toContain('Final answer from Chat SDK.')
    expect(text).toContain('Block Kit footer')
  })
})

async function postUserMessage(text: string, threadTs?: string): Promise<{ ts: string }> {
  const response = await slackCall(USER_TOKEN, 'chat.postMessage', {
    channel: CHANNEL_ID,
    thread_ts: threadTs,
    text
  })
  expect(response.ok).toBe(true)
  return { ts: String(response.ts) }
}

async function postBotMessage(text: string, threadTs?: string): Promise<{ ts: string }> {
  const response = await slackCall(BOT_TOKEN, 'chat.postMessage', {
    channel: CHANNEL_ID,
    thread_ts: threadTs,
    text
  })
  expect(response.ok).toBe(true)
  return { ts: String(response.ts) }
}

async function threadText(threadTs: string): Promise<string> {
  const replies = await slackCall(USER_TOKEN, 'conversations.replies', {
    channel: CHANNEL_ID,
    ts: threadTs,
    limit: 100
  })
  const messages = Array.isArray(replies.messages)
    ? (replies.messages as Array<{ text?: string }>)
    : []
  return messages.map(message => message.text ?? '').join('\n')
}

async function slackCall(
  token: string,
  method: string,
  body: Record<string, unknown>
): Promise<Record<string, any>> {
  const response = await fetch(new URL(method, slackApiUrl), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: encodeSlackForm(body)
  })
  return (await response.json()) as Record<string, any>
}

function encodeSlackForm(body: Record<string, unknown>): URLSearchParams {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) continue
    params.set(key, typeof value === 'string' ? value : JSON.stringify(value))
  }
  return params
}

function onlyRun(): WorkflowRunRequest {
  expect(centaur.workflowRuns).toHaveLength(1)
  return centaur.workflowRuns[0] as WorkflowRunRequest
}

function signedSlackEvent(input: {
  event_id: string
  event: Record<string, unknown>
}): RequestInit {
  const body = JSON.stringify({
    type: 'event_callback',
    team_id: TEAM_ID,
    event_id: input.event_id,
    event: input.event
  })
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const signature = `v0=${createHmac('sha256', SIGNING_SECRET)
    .update(`v0:${timestamp}:${body}`)
    .digest('hex')}`
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': signature
    },
    body
  }
}

function waitUntilContext(waits: Promise<unknown>[]): any {
  return {
    waitUntil: (promise: Promise<unknown>) => waits.push(promise),
    passThroughOnException: () => {},
    props: {}
  }
}

async function createFakeCentaur() {
  const ResponseCtor = await nativeResponseCtor()
  const json = (body: Record<string, unknown>, init?: ResponseInit) =>
    new ResponseCtor(JSON.stringify(body), {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...Object.fromEntries(new Headers(init?.headers).entries())
      }
    })
  const text = (body: string, init?: ResponseInit) => new ResponseCtor(body, init)
  const workflowRuns: WorkflowRunRequest[] = []
  const workflowRunById = new Map<
    string,
    { request: WorkflowRunRequest; runId: string; executionId: string }
  >()
  const executionToRun = new Map<string, string>()
  const chatStreams: string[] = []
  const delivered: string[] = []
  const failed: string[] = []
  const port = await preferredPort(4014)
  const server = Bun.serve({
    port,
    async fetch(request: Request) {
      const url = new URL(request.url)
      if (url.pathname === '/workflows/runs') {
        const body = (await request.json()) as WorkflowRunRequest
        workflowRuns.push(body)
        const runId = `wfr-${workflowRuns.length}`
        const executionId = `exe-${runId}`
        workflowRunById.set(runId, { request: body, runId, executionId })
        executionToRun.set(executionId, runId)
        return json(workflowRunResponse(runId, body, executionId))
      }
      const workflowMatch = /^\/workflows\/runs\/([^/]+)$/.exec(url.pathname)
      if (workflowMatch) {
        const runId = decodeURIComponent(workflowMatch[1] ?? '')
        const run = workflowRunById.get(runId)
        if (!run) return json({ ok: false, error: 'not_found' }, { status: 404 })
        return json(workflowRunResponse(run.runId, run.request, run.executionId))
      }
      const contextMatch = /^\/agent\/executions\/([^/]+)\/chat-stream\/context$/.exec(url.pathname)
      if (contextMatch) {
        const executionId = decodeURIComponent(contextMatch[1] ?? '')
        const run = runForExecution(executionId)
        if (!run) return json({ ok: false, error: 'not_found' }, { status: 404 })
        const delivery = run.request.input.delivery
        return json({
          execution_id: executionId,
          thread_key: run.request.input.thread_key,
          platform: 'slack',
          thread_id: `slack:${delivery.channel}:${delivery.thread_ts}`,
          stream_options: {
            recipientUserId: delivery.recipient_user_id,
            recipientTeamId: delivery.recipient_team_id,
            taskDisplayMode: 'plan',
            stopBlocks: fakeStopBlocks()
          }
        })
      }
      const chatStreamMatch = /^\/agent\/executions\/([^/]+)\/chat-stream$/.exec(url.pathname)
      if (chatStreamMatch) {
        const executionId = decodeURIComponent(chatStreamMatch[1] ?? '')
        if (!runForExecution(executionId)) {
          return json({ ok: false, error: 'not_found' }, { status: 404 })
        }
        chatStreams.push(executionId)
        return text(chatStreamSse(), {
          headers: { 'content-type': 'text/event-stream' }
        })
      }
      const deliveredMatch = /^\/agent\/final-deliveries\/([^/]+)\/delivered$/.exec(url.pathname)
      if (deliveredMatch) {
        delivered.push(decodeURIComponent(deliveredMatch[1] ?? ''))
        return json({ ok: true })
      }
      const failedMatch = /^\/agent\/final-deliveries\/([^/]+)\/failed$/.exec(url.pathname)
      if (failedMatch) {
        failed.push(decodeURIComponent(failedMatch[1] ?? ''))
        return json({ ok: true })
      }
      return json({ ok: false, error: 'not_found' }, { status: 404 })
    }
  })

  function runForExecution(executionId: string) {
    const runId = executionToRun.get(executionId)
    return runId ? workflowRunById.get(runId) : undefined
  }

  return {
    url: `http://localhost:${server.port}`,
    workflowRuns,
    chatStreams,
    delivered,
    failed,
    reset() {
      workflowRuns.length = 0
      workflowRunById.clear()
      executionToRun.clear()
      chatStreams.length = 0
      delivered.length = 0
      failed.length = 0
    },
    async close() {
      await server.stop()
    }
  }
}

async function nativeResponseCtor(): Promise<typeof Response> {
  const response = await fetch('data:,')
  return response.constructor as typeof Response
}

function workflowRunResponse(
  runId: string,
  request: WorkflowRunRequest,
  executionId: string
): Record<string, unknown> {
  return {
    ok: true,
    run_id: runId,
    workflow_name: request.workflow_name,
    status: 'running',
    thread_key: request.input.thread_key,
    execution_id: executionId,
    waiting_on: { type: 'execution', execution_id: executionId }
  }
}

function chatStreamSse(): string {
  return `${fakeChatStreamChunks()
    .map((chunk, index) =>
      [`id: ${index + 1}`, 'event: chat_stream_chunk', `data: ${JSON.stringify(chunk)}`, ''].join(
        '\n'
      )
    )
    .join('\n')}\n`
}

function fakeChatStreamChunks(): Array<Record<string, unknown>> {
  return [
    { type: 'plan_update', title: 'Execution plan' },
    {
      type: 'task_update',
      id: 'thinking',
      title: 'Thinking',
      status: 'in_progress',
      output: 'Checking Slack context before answering.'
    },
    {
      type: 'task_update',
      id: 'cmd-1',
      title: 'Command execution',
      status: 'in_progress',
      output: '```sh\ncall demo ping\n```'
    },
    { type: 'markdown_text', text: fakeMarkdownOne() },
    {
      type: 'task_update',
      id: 'cmd-1',
      title: 'Command execution',
      status: 'complete',
      output: 'ok'
    },
    {
      type: 'task_update',
      id: 'thinking',
      title: 'Thinking',
      status: 'complete',
      output: 'Ready.'
    },
    { type: 'markdown_text', text: fakeMarkdownTwo() }
  ]
}

function fakeMarkdownOne(): string {
  return 'Review [the run](https://example.com/run/123) before merging. '
}

function fakeMarkdownTwo(): string {
  return 'Final answer from Chat SDK.'
}

function fakeStopBlocks(): Array<Record<string, unknown>> {
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: 'Block Kit footer' }
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Open run' },
          url: 'https://example.com/run/123'
        }
      ]
    }
  ]
}

async function preferredPort(port: number): Promise<number> {
  if (await isPortOpen(port)) {
    for (let candidate = port + 1; candidate < port + 100; candidate++) {
      if (!(await isPortOpen(candidate))) return candidate
    }
    throw new Error(`No available port near ${port}`)
  }
  return port
}

async function isPortOpen(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect(port, '127.0.0.1')
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
    socket.setTimeout(250, () => {
      socket.destroy()
      resolve(false)
    })
  })
}
