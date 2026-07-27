import { describe, expect, test } from 'bun:test'
import { exportLinkForThread, isSlackExportCommand } from '../src/export-command'
import { handleExportCommand } from '../src/index'


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
    expect(exportLinkForThread('https://omp-viewer.example.ts.net/', 'slack:C123:1721400000.000100')).toBe(
      'https://omp-viewer.example.ts.net/export/slack%3AC123%3A1721400000.000100'
    )
  })

  test('leaves a slashless base untouched', () => {
    expect(exportLinkForThread('https://omp-viewer.example.ts.net', 'T1')).toBe(
      'https://omp-viewer.example.ts.net/export/T1'
    )
  })
})

describe('viewer handoff', () => {
  test('posts the direct viewer link without starting an agent turn', async () => {
    const posted: string[] = []
    const statuses: string[] = []
    const thread = {
      id: 'slack:C123:1721400000.000100',
      adapter: {
        setAssistantStatus: async (_channel: string, _threadTs: string, status: string) => {
          statuses.push(status)
        }
      },
      post: async (text: string) => {
        posted.push(text)
      }
    } as never
    const handled = await handleExportCommand(
      thread,
      { text: 'please export this thread' } as never,
      { ompViewerUrl: 'https://omp-viewer.example.ts.net/' } as never,
      'test'
    )
    expect(handled).toBe(true)
    expect(statuses).toEqual([''])
    expect(posted).toEqual([
      'Transcript export: https://omp-viewer.example.ts.net/export/slack%3AC123%3A1721400000.000100'
    ])
  })

  test('falls through when the viewer URL is unset', async () => {
    const posted: string[] = []
    const thread = {
      id: 'slack:C1:1',
      post: async (text: string) => {
        posted.push(text)
      }
    } as never
    const handled = await handleExportCommand(
      thread,
      { text: 'export' } as never,
      {} as never,
      'test'
    )
    expect(handled).toBe(false)
    expect(posted).toEqual([])
  })
})
