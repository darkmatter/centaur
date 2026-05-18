import { describe, expect, it } from 'bun:test'
import { authorizeSlackOrg } from './authorization'

describe('authorizeSlackOrg', () => {
  it('allows events from the installed workspace', () => {
    expect(
      authorizeSlackOrg({
        envelope: {
          type: 'event_callback',
          team_id: 'THOME',
          event: { type: 'app_mention', team: 'THOME', user_team: 'THOME' }
        },
        allowedExternalTeamIds: []
      })
    ).toEqual({ ok: true })
  })

  it('blocks external Slack Connect teams by default', () => {
    expect(
      authorizeSlackOrg({
        envelope: {
          type: 'event_callback',
          team_id: 'THOME',
          event: { type: 'app_mention', team: 'THOME', user_team: 'TEXTERNAL' }
        },
        allowedExternalTeamIds: []
      })
    ).toEqual({
      ok: false,
      externalTeamId: 'TEXTERNAL',
      reason: 'external_org_not_allowlisted'
    })
  })

  it('allows explicitly allowlisted external teams', () => {
    expect(
      authorizeSlackOrg({
        envelope: {
          type: 'event_callback',
          team_id: 'THOME',
          event: { type: 'app_mention', team: 'THOME', user_team: 'TEXTERNAL' }
        },
        allowedExternalTeamIds: ['TEXTERNAL']
      })
    ).toEqual({ ok: true, externalTeamId: 'TEXTERNAL' })
  })

  it('falls back to source_team when user_team is absent', () => {
    expect(
      authorizeSlackOrg({
        envelope: {
          type: 'event_callback',
          team_id: 'THOME',
          event: { type: 'app_mention', team: 'THOME', source_team: 'TSOURCE' }
        },
        allowedExternalTeamIds: []
      })
    ).toMatchObject({ ok: false, externalTeamId: 'TSOURCE' })
  })
})
