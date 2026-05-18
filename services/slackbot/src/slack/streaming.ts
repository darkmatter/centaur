import type { AnyChunk, RichTextBlock } from '@slack/types'

export type StreamTaskStatus = 'pending' | 'in_progress' | 'complete' | 'error'

export type StreamText = {
  type: 'text'
  text: string
  style?: { bold?: boolean; italic?: boolean; strike?: boolean; code?: boolean }
}

export type StreamLink = {
  type: 'link'
  url: string
  text?: string
}

export type StreamUser = {
  type: 'user'
  user_id: string
}

export type StreamInline = StreamText | StreamLink | StreamUser

export type StreamRichTextElement =
  | { type: 'rich_text_section'; elements: StreamInline[] }
  | { type: 'rich_text_preformatted'; elements: StreamText[]; language?: string; border?: 0 | 1 }
  | { type: 'rich_text_quote'; elements: StreamInline[] }

export type StreamRichText = RichTextBlock & {
  elements: StreamRichTextElement[]
}

export type StreamTask = {
  id: string
  title: string
  status: StreamTaskStatus
  details?: StreamRichText | string
  output?: StreamRichText | string
  sources?: Array<{ type: 'url'; text: string; url: string }>
}

export type StreamChunk = AnyChunk

const MAX_TASK_FIELD_CHARS = 12_000
const MAX_PLAN_TITLE_CHARS = 256

export function planUpdateChunk(title: string): StreamChunk {
  return { type: 'plan_update', title: clip(title, MAX_PLAN_TITLE_CHARS) }
}

export function markdownChunk(text: string): StreamChunk {
  return { type: 'markdown_text', text: text || ' ' }
}

export function taskUpdateChunk(task: StreamTask): StreamChunk {
  return {
    type: 'task_update',
    id: task.id,
    title: clip(task.title, MAX_PLAN_TITLE_CHARS),
    status: task.status,
    details: taskBodyToPlain(task.details),
    output: taskBodyToPlain(task.output),
    sources: task.sources
  }
}

export function planBlock(title: string, tasks: StreamTask[], blockId?: string): object {
  return {
    type: 'plan',
    title,
    ...(blockId ? { block_id: blockId } : {}),
    tasks: tasks.map(task => ({
      task_id: task.id,
      title: task.title,
      status: task.status,
      ...(task.details
        ? { details: typeof task.details === 'string' ? plainRichText(task.details) : task.details }
        : {}),
      ...(task.output
        ? { output: typeof task.output === 'string' ? plainRichText(task.output) : task.output }
        : {}),
      ...(task.sources ? { sources: task.sources } : {})
    }))
  }
}

export function plainRichText(value: string, blockId?: string): StreamRichText {
  return richText([section([text(value)])], blockId)
}

export function richText(elements: StreamRichTextElement[], blockId?: string): StreamRichText {
  return {
    type: 'rich_text',
    ...(blockId ? { block_id: blockId } : {}),
    elements
  }
}

export function section(elements: StreamInline[]): StreamRichTextElement {
  return { type: 'rich_text_section', elements }
}

export function preformatted(text: string, language?: string): StreamRichTextElement {
  return {
    type: 'rich_text_preformatted',
    ...(language ? { language } : {}),
    elements: [{ type: 'text', text: clip(text, MAX_TASK_FIELD_CHARS) }]
  }
}

export function text(text: string, style?: StreamText['style']): StreamText {
  return { type: 'text', text, ...(style ? { style } : {}) }
}

export function link(url: string, label?: string): StreamLink {
  return { type: 'link', url, ...(label ? { text: label } : {}) }
}

export function markdownToRichText(markdown: string, blockId?: string): StreamRichText {
  return richText(markdownRichElements(markdown), blockId)
}

export function markdownRichElements(markdown: string): StreamRichTextElement[] {
  const elements: StreamRichTextElement[] = []
  const pattern = /```([a-zA-Z0-9_-]+)?\n?([\s\S]*?)```/g
  let index = 0
  for (const match of markdown.matchAll(pattern)) {
    elements.push(...paragraphSections(markdown.slice(index, match.index)))
    elements.push(preformatted(match[2]?.trim() ?? '', match[1] || undefined))
    index = match.index + match[0].length
  }
  elements.push(...paragraphSections(markdown.slice(index)))
  return elements.length ? elements : [section([text(markdown)])]
}

function paragraphSections(value: string): StreamRichTextElement[] {
  return value
    .split(/\n{2,}/)
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => section(parseInlineMarkdown(part)))
}

function parseInlineMarkdown(value: string): StreamInline[] {
  const out: StreamInline[] = []
  const pattern = /(`([^`]+)`)|\[([^\]]+)\]\(([^)]+)\)|(\*\*([^*]+)\*\*)|<@(U[A-Z0-9]+)>/g
  let index = 0
  for (const match of value.matchAll(pattern)) {
    if (match.index !== undefined && match.index > index)
      out.push(text(value.slice(index, match.index)))
    if (match[2]) out.push(text(match[2], { code: true }))
    else if (match[3] && match[4]) out.push(link(match[4], match[3]))
    else if (match[6]) out.push(text(match[6], { bold: true }))
    else if (match[7]) out.push({ type: 'user', user_id: match[7] })
    index = (match.index ?? 0) + match[0].length
  }
  if (index < value.length) out.push(text(value.slice(index)))
  return out.length ? out : [text(value)]
}

function taskBodyToPlain(body: StreamRichText | string | undefined): string | undefined {
  if (!body) return undefined
  if (typeof body === 'string') return clip(body, MAX_TASK_FIELD_CHARS)
  return clip(
    body.elements
      .map(element =>
        element.elements
          .map(inline =>
            'text' in inline ? inline.text : 'user_id' in inline ? `<@${inline.user_id}>` : ''
          )
          .join('')
      )
      .filter(Boolean)
      .join('\n'),
    MAX_TASK_FIELD_CHARS
  )
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}
