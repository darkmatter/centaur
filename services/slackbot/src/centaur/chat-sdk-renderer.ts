import {
  CentaurClient,
  type ChatStreamChunk,
  type WorkflowRunAccepted
} from '@centaur/api-client'
import type { SlackAdapter } from '@chat-adapter/slack'
import type { StreamOptions } from 'chat'
import { centaurApiKey, type AppConfig } from '../config'
import { logInfo, logWarn } from '../logging'

const WORKFLOW_EXECUTION_WAIT_MS = 5 * 60 * 1000
const WORKFLOW_EXECUTION_POLL_MS = 500

export type ChatSdkRenderInput = {
  runId: string
  config: AppConfig
  adapter: SlackAdapter
  fallbackThreadId: string
  fallbackRecipientUserId?: string
  fallbackRecipientTeamId?: string
  skipInitialTyping?: boolean
}

export function workflowRunIdFromBody(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const runId = (body as { run_id?: unknown }).run_id
  return typeof runId === 'string' && runId.trim() ? runId.trim() : null
}

export function steeredExecutionIdFromBody(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const record = body as { steered?: unknown; execution_id?: unknown }
  if (record.steered !== true) return null
  const executionId = record.execution_id
  return typeof executionId === 'string' && executionId.trim() ? executionId.trim() : null
}

export async function renderWorkflowRunWithChatSdk(input: ChatSdkRenderInput): Promise<void> {
  const apiKey = centaurApiKey(input.config)
  if (!apiKey) {
    logWarn('chat_sdk_stream_skipped_no_api_key', { workflow_run_id: input.runId })
    return
  }

  const api = new CentaurClient({
    apiUrl: input.config.CENTAUR_API_URL,
    apiKey
  })
  if (!input.skipInitialTyping) {
    void startTyping(input.adapter, input.fallbackThreadId, 'Working...')
  }
  const executionId = await waitForExecutionId(api, input.runId)
  if (!executionId) return

  try {
    const context = await api.getChatStreamContext(executionId)
    const threadId = context.thread_id || input.fallbackThreadId
    const streamOptions = chatSdkStreamOptions({
      apiOptions: context.stream_options,
      fallbackRecipientTeamId: input.fallbackRecipientTeamId,
      fallbackRecipientUserId: input.fallbackRecipientUserId
    })
    logInfo('chat_sdk_stream_started', {
      workflow_run_id: input.runId,
      execution_id: executionId,
      thread_id: threadId,
      platform: context.platform
    })
    const preparedStream = await streamWithTerminalFallback(
      api.streamChatChunks({ executionId }),
      () => api.getExecution(executionId)
    )
    if (preparedStream.source === 'empty') {
      logWarn('chat_sdk_stream_skipped_no_chunks', {
        workflow_run_id: input.runId,
        execution_id: executionId
      })
      return
    }
    if (preparedStream.source === 'terminal_fallback') {
      logWarn('chat_sdk_stream_using_terminal_fallback', {
        workflow_run_id: input.runId,
        execution_id: executionId
      })
    }
    await input.adapter.stream(threadId, preparedStream.stream, streamOptions)
    await api.markFinalDelivered(executionId)
    logInfo('chat_sdk_stream_completed', {
      workflow_run_id: input.runId,
      execution_id: executionId,
      thread_id: threadId
    })
  } catch (error) {
    logWarn('chat_sdk_stream_failed', {
      workflow_run_id: input.runId,
      execution_id: executionId,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

export async function streamWithTerminalFallback(
  source: AsyncIterable<ChatStreamChunk>,
  getExecution: () => Promise<Record<string, unknown>>
): Promise<{
  source: 'api' | 'terminal_fallback' | 'empty'
  stream: AsyncIterable<ChatStreamChunk>
}> {
  const iterator = source[Symbol.asyncIterator]()
  const first = await iterator.next()
  if (!first.done) {
    return {
      source: 'api',
      stream: prependAsyncIterable(first.value, iterator)
    }
  }

  const execution = await getExecution()
  const resultText = stringValue(execution.result_text)
  if (!resultText) {
    return { source: 'empty', stream: emptyAsyncIterable() }
  }
  return {
    source: 'terminal_fallback',
    stream: singleChunkAsyncIterable({ type: 'markdown_text', text: resultText })
  }
}

async function* prependAsyncIterable<T>(
  first: T,
  iterator: AsyncIterator<T>
): AsyncGenerator<T, void, undefined> {
  yield first
  while (true) {
    const next = await iterator.next()
    if (next.done) return
    yield next.value
  }
}

async function* singleChunkAsyncIterable(
  chunk: ChatStreamChunk
): AsyncGenerator<ChatStreamChunk, void, undefined> {
  yield chunk
}

async function* emptyAsyncIterable(): AsyncGenerator<ChatStreamChunk, void, undefined> {
  return
}

async function startTyping(
  adapter: SlackAdapter,
  threadId: string,
  status: string
): Promise<void> {
  try {
    await adapter.startTyping(threadId, status)
  } catch (error) {
    logWarn('chat_sdk_start_typing_failed', {
      thread_id: threadId,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

async function waitForExecutionId(api: CentaurClient, runId: string): Promise<string | null> {
  const deadline = Date.now() + WORKFLOW_EXECUTION_WAIT_MS
  let latest: WorkflowRunAccepted | null = null
  while (Date.now() < deadline) {
    latest = await api.getWorkflowRun(runId)
    const executionId = stringValue(latest.execution_id)
    if (executionId) return executionId
    const waitingExecutionId = stringValue(latest.waiting_on?.execution_id)
    if (waitingExecutionId) return waitingExecutionId
    if (isTerminalWorkflowStatus(latest.status)) {
      logWarn('chat_sdk_stream_skipped_workflow_terminal_without_execution', {
        workflow_run_id: runId,
        workflow_status: latest.status,
        error_text: latest.error_text
      })
      return null
    }
    await delay(WORKFLOW_EXECUTION_POLL_MS)
  }
  logWarn('chat_sdk_stream_skipped_execution_wait_timeout', {
    workflow_run_id: runId,
    workflow_status: latest?.status
  })
  return null
}

function chatSdkStreamOptions(input: {
  apiOptions: StreamOptions | undefined
  fallbackRecipientUserId?: string
  fallbackRecipientTeamId?: string
}): StreamOptions {
  const options: StreamOptions = { ...input.apiOptions }
  options.recipientUserId ??= input.fallbackRecipientUserId
  options.recipientTeamId ??= input.fallbackRecipientTeamId
  options.taskDisplayMode ??= 'plan'
  return options
}

function isTerminalWorkflowStatus(status: string | undefined): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
