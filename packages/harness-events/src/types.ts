export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: unknown; is_error: boolean }

export type SubagentActivity = {
  description: string
  toolName?: string
}

export type CanonicalEvent =
  | {
      type: 'assistant'
      message: {
        content: ContentBlock[]
        usage?: Record<string, unknown>
        model?: string
      }
    }
  | {
      type: 'tool'
      content: Array<{ tool_use_id: string; content: unknown; is_error: boolean }>
    }
  | { type: 'reasoning'; text: string }
  | {
      type: 'command_execution'
      command: string
      aggregated_output: string
      exit_code?: unknown
      status?: unknown
    }
  | { type: 'file_change'; changes: unknown[] }
  | {
      type: 'subagent'
      status: string
      subagent_id: string
      name?: string
      summary?: string
      error?: string
      activity?: string
      activities?: SubagentActivity[]
    }
  | { type: 'result'; text: string }
  | { type: 'error'; error: string }
  | { type: 'system'; subtype: string; session_id?: string }
  | {
      type: 'usage'
      usage: Record<string, unknown>
      model?: string
      authoritative?: boolean
    }
  | {
      type:
        | 'turn.plan.updated'
        | 'item.started'
        | 'item.updated'
        | 'item.completed'
        | 'item.agentMessage.delta'
        | 'item.plan.delta'
        | 'item.commandExecution.outputDelta'
        | 'item.fileChange.outputDelta'
        | 'item.fileChange.patchUpdated'
        | 'item.reasoning.summaryTextDelta'
        | 'item.reasoning.summaryPartAdded'
        | 'item.reasoning.textDelta'
      [key: string]: unknown
    }
