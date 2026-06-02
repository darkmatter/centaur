import { Hono } from 'hono'
import {
  Chat,
  StreamingPlan,
  type Logger,
  type Message,
  type StateAdapter,
  type Thread
} from 'chat'
import { createSlackAdapter } from '@chat-adapter/slack'
import { createPostgresState } from '@chat-adapter/state-pg'
import {
  codexAppServerToChatSdkStream,
  type CodexAppServerToChatStreamOptions,
  type RendererEvent
} from '@centaur/rendering'
import {
  collectInitialContext,
  forwardToSessionApi,
  serializeMessage,
  sessionStreamError,
  streamSessionApiEvents,
  startingStreamNotification
} from './session-api'
import { isAllowedSlackMessage, isAllowedSlackWebhookBody } from './slack-events'
import type {
  ForwardSessionInput,
  ForwardSessionResult,
  SlackbotV2,
  SlackbotV2ActiveSessionStream,
  SlackbotV2ApiMessage,
  SlackbotV2MessageMode,
  SlackbotV2Options,
  SlackbotV2RendererSource,
  SlackbotV2ThreadState,
  SlackbotV2Trace
} from './types'
import { elapsedMs, errorMessage, noopLogger, nowMs, traceLog } from './utils'

export type {
  SlackbotV2,
  SlackbotV2ApiAttachment,
  SlackbotV2ApiAuthor,
  SlackbotV2ApiMessage,
  SlackbotV2AppendMessagesRequest,
  SlackbotV2CreateSessionRequest,
  SlackbotV2ExecuteSessionRequest,
  SlackbotV2Fetch,
  SlackbotV2Options,
  SlackbotV2SessionMessage,
  SlackbotV2SessionMessageRole,
  SlackbotV2ThreadState
} from './types'

type WaitUntilContext = {
  waitUntil(promise: Promise<unknown>): void
}

type SlackAssistantAdapter = {
  setAssistantStatus?(
    channelId: string,
    threadTs: string,
    status: string,
    loadingMessages?: string[]
  ): Promise<void>
  setAssistantTitle?(channelId: string, threadTs: string, title: string): Promise<void>
}

export function createSlackbotV2(options: SlackbotV2Options): SlackbotV2 {
  const userName = options.userName ?? 'centaur'
  const logger = options.logger ?? noopLogger
  const state = options.state ?? createDefaultState(options, logger)
  const runtimeOptions: SlackbotV2Options = { ...options, state }
  const activeRenderThreads = new Set<string>()
  const slack = createSlackAdapter({
    apiUrl: runtimeOptions.slackApiUrl,
    botToken: runtimeOptions.botToken,
    botUserId: runtimeOptions.botUserId,
    signingSecret: runtimeOptions.signingSecret,
    userName,
    logger
  })
  const chat = new Chat({
    userName,
    adapters: { slack },
    state,
    onLockConflict: 'force',
    logger
  })

  chat.onNewMention(async (thread, message) => {
    if (!isAllowedSlackMessage(message, runtimeOptions, logger)) return
    await thread.subscribe()
    await syncThreadMessageToSession(thread, message, {
      activeRenderThreads,
      mode: 'execute',
      options: runtimeOptions
    })
  })

  chat.onSubscribedMessage(async (thread, message) => {
    if (!isAllowedSlackMessage(message, runtimeOptions, logger)) return
    await syncThreadMessageToSession(thread, message, {
      activeRenderThreads,
      mode: message.isMention === true ? 'execute' : 'append',
      options: runtimeOptions
    })
  })

  const app = new Hono()
  app.get('/health', c => c.json({ ok: true, service: 'slackbotv2' }))
  app.post('/api/webhooks/slack', async c => {
    const rawBody = await c.req.raw.clone().text()
    if (!isAllowedSlackWebhookBody(rawBody, runtimeOptions, logger)) {
      return new globalThis.Response('ok', { status: 200 })
    }
    const response = await chat.webhooks.slack(c.req.raw, {
      waitUntil: promise => waitUntil(c, promise)
    })
    return new globalThis.Response(await response.text(), {
      headers: response.headers,
      status: response.status
    })
  })

  return { app, chat }
}

function createDefaultState(options: SlackbotV2Options, logger: Logger): StateAdapter {
  return createPostgresState({
    url: options.postgresUrl,
    keyPrefix: options.stateKeyPrefix ?? 'centaur-slackbotv2',
    logger: logger.child('postgres-state')
  })
}

async function resumeActiveSessionStream(
  thread: Thread<SlackbotV2ThreadState>,
  options: SlackbotV2Options,
  activeRenderThreads: Set<string>,
  parentTrace?: SlackbotV2Trace
): Promise<boolean> {
  if (activeRenderThreads.has(thread.id)) return false
  const state = (await thread.state) ?? {}
  const active = state.activeSessionStream
  if (state.activeExecution !== true || !active) return false

  let lastEventId = Math.max(state.lastEventId ?? 0, active.lastEventId)
  let streamReachedTerminal = false
  const trace: SlackbotV2Trace = {
    includeContext: false,
    messageId: active.message.id,
    mode: 'execute',
    openStream: true,
    startedAtMs: nowMs(),
    threadId: thread.id
  }
  traceLog(options, 'slackbotv2_active_stream_resume_started', parentTrace ?? trace, {
    after_event_id: lastEventId,
    execution_id: active.executionId
  })

  const streamInput: ForwardSessionInput = {
    afterEventId: lastEventId,
    executionId: active.executionId,
    messages: [],
    onEventId: async eventId => {
      lastEventId = Math.max(lastEventId, eventId)
      await persistActiveSessionCursor(thread, lastEventId)
    },
    onTerminal: () => {
      streamReachedTerminal = true
    },
    openStream: true,
    threadId: thread.id,
    trace
  }

  activeRenderThreads.add(thread.id)
  try {
    await renderExecutionStream(
      thread,
      resumeSessionStream(options, streamInput),
      active.message,
      options,
      trace
    )
  } finally {
    activeRenderThreads.delete(thread.id)
    const latest = (await thread.state) ?? {}
    const nextLastEventId = Math.max(latest.lastEventId ?? 0, lastEventId)
    await thread.setState({
      ...latest,
      activeExecution: streamReachedTerminal ? false : true,
      activeSessionStream: streamReachedTerminal
        ? undefined
        : updateActiveSessionLastEventId(latest.activeSessionStream, nextLastEventId),
      lastEventId: nextLastEventId
    })
  }
  traceLog(options, 'slackbotv2_active_stream_resume_complete', trace, {
    last_event_id: lastEventId,
    terminal: streamReachedTerminal
  })
  return true
}

async function* resumeSessionStream(
  options: SlackbotV2Options,
  input: ForwardSessionInput
): AsyncIterable<SlackbotV2RendererSource> {
  yield startingStreamNotification(input.threadId)
  try {
    const stream = await streamSessionApiEvents(options, input)
    for await (const event of stream) yield event
  } catch (error) {
    traceLog(options, 'slackbotv2_resume_stream_failed', input.trace, {
      error: errorMessage(error)
    })
    yield sessionStreamError(error)
  }
}

async function persistActiveSessionCursor(
  thread: Thread<SlackbotV2ThreadState>,
  lastEventId: number
): Promise<void> {
  const latest = (await thread.state) ?? {}
  const activeSessionStream = updateActiveSessionLastEventId(
    latest.activeSessionStream,
    lastEventId
  )
  if (!activeSessionStream) return
  await thread.setState({
    activeExecution: true,
    activeSessionStream,
    lastEventId: Math.max(latest.lastEventId ?? 0, lastEventId)
  })
}

function updateActiveSessionLastEventId(
  activeSessionStream: SlackbotV2ActiveSessionStream | undefined,
  lastEventId: number
): SlackbotV2ActiveSessionStream | undefined {
  if (!activeSessionStream) return undefined
  return {
    ...activeSessionStream,
    lastEventId: Math.max(activeSessionStream.lastEventId, lastEventId)
  }
}

/**
 * Persists a Slack thread update into the session API. In execute mode it also starts and
 * renders a session stream unless another execution is already active for the same thread.
 */
async function syncThreadMessageToSession(
  thread: Thread<SlackbotV2ThreadState>,
  message: Message,
  input: {
    activeRenderThreads: Set<string>
    mode: SlackbotV2MessageMode
    options: SlackbotV2Options
  }
): Promise<void> {
  const traceStartedAtMs = nowMs()
  const state = (await thread.state) ?? {}
  const messageIds = new Set(state.forwardedMessageIds ?? [])
  const shouldStartExecution = input.mode === 'execute' && state.activeExecution !== true
  const shouldIncludeContext = shouldStartExecution
  const isDuplicateIncrementalMessage =
    messageIds.has(message.id) && (!shouldIncludeContext || state.historyForwarded)
  const trace: SlackbotV2Trace = {
    includeContext: shouldIncludeContext,
    messageId: message.id,
    mode: input.mode,
    openStream: shouldStartExecution,
    startedAtMs: traceStartedAtMs,
    threadId: thread.id
  }
  if (isDuplicateIncrementalMessage) {
    traceLog(input.options, 'slackbotv2_forward_duplicate_skipped', trace)
    return
  }
  traceLog(input.options, 'slackbotv2_forward_started', trace, {
    active_execution: state.activeExecution === true,
    history_forwarded: state.historyForwarded === true
  })

  const serializeStartedAtMs = nowMs()
  const serializedMessage = await serializeMessage(message)
  traceLog(input.options, 'slackbotv2_forward_message_serialized', trace, {
    attachment_count: serializedMessage.attachments.length,
    phase_ms: elapsedMs(serializeStartedAtMs)
  })
  let context: SlackbotV2ApiMessage[] | undefined

  if (shouldIncludeContext && !state.historyForwarded) {
    const contextStartedAtMs = nowMs()
    context = await collectInitialContext(thread, message)
    for (const item of context) {
      messageIds.add(item.id)
    }
    traceLog(input.options, 'slackbotv2_forward_context_collected', trace, {
      message_count: context.length,
      phase_ms: elapsedMs(contextStartedAtMs)
    })
  } else {
    messageIds.add(serializedMessage.id)
    traceLog(input.options, 'slackbotv2_forward_context_skipped', trace, {
      message_count: 1
    })
  }

  let lastEventId = state.lastEventId ?? 0
  let streamReachedTerminal = false

  const forwardInput: ForwardSessionInput = {
    afterEventId: lastEventId,
    executeMessage: shouldStartExecution ? serializedMessage : undefined,
    messages: context ?? [serializedMessage],
    onEventId: async eventId => {
      lastEventId = Math.max(lastEventId, eventId)
      await persistActiveSessionCursor(thread, lastEventId)
    },
    onTerminal: () => {
      streamReachedTerminal = true
    },
    openStream: shouldStartExecution,
    threadId: thread.id,
    trace
  }

  const commitForwardedState = async (result?: ForwardSessionResult | null): Promise<void> => {
    const activeSessionStream =
      state.activeSessionStream ??
      (result?.executionId
        ? {
            executionId: result.executionId,
            lastEventId,
            message: serializedMessage,
            startedAtMs: traceStartedAtMs,
            threadId: thread.id
          }
        : undefined)
    await thread.setState({
      activeExecution: state.activeExecution || shouldStartExecution,
      activeSessionStream,
      forwardedMessageIds: Array.from(messageIds).slice(-1000),
      historyForwarded: state.historyForwarded || shouldIncludeContext,
      lastEventId
    })
    traceLog(input.options, 'slackbotv2_forward_state_committed', trace, {
      forwarded_message_count: Math.min(messageIds.size, 1000)
    })
  }

  if (!shouldStartExecution) {
    await forwardToSessionApi(input.options, forwardInput)
    await commitForwardedState()
    if (state.activeSessionStream && !input.activeRenderThreads.has(thread.id)) {
      await resumeActiveSessionStream(thread, input.options, input.activeRenderThreads, trace)
    }
    traceLog(input.options, 'slackbotv2_forward_complete', trace)
    return
  }

  try {
    await thread.setState({ ...state, activeExecution: true })
    traceLog(input.options, 'slackbotv2_forward_active_execution_marked', trace)
    input.activeRenderThreads.add(thread.id)
    await renderExecutionStream(
      thread,
      executeAndStreamSession(input.options, forwardInput, commitForwardedState),
      serializedMessage,
      input.options,
      trace
    )
    traceLog(input.options, 'slackbotv2_render_complete', trace)
  } finally {
    input.activeRenderThreads.delete(thread.id)
    const latest = (await thread.state) ?? {}
    const nextLastEventId = Math.max(latest.lastEventId ?? 0, lastEventId)
    await thread.setState({
      ...latest,
      activeExecution: streamReachedTerminal ? false : true,
      activeSessionStream: streamReachedTerminal
        ? undefined
        : updateActiveSessionLastEventId(latest.activeSessionStream, nextLastEventId),
      lastEventId: nextLastEventId
    })
    traceLog(input.options, 'slackbotv2_forward_complete', trace, {
      last_event_id: lastEventId
    })
  }
}

async function renderExecutionStream(
  thread: Thread,
  stream: AsyncIterable<SlackbotV2RendererSource>,
  message: SlackbotV2ApiMessage,
  options: SlackbotV2Options,
  trace?: SlackbotV2Trace
): Promise<void> {
  const titleStartedAtMs = nowMs()
  await setAssistantTitle(thread, titleFromMessage(message.text, options.userName))
  await setAssistantStatus(thread, options.assistantStatus ?? 'Thinking...')
  traceLog(options, 'slackbotv2_render_slack_metadata_set', trace, {
    phase_ms: elapsedMs(titleStartedAtMs)
  })
  try {
    await thread.post(
      new StreamingPlan(
        codexAppServerToChatSdkStream(stream, rendererOptions(thread, options)),
        { groupTasks: options.streamTaskDisplayMode ?? 'plan' }
      )
    )
  } finally {
    await setAssistantStatus(thread, '')
  }
}

async function* executeAndStreamSession(
  options: SlackbotV2Options,
  input: ForwardSessionInput,
  onSessionReady: (result: ForwardSessionResult | null) => Promise<void>
): AsyncIterable<SlackbotV2RendererSource> {
  yield startingStreamNotification(input.threadId)
  traceLog(options, 'slackbotv2_stream_heartbeat_emitted', input.trace)

  try {
    const result = await forwardToSessionApi(options, input)
    await onSessionReady(result)
    if (!result?.stream) return
    for await (const event of result.stream) yield event
  } catch (error) {
    if (input.executeMessage) input.onTerminal?.()
    traceLog(options, 'slackbotv2_forward_failed', input.trace, {
      error: errorMessage(error)
    })
    yield sessionStreamError(error)
  }
}

function rendererOptions(thread: Thread, options: SlackbotV2Options): CodexAppServerToChatStreamOptions {
  const mapper = options.mapper
  return {
    ...mapper,
    async onRendererEvent(event: RendererEvent) {
      await mapper?.onRendererEvent?.(event)
      if (event.type === 'renderer.title.update') {
        await setAssistantTitle(thread, event.title)
      }
    }
  }
}

async function setAssistantStatus(thread: Thread, status: string): Promise<void> {
  const target = slackAssistantTarget(thread)
  const adapter = thread.adapter as SlackAssistantAdapter
  if (!target || !adapter.setAssistantStatus) return
  await ignoreAssistantError(() =>
    adapter.setAssistantStatus!(
      target.channel,
      target.threadTs,
      status,
      status ? [status] : undefined
    )
  )
}

async function setAssistantTitle(thread: Thread, title: string | undefined): Promise<void> {
  const normalized = title?.trim()
  if (!normalized) return
  const target = slackAssistantTarget(thread)
  const adapter = thread.adapter as SlackAssistantAdapter
  if (!target || !adapter.setAssistantTitle) return
  await ignoreAssistantError(() =>
    adapter.setAssistantTitle!(target.channel, target.threadTs, clipOneLine(normalized, 80))
  )
}

async function ignoreAssistantError(fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch {
    // Assistant status/title are Slack UI polish. Rendering should continue if unsupported.
  }
}

function slackAssistantTarget(thread: Thread): { channel: string; threadTs: string } | null {
  const parts = thread.id.split(':')
  if (parts[0] !== 'slack' || !parts[1] || !parts[2]) return null
  return { channel: parts[1], threadTs: parts[2] }
}

function titleFromMessage(text: string, userName = 'centaur'): string {
  const mentionless = text
    .replace(/<@[A-Z0-9]+(?:\|[^>]+)?>/g, '')
    .replace(new RegExp(`^\\s*@?${escapeRegExp(userName)}\\b[:,]?\\s*`, 'i'), '')
    .replace(/^@\S+\s+/, '')
    .trim()
  return clipOneLine(mentionless || 'Centaur task', 80)
}

function clipOneLine(value: string, max: number): string {
  const oneLine = value.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= max) return oneLine
  return `${oneLine.slice(0, Math.max(0, max - 1)).trimEnd()}...`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function waitUntil(c: { executionCtx: WaitUntilContext }, promise: Promise<unknown>): void {
  try {
    c.executionCtx.waitUntil(promise)
  } catch {
    void promise.catch(() => undefined)
  }
}
