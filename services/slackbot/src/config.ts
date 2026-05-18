import { z } from 'zod'

const EnvSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_SIGNING_SECRET: z.string().optional(),
  SLACKBOT_API_KEY: z.string().optional(),
  CENTAUR_API_URL: z.string().url().default('http://localhost:8000'),
  CENTAUR_API_KEY: z.string().optional(),
  CENTAUR_SLACK_EVENTS_PATH: z.string().default('/api/webhooks/slack'),
  SLACK_EVENT_DEDUP_TTL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 60 * 1000),
  SLACK_SIGNATURE_MAX_AGE_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 5),
  SLACKBOT_EXTERNAL_ORG_ALLOWLIST: z
    .string()
    .default('')
    .transform(value =>
      value
        .split(/[\s,]+/)
        .map(part => part.trim())
        .filter(Boolean)
    )
})

export type AppConfig = z.infer<typeof EnvSchema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return EnvSchema.parse(env)
}

export function centaurApiKey(config: AppConfig): string | undefined {
  return config.SLACKBOT_API_KEY || config.CENTAUR_API_KEY || undefined
}
