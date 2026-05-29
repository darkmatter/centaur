import { Hono, type Context } from 'hono'
import { ulid } from '@std/ulid'
import { createSlackAdapter } from '@chat-adapter/slack'
import { createMemoryState } from '@chat-adapter/state-memory'
import {
  Chat,
  type ActionEvent,
  type Message,
  type ModalResponse,
  type ModalSubmitEvent,
  type SlashCommandEvent,
  type Thread
} from 'chat'
import { showRoutes } from 'hono/dev'
import { timeout } from 'hono/timeout'
import { requestId } from 'hono/request-id'
import { prettyJSON } from 'hono/pretty-json'
import {
  renderWorkflowRunWithChatSdk,
  steeredExecutionIdFromBody,
  workflowRunIdFromBody
} from './centaur/chat-sdk-renderer'
import { CentaurHandoff } from './centaur/handoff'
import { loadConfig } from './config'
import { logError, logInfo, logWarn } from './logging'
import {
  clientSpanOptions,
  configureOtel,
  internalSpanOptions,
  serverSpanOptions,
  spanAttributes,
  withSpan
} from './otel'

const config = loadConfig()
configureOtel()

const handoff = new CentaurHandoff(config)
const slackAdapter = createSlackAdapter({
  apiUrl: config.SLACK_API_URL,
  botToken: config.SLACK_BOT_TOKEN,
  signingSecret: config.SLACK_SIGNING_SECRET,
  userName: 'centaur'
})
const chat = new Chat({
  adapters: { slack: slackAdapter },
  concurrency: 'concurrent',
  dedupeTtlMs: config.SLACK_EVENT_DEDUP_TTL_MS,
  logger: process.env.NODE_ENV === 'test' ? 'silent' : 'info',
  state: createMemoryState(),
  userName: 'centaur'
})

chat.onNewMention(handleSlackTurn)
chat.onDirectMessage(handleSlackTurn)
chat.onSlashCommand(config.SLACK_FEEDBACK_COMMANDS, handleFeedbackCommand)
chat.onAction(handleSlackAction)
chat.onModalSubmit(handleSlackModalSubmit)

type WaitUntilContext = {
  waitUntil(promise: Promise<unknown>): void
}

export const app = new Hono()
  .use(prettyJSON())
  .use('*', async (c, next) => {
    await withSpan(
      'centaur.slackbot.http_request',
      serverSpanOptions({
        'http.request.method': c.req.method,
        'url.path': c.req.path
      }),
      async span => {
        await next()
        spanAttributes(span, {
          'http.response.status_code': c.res.status
        })
      }
    )
  })
  .use('*', async (c, next) => {
    await next()
    logInfo('http_request', {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status
    })
  })
  .use('*', timeout(5_000))
  .use(
    requestId({
      headerName: 'X-Slackbot-Request-ID',
      generator: () => ulid()
    })
  )

app
  .get('/health', c =>
    c.json({
      ok: true,
      service: 'slackbot',
      commit: process.env.COMMIT_SHA ?? 'local'
    })
  )
  .get('/health/ready', c => c.redirect('/health'))

const slackWebhookPaths = new Set([
  config.CENTAUR_SLACK_EVENTS_PATH,
  '/api/slack/events',
  '/api/slack/actions',
  '/api/slack/options',
  '/api/slack/commands',
  '/api/webhooks/slack'
])

for (const path of slackWebhookPaths) {
  app.post(path, c =>
    chat.webhooks.slack(c.req.raw, {
      waitUntil: task => runInBackground(c, task)
    })
  )
}

if (process.env.NODE_ENV === 'development') showRoutes(app)

export default {
  port: config.PORT,
  fetch: app.fetch
}

async function handleSlackTurn(thread: Thread, message: Message): Promise<void> {
  const raw = slackRaw(message)
  await withSpan(
    'centaur.slackbot.event',
    internalSpanOptions({
      'slack.team_id': slackTeamId(raw),
      'slack.event_type': stringField(raw.type),
      'slack.channel_id': stringField(raw.channel),
      'slack.message_ts': stringField(raw.ts),
      'slack.thread_ts': stringField(raw.thread_ts) ?? stringField(raw.ts)
    }),
    async span => {
      const ignored = slackIgnoreReason(message, raw)
      if (ignored) {
        spanAttributes(span, {
          'centaur.slackbot.event_ignored': true,
          'centaur.slackbot.ignore_reason': ignored
        })
        logInfo('slack_event_ignored', {
          reason: ignored,
          team_id: slackTeamId(raw),
          channel_id: stringField(raw.channel),
          message_ts: stringField(raw.ts)
        })
        return
      }

      void startThreadTyping(thread)

      const { event: normalized, result } = await handoff.emitChatMessage({
        thread,
        message,
        botUserId: slackAdapter.botUserId
      })
      spanAttributes(span, {
        'centaur.thread_key': normalized.thread_key,
        'slack.channel_id': normalized.channel_id,
        'slack.thread_ts': normalized.thread_ts,
        'slack.user_id': normalized.user_id,
        'centaur.slackbot.is_mention': normalized.is_mention,
        'centaur.slackbot.part_count': normalized.parts.length,
        'centaur.slackbot.handoff_status': result.status,
        'centaur.slackbot.handoff_ok': result.ok
      })
      if (!result.ok) {
        if (result.status === 409) {
          logWarn('centaur_slack_handoff_conflict', result.body)
          return
        }
        throw new Error(`Centaur Slack handoff failed: ${result.status}`)
      }

      const steeredExecutionId = steeredExecutionIdFromBody(result.body)
      if (steeredExecutionId) {
        logInfo('centaur_slack_handoff_steered_existing_stream', {
          thread_key: normalized.thread_key,
          execution_id: steeredExecutionId
        })
        return
      }

      const runId = workflowRunIdFromBody(result.body)
      if (!runId) {
        logWarn('centaur_slack_handoff_missing_run_id', {
          thread_key: normalized.thread_key,
          body: result.body
        })
        return
      }

      await renderWorkflowRunWithChatSdk({
        runId,
        config,
        adapter: slackAdapter,
        fallbackThreadId: `slack:${normalized.channel_id}:${normalized.thread_ts}`,
        fallbackRecipientUserId: normalized.user_id,
        fallbackRecipientTeamId: normalized.recipient_team_id ?? normalized.team_id,
        skipInitialTyping: true
      })
    }
  )
}

async function startThreadTyping(thread: Thread): Promise<void> {
  try {
    await thread.startTyping('Working...')
  } catch (error) {
    logWarn('slack_start_typing_failed', {
      thread_id: thread.id,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

async function handleFeedbackCommand(event: SlashCommandEvent): Promise<void> {
  const raw = recordValue(event.raw)
  const channelId = stringField(raw.channel_id)
  if (
    config.SLACK_FEEDBACK_ALLOWED_CHANNELS.length &&
    channelId &&
    !config.SLACK_FEEDBACK_ALLOWED_CHANNELS.includes(channelId)
  ) {
    await postEphemeral(event, 'This feedback command is not enabled in this channel.')
    return
  }
  if (!config.LINEAR_API_KEY) {
    await postEphemeral(event, 'Linear feedback is not configured: missing LINEAR_API_KEY.')
    return
  }

  const text = event.text.trim()
  if (!text) {
    await postEphemeral(event, `Usage: ${event.command} <feedback or bug report>`)
    return
  }

  try {
    const issue = await createLinearFeedbackIssue(event, text)
    await postEphemeral(event, `Created ${issue.identifier}: ${issue.url}`)
  } catch (error) {
    logError('linear_feedback_issue_create_failed', error)
    await postEphemeral(
      event,
      'Could not create the Linear issue. The error was logged for follow-up.'
    )
  }
}

async function handleSlackAction(event: ActionEvent): Promise<void> {
  logInfo('slack_action_received', {
    action_id: event.actionId,
    message_id: event.messageId,
    thread_id: event.threadId,
    user_id: event.user.userId,
    value: event.value
  })
}

async function handleSlackModalSubmit(event: ModalSubmitEvent): Promise<ModalResponse> {
  logInfo('slack_modal_submit_received', {
    callback_id: event.callbackId,
    view_id: event.viewId,
    user_id: event.user.userId
  })
  return { action: 'clear' as const }
}

async function postEphemeral(event: SlashCommandEvent, text: string): Promise<void> {
  await withSpan(
    'centaur.slackbot.slack.post_ephemeral',
    clientSpanOptions({
      'slack.command': event.command,
      'slack.user_id': event.user.userId
    }),
    async () => {
      await event.channel.postEphemeral(event.user, text, { fallbackToDM: false })
    }
  )
}

async function createLinearFeedbackIssue(
  event: SlashCommandEvent,
  text: string
): Promise<{ identifier: string; url: string }> {
  const raw = recordValue(event.raw)
  const channelName = stringField(raw.channel_name)
  const channelId = stringField(raw.channel_id)
  const title = firstLineTitle(text)
  const description = [
    text,
    '',
    `Slack channel: ${channelName ? `#${channelName}` : channelId}`,
    `Submitted by: <@${event.user.userId}>`
  ].join('\n')

  const response = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      Authorization: config.LINEAR_API_KEY ?? '',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      query: `
        mutation IssueCreate($input: IssueCreateInput!) {
          issueCreate(input: $input) {
            success
            issue { identifier url }
          }
        }
      `,
      variables: {
        input: {
          title,
          description,
          teamId: config.SLACK_FEEDBACK_LINEAR_TEAM_ID,
          projectId: config.SLACK_FEEDBACK_LINEAR_PROJECT_ID
        }
      }
    })
  })

  if (!response.ok) throw new Error(`Linear API returned ${response.status}`)
  const body = (await response.json()) as {
    errors?: { message?: string }[]
    data?: { issueCreate?: { issue?: { identifier?: string; url?: string } } }
  }
  if (body.errors?.length) throw new Error(body.errors[0]?.message ?? 'Linear API error')
  const issue = body.data?.issueCreate?.issue
  if (!issue?.identifier || !issue.url) throw new Error('Linear issueCreate returned no issue')
  return { identifier: issue.identifier, url: issue.url }
}

function slackIgnoreReason(
  message: Message,
  raw: Record<string, unknown>
): 'external_org_not_allowlisted' | 'bot_not_allowlisted' | null {
  const externalTeamId = externalSlackTeamId(raw)
  if (
    externalTeamId &&
    config.SLACKBOT_EXTERNAL_ORG_ALLOWLIST.length &&
    !config.SLACKBOT_EXTERNAL_ORG_ALLOWLIST.includes(externalTeamId)
  ) {
    return 'external_org_not_allowlisted'
  }

  if (isBotAuthoredMessage(message, raw) && !isAllowedTriggerBotMessage(raw)) {
    return 'bot_not_allowlisted'
  }

  return null
}

function externalSlackTeamId(raw: Record<string, unknown>): string | undefined {
  const homeTeamId = slackTeamId(raw)
  if (!homeTeamId) return undefined
  for (const candidate of [raw.user_team, raw.source_team, raw.team]) {
    if (typeof candidate === 'string' && candidate && candidate !== homeTeamId) {
      return candidate
    }
  }
  return undefined
}

function isBotAuthoredMessage(message: Message, raw: Record<string, unknown>): boolean {
  return Boolean(
    message.author.isBot ||
    raw.bot_id ||
    raw.bot_profile ||
    stringField(raw.subtype) === 'bot_message'
  )
}

function isAllowedTriggerBotMessage(raw: Record<string, unknown>): boolean {
  if (!config.SLACKBOT_TRIGGER_BOT_ALLOWLIST.length) return false
  const botProfile = recordValue(raw.bot_profile)
  const appIds = normalizedIdentifierSet(raw.app_id, botProfile.app_id)
  const botIds = normalizedIdentifierSet(raw.bot_id, botProfile.id)
  const botUserIds = normalizedIdentifierSet(raw.user, botProfile.user_id)
  const anyIds = new Set([...appIds, ...botIds, ...botUserIds])

  for (const entry of config.SLACKBOT_TRIGGER_BOT_ALLOWLIST) {
    const parsed = parseTriggerBotAllowlistEntry(entry)
    if (!parsed) continue
    if (parsed.kind === 'app' && appIds.has(parsed.value)) return true
    if (parsed.kind === 'bot' && botIds.has(parsed.value)) return true
    if (parsed.kind === 'user' && botUserIds.has(parsed.value)) return true
    if (parsed.kind === 'any' && anyIds.has(parsed.value)) return true
  }
  return false
}

function parseTriggerBotAllowlistEntry(
  entry: string
): { kind: 'app' | 'bot' | 'user' | 'any'; value: string } | null {
  const trimmed = entry.trim()
  if (!trimmed) return null
  const prefixed = /^(app|bot|user):(.+)$/i.exec(trimmed)
  if (!prefixed) return { kind: 'any', value: trimmed }
  const kind = prefixed[1]
  const value = prefixed[2]?.trim()
  if (!kind || !value) return null
  return { kind: kind.toLowerCase() as 'app' | 'bot' | 'user', value }
}

function normalizedIdentifierSet(...values: unknown[]): Set<string> {
  return new Set(
    values.map(value => (typeof value === 'string' ? value.trim() : '')).filter(Boolean)
  )
}

function firstLineTitle(text: string): string {
  const line = text.split(/\r?\n/, 1)[0]?.trim() || 'Slack feedback'
  return line.length <= 120 ? line : `${line.slice(0, 117)}...`
}

function slackRaw(message: Message): Record<string, unknown> {
  return recordValue(message.raw)
}

function slackTeamId(raw: Record<string, unknown>): string | undefined {
  return stringField(raw.team_id) ?? stringField(raw.team)
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function runInBackground(c: Context, promise: Promise<unknown>): void {
  const guarded = promise.catch((error: unknown) => {
    logError('slack_event_processing_failed', error)
  })
  const executionCtx = getExecutionContext(c)
  if (executionCtx) {
    executionCtx.waitUntil(guarded)
    return
  }
  void guarded
}

function getExecutionContext(c: Context): WaitUntilContext | null {
  try {
    return c.executionCtx
  } catch {
    return null
  }
}
