import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  app,
  k3sDeploymentCommands,
  runClusterSmoke,
  runClusterTurn,
  runSlackbotSmoke,
  serveCentaur,
} from '../src/app.js'
import { binaryChecks, envChecks } from '../src/checks.js'
import { CentaurClient, parseSse } from '../src/client.js'
import { runAgent } from '../src/run.js'
import { kubernetesEnvFile, writeSecrets } from '../src/secrets.js'
import { harnessAuthPlan, slackManifest, writeOverlay, writeSlackManifest } from '../src/templates.js'

async function runCli(args: string[]) {
  let stdout = ''
  await app.serve(args, {
    stdout: chunk => {
      stdout += chunk
    },
    exit: code => {
      if (code !== 0) throw new Error(`unexpected exit ${code}: ${stdout}`)
    },
  })
  return stdout
}

async function runCliWithExit(args: string[]) {
  let stdout = ''
  let exitCode = 0
  await app.serve(args, {
    stdout: chunk => {
      stdout += chunk
    },
    exit: code => {
      exitCode = code
    },
  })
  return { stdout, exitCode }
}

async function runEntry(args: string[]) {
  let stdout = ''
  await serveCentaur(args, {
    stdout: chunk => {
      stdout += chunk
    },
    exit: code => {
      if (code !== 0) throw new Error(`unexpected exit ${code}: ${stdout}`)
    },
  })
  return stdout
}

function response(data: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

function sse(body: string) {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body))
        controller.close()
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

describe('agent manifest', () => {
  it('renders llms-full flags in the same kebab-case form the CLI emits', async () => {
    const stdout = await runEntry(['--llms-full'])

    expect(stdout).toContain('`--assistant-name`')
    expect(stdout).toContain('`--image-source`')
    expect(stdout).toContain('`--release-thread`')
    expect(stdout).toContain('`--timeout-seconds`')
    expect(stdout).not.toContain('`--assistantName`')
    expect(stdout).not.toContain('`--imageSource`')
    expect(stdout).not.toContain('`--releaseThread`')
    expect(stdout).not.toContain('`--timeoutSeconds`')
  })
})

describe('slack manifest', () => {
  it('uses the Slackbot production routes', () => {
    const manifest = slackManifest('centaur', 'centaur.example.com', false)

    expect(manifest.settings.event_subscriptions.request_url).toBe(
      'https://centaur.example.com/api/webhooks/slack',
    )
    expect(manifest.settings.interactivity.request_url).toBe(
      'https://centaur.example.com/api/slack/actions',
    )
    expect(manifest.features.slash_commands[0]?.url).toBe(
      'https://centaur.example.com/api/slack/commands',
    )
    expect(manifest.oauth_config.scopes.bot).toContain('chat:write')
  })

  it('removes request URLs for socket mode', () => {
    const manifest = slackManifest('centaur', 'centaur.example.com', true)

    expect(manifest.settings.socket_mode_enabled).toBe(true)
    expect('request_url' in manifest.settings.event_subscriptions).toBe(false)
    expect('request_url' in manifest.settings.interactivity).toBe(false)
  })
})

describe('harness auth', () => {
  it('describes Codex subscription OAuth secrets for the selected harness', () => {
    const plan = harnessAuthPlan('codex', 'access_token')

    expect(plan.values.api.extraEnv).toEqual({ CODEX_AUTH_MODE: 'access_token' })
    expect(plan.values.sandbox.extraEnv).toEqual({ CODEX_AUTH_MODE: 'access_token' })
    expect(plan.requiredSecrets).toEqual([
      'OPENAI_CODEX_CLIENT_ID',
      'OPENAI_CODEX_BLOB',
      'OPENAI_CODEX_ACCOUNT_ID',
    ])
    expect(plan.bootstrap.join('\n')).toContain('OPENAI_CODEX_CLIENT_ID')
  })

  it('describes Claude Code subscription OAuth secrets for the selected harness', () => {
    const plan = harnessAuthPlan('claude-code', 'access_token')

    expect(plan.values.api.extraEnv).toEqual({ CLAUDE_CODE_AUTH_MODE: 'access_token' })
    expect(plan.values.sandbox.extraEnv).toEqual({ CLAUDE_CODE_AUTH_MODE: 'access_token' })
    expect(plan.requiredSecrets).toEqual(['CLAUDE_CODE_CLIENT_ID', 'CLAUDE_CODE_BLOB'])
    expect(plan.bootstrap.join('\n')).toContain('CLAUDE_CODE_CLIENT_ID')
  })
})

describe('overlay scaffolding', () => {
  it('writes access_token auth modes and OAuth secret placeholders', () => {
    const root = mkdtempSync(join(tmpdir(), 'centaur-cli-overlay-'))
    const overlayPath = join(root, 'org')

    const written = writeOverlay({
      path: overlayPath,
      org: 'acme',
      assistantName: 'centaur',
      domain: 'centaur.acme.com',
      harness: 'codex',
      authMode: 'access_token',
      secretBackend: 'onepassword',
    })
    writeSlackManifest(join(overlayPath, 'slack-app-manifest.json'), 'centaur', 'centaur.acme.com', false)

    expect(written.length).toBeGreaterThan(0)
    expect(readFileSync(join(overlayPath, 'values.centaur.yaml'), 'utf8')).toContain(
      'CODEX_AUTH_MODE: access_token',
    )
    expect(readFileSync(join(overlayPath, 'values.centaur.yaml'), 'utf8')).toContain(
      'secretSource: onepassword',
    )
    expect(readFileSync(join(overlayPath, 'values.centaur.yaml'), 'utf8')).toContain(
      'tokenBroker:\n  enabled: true',
    )
    const secrets = readFileSync(join(overlayPath, 'secrets.example.env'), 'utf8')
    expect(secrets).toContain('OPENAI_CODEX_CLIENT_ID=...')
    expect(secrets).not.toContain('CLAUDE_CODE_CLIENT_ID=...')
    expect(readFileSync(join(overlayPath, 'slack-app-manifest.json'), 'utf8')).toContain(
      '/api/webhooks/slack',
    )
  })

  it('init creates state and returns contextual next-command CTAs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'centaur-cli-init-'))
    const overlayPath = join(root, 'org')
    const home = join(root, 'home')

    const stdout = await runCli([
      'init',
      '--org',
      'acme',
      '--assistant-name',
      'centaur',
      '--domain',
      'centaur.acme.com',
      '--overlay-path',
      overlayPath,
      '--home',
      home,
      '--harness',
      'codex',
      '--auth-mode',
      'access_token',
      '--secret-backend',
      'onepassword',
      '--json',
    ])

    const output = JSON.parse(stdout)
    const ctaCommands = output.cta.commands.map((command: { command: string }) => command.command)
    expect(ctaCommands[0]).toContain('centaur integrations slack-manifest')
    expect(ctaCommands[0]).toContain('--copy')
    expect(ctaCommands[0]).toContain('--socket-mode')
    expect(ctaCommands[0]).toContain('--harness codex')
    expect(ctaCommands[1]).toContain('centaur secrets collect')
    expect(ctaCommands[1]).toContain('--auth-mode access_token')
    expect(ctaCommands[2]).toContain('centaur doctor --deep')
    expect(ctaCommands[2]).toContain('--harness codex')
    expect(ctaCommands[2]).toContain('--auth-mode access_token')
    expect(ctaCommands[3]).toContain('centaur deploy k3s --apply')
    expect(ctaCommands[3]).toContain('--image-source ghcr')
    expect(ctaCommands[4]).toContain("centaur run 'Reply with exactly PONG and nothing else.' --local --harness codex --expect PONG --release-thread")
    expect(ctaCommands[5]).toContain('centaur slackbot smoke')

    const state = JSON.parse(readFileSync(join(home, 'onboarding-state.json'), 'utf8'))
    expect(state.org).toBe('acme')
    expect(state.harness).toBe('codex')
    expect(state.authMode).toBe('access_token')
    expect(state.imageSource).toBe('ghcr')
    expect(state.completedSteps).toContain('slack-manifest')
    expect(readFileSync(join(overlayPath, 'values.centaur.yaml'), 'utf8')).toContain(
      'CODEX_AUTH_MODE: access_token',
    )
    expect(readFileSync(join(overlayPath, 'values.centaur.yaml'), 'utf8')).toContain(
      'secretSource: onepassword',
    )
    expect(readFileSync(join(overlayPath, 'values.centaur.yaml'), 'utf8')).toContain(
      'tokenBroker:\n  enabled: true',
    )
  })

  it('slack-manifest returns the exact next secrets collection command', async () => {
    const root = mkdtempSync(join(tmpdir(), 'centaur-cli-slack-'))
    const overlayPath = join(root, 'org')
    const outputPath = join(overlayPath, 'slack-app-manifest.json')

    const stdout = await runCli([
      'integrations',
      'slack-manifest',
      '--domain',
      'centaur.acme.com',
      '--app-name',
      'centaur',
      '--output',
      outputPath,
      '--backend',
      'kubernetes',
      '--install-mode',
      'k8s',
      '--harness',
      'claude-code',
      '--auth-mode',
      'access_token',
      '--overlay-path',
      overlayPath,
      '--json',
    ])

    const output = JSON.parse(stdout)
    expect(output.copied).toBe(false)
    expect(output.nextCommand).toContain('secrets collect --backend kubernetes')
    expect(output.nextCommand).toContain('--image-source ghcr')
    expect(output.nextCommand).toContain('--harness claude-code')
    expect(output.nextCommand).toContain('--auth-mode access_token')
    expect(output.cta.commands[0].command).toContain('centaur secrets collect --backend kubernetes')
  })

  it('slack-manifest defaults local install mode to Socket Mode', async () => {
    const root = mkdtempSync(join(tmpdir(), 'centaur-cli-local-slack-'))
    const outputPath = join(root, 'slack-app-manifest.json')

    const stdout = await runCli([
      'integrations',
      'slack-manifest',
      '--domain',
      'centaur.local.test',
      '--app-name',
      'centaur',
      '--output',
      outputPath,
      '--install-mode',
      'local',
      '--json',
    ])

    const output = JSON.parse(stdout)
    const manifest = JSON.parse(readFileSync(outputPath, 'utf8'))
    expect(output.socketMode).toBe(true)
    expect(output.manifest.settings.socket_mode_enabled).toBe(true)
    expect(manifest.settings.socket_mode_enabled).toBe(true)
    expect('request_url' in manifest.settings.event_subscriptions).toBe(false)
    expect(output.requiredSecrets).toContain('SLACK_APP_TOKEN')
    expect(output.optionalSecrets).not.toContain('SLACK_APP_TOKEN')
  })

  it('top-level setup returns the full agent command chain through local run and Slackbot smoke', async () => {
    const stdout = await runCli([
      'setup',
      '--org',
      'acme',
      '--assistant-name',
      'centaur',
      '--domain',
      'centaur.acme.com',
      '--backend',
      'local-env',
      '--install-mode',
      'local',
      '--harness',
      'codex',
      '--auth-mode',
      'api_key',
      '--overlay-path',
      'org',
      '--json',
    ])

    const output = JSON.parse(stdout)
    expect(output.commands).toEqual([
      'centaur init --org acme --assistant-name centaur --domain centaur.acme.com --install-mode local --image-source ghcr --secret-backend local-env --harness codex --auth-mode api_key --overlay-path org',
      'centaur integrations slack-manifest --domain centaur.acme.com --app-name centaur --output org/slack-app-manifest.json --copy --socket-mode --backend local-env --install-mode local --image-source ghcr --harness codex --auth-mode api_key --overlay-path org',
      'centaur secrets collect --backend local-env --install-mode local --image-source ghcr --harness codex --auth-mode api_key --overlay-path org',
      'centaur doctor --deep --overlay-path org --harness codex --auth-mode api_key --secret-backend local-env --install-mode local --image-source ghcr',
      'centaur deploy k3s --apply --image-source ghcr --wait --timeout 10m --secrets-file org/secrets.local.env',
      "centaur run 'Reply with exactly PONG and nothing else.' --local --harness codex --expect PONG --release-thread",
      'centaur slackbot smoke',
    ])
  })

  it('doctor warns without blocking local subscription bootstrap on read-only backends', async () => {
    const root = mkdtempSync(join(tmpdir(), 'centaur-cli-doctor-'))
    const overlayPath = join(root, 'org')
    const localEnvPath = join(root, 'secrets.local.env')
    writeOverlay({
      path: overlayPath,
      org: 'acme',
      assistantName: 'centaur',
      domain: 'centaur.acme.com',
      harness: 'codex',
      authMode: 'access_token',
      secretBackend: 'local-env',
    })
    writeSlackManifest(join(overlayPath, 'slack-app-manifest.json'), 'centaur', 'centaur.acme.com', false)
    writeSecrets(
      'local-env',
      {
        SLACK_BOT_TOKEN: 'xoxb-test',
        SLACK_SIGNING_SECRET: 'signing-test',
        OPENAI_CODEX_CLIENT_ID: 'client-test',
        OPENAI_CODEX_BLOB: '{"refresh_token":"test"}',
        OPENAI_CODEX_ACCOUNT_ID: 'acct-test',
      },
      { localEnvPath },
    )

    const { stdout } = await runCliWithExit([
      'secrets',
      'doctor',
      '--backend',
      'local-env',
      '--harness',
      'codex',
      '--auth-mode',
      'access_token',
      '--overlay-path',
      overlayPath,
      '--local-env-path',
      localEnvPath,
      '--json',
    ])

    const output = JSON.parse(stdout)
    expect(output.ok).toBe(true)
    const backendCheck = output.results.find(
      (result: { name: string }) => result.name === 'backend:brokered-token-store',
    )
    expect(backendCheck.ok).toBe(true)
    expect(backendCheck.detail).toContain('production refresh-token rotation needs onepassword')
  })
})

describe('environment checks', () => {
  it('does not block CLI setup on legacy shell helpers the happy path does not use', () => {
    const results = binaryChecks()

    for (const name of ['binary:git', 'binary:jq', 'binary:openssl']) {
      const result = results.find(item => item.name === name)
      expect(result?.ok).toBe(true)
      expect(result?.repair).toBeUndefined()
    }
  })

  it('validates only the selected default harness', () => {
    const results = envChecks(
      {
        SLACK_BOT_TOKEN: 'xoxb-test',
        SLACK_SIGNING_SECRET: 'signing-test',
        ANTHROPIC_API_KEY: 'sk-ant-test',
      },
      { harness: 'claude-code', authMode: 'api_key' },
    )

    expect(results.some(result => result.name === 'env:codex-auth')).toBe(false)
    expect(results.find(result => result.name === 'env:claude-code-auth')?.ok).toBe(true)
  })

  it('does not block the default happy path on optional GitHub credentials', () => {
    const results = envChecks(
      {
        SLACK_BOT_TOKEN: 'xoxb-test',
        SLACK_SIGNING_SECRET: 'signing-test',
        SLACK_APP_TOKEN: 'xapp-test',
        OPENAI_API_KEY: 'sk-test',
      },
      { harness: 'codex', authMode: 'api_key', installMode: 'local' },
    )

    const github = results.find(result => result.name === 'env:github')
    expect(results.every(result => result.ok)).toBe(true)
    expect(github?.detail).toBe('missing optional')
    expect(github?.repair).toBeUndefined()
  })

  it('can still require GitHub credentials for workflows that need them', () => {
    const results = envChecks(
      {
        SLACK_BOT_TOKEN: 'xoxb-test',
        SLACK_SIGNING_SECRET: 'signing-test',
        OPENAI_API_KEY: 'sk-test',
      },
      { harness: 'codex', authMode: 'api_key', requireGithub: true },
    )

    const github = results.find(result => result.name === 'env:github')
    expect(github?.ok).toBe(false)
    expect(github?.repair).toContain('GITHUB_TOKEN')
  })

  it('requires SLACK_APP_TOKEN for local socket-mode setup checks', () => {
    const results = envChecks(
      {
        SLACK_BOT_TOKEN: 'xoxb-test',
        SLACK_SIGNING_SECRET: 'signing-test',
        OPENAI_API_KEY: 'sk-test',
        GITHUB_TOKEN: 'gh-test',
      },
      { harness: 'codex', authMode: 'api_key', installMode: 'local' },
    )

    const slack = results.find(result => result.name === 'env:slack')
    expect(slack?.ok).toBe(false)
    expect(slack?.detail).toContain('SLACK_APP_TOKEN')
  })
})

describe('deploy plans', () => {
  it('prints local k3s cluster commands', () => {
    const commands = k3sDeploymentCommands('centaur', 'centaur', 'org/values.centaur.yaml')

    expect(commands[0]).toEqual(['kubectl', 'config', 'current-context'])
    expect(commands.some(command => command.join(' ').includes('helm dependency update'))).toBe(false)
    expect(commands.at(-1)?.slice(0, 4)).toEqual(['helm', 'upgrade', '--install', 'centaur'])
    expect(commands.at(-1)?.[4]).toMatch(/contrib\/chart$/)
    expect(commands.at(-1)?.slice(5)).toEqual([
      '-n',
      'centaur',
      '-f',
      'org/values.centaur.yaml',
      '--set',
      'api.image.repository=ghcr.io/paradigmxyz/centaur/centaur-api',
      '--set',
      'ironProxy.image.repository=ghcr.io/paradigmxyz/centaur/centaur-iron-proxy',
      '--set',
      'slackbot.image.repository=ghcr.io/paradigmxyz/centaur/centaur-slackbot',
      '--set',
      'sandbox.image.repository=ghcr.io/paradigmxyz/centaur/centaur-agent',
      '--wait',
      '--timeout',
      '10m',
    ])
  })

  it('supports local image names without forcing image pulls', () => {
    const commands = k3sDeploymentCommands('centaur', 'centaur', 'org/values.centaur.yaml', {
      imageSource: 'local',
    })

    expect(commands.at(-1)?.slice(5)).toEqual([
      '-n',
      'centaur',
      '-f',
      'org/values.centaur.yaml',
      '--set',
      'api.image.pullPolicy=IfNotPresent',
      '--set',
      'ironProxy.image.pullPolicy=IfNotPresent',
      '--set',
      'slackbot.image.pullPolicy=IfNotPresent',
      '--set',
      'sandbox.image.pullPolicy=IfNotPresent',
      '--wait',
      '--timeout',
      '10m',
    ])
  })

  it('only updates Helm chart dependencies when explicitly requested', async () => {
    const commands = k3sDeploymentCommands('centaur', 'centaur', 'org/values.centaur.yaml', {
      updateDependencies: true,
    })

    expect(commands.some(command => command.slice(0, 3).join(' ') === 'helm dependency update')).toBe(true)

    const stdout = await runCli([
      'deploy',
      'k3s',
      '--update-dependencies',
      '--json',
    ])
    const output = JSON.parse(stdout)
    expect(output.commands.some((command: string) => command.startsWith('helm dependency update '))).toBe(true)
  })

  it('can print a deploy plan without Helm readiness waiting', async () => {
    const stdout = await runCli([
      'deploy',
      'k3s',
      '--no-wait',
      '--json',
    ])
    const output = JSON.parse(stdout)
    expect(output.commands.at(-1)).not.toContain('--wait')
  })

  it('can include a local env secret apply before Helm', async () => {
    const commands = k3sDeploymentCommands('centaur', 'centaur', 'org/values.centaur.yaml', {
      secretsFile: 'org/secrets.local.env',
    })

    expect(commands[3]).toEqual([
      'kubectl',
      'create',
      'secret',
      'generic',
      'centaur-infra-env',
      '-n',
      'centaur',
      '--from-env-file',
      'org/secrets.local.env',
      '--dry-run=client',
      '-o',
      'yaml',
    ])

    const stdout = await runCli([
      'deploy',
      'k3s',
      '--secrets-file',
      'org/secrets.local.env',
      '--json',
    ])
    const output = JSON.parse(stdout)
    expect(output.applied).toBe(false)
    expect(output.commands).toContain(
      'kubectl create secret generic centaur-infra-env -n centaur --from-env-file org/secrets.local.env --dry-run=client -o yaml | kubectl apply -f -',
    )
  })
})

describe('cluster smoke', () => {
  it('runs an arbitrary CLI prompt through the local API deployment without external auth', () => {
    const calls: string[][] = []
    const runner = (command: string[]) => {
      calls.push(command)
      const joined = command.join(' ')
      if (joined.includes('/agent/spawn')) {
        return JSON.stringify({ runtime_id: 'rtm-1', assignment_generation: 4 })
      }
      if (joined.includes('/agent/message')) {
        return JSON.stringify({ ok: true, message_id: 'msg-run' })
      }
      if (joined.includes('/agent/execute')) {
        return JSON.stringify({ execution_id: 'exe-run', status: 'queued' })
      }
      if (joined.includes('/agent/executions/exe-run')) {
        return JSON.stringify({ status: 'completed', result_text: 'hello from local pod' })
      }
      throw new Error(`unexpected command ${joined}`)
    }

    const result = runClusterTurn({
      namespace: 'centaur',
      release: 'centaur',
      harness: 'codex',
      engine: 'gpt-5',
      personaId: 'operator',
      prompt: 'Say hello',
      threadKey: 'cli:run:test',
      pollMs: 1,
    }, runner)

    expect(result.status).toBe('completed')
    expect(result.resultText).toBe('hello from local pod')
    expect(result.release).toBeUndefined()
    expect(calls[0]?.[8]).toContain(JSON.stringify({
      thread_key: 'cli:run:test',
      harness: 'codex',
      engine: 'gpt-5',
      persona_id: 'operator',
    }))
    expect(calls.some(call => call.join(' ').includes('/release'))).toBe(false)
  })

  it('runs spawn/message/execute through the API deployment and releases the thread', () => {
    const calls: string[][] = []
    const runner = (command: string[]) => {
      calls.push(command)
      const joined = command.join(' ')
      if (joined.includes('/agent/spawn')) {
        return JSON.stringify({ runtime_id: 'rtm-1', assignment_generation: 3 })
      }
      if (joined.includes('/agent/message')) {
        return JSON.stringify({ ok: true, message_id: 'msg-1' })
      }
      if (joined.includes('/agent/execute')) {
        return JSON.stringify({ execution_id: 'exe-1', status: 'queued' })
      }
      if (joined.includes('/agent/executions/exe-1')) {
        return JSON.stringify({ status: 'completed', result_text: 'PONG' })
      }
      if (joined.includes('/agent/threads/cli%3Atest/release')) {
        return JSON.stringify({ ok: true, released: true })
      }
      throw new Error(`unexpected command ${joined}`)
    }

    const result = runClusterSmoke({
      namespace: 'centaur',
      release: 'centaur',
      harness: 'codex',
      prompt: 'Reply PONG',
      expectText: 'PONG',
      threadKey: 'cli:test',
      pollMs: 1,
    }, runner)

    expect(result.ok).toBe(true)
    expect(result.status).toBe('completed')
    expect(result.resultText).toBe('PONG')
    expect(calls[0]?.slice(0, 8)).toEqual([
      'kubectl',
      'exec',
      '-n',
      'centaur',
      'deploy/centaur-centaur-api',
      '--',
      'sh',
      '-lc',
    ])
    expect(calls[0]?.[8]).toContain('SLACKBOT_API_KEY')
    expect(calls[0]?.[8]).toContain('http://localhost:8000/agent/spawn')
    expect(calls[0]?.[8]).toContain(JSON.stringify({ thread_key: 'cli:test', harness: 'codex' }))
    expect(calls[0]?.[8]).not.toContain('aiv2_')
  })
})

describe('slackbot smoke', () => {
  it('sends a signed synthetic Slack mention and waits for the workflow execution', () => {
    const calls: string[][] = []
    let workflowPolls = 0
    let executionPolls = 0
    const runner = (command: string[]) => {
      calls.push(command)
      const joined = command.join(' ')
      if (joined.includes('deploy/centaur-centaur-slackbot')) {
        return JSON.stringify({ status: 504, text: 'Gateway Timeout' })
      }
      if (joined.includes('/workflows/runs?thread_key=slack%3ATCLI%3ACCLI%3A1770000000.000001')) {
        workflowPolls += 1
        return JSON.stringify({
          ok: true,
          items: [
            workflowPolls === 1
              ? { run_id: 'wfr-1', status: 'running' }
              : { run_id: 'wfr-1', status: 'waiting', execution_id: 'exe-1' },
          ],
        })
      }
      if (joined.includes('/agent/executions/exe-1')) {
        executionPolls += 1
        return JSON.stringify(
          executionPolls === 1
            ? { status: 'running', result_text: null }
            : { status: 'completed', result_text: 'PONG' },
        )
      }
      if (joined.includes('/agent/threads/slack%3ATCLI%3ACCLI%3A1770000000.000001/release')) {
        return JSON.stringify({ ok: true, released: true })
      }
      throw new Error(`unexpected command ${joined}`)
    }

    const result = runSlackbotSmoke({
      namespace: 'centaur',
      release: 'centaur',
      prompt: 'Reply PONG',
      expectText: 'PONG',
      threadTs: '1770000000.000001',
      pollMs: 1,
    }, runner)

    expect(result.ok).toBe(true)
    expect(result.webhookAccepted).toBe(false)
    expect(result.threadKey).toBe('slack:TCLI:CCLI:1770000000.000001')
    expect(result.workflowRunId).toBe('wfr-1')
    expect(result.executionId).toBe('exe-1')
    expect(result.resultText).toBe('PONG')
    expect(calls[0]?.slice(0, 8)).toEqual([
      'kubectl',
      'exec',
      '-n',
      'centaur',
      'deploy/centaur-centaur-slackbot',
      '--',
      'bun',
      '-e',
    ])
    expect(calls[0]?.[8]).toContain('SLACK_SIGNING_SECRET')
    expect(calls[0]?.[8]).toContain('/api/webhooks/slack')
    expect(calls[0]?.[8]).toContain('Reply PONG')
    expect(calls[0]?.[8]).not.toContain('local-dev')
  })
})

describe('secret backends', () => {
  it('preserves JSON values for kubectl env-file secrets', () => {
    const text = kubernetesEnvFile({
      OPENAI_CODEX_BLOB: '{"refresh_token":"secret"}',
    })

    expect(text).toBe('OPENAI_CODEX_BLOB={"refresh_token":"secret"}\n')
  })

  it('writes local-env secrets without printing values in the command summary', () => {
    const root = mkdtempSync(join(tmpdir(), 'centaur-cli-secrets-'))
    const target = join(root, 'secrets.local.env')

    const result = writeSecrets(
      'local-env',
      { SLACK_BOT_TOKEN: 'xoxb-secret', OPENAI_API_KEY: 'sk-secret' },
      { localEnvPath: target },
    )

    const text = readFileSync(target, 'utf8')
    expect(text).toContain('SLACK_BOT_TOKEN=xoxb-secret')
    expect(text).toContain('OPENAI_API_KEY=sk-secret')
    expect(result.command).toBe(`write ${target}`)
    expect(result.command).not.toContain('xoxb-secret')
  })
})

describe('agent run client', () => {
  it('posts spawn, message, and execute payloads', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      if (String(url).endsWith('/agent/spawn')) {
        return response({ thread_key: 'cli:test', assignment_generation: 7 })
      }
      if (String(url).endsWith('/agent/message')) return response({ ok: true, message_id: 'msg-1' })
      if (String(url).endsWith('/agent/execute')) return response({ execution_id: 'exe-1', status: 'queued' })
      throw new Error(`unexpected url ${String(url)}`)
    }) as typeof fetch

    const client = new CentaurClient({
      apiUrl: 'http://api.test/',
      apiKey: 'key',
      fetchImpl,
    })

    const spawn = await client.spawn({ threadKey: 'cli:test', harness: 'codex' })
    await client.message({
      threadKey: 'cli:test',
      assignmentGeneration: spawn.assignment_generation,
      parts: [{ type: 'text', text: 'hello' }],
    })
    await client.execute({
      threadKey: 'cli:test',
      assignmentGeneration: spawn.assignment_generation,
      harness: 'codex',
    })

    expect(calls.map(call => [call.url, call.init?.body && JSON.parse(String(call.init.body))])).toEqual([
      [
        'http://api.test/agent/spawn',
        {
          thread_key: 'cli:test',
          harness: 'codex',
        },
      ],
      [
        'http://api.test/agent/message',
        {
          thread_key: 'cli:test',
          assignment_generation: 7,
          role: 'user',
          parts: [{ type: 'text', text: 'hello' }],
          metadata: { platform: 'cli' },
        },
      ],
      [
        'http://api.test/agent/execute',
        {
          thread_key: 'cli:test',
          assignment_generation: 7,
          harness: 'codex',
          delivery: { platform: 'cli' },
          metadata: { platform: 'cli' },
        },
      ],
    ])
    expect(calls[0]?.init?.headers).toMatchObject({
      Authorization: 'Bearer key',
      'X-Api-Key': 'key',
    })
  })

  it('parses SSE frames with ids, events, multiline data, and invalid json fallback', async () => {
    const frames = []
    const stream = sse(
      [
        'id: 1',
        'event: assistant',
        'data: {"result":"hello"}',
        '',
        'id: 2',
        'event: message',
        'data: first',
        'data: second',
        '',
      ].join('\n'),
    ).body!

    for await (const frame of parseSse(stream)) frames.push(frame)

    expect(frames).toEqual([
      { id: '1', event: 'assistant', data: '{"result":"hello"}' },
      { id: '2', event: 'message', data: 'first\nsecond' },
    ])
  })

  it('runs the durable agent flow and preserves every streamed API event', async () => {
    const calls: string[] = []
    const fetchImpl = (async (url: string | URL | Request) => {
      const target = String(url)
      calls.push(target)
      if (target.endsWith('/agent/spawn')) {
        return response({ thread_key: 'cli:test', assignment_generation: 7 })
      }
      if (target.endsWith('/agent/message')) return response({ ok: true, message_id: 'msg-1' })
      if (target.endsWith('/agent/execute')) return response({ execution_id: 'exe-1', status: 'queued' })
      if (target.includes('/agent/threads/cli%3Atest/events')) {
        return sse(
          [
            'id: 1',
            'event: harness_raw_event',
            'data: {"item":{"type":"userMessage","content":[{"type":"text","text":"hello"}]},"type":"item.completed"}',
            '',
            'id: 2',
            'event: chat_stream_chunk',
            'data: {"type":"markdown_text","text":"P"}',
            '',
            'id: 3',
            'event: chat_stream_chunk',
            'data: {"type":"markdown_text","text":"P"}',
            '',
            'id: 4',
            'event: execution_state',
            'data: {"status":"completed","result_text":"P"}',
            '',
          ].join('\n'),
        )
      }
      if (target.endsWith('/agent/executions/exe-1')) {
        return response({ status: 'completed', result_text: 'P' })
      }
      throw new Error(`unexpected url ${target}`)
    }) as typeof fetch

    const stream = runAgent({
      apiUrl: 'http://api.test',
      apiKey: 'key',
      prompt: 'hello',
      threadKey: 'cli:test',
      harness: 'codex',
      fetchImpl,
    })

    const yielded = []
    let next = await stream.next()
    while (!next.done) {
      yielded.push(next.value)
      next = await stream.next()
    }

    expect(yielded).toEqual([
      {
        phase: 'spawned',
        threadKey: 'cli:test',
        assignmentGeneration: 7,
      },
      {
        phase: 'message_persisted',
        messageId: 'msg-1',
      },
      {
        phase: 'execution_queued',
        executionId: 'exe-1',
        status: 'queued',
      },
      {
        phase: 'api_event',
        eventId: 1,
        eventKind: 'harness_raw_event',
        data: {
          item: {
            type: 'userMessage',
            content: [{ type: 'text', text: 'hello' }],
          },
          type: 'item.completed',
        },
      },
      {
        phase: 'api_event',
        eventId: 2,
        eventKind: 'chat_stream_chunk',
        data: { type: 'markdown_text', text: 'P' },
      },
      {
        phase: 'api_event',
        eventId: 3,
        eventKind: 'chat_stream_chunk',
        data: { type: 'markdown_text', text: 'P' },
      },
      {
        phase: 'api_event',
        eventId: 4,
        eventKind: 'execution_state',
        data: { status: 'completed', result_text: 'P' },
      },
      {
        phase: 'final_state',
        executionId: 'exe-1',
        state: { status: 'completed', result_text: 'P' },
      },
    ])
    expect(next.value).toEqual({
      threadKey: 'cli:test',
      assignmentGeneration: 7,
      executionId: 'exe-1',
      status: 'completed',
      resultText: 'P',
    })
    expect(calls.at(-1)).toBe('http://api.test/agent/executions/exe-1')
  })
})
