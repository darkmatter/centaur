import { parseChannelDefaults } from './channel-defaults'
import type { Logger } from 'chat'
import type { SlackbotV2Options } from './types'

/**
 * Pure env → {@link SlackbotV2Options} builder. Keeping this out of `server.ts`
 * (which reads `process.env` at module load as a side effect) makes the env
 * mapping testable: the chart only ever sets `CENTAUR_CONSOLE_PUBLIC_URL`, and
 * every user-facing link (the "Open chat in Console" context block AND the
 * "export this thread" reply) must read that same env through `options.consolePublicUrl`.
 *
 * `env` defaults to `process.env` so the runtime entry stays one call; tests
 * pass an explicit record. `logger` is required so the builder never reaches
 * for a console at import time.
 */
export function buildSlackbotV2Options(
  env: Record<string, string | undefined>,
  logger: Logger
): SlackbotV2Options {
  const optional = (name: string): string | undefined => {
    const value = env[name]?.trim()
    return value ? value : undefined
  }
  const required = (name: string): string => {
    const value = optional(name)
    if (!value) throw new Error(`${name} is required`)
    return value
  }
  const stringEnv = (name: string, fallback: string): string => optional(name) ?? fallback
  const booleanEnv = (name: string, fallback: boolean): boolean => {
    const value = optional(name)
    if (!value) return fallback
    if (['1', 'true', 'yes', 'on'].includes(value.toLowerCase())) return true
    if (['0', 'false', 'no', 'off'].includes(value.toLowerCase())) return false
    throw new Error(`${name} must be a boolean`)
  }
  const optionalNumberEnv = (name: string): number | undefined => {
    const value = optional(name)
    if (!value) return undefined
    const parsed = Number.parseInt(value, 10)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`${name} must be a positive integer`)
    }
    return parsed
  }

  return {
    apiUrl: stringEnv('CENTAUR_API_URL', 'http://127.0.0.1:8080'),
    apiKey: optional('SLACKBOT_API_KEY'),
    assistantStatus: optional('SLACKBOTV2_ASSISTANT_STATUS'),
    activitySummaryStatusEnabled: booleanEnv('SLACKBOTV2_ACTIVITY_SUMMARY_STATUS_ENABLED', false),
    botToken: required('SLACK_BOT_TOKEN'),
    botUserId: optional('SLACK_BOT_USER_ID'),
    channelDefaults: parseChannelDefaults(optional('SLACKBOTV2_CHANNEL_DEFAULTS'), reason =>
      logger.warn('slackbotv2 SLACKBOTV2_CHANNEL_DEFAULTS', { reason })
    ),
    consolePublicUrl: optional('CENTAUR_CONSOLE_PUBLIC_URL'),
    defaultHarnessType: optional('SLACKBOTV2_DEFAULT_HARNESS'),
    // Same env vars deployers use to override the sandbox harness model
    // (sandbox.extraEnv); the chart mirrors them here so displayed defaults
    // track the deployment instead of the baked harness config.
    harnessDefaultModels: {
      ...(optional('CLAUDE_MODEL') ? { claudecode: optional('CLAUDE_MODEL')! } : {}),
      ...(optional('CODEX_MODEL') ? { codex: optional('CODEX_MODEL')! } : {})
    },
    idleTimeoutMs: optionalNumberEnv('SESSION_IDLE_TIMEOUT_MS'),
    maxDurationMs: optionalNumberEnv('SESSION_MAX_DURATION_MS'),
    postgresUrl:
      optional('SLACKBOTV2_DATABASE_URL') ??
      optional('DATABASE_URL') ??
      optional('POSTGRES_URL'),
    renderRecoveryMaxObligationAgeMs: optionalNumberEnv(
      'SLACKBOTV2_RENDER_RECOVERY_MAX_OBLIGATION_AGE_MS'
    ),
    sessionApiTimeoutMs: optionalNumberEnv('SLACKBOTV2_SESSION_API_TIMEOUT_MS'),
    signingSecret: required('SLACK_SIGNING_SECRET'),
    slackApiUrl: optional('SLACK_API_URL'),
    slackApiTimeoutMs: optionalNumberEnv('SLACKBOTV2_SLACK_API_TIMEOUT_MS'),
    stateKeyPrefix: optional('SLACKBOTV2_STATE_KEY_PREFIX'),
    userName: stringEnv('SLACKBOTV2_USER_NAME', 'centaur'),
    logger
  }
}
