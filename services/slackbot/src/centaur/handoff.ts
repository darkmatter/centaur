import { Buffer } from 'node:buffer'
import type { Attachment, Message, Thread } from 'chat'
import { centaurApiKey, type AppConfig } from '../config'
import { logInfo, logWarn } from '../logging'
import { clientSpanOptions, injectTraceHeaders, spanAttributes, withSpan } from '../otel'

const HISTORY_PAGE_LIMIT = 200
const PROMPT_SELECTOR_RE = /(^|\s)`?--[a-z][a-z0-9-]*(?=\s|`|$)/i
const INTERRUPTIBLE_EXECUTION_STATUSES = new Set(['running'])
const REPLACEABLE_EXECUTION_STATUSES = new Set(['queued', 'retry_wait'])
const STEER_ACCEPTED_STATUSES = new Set(['running', 'steered'])

export type NormalizedTextPart = {
  type: 'text'
  text: string
}

export type NormalizedBinaryPart = {
  type: 'image' | 'document' | 'file'
  name: string
  mime_type: string
  size: number
  slack_file_id?: string
  source: {
    type: 'base64'
    media_type: string
    data: string
  }
}

export type NormalizedPart = NormalizedTextPart | NormalizedBinaryPart

export type NormalizedSlackEvent = {
  thread_key: string
  message_id: string
  team_id: string
  recipient_team_id?: string
  user_id: string
  channel_id: string
  thread_ts: string
  is_mention: boolean
  parts: NormalizedPart[]
  history_messages?: Array<{
    message_id: string
    role?: 'user' | 'assistant'
    parts: NormalizedPart[]
    user_id?: string
    metadata?: Record<string, unknown>
  }>
  slack: {
    event_id?: string
    event_ts?: string
    message_ts: string
    enterprise_id?: string
    user_team?: string
    source_team?: string
    bot_id?: string
    app_id?: string
    bot_user_id?: string
  }
}

export type ChatSdkSlackMessageInput = {
  thread: Thread
  message: Message
  botUserId?: string
}

type WorkflowRunRequestBody = {
  workflow_name: 'slack_thread_turn'
  trigger_key: string
  eager_start: true
  input: {
    thread_key: string
    parts: NormalizedPart[]
    history_messages: NonNullable<NormalizedSlackEvent['history_messages']>
    message_id: string
    user_id: string
    metadata: Record<string, unknown>
    delivery: Record<string, unknown>
  }
}

export type CentaurHandoffResult =
  | { ok: true; status: number; body: unknown }
  | { ok: false; status: number; body: unknown }

export class CentaurHandoff {
  readonly config: AppConfig

  constructor(config: AppConfig) {
    this.config = config
  }

  async emit(event: NormalizedSlackEvent): Promise<CentaurHandoffResult> {
    return withSpan(
      'centaur.slackbot.handoff',
      clientSpanOptions({
        'centaur.thread_key': event.thread_key,
        'centaur.workflow.name': 'slack_thread_turn',
        'slack.team_id': event.team_id,
        'slack.channel_id': event.channel_id,
        'slack.thread_ts': event.thread_ts,
        'slack.user_id': event.user_id
      }),
      async span => {
        const requestBody = workflowRunRequestBody(event)
        const steerResult = await this.trySteerActiveExecution(
          event,
          requestBody.input.metadata as Record<string, unknown>
        )
        if (steerResult) {
          spanAttributes(span, {
            'http.response.status_code': steerResult.status,
            'centaur.handoff.ok': steerResult.ok,
            'centaur.handoff.steered': true
          })
          return steerResult
        }

        const url = new URL('/workflows/runs', this.config.CENTAUR_API_URL)
        const apiKey = centaurApiKey(this.config)
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Centaur-Thread-Key': event.thread_key,
            ...injectTraceHeaders(),
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
          },
          body: JSON.stringify(requestBody)
        })

        spanAttributes(span, {
          'http.response.status_code': response.status,
          'centaur.handoff.ok': response.ok
        })
        const body = await readResponseBody(response)
        return { ok: response.ok, status: response.status, body }
      }
    )
  }

  private async trySteerActiveExecution(
    event: NormalizedSlackEvent,
    metadata: Record<string, unknown>
  ): Promise<CentaurHandoffResult | null> {
    if (hasPromptSelector(event.parts)) return null
    const apiKey = centaurApiKey(this.config)
    if (!apiKey) return null

    try {
      const executionsUrl = new URL(
        `/agent/threads/${encodeURIComponent(event.thread_key)}/executions`,
        this.config.CENTAUR_API_URL
      )
      executionsUrl.searchParams.set('limit', '10')
      const executionsResponse = await fetch(executionsUrl, {
        headers: authHeaders(apiKey)
      })
      if (!executionsResponse.ok) return null
      const executionsBody = await readResponseBody(executionsResponse)
      const executions = Array.isArray(recordValue(executionsBody).executions)
        ? (recordValue(executionsBody).executions as Array<Record<string, unknown>>)
        : []

      const running = executions.find(execution =>
        INTERRUPTIBLE_EXECUTION_STATUSES.has(stringField(execution.status) ?? '')
      )
      if (running) {
        const executionId = stringField(running.execution_id)
        if (!executionId) return null
        const steerUrl = new URL(
          `/agent/executions/${encodeURIComponent(executionId)}/steer`,
          this.config.CENTAUR_API_URL
        )
        const steerResponse = await fetch(steerUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders(apiKey)
          },
          body: JSON.stringify({
            content_blocks: event.parts,
            history_messages: event.history_messages ?? [],
            message_id: event.message_id,
            user_id: event.user_id,
            metadata: {
              ...metadata,
              steer_replacement: true
            }
          })
        })
        const body = await readResponseBody(steerResponse)
        const steerStatus = stringField(recordValue(body).status)
        if (steerResponse.ok && STEER_ACCEPTED_STATUSES.has(steerStatus ?? '')) {
          logInfo('centaur_slack_handoff_steered_execution', {
            thread_key: event.thread_key,
            execution_id: executionId,
            message_id: event.message_id,
            status: steerStatus
          })
          return {
            ok: true,
            status: steerResponse.status,
            body: {
              ...recordValue(body),
              steered: true,
              execution_id: executionId
            }
          }
        }
        logWarn('centaur_slack_handoff_steer_not_running', {
          thread_key: event.thread_key,
          execution_id: executionId,
          status: steerStatus,
          response_status: steerResponse.status
        })
        return null
      }

      for (const execution of executions) {
        const status = stringField(execution.status) ?? ''
        if (!REPLACEABLE_EXECUTION_STATUSES.has(status)) continue
        const executionId = stringField(execution.execution_id)
        if (!executionId) continue
        const cancelUrl = new URL(
          `/agent/executions/${encodeURIComponent(executionId)}/cancel`,
          this.config.CENTAUR_API_URL
        )
        await fetch(cancelUrl, {
          method: 'POST',
          headers: authHeaders(apiKey)
        })
      }
    } catch (error) {
      logWarn('centaur_slack_handoff_steer_lookup_failed', {
        thread_key: event.thread_key,
        error: error instanceof Error ? error.message : String(error)
      })
    }
    return null
  }

  async emitChatMessage(input: ChatSdkSlackMessageInput): Promise<{
    event: NormalizedSlackEvent
    result: CentaurHandoffResult
  }> {
    const event = await slackEventFromChatMessage(input)
    const result = await this.emit(event)
    return { event, result }
  }
}

function workflowRunRequestBody(event: NormalizedSlackEvent): WorkflowRunRequestBody {
  return {
    workflow_name: 'slack_thread_turn',
    trigger_key: event.message_id,
    eager_start: true,
    input: {
      thread_key: event.thread_key,
      parts: event.parts,
      history_messages: event.history_messages ?? [],
      message_id: event.message_id,
      user_id: event.user_id,
      metadata: {
        source: 'slackbot',
        slack: {
          message_ts: event.slack.message_ts,
          enterprise_id: event.slack.enterprise_id,
          user_team: event.slack.user_team,
          source_team: event.slack.source_team,
          bot_id: event.slack.bot_id,
          app_id: event.slack.app_id,
          bot_user_id: event.slack.bot_user_id
        },
        is_mention: event.is_mention
      },
      delivery: {
        platform: 'slack',
        channel: event.channel_id,
        thread_ts: event.thread_ts,
        recipient_user_id: event.user_id,
        recipient_team_id: event.recipient_team_id ?? event.team_id
      }
    }
  }
}

function hasPromptSelector(parts: NormalizedPart[]): boolean {
  return parts.some(part => part.type === 'text' && PROMPT_SELECTOR_RE.test(part.text))
}

function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` }
}

export async function slackEventFromChatMessage(
  input: ChatSdkSlackMessageInput
): Promise<NormalizedSlackEvent> {
  const raw = recordValue(input.message.raw)
  const decoded = decodeSlackThreadId(input.thread.id)
  const channelId = stringField(raw.channel) ?? decoded.channel
  const messageTs = stringField(raw.ts) ?? input.message.id
  const threadTs = stringField(raw.thread_ts) ?? decoded.threadTs ?? messageTs
  const teamId =
    stringField(raw.team_id) ??
    stringField(raw.team) ??
    stringField(raw.user_team) ??
    stringField(raw.source_team) ??
    'unknown'
  const userId =
    stringField(raw.user) ??
    stringField(recordValue(raw.bot_profile).user_id) ??
    input.message.author.userId
  const parts = await partsFromMessage(input.message, input.botUserId)
  const historyMessages = await historyFromThread(input)

  return {
    thread_key: `slack:${teamId}:${channelId}:${threadTs}`,
    message_id: `slack:${teamId}:${channelId}:${messageTs}`,
    team_id: teamId,
    recipient_team_id: stringField(raw.user_team) ?? stringField(raw.source_team) ?? teamId,
    user_id: userId,
    channel_id: channelId,
    thread_ts: threadTs,
    is_mention: Boolean(input.message.isMention || input.thread.isDM),
    parts,
    ...(historyMessages.length ? { history_messages: historyMessages } : {}),
    slack: {
      event_ts: stringField(raw.event_ts),
      message_ts: messageTs,
      enterprise_id: stringField(raw.enterprise_id),
      user_team: stringField(raw.user_team),
      source_team: stringField(raw.source_team),
      bot_id: stringField(raw.bot_id),
      app_id: stringField(raw.app_id),
      bot_user_id: input.botUserId
    }
  }
}

async function historyFromThread(
  input: ChatSdkSlackMessageInput
): Promise<NonNullable<NormalizedSlackEvent['history_messages']>> {
  const decoded = decodeSlackThreadId(input.thread.id)
  if (!decoded.threadTs) return []
  if (input.message.id === decoded.threadTs) return []

  const currentTs = numericSlackTs(input.message.id)
  const collected: Array<{
    index: number
    sortTs: number | null
    entry: NonNullable<NormalizedSlackEvent['history_messages']>[number]
  }> = []
  try {
    let cursor: string | undefined
    do {
      const result = await input.thread.adapter.fetchMessages(input.thread.id, {
        limit: HISTORY_PAGE_LIMIT,
        direction: 'forward',
        cursor
      })
      for (const message of result.messages) {
        if (message.id === input.message.id) continue
        const messageTs = numericSlackTs(message.id)
        if (currentTs && messageTs && messageTs >= currentTs) continue

        const parts = await partsFromMessage(message, input.botUserId)
        if (!parts.length) continue

        const raw = recordValue(message.raw)
        const teamId =
          stringField(raw.team_id) ??
          stringField(raw.team) ??
          stringField(raw.user_team) ??
          stringField(raw.source_team) ??
          'unknown'
        const channelId = stringField(raw.channel) ?? decoded.channel
        const userId =
          stringField(raw.user) ??
          stringField(recordValue(raw.bot_profile).user_id) ??
          message.author.userId

        collected.push({
          index: collected.length,
          sortTs: messageTs,
          entry: {
            message_id: `slack:${teamId}:${channelId}:${message.id}`,
            role: message.author.isMe ? 'assistant' : 'user',
            parts,
            user_id: userId,
            metadata: {
              platform: 'slack',
              history_backfill: true,
              slack: {
                message_ts: message.id,
                is_mention: input.thread.isDM || messageMentionsBot(message, input.botUserId),
                bot_id: stringField(raw.bot_id),
                app_id: stringField(raw.app_id)
              }
            }
          }
        })
      }
      cursor =
        typeof result.nextCursor === 'string' && result.nextCursor.trim()
          ? result.nextCursor
          : undefined
    } while (cursor)
  } catch {
    return []
  }

  return collected
    .sort((left, right) => {
      if (left.sortTs !== null && right.sortTs !== null) return left.sortTs - right.sortTs
      if (left.sortTs !== null) return -1
      if (right.sortTs !== null) return 1
      return left.index - right.index
    })
    .map(item => item.entry)
}

async function partsFromMessage(
  message: Message,
  botUserId: string | undefined
): Promise<NormalizedPart[]> {
  const parts: NormalizedPart[] = []
  const text = textFromMessage(message, botUserId)
  if (text) parts.push({ type: 'text', text })

  for (const attachment of message.attachments) {
    const part = await partFromAttachment(attachment)
    if (part) parts.push(part)
  }

  return parts
}

function textFromMessage(message: Message, botUserId: string | undefined): string {
  const raw = recordValue(message.raw)
  const body = stripBotMention(message.text, botUserId)
  const attachmentText = slackAttachmentText(raw.attachments)
  return [body, attachmentText]
    .map(part => part.trim())
    .filter(Boolean)
    .join('\n')
}

function messageMentionsBot(message: Message, botUserId: string | undefined): boolean {
  if (message.isMention) return true
  if (!botUserId) return false
  const raw = recordValue(message.raw)
  const text = stringField(raw.text) ?? message.text
  if (!text) return false
  return new RegExp(`<@${escapeRegex(botUserId)}(?:\\|[^>]*)?>`).test(text)
}

async function partFromAttachment(attachment: Attachment): Promise<NormalizedBinaryPart | null> {
  if (!attachment.fetchData) return null
  const data = await attachment.fetchData()
  const bytes = bufferFromUnknown(data)
  const mimeType = attachment.mimeType || 'application/octet-stream'
  const type = attachmentType(mimeType, attachment.type)

  return {
    type,
    name: attachment.name || 'slack-file',
    mime_type: mimeType,
    size: attachment.size ?? bytes.length,
    slack_file_id: stringField(recordValue(attachment.fetchMetadata).id),
    source: {
      type: 'base64',
      media_type: mimeType,
      data: bytes.toString('base64')
    }
  }
}

function attachmentType(
  mimeType: string,
  chatType: Attachment['type']
): NormalizedBinaryPart['type'] {
  if (chatType === 'image' || mimeType.startsWith('image/')) return 'image'
  if (
    mimeType === 'application/pdf' ||
    mimeType.startsWith('text/') ||
    mimeType.includes('document') ||
    mimeType.includes('json')
  ) {
    return 'document'
  }
  return 'file'
}

function stripBotMention(text: string, botUserId: string | undefined): string {
  let out = text
  if (botUserId) {
    const escaped = escapeRegex(botUserId)
    out = out
      .replace(new RegExp(`<@${escaped}(?:\\|[^>]+)?>`, 'gi'), ' ')
      .replace(new RegExp(`@${escaped}\\b`, 'gi'), ' ')
  }
  out = out.replace(/^(\s*(?:<@[A-Z0-9_]+(?:\|[^>]+)?>|@[A-Z0-9_]+)\s*)+/i, '')
  return out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function slackAttachmentText(value: unknown): string {
  if (!Array.isArray(value)) return ''
  const lines: string[] = []
  for (const item of value) {
    const attachment = recordValue(item)
    for (const key of ['title', 'text', 'pretext']) {
      const text = stringField(attachment[key])
      if (text) lines.push(text)
    }
    const fields = attachment.fields
    if (Array.isArray(fields)) {
      for (const field of fields) {
        const record = recordValue(field)
        const title = stringField(record.title)
        const fieldValue = stringField(record.value)
        if (title && fieldValue) lines.push(`${title}: ${fieldValue}`)
        else if (fieldValue) lines.push(fieldValue)
      }
    }
  }
  return uniqueNonEmpty(lines).join('\n')
}

function decodeSlackThreadId(threadId: string): { channel: string; threadTs: string } {
  const [, channel = '', threadTs = ''] = /^slack:([^:]*):?(.*)$/.exec(threadId) ?? []
  return { channel, threadTs }
}

function bufferFromUnknown(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof ArrayBuffer) return Buffer.from(value)
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  }
  throw new Error('Unsupported Slack attachment data')
}

function numericSlackTs(value: string): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const text = value.trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
