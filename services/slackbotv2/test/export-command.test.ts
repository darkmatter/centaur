import { describe, expect, test } from 'bun:test'
import { exportLinkForThread, isSlackExportCommand } from '../src/export-command'
import { buildSlackbotV2Options } from '../src/options'
import { handleExportCommand } from '../src/index'
import type { Logger } from 'chat'

// Minimal logger stub: the builder wires warnings through it; tests stay quiet.
const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger
}


describe('Slack export command detection', () => {
  test('matches export keyword and thread variants', () => {
    expect(isSlackExportCommand({ text: 'export' })).toBe(true)
    expect(isSlackExportCommand({ text: 'Export session!' })).toBe(true)
    expect(isSlackExportCommand({ text: 'please export this thread' })).toBe(true)
    expect(isSlackExportCommand({ text: 'pls export chat' })).toBe(true)
    expect(isSlackExportCommand({ text: 'export conversation.' })).toBe(true)
  })

  test('matches mention plus export keyword', () => {
    expect(isSlackExportCommand({ text: '<@UCENTAUR> export' })).toBe(true)
    expect(isSlackExportCommand({ text: '<@UCENTAUR> please export this thread' })).toBe(true)
  })

  test('matches Chat-SDK-normalized mentions plus export keyword', () => {
    // The Chat SDK rewrites <@U123|name> to @name and the bot's own <@U123>
    // to @U123 before handlers run, so live message.text carries these forms.
    expect(isSlackExportCommand({ text: '@centaur_ai export' })).toBe(true)
    expect(isSlackExportCommand({ text: '@U08TEST123 Export session!' })).toBe(true)
  })

  test('does not match export requests with other objects', () => {
    expect(isSlackExportCommand({ text: 'export my data to csv' })).toBe(false)
    expect(isSlackExportCommand({ text: 'please export the report' })).toBe(false)
    expect(isSlackExportCommand({ text: '<@UCENTAUR> export the dashboard' })).toBe(false)
    expect(isSlackExportCommand({ text: 'exported' })).toBe(false)
    expect(isSlackExportCommand({ text: 'can you export this thread later?' })).toBe(false)
    expect(isSlackExportCommand({ text: '' })).toBe(false)
  })
})

describe('export link construction', () => {
  test('percent-encodes the thread key and trims trailing slash', () => {
    expect(exportLinkForThread('https://console.example.test/', 'slack:C123:1721400000.000100')).toBe(
      'https://console.example.test/console/apps/omp-stats/export/slack%3AC123%3A1721400000.000100'
    )
  })

  test('leaves a slashless base untouched', () => {
    expect(exportLinkForThread('https://console.example.test', 'T1')).toBe(
      'https://console.example.test/console/apps/omp-stats/export/T1'
    )
  })
})

describe('env → options → handler contract', () => {
  // The chart (slackbotv2.yaml) supplies CENTAUR_CONSOLE_PUBLIC_URL and
  // buildSlackbotV2Options maps it verbatim onto options.consolePublicUrl.
  // handleExportCommand guards on that same field. This test exercises the
  // SAME mapping and handler production uses — a regression that re-introduces
  // a parallel env (e.g. CONSOLE_BASE_URL, which the chart never populates)
  // would fail here: the builder would not set consolePublicUrl from it, the
  // handler guard would fall through, and no link would be posted.
  const baseEnvs = {
    SLACK_BOT_TOKEN: 'xoxb-test',
    SLACK_SIGNING_SECRET: 'shss-test'
  }

  test('CENTAUR_CONSOLE_PUBLIC_URL flows through the real builder and handler to the posted link', async () => {
    const env = { ...baseEnvs, CENTAUR_CONSOLE_PUBLIC_URL: 'https://console.example.test/' }
    const options = buildSlackbotV2Options(env, silentLogger)
    expect(options.consolePublicUrl).toBe('https://console.example.test/')
    // handleExportCommand only reads message.text (via isSlackExportCommand)
    // and thread.id / thread.post; stub just those and cast to the SDK types.
    const posted: string[] = []
    const thread = { id: 'slack:C123:1721400000.000100', post: async (text: string) => { posted.push(text); return undefined } } as never
    const message = { text: 'please export this thread' } as never
    const handled = await handleExportCommand(thread, message, options, 'test')
    expect(handled).toBe(true)
    expect(posted).toHaveLength(1)
    expect(posted[0]).toBe(
      'Transcript export: https://console.example.test/console/apps/omp-stats/export/slack%3AC123%3A1721400000.000100'
    )
  })

  test('falls through (returns false, posts nothing) when CENTAUR_CONSOLE_PUBLIC_URL is unset', async () => {
    const options = buildSlackbotV2Options(baseEnvs, silentLogger)
    expect(options.consolePublicUrl).toBeUndefined()
    const posted: string[] = []
    const thread = { id: 'slack:C1:1', post: async (text: string) => { posted.push(text); return undefined } } as never
    const message = { text: 'export' } as never
    const handled = await handleExportCommand(thread, message, options, 'test')
    expect(handled).toBe(false)
    expect(posted).toHaveLength(0)
  })

  test('a parallel CONSOLE_BASE_URL env does NOT populate consolePublicUrl (regression guard)', () => {
    const env = { ...baseEnvs, CONSOLE_BASE_URL: 'https://evil.example.test/' }
    const options = buildSlackbotV2Options(env, silentLogger)
    expect(options.consolePublicUrl).toBeUndefined()
  })
})
