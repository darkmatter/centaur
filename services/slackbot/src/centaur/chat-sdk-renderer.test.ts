import { describe, expect, it } from 'bun:test'
import type { ChatStreamChunk } from '@centaur/api-client'
import { streamWithTerminalFallback } from './chat-sdk-renderer'

describe('Chat SDK renderer stream fallback', () => {
  it('preserves API chunks when the stream has content', async () => {
    const chunks: ChatStreamChunk[] = [
      { type: 'markdown_text', text: '_base · codex_\n\n' },
      { type: 'markdown_text', text: 'PONG' }
    ]

    const prepared = await streamWithTerminalFallback(
      asyncIterable(chunks),
      async () => {
        throw new Error('fallback should not be read')
      }
    )

    expect(prepared.source).toBe('api')
    expect(await collect(prepared.stream)).toEqual(chunks)
  })

  it('falls back to terminal result text when the API stream is empty', async () => {
    const prepared = await streamWithTerminalFallback(
      asyncIterable([]),
      async () => ({ result_text: 'final answer' })
    )

    expect(prepared.source).toBe('terminal_fallback')
    expect(await collect(prepared.stream)).toEqual([
      { type: 'markdown_text', text: 'final answer' }
    ])
  })
})

async function* asyncIterable<T>(items: T[]): AsyncGenerator<T, void, undefined> {
  for (const item of items) yield item
}

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of items) out.push(item)
  return out
}
