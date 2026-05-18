import type { SlackEnvelope } from './types'

type SlackEventWithTeam = {
  team?: unknown
  user_team?: unknown
  source_team?: unknown
}

export type SlackOrgAuthorizationDecision = {
  ok: boolean
  externalTeamId?: string
  reason?: 'external_org_not_allowlisted'
}

export function authorizeSlackOrg(opts: {
  envelope: SlackEnvelope
  allowedExternalTeamIds: readonly string[]
}): SlackOrgAuthorizationDecision {
  const externalTeamId = externalSlackTeamId(opts.envelope)
  if (!externalTeamId) return { ok: true }

  const allowed = new Set(opts.allowedExternalTeamIds)
  if (allowed.has(externalTeamId)) return { ok: true, externalTeamId }

  return {
    ok: false,
    externalTeamId,
    reason: 'external_org_not_allowlisted'
  }
}

function externalSlackTeamId(envelope: SlackEnvelope): string | undefined {
  const homeTeamId = envelope.team_id
  if (!homeTeamId || !isRecord(envelope.event)) return undefined

  const event = envelope.event as SlackEventWithTeam
  const candidates = [event.user_team, event.source_team, event.team]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate && candidate !== homeTeamId) {
      return candidate
    }
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
