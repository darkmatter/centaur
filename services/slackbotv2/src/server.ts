import { createSlackbotV2 } from './index'
import { buildSlackbotV2Options } from './options'

const port = numberEnv('PORT', 3002)

// Default to info: the chat adapter logs entire raw Slack webhook bodies at
// debug, and JSON-serializing those multi-hundred-KB payloads on the hot path
// blocks the event loop long enough to fail the 1s liveness probe.
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const
const minLogLevel: (typeof LOG_LEVELS)[number] = (() => {
  const value = optionalEnv('SLACKBOTV2_LOG_LEVEL')?.toLowerCase()
  return (LOG_LEVELS as readonly string[]).includes(value ?? '')
    ? (value as (typeof LOG_LEVELS)[number])
    : 'info'
})()

const consoleLogger = {
  debug: (message: string, data?: unknown) => log('debug', message, data),
  info: (message: string, data?: unknown) => log('info', message, data),
  warn: (message: string, data?: unknown) => log('warn', message, data),
  error: (message: string, data?: unknown) => log('error', message, data),
  child: () => consoleLogger
}

const options = buildSlackbotV2Options(process.env, consoleLogger)

const { app } = createSlackbotV2(options)
const server = Bun.serve({
  port,
  fetch: app.fetch
})

console.log(
  JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'info',
    event: 'slackbotv2_started',
    service: 'slackbotv2',
    activity_summary_status_enabled: options.activitySummaryStatusEnabled,
    port: server.port,
    api_url: options.apiUrl
  })
)

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value ? value : undefined
}

function numberEnv(name: string, fallback: number): number {
  const value = optionalEnv(name)
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

function log(level: (typeof LOG_LEVELS)[number], message: string, data?: unknown): void {
  if (LOG_LEVELS.indexOf(level) < LOG_LEVELS.indexOf(minLogLevel)) return
  console.log(
    JSON.stringify({
      level,
      service: 'slackbotv2',
      timestamp: new Date().toISOString(),
      event: message,
      ...(data && typeof data === 'object' ? (data as Record<string, unknown>) : {})
    })
  )
}
