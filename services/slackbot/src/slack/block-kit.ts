import type { AnyBlock, AnyChunk, BlocksChunk } from '@slack/types'
import { slackReplyLimits } from '../constants'

export type SlackBlock = AnyBlock
export type SlackBlocksChunk = BlocksChunk
export type SlackStreamChunk = AnyChunk | SlackBlocksChunk
export type SlackTaskDisplayMode = 'timeline' | 'plan' | 'dense'

const MAX_BLOCKS = slackReplyLimits.message.maxBlocks
const MAX_MARKDOWN_CHARS = slackReplyLimits.stream.markdownChunkChars

// These mirror Slack's published Block Kit limits. Keep the values explicit
// near the validator because this module guards JSON supplied to internal
// Slackbot endpoints before it reaches Slack as chat.postMessage/chat.update
// or chat.*Stream payloads.
//
// Reference:
// - Section block: https://docs.slack.dev/reference/block-kit/blocks/section-block/
// - Context block: https://docs.slack.dev/reference/block-kit/blocks/context-block/
// - Markdown block: https://docs.slack.dev/reference/block-kit/blocks/markdown-block/
// - Common block_id fields are capped at 255 chars across Block Kit blocks.
const MAX_SECTION_TEXT_CHARS = 3_000
const MAX_SECTION_FIELD_CHARS = 2_000
const MAX_TEXT_OBJECT_CHARS = 3_000
const MAX_BLOCK_ID_CHARS = 255
const MAX_CONTEXT_ELEMENTS = 10
const MAX_SECTION_FIELDS = 10
const TASK_STATUSES = new Set(['pending', 'in_progress', 'complete', 'error'])

export class BlockKitValidationError extends Error {
  readonly code: 'invalid_blocks' | 'invalid_chunks'

  constructor(code: 'invalid_blocks' | 'invalid_chunks', message: string) {
    super(message)
    this.name = 'BlockKitValidationError'
    this.code = code
  }
}

export function parseSlackBlocks(value: unknown, field = 'blocks'): SlackBlock[] {
  if (!Array.isArray(value)) {
    throw new BlockKitValidationError('invalid_blocks', `${field} must be an array`)
  }
  if (value.length > MAX_BLOCKS) {
    throw new BlockKitValidationError(
      'invalid_blocks',
      `${field} must contain ${MAX_BLOCKS} blocks or fewer`
    )
  }

  let markdownChars = 0
  for (const [index, block] of value.entries()) {
    assertPlainObject(block, `${field}[${index}]`, 'invalid_blocks')
    const type = assertString(block.type, `${field}[${index}].type`, 'invalid_blocks')
    assertBlockId(block, `${field}[${index}]`)
    if (type === 'markdown') {
      const text = assertString(block.text, `${field}[${index}].text`, 'invalid_blocks')
      assertNonEmpty(text, `${field}[${index}].text`, 'invalid_blocks')
      markdownChars += text.length
      continue
    }
    validateKnownBlock(block, type, `${field}[${index}]`)
  }
  if (markdownChars > MAX_MARKDOWN_CHARS) {
    throw new BlockKitValidationError(
      'invalid_blocks',
      `${field} markdown blocks exceed the ${MAX_MARKDOWN_CHARS} character cumulative limit`
    )
  }
  return value as SlackBlock[]
}

export function parseOptionalSlackBlocks(
  value: unknown,
  field = 'blocks'
): SlackBlock[] | undefined {
  if (value === undefined || value === null) return undefined
  return parseSlackBlocks(value, field)
}

export function parseSlackStreamChunks(value: unknown, field = 'chunks'): SlackStreamChunk[] {
  if (!Array.isArray(value)) {
    throw new BlockKitValidationError('invalid_chunks', `${field} must be an array`)
  }
  return value.map((chunk, index) => {
    assertPlainObject(chunk, `${field}[${index}]`, 'invalid_chunks')
    const type = assertString(chunk.type, `${field}[${index}].type`, 'invalid_chunks')
    if (type === 'markdown_text') {
      const text = assertString(chunk.text, `${field}[${index}].text`, 'invalid_chunks')
      assertNonEmpty(text, `${field}[${index}].text`, 'invalid_chunks')
      assertMaxChars(text, MAX_MARKDOWN_CHARS, `${field}[${index}].text`, 'invalid_chunks')
    } else if (type === 'plan_update') {
      assertNonEmpty(
        assertString(chunk.title, `${field}[${index}].title`, 'invalid_chunks'),
        `${field}[${index}].title`,
        'invalid_chunks'
      )
    } else if (type === 'task_update') {
      assertNonEmpty(
        assertString(chunk.id, `${field}[${index}].id`, 'invalid_chunks'),
        `${field}[${index}].id`,
        'invalid_chunks'
      )
      assertNonEmpty(
        assertString(chunk.title, `${field}[${index}].title`, 'invalid_chunks'),
        `${field}[${index}].title`,
        'invalid_chunks'
      )
      validateTaskStatus(chunk.status, `${field}[${index}].status`, 'invalid_chunks')
      assertOptionalString(chunk.details, `${field}[${index}].details`, 'invalid_chunks')
      assertOptionalString(chunk.output, `${field}[${index}].output`, 'invalid_chunks')
    } else if (type === 'blocks') {
      parseSlackBlocks(chunk.blocks, `${field}[${index}].blocks`)
    } else {
      throw new BlockKitValidationError(
        'invalid_chunks',
        `${field}[${index}].type must be markdown_text, plan_update, task_update, or blocks`
      )
    }
    return chunk as unknown as SlackStreamChunk
  })
}

export function parseOptionalSlackStreamChunks(
  value: unknown,
  field = 'chunks'
): SlackStreamChunk[] | undefined {
  if (value === undefined || value === null) return undefined
  return parseSlackStreamChunks(value, field)
}

export function blocksChunk(blocks: SlackBlock[]): SlackBlocksChunk {
  return { type: 'blocks', blocks: parseSlackBlocks(blocks) }
}

export function slackStreamChunksForApi(chunks: SlackStreamChunk[]): AnyChunk[] {
  // Slack documents blocks chunks for chat.*Stream, but @slack/types still omits them
  // from AnyChunk, so the SDK call boundary needs this validated cast.
  return chunks as AnyChunk[]
}

function validateKnownBlock(block: Record<string, unknown>, type: string, path: string): void {
  if (type === 'section') {
    const hasText = block.text !== undefined
    const hasFields = block.fields !== undefined
    if (!hasText && !hasFields) {
      throw new BlockKitValidationError('invalid_blocks', `${path} must include text or fields`)
    }
    if (hasText) {
      validateTextObject(block.text, `${path}.text`, MAX_SECTION_TEXT_CHARS)
    }
    if (hasFields) {
      validateTextObjectArray(
        block.fields,
        `${path}.fields`,
        MAX_SECTION_FIELDS,
        MAX_SECTION_FIELD_CHARS
      )
    }
    assertOptionalBoolean(block.expand, `${path}.expand`, 'invalid_blocks')
  } else if (type === 'context') {
    assertArray(block.elements, `${path}.elements`, 'invalid_blocks')
    if (!block.elements.length || block.elements.length > MAX_CONTEXT_ELEMENTS) {
      throw new BlockKitValidationError(
        'invalid_blocks',
        `${path}.elements must contain 1 to ${MAX_CONTEXT_ELEMENTS} items`
      )
    }
    for (const [index, element] of block.elements.entries()) {
      validateContextElement(element, `${path}.elements[${index}]`)
    }
  } else if (type === 'rich_text') {
    assertArray(block.elements, `${path}.elements`, 'invalid_blocks')
  } else if (type === 'plan') {
    assertNonEmpty(
      assertString(block.title, `${path}.title`, 'invalid_blocks'),
      `${path}.title`,
      'invalid_blocks'
    )
    if (block.tasks !== undefined) {
      assertArray(block.tasks, `${path}.tasks`, 'invalid_blocks')
      for (const [index, task] of block.tasks.entries()) {
        validateTaskCard(task, `${path}.tasks[${index}]`, { nested: true })
      }
    }
  } else if (type === 'task_card') {
    validateTaskCard(block, path, { nested: false })
  } else if (type === 'header') {
    validateTextObject(block.text, `${path}.text`, 150, { plainTextOnly: true })
  } else if (type === 'divider') {
    return
  }
}

function validateTaskCard(value: unknown, path: string, opts: { nested: boolean }): void {
  assertPlainObject(value, path, 'invalid_blocks')
  if (!opts.nested) {
    const type = assertString(value.type, `${path}.type`, 'invalid_blocks')
    if (type !== 'task_card') {
      throw new BlockKitValidationError('invalid_blocks', `${path}.type must be task_card`)
    }
  }
  assertNonEmpty(
    assertString(value.task_id, `${path}.task_id`, 'invalid_blocks'),
    `${path}.task_id`,
    'invalid_blocks'
  )
  assertNonEmpty(
    assertString(value.title, `${path}.title`, 'invalid_blocks'),
    `${path}.title`,
    'invalid_blocks'
  )
  if (value.status !== undefined) {
    validateTaskStatus(value.status, `${path}.status`, 'invalid_blocks')
  }
  if (value.details !== undefined) {
    validateRichTextBlock(value.details, `${path}.details`)
  }
  if (value.output !== undefined) {
    validateRichTextBlock(value.output, `${path}.output`)
  }
  if (value.sources !== undefined) {
    assertArray(value.sources, `${path}.sources`, 'invalid_blocks')
  }
}

function validateRichTextBlock(value: unknown, path: string): void {
  assertPlainObject(value, path, 'invalid_blocks')
  const type = assertString(value.type, `${path}.type`, 'invalid_blocks')
  if (type !== 'rich_text') {
    throw new BlockKitValidationError('invalid_blocks', `${path}.type must be rich_text`)
  }
  assertArray(value.elements, `${path}.elements`, 'invalid_blocks')
}

function validateContextElement(value: unknown, path: string): void {
  assertPlainObject(value, path, 'invalid_blocks')
  const type = assertString(value.type, `${path}.type`, 'invalid_blocks')
  if (type === 'image') {
    assertNonEmpty(
      assertString(value.image_url, `${path}.image_url`, 'invalid_blocks'),
      `${path}.image_url`,
      'invalid_blocks'
    )
    assertNonEmpty(
      assertString(value.alt_text, `${path}.alt_text`, 'invalid_blocks'),
      `${path}.alt_text`,
      'invalid_blocks'
    )
    return
  }
  validateTextObject(value, path, MAX_TEXT_OBJECT_CHARS)
}

function validateTextObject(
  value: unknown,
  path: string,
  maxChars = MAX_TEXT_OBJECT_CHARS,
  opts: { plainTextOnly?: boolean } = {}
): void {
  assertPlainObject(value, path, 'invalid_blocks')
  const type = assertString(value.type, `${path}.type`, 'invalid_blocks')
  if (opts.plainTextOnly && type !== 'plain_text') {
    throw new BlockKitValidationError('invalid_blocks', `${path}.type must be plain_text`)
  }
  if (type !== 'plain_text' && type !== 'mrkdwn') {
    throw new BlockKitValidationError('invalid_blocks', `${path}.type must be plain_text or mrkdwn`)
  }
  const text = assertString(value.text, `${path}.text`, 'invalid_blocks')
  assertNonEmpty(text, `${path}.text`, 'invalid_blocks')
  assertMaxChars(text, maxChars, `${path}.text`, 'invalid_blocks')
}

function validateTextObjectArray(
  value: unknown,
  path: string,
  maxItems: number,
  maxChars: number
): void {
  assertArray(value, path, 'invalid_blocks')
  if (!value.length || value.length > maxItems) {
    throw new BlockKitValidationError(
      'invalid_blocks',
      `${path} must contain 1 to ${maxItems} items`
    )
  }
  for (const [index, item] of value.entries()) {
    validateTextObject(item, `${path}[${index}]`, maxChars)
  }
}

function validateTaskStatus(
  value: unknown,
  path: string,
  code: BlockKitValidationError['code']
): void {
  const status = assertString(value, path, code)
  if (!TASK_STATUSES.has(status)) {
    throw new BlockKitValidationError(
      code,
      `${path} must be pending, in_progress, complete, or error`
    )
  }
}

function assertBlockId(block: Record<string, unknown>, path: string): void {
  if (block.block_id === undefined) return
  assertMaxChars(
    assertString(block.block_id, `${path}.block_id`, 'invalid_blocks'),
    MAX_BLOCK_ID_CHARS,
    `${path}.block_id`,
    'invalid_blocks'
  )
}

function assertPlainObject(
  value: unknown,
  path: string,
  code: BlockKitValidationError['code']
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BlockKitValidationError(code, `${path} must be an object`)
  }
}

function assertArray(
  value: unknown,
  path: string,
  code: BlockKitValidationError['code']
): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw new BlockKitValidationError(code, `${path} must be an array`)
  }
}

function assertString(value: unknown, path: string, code: BlockKitValidationError['code']): string {
  if (typeof value !== 'string') {
    throw new BlockKitValidationError(code, `${path} must be a string`)
  }
  return value
}

function assertOptionalString(
  value: unknown,
  path: string,
  code: BlockKitValidationError['code']
): void {
  if (value === undefined) return
  assertString(value, path, code)
}

function assertOptionalBoolean(
  value: unknown,
  path: string,
  code: BlockKitValidationError['code']
): void {
  if (value === undefined || typeof value === 'boolean') return
  throw new BlockKitValidationError(code, `${path} must be a boolean`)
}

function assertNonEmpty(value: string, path: string, code: BlockKitValidationError['code']): void {
  if (!value.length) {
    throw new BlockKitValidationError(code, `${path} must not be empty`)
  }
}

function assertMaxChars(
  value: string,
  maxChars: number,
  path: string,
  code: BlockKitValidationError['code']
): void {
  if (value.length > maxChars) {
    throw new BlockKitValidationError(code, `${path} must be ${maxChars} characters or fewer`)
  }
}
