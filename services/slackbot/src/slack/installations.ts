import { WebClient } from '@slack/web-api'

export type SlackInstallation = {
  teamId?: string
  enterpriseId?: string
  botToken: string
  botUserId?: string
}

export type SlackInstallationKey = {
  teamId?: string
  enterpriseId?: string
}

export interface SlackInstallationStore {
  findInstallation(key: SlackInstallationKey): Promise<SlackInstallation | null>
}

export class EnvSlackInstallationStore implements SlackInstallationStore {
  readonly token?: string
  private botUserId?: string

  constructor(opts: { token?: string }) {
    this.token = opts.token
  }

  async findInstallation(key: SlackInstallationKey): Promise<SlackInstallation | null> {
    if (!this.token) return null
    this.botUserId ??= await fetchBotUserId(this.token)
    return {
      teamId: key.teamId,
      enterpriseId: key.enterpriseId,
      botToken: this.token,
      botUserId: this.botUserId
    }
  }
}

async function fetchBotUserId(token: string): Promise<string | undefined> {
  const auth = await new WebClient(token).auth.test()
  return typeof auth.user_id === 'string' ? auth.user_id : undefined
}

export class SlackClientResolver {
  readonly store: SlackInstallationStore

  constructor(store: SlackInstallationStore) {
    this.store = store
  }

  async resolve(
    key: SlackInstallationKey
  ): Promise<{ installation: SlackInstallation; client: WebClient }> {
    const installation = await this.store.findInstallation(key)
    if (!installation) {
      throw new Error(
        `No Slack installation for team=${key.teamId ?? '-'} enterprise=${key.enterpriseId ?? '-'}`
      )
    }
    return { installation, client: new WebClient(installation.botToken) }
  }
}
