import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Cli, z } from 'incur'

import {
  AUTH_MODES,
  HARNESSES,
  IMAGE_SOURCES,
  INSTALL_MODES,
  SECRET_BACKENDS,
  VERSION,
  type AuthMode,
  type Harness,
  type ImageSource,
  type InstallMode,
  type SecretBackend,
} from './constants.js'
import {
  binaryChecks,
  commandCheck,
  dockerDaemonCheck,
  envChecks,
  overlayChecks,
  type CheckResult,
} from './checks.js'
import { DEFAULT_HOME, emptyState, expandPath, loadState, markDone, saveState } from './state.js'
import {
  SLACK_SCOPES,
  harnessAuthPlan,
  slackManifest,
  writeOverlay,
  writeSlackManifest,
} from './templates.js'
import {
  defaultSecretTarget,
  writeSecrets,
  type SecretBackendOptions,
  type SecretMap,
} from './secrets.js'
import { runAgent } from './run.js'

const authModeSchema = z.enum(AUTH_MODES)
const harnessSchema = z.enum(HARNESSES)
const imageSourceSchema = z.enum(IMAGE_SOURCES)
const installModeSchema = z.enum(INSTALL_MODES)
const secretBackendSchema = z.enum(SECRET_BACKENDS)

function allOk(results: CheckResult[]) {
  return results.every(result => result.ok)
}

function setFailedExit(ok: boolean) {
  if (!ok) process.exitCode = 1
}

async function ask(prompt: string, defaultValue: string, nonInteractive: boolean) {
  if (nonInteractive) return defaultValue
  const rl = createInterface({ input, output })
  try {
    const answer = await rl.question(`${prompt} [${defaultValue}]: `)
    return answer.trim() || defaultValue
  } finally {
    rl.close()
  }
}

async function askSecret(
  prompt: string,
  options: { nonInteractive: boolean; defaultValue?: string; required?: boolean } = { nonInteractive: false },
) {
  if (options.nonInteractive) {
    if (options.defaultValue) return options.defaultValue
    if (options.required) throw new Error(`${prompt} is required; run in a TTY or use environment-backed secret collection`)
    return ''
  }
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    throw new Error(`${prompt} requires a TTY for masked input; rerun in an interactive terminal or use --from-env`)
  }
  const suffix = options.defaultValue ? ' [leave blank to use generated/default value]' : ''
  while (true) {
    let answer = ''
    answer = await new Promise<string>((resolve, reject) => {
      let value = ''
      const onData = (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        for (const char of text) {
          if (char === '\u0003') {
            cleanup()
            output.write('\n')
            reject(new Error('interrupted'))
            return
          }
          if (char === '\r' || char === '\n') {
            cleanup()
            output.write('\n')
            resolve(value)
            return
          }
          if (char === '\u007f' || char === '\b') {
            if (value.length > 0) {
              value = value.slice(0, -1)
              output.write('\b \b')
            }
            continue
          }
          value += char
          output.write('*')
        }
      }
      const cleanup = () => {
        input.off('data', onData)
        input.setRawMode(false)
        input.pause()
      }
      output.write(`${prompt}${suffix}: `)
      input.setRawMode(true)
      input.resume()
      input.on('data', onData)
    })
    const value = answer.trim() || options.defaultValue || ''
    if (value || !options.required) return value
    console.log('  Required. Paste a value or press Ctrl-C to stop.')
  }
}

function quotePart(part: string) {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(part)) return part
  return `'${part.replaceAll("'", "'\\''")}'`
}

function commandLine(parts: string[]) {
  return parts.map(quotePart).join(' ')
}

function repoRoot() {
  return resolve(dirname(realpathSync(fileURLToPath(import.meta.url))), '../../..')
}

export function resolveChartPath(path = 'contrib/chart') {
  if (path.startsWith('/')) return path
  if (existsSync(resolve(process.cwd(), path))) return path
  let current = dirname(realpathSync(fileURLToPath(import.meta.url)))
  while (true) {
    const candidate = resolve(current, path)
    if (existsSync(candidate)) return candidate
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  const fromRepoRoot = resolve(repoRoot(), path)
  return existsSync(fromRepoRoot) ? fromRepoRoot : path
}

function generatedSecret(bytes = 32) {
  return randomBytes(bytes).toString('base64url')
}

const DEFAULT_POSTGRES_PASSWORD = 'tempo_dev_change_me'
const DEFAULT_SMOKE_PROMPT = 'Reply with exactly PONG and nothing else.'
const DEFAULT_SMOKE_EXPECT = 'PONG'

function defaultDatabaseUrl(postgresPassword: string) {
  return `postgres://tempo:${encodeURIComponent(postgresPassword)}@centaur-centaur-postgres:5432/ai_v2`
}

function readDotenvFile(path: string) {
  const env: NodeJS.ProcessEnv = {}
  try {
    const text = readFileSync(expandPath(path), 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const equals = trimmed.indexOf('=')
      if (equals <= 0) continue
      const key = trimmed.slice(0, equals).trim()
      const rawValue = trimmed.slice(equals + 1).trim()
      try {
        env[key] = rawValue.startsWith('"') ? JSON.parse(rawValue) : rawValue
      } catch {
        env[key] = rawValue
      }
    }
  } catch {
    // Missing local files are reported by the env checks as missing keys.
  }
  return env
}

function commandExists(command: string) {
  return spawnSync('sh', ['-lc', `command -v ${command}`], { stdio: 'ignore' }).status === 0
}

function copyToClipboard(text: string) {
  const candidates: { command: string; args: string[] }[] = [
    { command: 'pbcopy', args: [] },
    { command: 'wl-copy', args: [] },
    { command: 'xclip', args: ['-selection', 'clipboard'] },
    { command: 'xsel', args: ['--clipboard', '--input'] },
    { command: 'clip.exe', args: [] },
  ]
  for (const candidate of candidates) {
    if (!commandExists(candidate.command)) continue
    const proc = spawnSync(candidate.command, candidate.args, { input: text, encoding: 'utf8' })
    if (proc.status === 0) return { ok: true, command: candidate.command }
  }
  return { ok: false, command: '' }
}

function readJson(path: string) {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

function nestedString(value: unknown, path: string[]) {
  let current = value
  for (const key of path) {
    if (!current || typeof current !== 'object' || !(key in current)) return ''
    current = (current as Record<string, unknown>)[key]
  }
  return typeof current === 'string' ? current : ''
}

function refreshTokenFromCredentialJson(value: unknown) {
  return (
    nestedString(value, ['claudeAiOauth', 'refreshToken']) ||
    nestedString(value, ['claudeAiOauth', 'refresh_token']) ||
    nestedString(value, ['refreshToken']) ||
    nestedString(value, ['refresh_token'])
  )
}

function readClaudeRefreshTokenFromKeychain() {
  if (process.platform !== 'darwin' || !commandExists('security')) return ''
  const proc = spawnSync(
    'security',
    ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  )
  if (proc.status !== 0) return ''
  try {
    return refreshTokenFromCredentialJson(JSON.parse(proc.stdout.trim()))
  } catch {
    return ''
  }
}

function commandPath(command: string) {
  const proc = spawnSync('sh', ['-lc', `command -v ${quotePart(command)}`], { encoding: 'utf8' })
  return proc.status === 0 ? proc.stdout.trim() : ''
}

function readFileTextIfExists(path: string) {
  try {
    return readFileSync(path).toString('latin1')
  } catch {
    return ''
  }
}

export function extractCodexOAuthClientIdFromText(text: string) {
  const candidates = Array.from(new Set(text.match(/app_[A-Za-z0-9]{24}/g) || []))
    .filter(candidate => !/^app_[a-z]+$/.test(candidate))
  return candidates.length === 1 ? candidates[0] : ''
}

export function extractClaudeOAuthClientIdFromText(text: string) {
  const match = /CLIENT_ID:"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",OAUTH_FILE_SUFFIX:"",MCP_PROXY_URL:"https:\/\/mcp-proxy\.anthropic\.com"/.exec(text)
  return match?.[1] || ''
}

function codexNativeBinaryPath(wrapperPath: string) {
  const packageRoot = dirname(dirname(wrapperPath))
  const binaryName = process.platform === 'win32' ? 'codex.exe' : 'codex'
  let targetTriple = ''
  if ((process.platform === 'linux' || process.platform === 'android') && process.arch === 'x64') {
    targetTriple = 'x86_64-unknown-linux-musl'
  } else if ((process.platform === 'linux' || process.platform === 'android') && process.arch === 'arm64') {
    targetTriple = 'aarch64-unknown-linux-musl'
  } else if (process.platform === 'darwin' && process.arch === 'x64') {
    targetTriple = 'x86_64-apple-darwin'
  } else if (process.platform === 'darwin' && process.arch === 'arm64') {
    targetTriple = 'aarch64-apple-darwin'
  } else if (process.platform === 'win32' && process.arch === 'x64') {
    targetTriple = 'x86_64-pc-windows-msvc'
  } else if (process.platform === 'win32' && process.arch === 'arm64') {
    targetTriple = 'aarch64-pc-windows-msvc'
  }
  return targetTriple ? join(packageRoot, 'vendor', targetTriple, 'codex', binaryName) : ''
}

function discoverCodexOAuthClientIdFromCli() {
  const path = commandPath('codex')
  if (!path) return ''
  try {
    const resolved = realpathSync(path)
    return (
      extractCodexOAuthClientIdFromText(readFileTextIfExists(codexNativeBinaryPath(resolved))) ||
      extractCodexOAuthClientIdFromText(readFileTextIfExists(resolved))
    )
  } catch {
    return ''
  }
}

function discoverClaudeOAuthClientIdFromCli() {
  const path = commandPath('claude')
  if (!path) return ''
  try {
    return extractClaudeOAuthClientIdFromText(readFileTextIfExists(realpathSync(path)))
  } catch {
    return ''
  }
}

function readCodexSubscriptionAuth() {
  try {
    const auth = readJson(expandPath('~/.codex/auth.json'))
    return {
      refreshToken: nestedString(auth, ['tokens', 'refresh_token']),
      accountId: nestedString(auth, ['tokens', 'account_id']),
      clientId:
        nestedString(auth, ['tokens', 'client_id']) ||
        nestedString(auth, ['client_id']) ||
        nestedString(auth, ['clientId']),
    }
  } catch {
    return { refreshToken: '', accountId: '', clientId: '' }
  }
}

function clientIdFromCredentialJson(value: unknown) {
  return (
    nestedString(value, ['claudeAiOauth', 'clientId']) ||
    nestedString(value, ['claudeAiOauth', 'client_id']) ||
    nestedString(value, ['clientId']) ||
    nestedString(value, ['client_id'])
  )
}

function readClaudeSubscriptionAuth() {
  let refreshToken = ''
  let clientId = ''
  try {
    const auth = readJson(expandPath('~/.claude/.credentials.json'))
    refreshToken = refreshTokenFromCredentialJson(auth)
    clientId = clientIdFromCredentialJson(auth)
  } catch {
    // Fall back to keychain below.
  }
  return {
    refreshToken: refreshToken || readClaudeRefreshTokenFromKeychain(),
    clientId,
  }
}

type DeploymentCommandOptions = {
  secretsFile?: string
  secretName?: string
  imageSource?: ImageSource
  wait?: boolean
  timeout?: string
  updateDependencies?: boolean
}

function secretApplyCommands(namespace: string, options: DeploymentCommandOptions = {}) {
  if (!options.secretsFile) return []
  return [
    [
      'kubectl',
      'create',
      'secret',
      'generic',
      options.secretName || 'centaur-infra-env',
      '-n',
      namespace,
      '--from-env-file',
      options.secretsFile,
      '--dry-run=client',
      '-o',
      'yaml',
    ],
    ['kubectl', 'apply', '-f', '-'],
  ]
}

function imageSourceHelmArgs(imageSource: ImageSource = 'ghcr') {
  if (imageSource === 'local') {
    return [
      '--set',
      'api.image.pullPolicy=IfNotPresent',
      '--set',
      'ironProxy.image.pullPolicy=IfNotPresent',
      '--set',
      'slackbot.image.pullPolicy=IfNotPresent',
      '--set',
      'sandbox.image.pullPolicy=IfNotPresent',
    ]
  }
  return [
    '--set',
    'api.image.repository=ghcr.io/paradigmxyz/centaur/centaur-api',
    '--set',
    'ironProxy.image.repository=ghcr.io/paradigmxyz/centaur/centaur-iron-proxy',
    '--set',
    'slackbot.image.repository=ghcr.io/paradigmxyz/centaur/centaur-slackbot',
    '--set',
    'sandbox.image.repository=ghcr.io/paradigmxyz/centaur/centaur-agent',
  ]
}

function helmUpgradeCommand(
  release: string,
  chartPath: string,
  namespace: string,
  values: string,
  options: DeploymentCommandOptions = {},
) {
  const command = [
    'helm',
    'upgrade',
    '--install',
    release,
    chartPath,
    '-n',
    namespace,
    '-f',
    values,
    ...imageSourceHelmArgs(options.imageSource),
  ]
  if (options.wait !== false) command.push('--wait', '--timeout', options.timeout || '10m')
  return command
}

export function kindDeploymentCommands(
  clusterName: string,
  namespace: string,
  release: string,
  values: string,
  options: DeploymentCommandOptions = {},
) {
  const chartPath = resolveChartPath()
  return [
    ['kind', 'create', 'cluster', '--name', clusterName],
    ['kubectl', 'cluster-info', '--context', `kind-${clusterName}`],
    ['kubectl', 'create', 'namespace', namespace, '--dry-run=client', '-o', 'yaml'],
    ['kubectl', 'apply', '-f', '-'],
    ...secretApplyCommands(namespace, options),
    ...(options.updateDependencies ? [['helm', 'dependency', 'update', chartPath]] : []),
    helmUpgradeCommand(release, chartPath, namespace, values, options),
  ]
}

export function k3sDeploymentCommands(
  namespace: string,
  release: string,
  values: string,
  options: DeploymentCommandOptions = {},
) {
  const chartPath = resolveChartPath()
  return [
    ['kubectl', 'config', 'current-context'],
    ['kubectl', 'create', 'namespace', namespace, '--dry-run=client', '-o', 'yaml'],
    ['kubectl', 'apply', '-f', '-'],
    ...secretApplyCommands(namespace, options),
    ...(options.updateDependencies ? [['helm', 'dependency', 'update', chartPath]] : []),
    helmUpgradeCommand(release, chartPath, namespace, values, options),
  ]
}

export function k8sDeploymentCommands(
  namespace: string,
  release: string,
  values: string,
  options: DeploymentCommandOptions = {},
) {
  const chartPath = resolveChartPath()
  return [
    ['kubectl', 'create', 'namespace', namespace, '--dry-run=client', '-o', 'yaml'],
    ['kubectl', 'apply', '-f', '-'],
    ...secretApplyCommands(namespace, options),
    ...(options.updateDependencies ? [['helm', 'dependency', 'update', chartPath]] : []),
    helmUpgradeCommand(release, chartPath, namespace, values, options),
  ]
}

function deployCommandPartsForInstallMode(
  installMode: string,
  options: {
    apply?: boolean
    secretsFile?: string
    imageSource?: ImageSource
    values?: string
    wait?: boolean
    timeout?: string
  } = {},
) {
  const parts = ['deploy', installMode === 'local' || installMode === 'k3s' ? 'k3s' : 'k8s']
  if (options.apply) parts.push('--apply')
  if (options.imageSource) parts.push('--image-source', options.imageSource)
  if (options.values && options.values !== 'org/values.centaur.yaml') parts.push('--values', options.values)
  if (options.wait !== false) parts.push('--wait', '--timeout', options.timeout || '10m')
  if (options.secretsFile) parts.push('--secrets-file', options.secretsFile)
  return parts
}

function deploymentCommandForInstallMode(
  installMode: string,
  options: {
    apply?: boolean
    secretsFile?: string
    imageSource?: ImageSource
    values?: string
    wait?: boolean
    timeout?: string
  } = {},
) {
  return commandLine(deployCommandPartsForInstallMode(installMode, options))
}

function localRunVerificationCommand(
  harness: Harness,
  options: { namespace?: string; release?: string } = {},
) {
  const parts = [
    'run',
    DEFAULT_SMOKE_PROMPT,
    '--local',
    '--harness',
    harness,
    '--expect',
    DEFAULT_SMOKE_EXPECT,
    '--release-thread',
  ]
  if (options.namespace && options.namespace !== 'centaur') parts.push('--namespace', options.namespace)
  if (options.release && options.release !== 'centaur') parts.push('--release', options.release)
  return commandLine(parts)
}

function smokeCommand(options: {
  namespace?: string
  release?: string
  harness?: Harness
  prompt?: string
  expect?: string
  timeoutSeconds?: number
} = {}) {
  const parts = ['smoke']
  if (options.namespace && options.namespace !== 'centaur') parts.push('--namespace', options.namespace)
  if (options.release && options.release !== 'centaur') parts.push('--release', options.release)
  if (options.harness && options.harness !== 'codex') parts.push('--harness', options.harness)
  if (options.prompt && options.prompt !== DEFAULT_SMOKE_PROMPT) parts.push('--prompt', options.prompt)
  if (options.expect && options.expect !== DEFAULT_SMOKE_EXPECT) parts.push('--expect', options.expect)
  if (options.timeoutSeconds && options.timeoutSeconds !== 300) {
    parts.push('--timeout-seconds', String(options.timeoutSeconds))
  }
  return commandLine(parts)
}

function slackbotSmokeCommand(options: {
  namespace?: string
  release?: string
  prompt?: string
  expect?: string
  teamId?: string
  channelId?: string
  userId?: string
  botUserId?: string
  timeoutSeconds?: number
} = {}) {
  const parts = ['slackbot', 'smoke']
  if (options.namespace && options.namespace !== 'centaur') parts.push('--namespace', options.namespace)
  if (options.release && options.release !== 'centaur') parts.push('--release', options.release)
  if (options.prompt && options.prompt !== DEFAULT_SMOKE_PROMPT) parts.push('--prompt', options.prompt)
  if (options.expect && options.expect !== DEFAULT_SMOKE_EXPECT) parts.push('--expect', options.expect)
  if (options.teamId && options.teamId !== 'TCLI') parts.push('--team-id', options.teamId)
  if (options.channelId && options.channelId !== 'CCLI') parts.push('--channel-id', options.channelId)
  if (options.userId && options.userId !== 'UCLI') parts.push('--user-id', options.userId)
  if (options.botUserId && options.botUserId !== 'UCENTAUR') parts.push('--bot-user-id', options.botUserId)
  if (options.timeoutSeconds && options.timeoutSeconds !== 300) {
    parts.push('--timeout-seconds', String(options.timeoutSeconds))
  }
  return commandLine(parts)
}

function harnessFromValuesFile(path: string): Harness {
  try {
    const match = /^\s*defaultHarness:\s*([A-Za-z0-9-]+)/m.exec(readFileSync(expandPath(path), 'utf8'))
    const harness = match?.[1]
    return HARNESSES.includes(harness as Harness) ? harness as Harness : 'codex'
  } catch {
    return 'codex'
  }
}

function deploySecretsFileForBackend(secretBackend: string, overlayPath: string) {
  return secretBackend === 'local-env' ? join(overlayPath, 'secrets.local.env') : undefined
}

function deploySecretsFileForDoctor(secretBackend: string, overlayPath: string, localEnvPath?: string) {
  return secretBackend === 'local-env'
    ? localEnvPath || deploySecretsFileForBackend(secretBackend, overlayPath)
    : deploySecretsFileForBackend(secretBackend, overlayPath)
}

type SetupPlanOptions = {
  org: string
  assistantName: string
  domain: string
  installMode: string
  imageSource: ImageSource
  backend: string
  harness: Harness
  authMode: string
  overlayPath: string
  bin?: string
}

function setupPlan(options: SetupPlanOptions) {
  const manifestPath = join(options.overlayPath, 'slack-app-manifest.json')
  const localSocketMode = options.installMode === 'local'
  const deployCommand = deploymentCommandForInstallMode(options.installMode, {
    apply: true,
    imageSource: options.imageSource,
    values: join(options.overlayPath, 'values.centaur.yaml'),
    secretsFile: deploySecretsFileForBackend(options.backend, options.overlayPath),
  })
  const centaurCommand = (command: string) => `${quotePart(options.bin || 'centaur')} ${command}`
  return {
    commands: [
      centaurCommand(commandLine([
        'init',
        '--org',
        options.org,
        '--assistant-name',
        options.assistantName,
        '--domain',
        options.domain,
        '--install-mode',
        options.installMode,
        '--image-source',
        options.imageSource,
        '--secret-backend',
        options.backend,
        '--harness',
        options.harness,
        '--auth-mode',
        options.authMode,
        '--overlay-path',
        options.overlayPath,
      ])),
      centaurCommand(commandLine([
        'integrations',
        'slack-manifest',
        '--domain',
        options.domain,
        '--app-name',
        options.assistantName,
        '--output',
        manifestPath,
        '--copy',
        ...(localSocketMode ? ['--socket-mode'] : []),
        '--backend',
        options.backend,
        '--install-mode',
        options.installMode,
        '--image-source',
        options.imageSource,
        '--harness',
        options.harness,
        '--auth-mode',
        options.authMode,
        '--overlay-path',
        options.overlayPath,
      ])),
      centaurCommand(commandLine([
        'secrets',
        'collect',
        '--backend',
        options.backend,
        '--install-mode',
        options.installMode,
        '--image-source',
        options.imageSource,
        '--harness',
        options.harness,
        '--auth-mode',
        options.authMode,
        '--overlay-path',
        options.overlayPath,
      ])),
      centaurCommand(commandLine([
        'doctor',
        '--deep',
        '--overlay-path',
        options.overlayPath,
        '--harness',
        options.harness,
        '--auth-mode',
        options.authMode,
        '--secret-backend',
        options.backend,
        '--install-mode',
        options.installMode,
        '--image-source',
        options.imageSource,
      ])),
      centaurCommand(deployCommand),
      centaurCommand(localRunVerificationCommand(options.harness)),
      centaurCommand(commandLine(['slackbot', 'smoke'])),
    ],
    harness: options.harness,
    authMode: options.authMode,
    note: 'Use exactly one default harness for the deployment: codex or claude-code. The local run and Slackbot smoke commands run through the Kubernetes pods and do not need a port-forward or external API key.',
  }
}

function setupPlanCta(plan: ReturnType<typeof setupPlan>, bin?: string) {
  if (bin && bin !== 'centaur') return undefined
  return {
    description: 'Run these setup commands in order:',
    commands: plan.commands.map(command => ({ command })),
  }
}

function deployApplyCommandParts(
  subcommand: 'k3s' | 'k8s' | 'kind',
  options: {
    clusterName?: string
    namespace: string
    release: string
    values: string
    imageSource: ImageSource
    secretsFile?: string
    secretName: string
    wait: boolean
    timeout: string
    updateDependencies: boolean
  },
) {
  const parts = ['deploy', subcommand]
  if (subcommand === 'kind' && options.clusterName && options.clusterName !== 'centaur') {
    parts.push('--cluster-name', options.clusterName)
  }
  parts.push(
    '--apply',
    '--namespace',
    options.namespace,
    '--release',
    options.release,
    '--values',
    options.values,
    '--image-source',
    options.imageSource,
  )
  if (options.secretsFile) {
    parts.push('--secrets-file', options.secretsFile)
    if (options.secretName !== 'centaur-infra-env') parts.push('--secret-name', options.secretName)
  }
  if (options.updateDependencies) parts.push('--update-dependencies')
  if (options.wait) parts.push('--wait', '--timeout', options.timeout)
  else parts.push('--no-wait')
  return parts
}

function deployCta(
  subcommand: 'k3s' | 'k8s' | 'kind',
  options: Parameters<typeof deployApplyCommandParts>[1] & { applied: boolean },
) {
  const harness = harnessFromValuesFile(options.values)
  const verificationCommands = [
    {
      command: localRunVerificationCommand(harness, options),
      description: 'run one verified Centaur turn through the local API pod',
    },
    {
      command: slackbotSmokeCommand(options),
      description: 'prove Slackbot can turn a signed Slack mention into a completed Centaur execution',
    },
  ]
  if (options.applied) {
    return {
      description: 'Next verification commands:',
      commands: verificationCommands,
    }
  }
  return {
    description: 'Next deployment commands:',
    commands: [
      {
        command: commandLine(deployApplyCommandParts(subcommand, options)),
        description: 'apply this deployment plan',
      },
      ...verificationCommands,
    ],
  }
}

function deployFailureCta(
  subcommand: 'k3s' | 'k8s' | 'kind',
  options: Parameters<typeof deployApplyCommandParts>[1],
) {
  return {
    description: 'Deploy failed; inspect and retry:',
    commands: [
      {
        command: commandLine([
          'doctor',
          '--deep',
          '--overlay-path',
          dirname(options.values),
          '--install-mode',
          subcommand === 'k8s' ? 'k8s' : 'local',
          '--image-source',
          options.imageSource,
        ]),
        description: 'recheck local tools, cluster access, and generated setup files',
      },
      {
        command: commandLine([
          'logs',
          '--component',
          'api',
          '--namespace',
          options.namespace,
          '--release',
          options.release,
        ]),
        description: 'inspect API logs if the release partially started',
      },
      {
        command: commandLine(deployApplyCommandParts(subcommand, options)),
        description: 'retry the same deploy command after fixing the error',
      },
    ],
  }
}

function supportsBrokeredTokenStore(secretBackend: string) {
  return secretBackend === 'onepassword' || secretBackend === 'onepassword-connect'
}

function brokeredTokenBackendCheck(secretBackend: string, authMode: string) {
  if (authMode !== 'access_token' || supportsBrokeredTokenStore(secretBackend)) return []
  return [
    {
      name: 'backend:brokered-token-store',
      ok: true,
      detail: `${secretBackend} can bootstrap access_token auth, but production refresh-token rotation needs onepassword or onepassword-connect`,
    },
  ]
}

function runCommand(command: string[], inputBytes?: Buffer) {
  const proc = spawnSync(command[0]!, command.slice(1), {
    encoding: 'utf8',
    input: inputBytes,
    stdio: inputBytes ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
  })
  if (proc.status !== 0) {
    throw new Error(`${commandLine(command)} failed: ${(proc.stderr || proc.stdout || '').trim()}`)
  }
  return proc.stdout
}

function isYamlPipeSource(command: string[]) {
  return command[0] === 'kubectl' && command.includes('--dry-run=client') && command.at(-2) === '-o' && command.at(-1) === 'yaml'
}

function isKubectlApplyStdin(command: string[]) {
  return command[0] === 'kubectl' && command[1] === 'apply' && command[2] === '-f' && command[3] === '-'
}

function runDeploymentCommands(commands: string[][]) {
  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index]!
    const next = commands[index + 1]
    if (next && isYamlPipeSource(command) && isKubectlApplyStdin(next)) {
      runCommand(next, Buffer.from(runCommand(command)))
      index += 1
      continue
    }
    runCommand(command)
  }
}

function formatDeploymentCommands(commands: string[][]) {
  const formatted: string[] = []
  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index]!
    const next = commands[index + 1]
    if (next && isYamlPipeSource(command) && isKubectlApplyStdin(next)) {
      formatted.push(`${commandLine(command)} | ${commandLine(next)}`)
      index += 1
      continue
    }
    formatted.push(commandLine(command))
  }
  return formatted
}

type LogOptions = {
  component: string
  namespace: string
  release: string
  tail: number
  follow?: boolean
  previous?: boolean
}

export function componentLogCommand(options: LogOptions) {
  return [
    'kubectl',
    'logs',
    '-n',
    options.namespace,
    `deploy/${options.release}-centaur-${options.component}`,
    `--tail=${options.tail}`,
    ...(options.previous ? ['--previous'] : []),
    ...(options.follow ? ['-f'] : []),
  ]
}

export function readComponentLogs(
  options: LogOptions,
  runner: SmokeRunner = runCommand,
) {
  const command = componentLogCommand(options)
  return {
    command: commandLine(command),
    component: options.component,
    namespace: options.namespace,
    release: options.release,
    tail: options.tail,
    previous: Boolean(options.previous),
    follow: Boolean(options.follow),
    output: options.follow ? '' : runner(command),
  }
}

function runInteractive(command: string[]) {
  const proc = spawnSync(command[0]!, command.slice(1), { stdio: 'inherit' })
  return proc.status === 0
}

type SmokeRunner = (command: string[], inputBytes?: Buffer) => string

type ClusterSmokeOptions = {
  namespace: string
  release: string
  harness: string
  prompt: string
  expectText: string
  threadKey?: string
  timeoutSeconds?: number
  pollMs?: number
  releaseThread?: boolean
}

type ClusterTurnOptions = {
  namespace: string
  release: string
  prompt: string
  harness?: string
  engine?: string
  personaId?: string
  threadKey?: string
  timeoutSeconds?: number
  pollMs?: number
  releaseThread?: boolean
  platform?: string
}

type SlackbotSmokeOptions = {
  namespace: string
  release: string
  prompt: string
  expectText: string
  teamId?: string
  channelId?: string
  userId?: string
  botUserId?: string
  threadTs?: string
  timeoutSeconds?: number
  pollMs?: number
  releaseThread?: boolean
}

function kubectlApiCurlCommand(
  options: { namespace: string; release: string; method: string; path: string; body?: Record<string, unknown> },
) {
  const curl = [
    'curl',
    '-fsS',
    '-X',
    quotePart(options.method),
    quotePart(`http://localhost:8000${options.path}`),
    '-H',
    '"Authorization: Bearer $API_KEY"',
    '-H',
    '"X-Api-Key: $API_KEY"',
  ]
  if (options.body !== undefined) {
    curl.push('-H', quotePart('Content-Type: application/json'), '-d', quotePart(JSON.stringify(options.body)))
  }
  const script = [
    'API_KEY="${SLACKBOT_API_KEY:-${CENTAUR_API_KEY:-}}"',
    'if [ -z "$API_KEY" ]; then echo "SLACKBOT_API_KEY or CENTAUR_API_KEY is missing in the API pod" >&2; exit 64; fi',
    curl.join(' '),
  ].join('; ')
  return [
    'kubectl',
    'exec',
    '-n',
    options.namespace,
    `deploy/${options.release}-centaur-api`,
    '--',
    'sh',
    '-lc',
    script,
  ]
}

function kubectlSlackbotSignedEventCommand(options: {
  namespace: string
  release: string
  payload: Record<string, unknown>
  path?: string
}) {
  const body = JSON.stringify(options.payload)
  const script = `
const crypto = require('node:crypto')
const secret = process.env.SLACK_SIGNING_SECRET || ''
if (!secret) {
  console.error('SLACK_SIGNING_SECRET is missing in the Slackbot pod')
  process.exit(64)
}
const timestamp = Math.floor(Date.now() / 1000).toString()
const body = ${JSON.stringify(body)}
const signature = 'v0=' + crypto.createHmac('sha256', secret).update('v0:' + timestamp + ':' + body).digest('hex')
const response = await fetch('http://localhost:3001${options.path || '/api/webhooks/slack'}', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-slack-request-timestamp': timestamp,
    'x-slack-signature': signature
  },
  body
})
console.log(JSON.stringify({ status: response.status, text: await response.text() }))
`.trim()
  return [
    'kubectl',
    'exec',
    '-n',
    options.namespace,
    `deploy/${options.release}-centaur-slackbot`,
    '--',
    'bun',
    '-e',
    script,
  ]
}

function sleepMs(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function kubectlApiJson<T>(
  runner: SmokeRunner,
  options: { namespace: string; release: string; method: string; path: string; body?: Record<string, unknown> },
) {
  return JSON.parse(runner(kubectlApiCurlCommand(options))) as T
}

export function runClusterTurn(
  options: ClusterTurnOptions,
  runner: SmokeRunner = runCommand,
) {
  const threadPrefix = options.platform === 'cli-smoke' ? 'cli:smoke' : 'cli:run'
  const threadKey = options.threadKey || `${threadPrefix}:${Date.now()}`
  const phases: Record<string, unknown>[] = []
  const base = { namespace: options.namespace, release: options.release }
  const push = (phase: Record<string, unknown>) => {
    phases.push(phase)
    return phase
  }

  const spawnBody: Record<string, unknown> = { thread_key: threadKey }
  if (options.harness) spawnBody.harness = options.harness
  if (options.engine) spawnBody.engine = options.engine
  if (options.personaId) spawnBody.persona_id = options.personaId
  const spawn = kubectlApiJson<Record<string, unknown>>(runner, {
    ...base,
    method: 'POST',
    path: '/agent/spawn',
    body: spawnBody,
  })
  const assignmentGeneration = Number(spawn.assignment_generation)
  push({
    phase: 'spawned',
    threadKey,
    assignmentGeneration,
    runtimeId: spawn.runtime_id,
  })

  const message = kubectlApiJson<Record<string, unknown>>(runner, {
    ...base,
    method: 'POST',
    path: '/agent/message',
    body: {
      thread_key: threadKey,
      assignment_generation: assignmentGeneration,
      role: 'user',
      parts: [{ type: 'text', text: options.prompt }],
      metadata: { platform: options.platform || 'cli-local' },
    },
  })
  push({ phase: 'message_persisted', messageId: message.message_id })

  const executeBody: Record<string, unknown> = {
    thread_key: threadKey,
    assignment_generation: assignmentGeneration,
    delivery: { platform: options.platform || 'cli-local' },
    metadata: { platform: options.platform || 'cli-local' },
  }
  if (options.harness) executeBody.harness = options.harness
  const execute = kubectlApiJson<Record<string, unknown>>(runner, {
    ...base,
    method: 'POST',
    path: '/agent/execute',
    body: executeBody,
  })
  const executionId = String(execute.execution_id)
  push({ phase: 'execution_queued', executionId, status: execute.status })

  const deadline = Date.now() + (options.timeoutSeconds || 300) * 1000
  const pollMs = options.pollMs || 1000
  let finalState: Record<string, unknown> = {}
  for (;;) {
    finalState = kubectlApiJson<Record<string, unknown>>(runner, {
      ...base,
      method: 'GET',
      path: `/agent/executions/${encodeURIComponent(executionId)}`,
    })
    const status = String(finalState.status || '')
    push({
      phase: 'execution_state',
      executionId,
      status,
      resultText: finalState.result_text,
    })
    if (['completed', 'failed', 'cancelled', 'timed_out'].includes(status)) break
    if (Date.now() >= deadline) {
      finalState = { ...finalState, status: status || 'timeout', error: 'timed out waiting for execution' }
      break
    }
    sleepMs(pollMs)
  }
  push({ phase: 'final_state', executionId, state: finalState })

  let release: Record<string, unknown> | undefined
  if (options.releaseThread) {
    release = kubectlApiJson<Record<string, unknown>>(runner, {
      ...base,
      method: 'POST',
      path: `/agent/threads/${encodeURIComponent(threadKey)}/release`,
      body: { cancel_inflight: false },
    })
    push({ phase: 'thread_released', released: release.released })
  }

  const status = String(finalState.status || '')
  const resultText = String(finalState.result_text || '')
  return {
    threadKey,
    assignmentGeneration,
    executionId,
    status,
    resultText,
    finalState,
    release,
    phases,
  }
}

export function runClusterSmoke(
  options: ClusterSmokeOptions,
  runner: SmokeRunner = runCommand,
) {
  const result = runClusterTurn({
    namespace: options.namespace,
    release: options.release,
    harness: options.harness,
    prompt: options.prompt,
    threadKey: options.threadKey,
    timeoutSeconds: options.timeoutSeconds,
    pollMs: options.pollMs,
    releaseThread: options.releaseThread !== false,
    platform: 'cli-smoke',
  }, runner)
  const ok = result.status === 'completed' && result.resultText.includes(options.expectText)
  return {
    ok,
    ...result,
    expectedText: options.expectText,
  }
}

function timestampLike() {
  const seconds = Math.floor(Date.now() / 1000)
  const micros = randomBytes(3).readUIntBE(0, 3) % 1_000_000
  return `${seconds}.${micros.toString().padStart(6, '0')}`
}

function workflowExecutionId(run: Record<string, unknown>) {
  if (typeof run.execution_id === 'string' && run.execution_id) return run.execution_id
  const waitingOn = run.waiting_on
  if (waitingOn && typeof waitingOn === 'object' && !Array.isArray(waitingOn)) {
    const executionId = (waitingOn as Record<string, unknown>).execution_id
    if (typeof executionId === 'string' && executionId) return executionId
  }
  return ''
}

export function runSlackbotSmoke(
  options: SlackbotSmokeOptions,
  runner: SmokeRunner = runCommand,
) {
  const teamId = options.teamId || 'TCLI'
  const channelId = options.channelId || 'CCLI'
  const userId = options.userId || 'UCLI'
  const botUserId = options.botUserId || 'UCENTAUR'
  const threadTs = options.threadTs || timestampLike()
  const eventId = `Ev-centaur-cli-${threadTs.replace(/\W/g, '')}`
  const threadKey = `slack:${teamId}:${channelId}:${threadTs}`
  const promptText = `<@${botUserId}> ${options.prompt}`
  const payload = {
    type: 'event_callback',
    token: 'centaur-cli-smoke',
    team_id: teamId,
    api_app_id: 'ACENTAURCLI',
    event_id: eventId,
    event_time: Math.floor(Date.now() / 1000),
    event: {
      type: 'app_mention',
      user: userId,
      channel: channelId,
      ts: threadTs,
      text: promptText,
    },
  }
  const phases: Record<string, unknown>[] = []
  const push = (phase: Record<string, unknown>) => {
    phases.push(phase)
    return phase
  }

  const webhook = JSON.parse(runner(kubectlSlackbotSignedEventCommand({
    namespace: options.namespace,
    release: options.release,
    payload,
  }))) as { status: number; text: string }
  push({
    phase: 'slackbot_webhook',
    status: webhook.status,
    accepted: webhook.status >= 200 && webhook.status < 300,
  })

  const deadline = Date.now() + (options.timeoutSeconds || 300) * 1000
  const pollMs = options.pollMs || 1000
  let workflowRun: Record<string, unknown> | undefined
  let executionId = ''
  let finalState: Record<string, unknown> = {}

  for (;;) {
    const runs = kubectlApiJson<{ items?: Record<string, unknown>[] }>(runner, {
      namespace: options.namespace,
      release: options.release,
      method: 'GET',
      path: `/workflows/runs?thread_key=${encodeURIComponent(threadKey)}&limit=5`,
    })
    workflowRun = runs.items?.[0]
    if (workflowRun) {
      executionId = workflowExecutionId(workflowRun)
      push({
        phase: 'workflow_state',
        runId: workflowRun.run_id,
        status: workflowRun.status,
        executionId: executionId || undefined,
      })
      if (executionId) break
      if (['completed', 'failed', 'cancelled'].includes(String(workflowRun.status || ''))) break
    }
    if (Date.now() >= deadline) break
    sleepMs(pollMs)
  }

  if (executionId) {
    for (;;) {
      finalState = kubectlApiJson<Record<string, unknown>>(runner, {
        namespace: options.namespace,
        release: options.release,
        method: 'GET',
        path: `/agent/executions/${encodeURIComponent(executionId)}`,
      })
      const status = String(finalState.status || '')
      push({
        phase: 'execution_state',
        executionId,
        status,
        resultText: finalState.result_text,
      })
      if (['completed', 'failed', 'cancelled', 'timed_out'].includes(status)) break
      if (Date.now() >= deadline) {
        finalState = { ...finalState, status: status || 'timeout', error: 'timed out waiting for execution' }
        break
      }
      sleepMs(pollMs)
    }
  }

  let release: Record<string, unknown> | undefined
  if (executionId && options.releaseThread !== false) {
    release = kubectlApiJson<Record<string, unknown>>(runner, {
      namespace: options.namespace,
      release: options.release,
      method: 'POST',
      path: `/agent/threads/${encodeURIComponent(threadKey)}/release`,
      body: { cancel_inflight: false },
    })
    push({ phase: 'thread_released', released: release.released })
  }

  const status = String(finalState.status || workflowRun?.status || '')
  const resultText = String(finalState.result_text || '')
  const ok = Boolean(executionId) && status === 'completed' && resultText.includes(options.expectText)
  return {
    ok,
    webhook,
    webhookAccepted: webhook.status >= 200 && webhook.status < 300,
    threadKey,
    messageId: `slack:${teamId}:${channelId}:${threadTs}`,
    eventId,
    workflowRunId: workflowRun?.run_id,
    workflowStatus: workflowRun?.status,
    executionId,
    status,
    resultText,
    expectedText: options.expectText,
    finalState,
    release,
    phases,
    note:
      webhook.status >= 200 && webhook.status < 300
        ? 'Slackbot webhook acknowledged the synthetic signed Slack event.'
        : 'The webhook did not acknowledge before timeout, but the workflow/execution result still proves Slackbot processed the event. Check Slack credentials if Slack delivery also needs verification.',
  }
}

async function collectCodexSubscriptionSecrets(promptUser: boolean): Promise<SecretMap> {
  let clientId = process.env.OPENAI_CODEX_CLIENT_ID || ''
  let refreshToken = ''
  let accountId = ''
  if (promptUser) {
    const existing = readCodexSubscriptionAuth()
    refreshToken = existing.refreshToken
    accountId = existing.accountId
    clientId = clientId || existing.clientId || discoverCodexOAuthClientIdFromCli()
    if ((!refreshToken || !accountId) && commandExists('codex')) {
      console.log('  Running codex login now. Complete the browser/device flow, then return here.')
      runInteractive(['codex', 'login'])
      const updated = readCodexSubscriptionAuth()
      refreshToken = updated.refreshToken
      accountId = updated.accountId
      clientId = clientId || updated.clientId || discoverCodexOAuthClientIdFromCli()
    } else if (!refreshToken || !accountId) {
      console.log('  codex is not installed or not on PATH; falling back to manual token prompts.')
    } else {
      console.log('  Found existing Codex ChatGPT login; using ~/.codex/auth.json.')
    }
    if (clientId) console.log('  Found Codex OAuth client id from installed codex CLI metadata.')
  }
  clientId = clientId || discoverCodexOAuthClientIdFromCli()
  clientId =
    clientId ||
    (await askSecret('OPENAI_CODEX_CLIENT_ID', {
      nonInteractive: !promptUser,
      required: true,
    }))
  refreshToken = refreshToken || (await askSecret('OPENAI_CODEX refresh token', { nonInteractive: !promptUser, required: true }))
  accountId = accountId || (await askSecret('OPENAI_CODEX account id', { nonInteractive: !promptUser, required: true }))
  return {
    OPENAI_CODEX_CLIENT_ID: clientId,
    OPENAI_CODEX_BLOB: JSON.stringify({ refresh_token: refreshToken }),
    OPENAI_CODEX_ACCOUNT_ID: accountId,
  }
}

async function collectClaudeSubscriptionSecrets(promptUser: boolean): Promise<SecretMap> {
  let clientId = process.env.CLAUDE_CODE_CLIENT_ID || ''
  let refreshToken = ''
  if (promptUser) {
    const existing = readClaudeSubscriptionAuth()
    refreshToken = existing.refreshToken
    clientId = clientId || existing.clientId || discoverClaudeOAuthClientIdFromCli()
    if (!refreshToken && commandExists('claude')) {
      console.log('  Running claude login now. Complete the browser/device flow, then return here.')
      runInteractive(['claude', 'login'])
      const updated = readClaudeSubscriptionAuth()
      refreshToken = updated.refreshToken
      clientId = clientId || updated.clientId || discoverClaudeOAuthClientIdFromCli()
    } else if (!refreshToken) {
      console.log('  claude is not installed or not on PATH; falling back to manual token prompts.')
    } else {
      console.log('  Found existing Claude Code login; using local credentials.')
    }
    if (clientId) console.log('  Found Claude Code OAuth client id from installed claude CLI metadata.')
  }
  clientId = clientId || discoverClaudeOAuthClientIdFromCli()
  clientId =
    clientId ||
    (await askSecret('CLAUDE_CODE_CLIENT_ID', {
      nonInteractive: !promptUser,
      required: true,
    }))
  refreshToken = refreshToken || (await askSecret('CLAUDE_CODE refresh token', { nonInteractive: !promptUser, required: true }))
  return {
    CLAUDE_CODE_CLIENT_ID: clientId,
    CLAUDE_CODE_BLOB: JSON.stringify({ refresh_token: refreshToken }),
  }
}

async function collectWizardSecrets(state: {
  installMode: string
  harness: Harness
  authMode: string
}, promptUser: boolean) {
  const secrets: SecretMap = {}
  secrets.SLACK_BOT_TOKEN = await askSecret('SLACK_BOT_TOKEN', {
    nonInteractive: !promptUser,
    required: true,
  })
  secrets.SLACK_SIGNING_SECRET = await askSecret('SLACK_SIGNING_SECRET', {
    nonInteractive: !promptUser,
    required: true,
  })
  if (state.installMode === 'local') {
    secrets.SLACK_APP_TOKEN = await askSecret('SLACK_APP_TOKEN', {
      nonInteractive: !promptUser,
      required: true,
    })
  }
  if (state.harness === 'codex' && state.authMode === 'api_key') {
    secrets.OPENAI_API_KEY = await askSecret('OPENAI_API_KEY', {
      nonInteractive: !promptUser,
      required: true,
    })
  } else if (state.harness === 'codex') {
    Object.assign(secrets, await collectCodexSubscriptionSecrets(promptUser))
  } else if (state.authMode === 'api_key') {
    secrets.ANTHROPIC_API_KEY = await askSecret('ANTHROPIC_API_KEY', {
      nonInteractive: !promptUser,
      required: true,
    })
  } else {
    Object.assign(secrets, await collectClaudeSubscriptionSecrets(promptUser))
  }
  secrets.POSTGRES_PASSWORD = await askSecret('POSTGRES_PASSWORD', {
    nonInteractive: !promptUser,
    defaultValue: DEFAULT_POSTGRES_PASSWORD,
    required: true,
  })
  secrets.DATABASE_URL = await askSecret('DATABASE_URL', {
    nonInteractive: !promptUser,
    defaultValue: defaultDatabaseUrl(secrets.POSTGRES_PASSWORD),
    required: true,
  })
  secrets.IRON_MANAGEMENT_API_KEY = await askSecret('IRON_MANAGEMENT_API_KEY', {
    nonInteractive: !promptUser,
    defaultValue: generatedSecret(),
    required: true,
  })
  secrets.SANDBOX_SIGNING_KEY = await askSecret('SANDBOX_SIGNING_KEY', {
    nonInteractive: !promptUser,
    defaultValue: generatedSecret(),
    required: true,
  })
  secrets.SLACKBOT_API_KEY = await askSecret('SLACKBOT_API_KEY', {
    nonInteractive: !promptUser,
    defaultValue: generatedSecret(),
    required: true,
  })
  return secrets
}

function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required in the environment`)
  return value
}

function requireValue(name: string, value: string) {
  if (!value) throw new Error(`${name} is required in the environment or local CLI auth state`)
  return value
}

type CodexSubscriptionAuth = ReturnType<typeof readCodexSubscriptionAuth>
type ClaudeSubscriptionAuth = ReturnType<typeof readClaudeSubscriptionAuth>

type MissingSecretInput = {
  env: string
  alternatives?: string[]
  source?: string
}

function secretsCollectCommandParts(options: {
  backend: string
  installMode: string
  imageSource: ImageSource
  harness: Harness
  authMode: string
  overlayPath: string
  fromEnv?: boolean
  localEnvPath?: string
  kubernetesNamespace?: string
  kubernetesSecretName?: string
  onePasswordVault?: string
  sopsPath?: string
  vaultPath?: string
}) {
  const parts = [
    'secrets',
    'collect',
    '--backend',
    options.backend,
    '--install-mode',
    options.installMode,
    '--image-source',
    options.imageSource,
    '--harness',
    options.harness,
    '--auth-mode',
    options.authMode,
    '--overlay-path',
    options.overlayPath,
  ]
  if (options.fromEnv) parts.push('--from-env')
  if (options.localEnvPath) parts.push('--local-env-path', options.localEnvPath)
  if (options.kubernetesNamespace) parts.push('--kubernetes-namespace', options.kubernetesNamespace)
  if (options.kubernetesSecretName) parts.push('--kubernetes-secret-name', options.kubernetesSecretName)
  if (options.onePasswordVault) parts.push('--one-password-vault', options.onePasswordVault)
  if (options.sopsPath) parts.push('--sops-path', options.sopsPath)
  if (options.vaultPath) parts.push('--vault-path', options.vaultPath)
  return parts
}

function missingSecretInputsFromEnv(state: {
  installMode: string
  harness: Harness
  authMode: string
}) {
  const missing: MissingSecretInput[] = []
  const requireEnvInput = (env: string, options: Omit<MissingSecretInput, 'env'> = {}) => {
    if (!process.env[env]) missing.push({ env, ...options })
  }

  requireEnvInput('SLACK_BOT_TOKEN')
  requireEnvInput('SLACK_SIGNING_SECRET')
  if (state.installMode === 'local') requireEnvInput('SLACK_APP_TOKEN')

  if (state.harness === 'codex' && state.authMode === 'api_key') {
    requireEnvInput('OPENAI_API_KEY')
  } else if (state.harness === 'codex') {
    const auth = readCodexSubscriptionAuth()
    const cliClientId = discoverCodexOAuthClientIdFromCli()
    if (!(process.env.OPENAI_CODEX_CLIENT_ID || auth.clientId || cliClientId)) {
      missing.push({
        env: 'OPENAI_CODEX_CLIENT_ID',
        source: 'installed codex CLI metadata can satisfy this automatically',
      })
    }
    if (!(process.env.OPENAI_CODEX_BLOB || process.env.OPENAI_CODEX_REFRESH_TOKEN || auth.refreshToken)) {
      missing.push({
        env: 'OPENAI_CODEX_BLOB',
        alternatives: ['OPENAI_CODEX_REFRESH_TOKEN'],
        source: '~/.codex/auth.json refresh_token can satisfy this automatically',
      })
    }
    if (!(process.env.OPENAI_CODEX_ACCOUNT_ID || auth.accountId)) {
      missing.push({
        env: 'OPENAI_CODEX_ACCOUNT_ID',
        source: '~/.codex/auth.json account_id can satisfy this automatically',
      })
    }
  } else if (state.authMode === 'api_key') {
    requireEnvInput('ANTHROPIC_API_KEY')
  } else {
    const auth = readClaudeSubscriptionAuth()
    const cliClientId = discoverClaudeOAuthClientIdFromCli()
    if (!(process.env.CLAUDE_CODE_CLIENT_ID || auth.clientId || cliClientId)) {
      missing.push({
        env: 'CLAUDE_CODE_CLIENT_ID',
        source: 'installed claude CLI metadata can satisfy this automatically',
      })
    }
    if (!(process.env.CLAUDE_CODE_BLOB || process.env.CLAUDE_CODE_REFRESH_TOKEN || auth.refreshToken)) {
      missing.push({
        env: 'CLAUDE_CODE_BLOB',
        alternatives: ['CLAUDE_CODE_REFRESH_TOKEN'],
        source: 'local Claude Code credentials can satisfy this automatically',
      })
    }
  }

  return missing
}

function secretBackendChecks(options: {
  backend: SecretBackend
  harness: Harness
  authMode: AuthMode
  overlayPath: string
  localEnvPath?: string
  installMode?: InstallMode
}) {
  if (options.backend === 'onepassword') {
    return [
      commandCheck('1password:op', ['op', 'vault', 'list'], 'Set OP_SERVICE_ACCOUNT_TOKEN and run op vault list.'),
    ]
  }
  if (options.backend === 'onepassword-connect') {
    return [
      {
        name: 'env:OP_CONNECT_TOKEN',
        ok: Boolean(process.env.OP_CONNECT_TOKEN),
        detail: process.env.OP_CONNECT_TOKEN ? 'set' : 'missing',
        repair: 'Set OP_CONNECT_TOKEN for 1Password Connect.',
      },
      {
        name: 'env:OP_VAULT',
        ok: Boolean(process.env.OP_VAULT),
        detail: process.env.OP_VAULT ? 'set' : 'missing',
        repair: 'Set OP_VAULT to the vault name or id.',
      },
    ]
  }
  if (options.backend === 'sops') {
    return [
      commandCheck('sops:version', ['sops', '--version'], 'Install sops.'),
      commandCheck('age:version', ['age', '--version'], 'Install age and generate a key.'),
    ]
  }
  if (options.backend === 'kubernetes') {
    return [
      commandCheck('kubectl:secrets', ['kubectl', 'get', 'secret', '-A'], 'Create Kubernetes secrets or configure cluster access.'),
    ]
  }
  const env =
    options.backend === 'local-env'
      ? {
          ...process.env,
          ...readDotenvFile(options.localEnvPath || defaultSecretTarget('local-env', options.overlayPath)),
        }
      : process.env
  return envChecks(env, {
    harness: options.harness,
    authMode: options.authMode,
    installMode: options.installMode,
  })
}

export function codexSubscriptionSecretsFromSources(
  env: NodeJS.ProcessEnv,
  auth: CodexSubscriptionAuth,
  cliClientId = '',
) {
  const refreshToken = env.OPENAI_CODEX_REFRESH_TOKEN || auth.refreshToken
  return {
    OPENAI_CODEX_CLIENT_ID: requireValue(
      'OPENAI_CODEX_CLIENT_ID',
      env.OPENAI_CODEX_CLIENT_ID || auth.clientId || cliClientId,
    ),
    OPENAI_CODEX_BLOB: requireValue(
      'OPENAI_CODEX_BLOB',
      env.OPENAI_CODEX_BLOB || (refreshToken ? JSON.stringify({ refresh_token: refreshToken }) : ''),
    ),
    OPENAI_CODEX_ACCOUNT_ID: requireValue(
      'OPENAI_CODEX_ACCOUNT_ID',
      env.OPENAI_CODEX_ACCOUNT_ID || auth.accountId,
    ),
  }
}

export function claudeSubscriptionSecretsFromSources(
  env: NodeJS.ProcessEnv,
  auth: ClaudeSubscriptionAuth,
  cliClientId = '',
) {
  const refreshToken = env.CLAUDE_CODE_REFRESH_TOKEN || auth.refreshToken
  return {
    CLAUDE_CODE_CLIENT_ID: requireValue(
      'CLAUDE_CODE_CLIENT_ID',
      env.CLAUDE_CODE_CLIENT_ID || auth.clientId || cliClientId,
    ),
    CLAUDE_CODE_BLOB: requireValue(
      'CLAUDE_CODE_BLOB',
      env.CLAUDE_CODE_BLOB || (refreshToken ? JSON.stringify({ refresh_token: refreshToken }) : ''),
    ),
  }
}

function collectSecretsFromEnv(state: {
  installMode: string
  harness: Harness
  authMode: string
}) {
  const secrets: SecretMap = {
    SLACK_BOT_TOKEN: requireEnv('SLACK_BOT_TOKEN'),
    SLACK_SIGNING_SECRET: requireEnv('SLACK_SIGNING_SECRET'),
    POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD || DEFAULT_POSTGRES_PASSWORD,
    DATABASE_URL:
      process.env.DATABASE_URL ||
      defaultDatabaseUrl(process.env.POSTGRES_PASSWORD || DEFAULT_POSTGRES_PASSWORD),
    IRON_MANAGEMENT_API_KEY: process.env.IRON_MANAGEMENT_API_KEY || generatedSecret(),
    SANDBOX_SIGNING_KEY: process.env.SANDBOX_SIGNING_KEY || generatedSecret(),
    SLACKBOT_API_KEY: process.env.SLACKBOT_API_KEY || generatedSecret(),
  }
  if (state.installMode === 'local') secrets.SLACK_APP_TOKEN = requireEnv('SLACK_APP_TOKEN')
  if (state.harness === 'codex' && state.authMode === 'api_key') {
    secrets.OPENAI_API_KEY = requireEnv('OPENAI_API_KEY')
  } else if (state.harness === 'codex') {
    Object.assign(
      secrets,
      codexSubscriptionSecretsFromSources(
        process.env,
        readCodexSubscriptionAuth(),
        discoverCodexOAuthClientIdFromCli(),
      ),
    )
  } else if (state.authMode === 'api_key') {
    secrets.ANTHROPIC_API_KEY = requireEnv('ANTHROPIC_API_KEY')
  } else {
    Object.assign(
      secrets,
      claudeSubscriptionSecretsFromSources(
        process.env,
        readClaudeSubscriptionAuth(),
        discoverClaudeOAuthClientIdFromCli(),
      ),
    )
  }
  return secrets
}

async function collectBackendOptions(
  backend: string,
  overlayPath: string,
  promptUser: boolean,
): Promise<SecretBackendOptions> {
  if (backend === 'local-env') {
    return {
      localEnvPath: await ask(
        'Local secrets file',
        defaultSecretTarget('local-env', overlayPath),
        !promptUser,
      ),
    }
  }
  if (backend === 'sops') {
    return {
      sopsPath: await ask('SOPS encrypted secrets file', defaultSecretTarget('sops', overlayPath), !promptUser),
    }
  }
  if (backend === 'kubernetes') {
    return {
      kubernetesNamespace: await ask('Kubernetes namespace for the Secret', 'centaur', !promptUser),
      kubernetesSecretName: await ask('Kubernetes Secret name', 'centaur-infra-env', !promptUser),
    }
  }
  if (backend === 'onepassword' || backend === 'onepassword-connect') {
    return {
      onePasswordVault: await ask('1Password vault name or id', process.env.OP_VAULT || 'centaur', !promptUser),
    }
  }
  if (backend === 'vault') {
    return {
      vaultPath: await ask('Vault KV path', defaultSecretTarget('vault', overlayPath), !promptUser),
    }
  }
  return {}
}

const overlay = Cli.create('overlay', {
  description: 'Create and validate Centaur overlays',
})
  .command('init', {
    description: 'Scaffold a Centaur overlay repo.',
    options: z.object({
      path: z.string().default('org').describe('Overlay directory'),
      org: z.string().default('acme').describe('Organization name'),
      assistantName: z.string().default('centaur').describe('Assistant name'),
      domain: z.string().default('centaur.example.com').describe('Deployment domain'),
      harness: harnessSchema.default('codex').describe('Default harness'),
      authMode: authModeSchema.default('api_key').describe('Auth mode for the selected harness'),
      secretBackend: secretBackendSchema.default('local-env').describe('Secret backend'),
      socketMode: z.boolean().default(false).describe('Generate Slack manifest for Socket Mode'),
    }),
    run(c) {
      const written = writeOverlay({
        path: c.options.path,
        org: c.options.org,
        assistantName: c.options.assistantName,
        domain: c.options.domain,
        harness: c.options.harness,
        authMode: c.options.authMode,
        secretBackend: c.options.secretBackend,
      })
      const manifestPath = writeSlackManifest(
        join(expandPath(c.options.path), 'slack-app-manifest.json'),
        c.options.assistantName,
        c.options.domain,
        c.options.socketMode,
      )
      const auth = harnessAuthPlan(c.options.harness, c.options.authMode)
      return {
        overlayPath: expandPath(c.options.path),
        created: [...written, manifestPath],
        auth,
      }
    },
  })
  .command('validate', {
    description: 'Validate required overlay files.',
    options: z.object({
      path: z.string().default('org').describe('Overlay directory'),
    }),
    run(c) {
      const results = overlayChecks(c.options.path)
      const ok = allOk(results)
      setFailedExit(ok)
      return { ok, results }
    },
  })

const integrations = Cli.create('integrations', {
  description: 'Generate and verify integration setup',
})
  .command('slack-manifest', {
    description: 'Generate the Slack app manifest with scopes, events, commands, and interactivity.',
    options: z.object({
      domain: z.string().default('centaur.example.com').describe('Public Centaur domain'),
      appName: z.string().default('centaur').describe('Slack app name'),
      socketMode: z.boolean().default(false).describe('Use Socket Mode instead of public request URLs; automatically enabled for local install mode'),
      output: z.string().optional().describe('Write manifest to a file'),
      copy: z.boolean().default(false).describe('Copy manifest JSON to the system clipboard'),
      backend: secretBackendSchema.default('local-env').describe('Secret backend for the next secrets step'),
      installMode: installModeSchema.default('local').describe('Install mode for the next secrets step'),
      imageSource: imageSourceSchema.default('ghcr').describe('Container image source for the next deploy step'),
      harness: harnessSchema.default('codex').describe('Selected default harness'),
      authMode: authModeSchema.default('api_key').describe('Auth mode for the selected harness'),
      overlayPath: z.string().default('org').describe('Overlay path for the next secrets step'),
    }),
    run(c) {
      const socketMode = c.options.socketMode || c.options.installMode === 'local'
      const manifest = slackManifest(c.options.appName, c.options.domain, socketMode)
      const outputPath = c.options.output
        ? writeSlackManifest(c.options.output, c.options.appName, c.options.domain, socketMode)
        : undefined
      const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`
      const clipboard = c.options.copy ? copyToClipboard(manifestJson) : undefined
      return c.ok(
        {
          manifest,
          socketMode,
          outputPath,
          copied: clipboard?.ok ?? false,
          clipboardCommand: clipboard?.command || undefined,
          requiredBotScopes: [...SLACK_SCOPES],
          requiredSecrets: socketMode
            ? ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'SLACK_APP_TOKEN']
            : ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET'],
          optionalSecrets: socketMode ? [] : ['SLACK_APP_TOKEN'],
          userStep: clipboard?.ok
            ? socketMode
              ? 'Open https://api.slack.com/apps, create an app from manifest, alt-tab, paste, then generate an app-level token for Socket Mode.'
              : 'Open https://api.slack.com/apps, create an app from manifest, alt-tab, and paste.'
            : socketMode
              ? 'Open https://api.slack.com/apps, paste the manifest JSON or output file contents, then generate an app-level token for Socket Mode.'
              : 'Open https://api.slack.com/apps and paste the returned manifest JSON or the output file contents.',
          nextCommand: `centaur ${commandLine(secretsCollectCommandParts(c.options))}`,
        },
        {
          cta: {
            description: 'After installing the Slack app:',
            commands: [
              {
                command: commandLine(secretsCollectCommandParts(c.options)),
                description: 'prompt for Slack, harness, and infra secrets and write them to the backend',
              },
            ],
          },
        },
      )
    },
  })
  .command('harness-auth', {
    description: 'Show api_key vs subscription access_token setup for one selected harness.',
    options: z.object({
      harness: harnessSchema.default('codex').describe('Harness to configure'),
      authMode: authModeSchema.default('api_key').describe('Auth mode for the selected harness'),
    }),
    run(c) {
      return harnessAuthPlan(c.options.harness, c.options.authMode)
    },
  })
  .command('setup', {
    description: 'Return the agent-driven setup command chain for Slack, secrets, validation, and deploy.',
    options: z.object({
      org: z.string().default('acme').describe('Organization name'),
      assistantName: z.string().default('centaur').describe('Assistant display name'),
      domain: z.string().default('centaur.example.com').describe('Public deployment domain'),
      installMode: installModeSchema.default('local').describe('local, k3s, k8s, or ssh'),
      imageSource: imageSourceSchema.default('ghcr').describe('Container image source for deploy commands'),
      backend: secretBackendSchema.default('local-env').describe('Secret backend'),
      harness: harnessSchema.default('codex').describe('Selected default harness'),
      authMode: authModeSchema.default('api_key').describe('Auth mode for the selected harness'),
      overlayPath: z.string().default('org').describe('Overlay directory'),
      bin: z.string().default('centaur').describe('CLI executable to prefix in returned commands'),
    }),
    run(c) {
      const plan = setupPlan(c.options)
      return c.ok(plan, { cta: setupPlanCta(plan, c.options.bin) })
    },
  })

const secrets = Cli.create('secrets', {
  description: 'Populate and validate secret backend setup',
}).command('doctor', {
  description: 'Validate the selected secret backend enough to continue onboarding.',
  options: z.object({
    backend: secretBackendSchema.default('local-env').describe('Secret backend'),
    harness: harnessSchema.default('codex').describe('Selected default harness'),
    authMode: authModeSchema.default('api_key').describe('Auth mode for the selected harness'),
    overlayPath: z.string().default('org').describe('Overlay path for local generated files'),
    installMode: installModeSchema.optional().describe('Install mode for local-env required secret checks'),
    localEnvPath: z.string().optional().describe('local-env source file'),
  }),
  run(c) {
    const results = secretBackendChecks(c.options)
    results.push(...brokeredTokenBackendCheck(c.options.backend, c.options.authMode))
    const ok = allOk(results)
    setFailedExit(ok)
    return { ok, results }
  },
}).command('collect', {
  description: 'Collect required setup secrets and write them into the selected backend.',
  options: z.object({
    backend: secretBackendSchema.default('local-env').describe('Secret backend to populate'),
    installMode: installModeSchema.default('local').describe('local, k3s, k8s, or ssh'),
    imageSource: imageSourceSchema.default('ghcr').describe('Container image source for the next deploy command'),
    harness: harnessSchema.default('codex').describe('Selected default harness'),
    authMode: authModeSchema.default('api_key').describe('Auth mode for the selected harness'),
    overlayPath: z.string().default('org').describe('Overlay path for local generated files'),
    fromEnv: z.boolean().default(false).describe('Read required secret values from environment variables'),
    localEnvPath: z.string().optional().describe('local-env target file'),
    kubernetesNamespace: z.string().optional().describe('Kubernetes namespace for secret writes'),
    kubernetesSecretName: z.string().optional().describe('Kubernetes Secret name'),
    onePasswordVault: z.string().optional().describe('1Password vault name or id'),
    sopsPath: z.string().optional().describe('SOPS encrypted dotenv target file'),
    vaultPath: z.string().optional().describe('Vault KV path'),
  }),
  async run(c) {
    const state = {
      installMode: c.options.installMode,
      harness: c.options.harness,
      authMode: c.options.authMode,
    }
    const collectCommandOptions = {
      backend: c.options.backend,
      installMode: c.options.installMode,
      imageSource: c.options.imageSource,
      harness: c.options.harness,
      authMode: c.options.authMode,
      overlayPath: c.options.overlayPath,
      localEnvPath: c.options.localEnvPath,
      kubernetesNamespace: c.options.kubernetesNamespace,
      kubernetesSecretName: c.options.kubernetesSecretName,
      onePasswordVault: c.options.onePasswordVault,
      sopsPath: c.options.sopsPath,
      vaultPath: c.options.vaultPath,
    }
    const promptUser = !c.options.fromEnv
    if (promptUser && (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function')) {
      return c.error({
        code: 'TTY_REQUIRED',
        message: 'secrets collect needs an interactive terminal so secret prompts can be masked',
        retryable: true,
        cta: {
          description: 'Run one of these:',
          commands: [
            {
              command: commandLine(secretsCollectCommandParts(collectCommandOptions)),
              description: 'run in a real terminal and type secrets into masked prompts',
            },
            {
              command: commandLine(secretsCollectCommandParts({ ...collectCommandOptions, fromEnv: true })),
              description: 'let an agent populate required environment variables first',
            },
          ],
        },
      })
    }
    if (c.options.fromEnv) {
      const missing = missingSecretInputsFromEnv(state)
      if (missing.length > 0) {
        setFailedExit(false)
        return c.ok({
          ok: false,
          code: 'MISSING_ENV',
          message: `Missing required secret inputs: ${missing.map(item => item.env).join(', ')}`,
          retryable: true,
          missing,
        }, {
          cta: {
            description: 'Set the missing values or login with the selected harness CLI, then retry:',
            commands: [
              {
                command: commandLine(secretsCollectCommandParts({ ...collectCommandOptions, fromEnv: true })),
                description: 'retry non-interactively from environment variables and local harness auth state',
              },
              {
                command: commandLine(secretsCollectCommandParts(collectCommandOptions)),
                description: 'run interactive masked prompts and let the CLI drive harness login when needed',
              },
            ],
          },
        })
      }
    }
    const secrets = c.options.fromEnv ? collectSecretsFromEnv(state) : await collectWizardSecrets(state, promptUser)
    const promptedBackendOptions = c.options.fromEnv
      ? {}
      : await collectBackendOptions(c.options.backend, c.options.overlayPath, true)
    const backendOptions = {
      localEnvPath:
        c.options.localEnvPath ||
        promptedBackendOptions.localEnvPath ||
        defaultSecretTarget('local-env', c.options.overlayPath),
      kubernetesNamespace:
        c.options.kubernetesNamespace || promptedBackendOptions.kubernetesNamespace,
      kubernetesSecretName:
        c.options.kubernetesSecretName || promptedBackendOptions.kubernetesSecretName,
      onePasswordVault:
        c.options.onePasswordVault || promptedBackendOptions.onePasswordVault,
      sopsPath:
        c.options.sopsPath ||
        promptedBackendOptions.sopsPath ||
        defaultSecretTarget('sops', c.options.overlayPath),
      vaultPath: c.options.vaultPath || promptedBackendOptions.vaultPath,
    }
    const result = writeSecrets(c.options.backend, secrets, backendOptions)
    const deploySecretsFile =
      c.options.backend === 'local-env'
        ? backendOptions.localEnvPath
        : deploySecretsFileForBackend(c.options.backend, c.options.overlayPath)
    const nextDeployCommand = deploymentCommandForInstallMode(c.options.installMode, {
      apply: true,
      imageSource: c.options.imageSource,
      values: join(c.options.overlayPath, 'values.centaur.yaml'),
      secretsFile: deploySecretsFile,
    })
    const doctorCommand = [
      'doctor',
      '--deep',
      '--overlay-path',
      c.options.overlayPath,
      '--harness',
      c.options.harness,
      '--auth-mode',
      c.options.authMode,
      '--secret-backend',
      c.options.backend,
      '--install-mode',
      c.options.installMode,
      '--image-source',
      c.options.imageSource,
    ]
    if (c.options.backend === 'local-env') {
      doctorCommand.push('--local-env-path', backendOptions.localEnvPath!)
    }
    return c.ok(
      {
        backend: result.backend,
        target: result.target,
        writtenKeys: result.writtenKeys,
        command: result.command,
      },
      {
        cta: {
          description: 'Next validation commands:',
          commands: [
            {
              command: commandLine(doctorCommand),
              description: 'verify prerequisites and generated setup files',
            },
            {
              command: nextDeployCommand,
              description: 'apply local secrets when needed and deploy Centaur with Helm',
            },
            {
              command: localRunVerificationCommand(c.options.harness),
              description: 'run one verified Centaur turn through the local API pod',
            },
            {
              command: commandLine(['slackbot', 'smoke']),
              description: 'prove Slackbot can turn a signed Slack mention into a completed Centaur execution',
            },
          ],
        },
      },
    )
  },
})

const deploy = Cli.create('deploy', {
  description: 'Prepare Centaur deployments',
})
  .command('k8s', {
    description: 'Deploy Centaur into the current Kubernetes context.',
    options: z.object({
      namespace: z.string().default('centaur'),
      release: z.string().default('centaur'),
      values: z.string().default('org/values.centaur.yaml'),
      imageSource: imageSourceSchema.default('ghcr').describe('Use published GHCR images or local image names'),
      secretsFile: z.string().optional().describe('Optional dotenv file to apply as the infra Kubernetes Secret'),
      secretName: z.string().default('centaur-infra-env').describe('Kubernetes Secret name for --secrets-file'),
      wait: z.boolean().default(true).describe('Wait for Kubernetes resources to become ready'),
      timeout: z.string().default('10m').describe('Helm wait timeout'),
      updateDependencies: z.boolean().default(false).describe('Run helm dependency update before deploy'),
      apply: z.boolean().default(false).describe('Run the commands instead of printing them'),
    }),
    run(c) {
      const commands = k8sDeploymentCommands(c.options.namespace, c.options.release, c.options.values, {
        imageSource: c.options.imageSource,
        secretsFile: c.options.secretsFile,
        secretName: c.options.secretName,
        wait: c.options.wait,
        timeout: c.options.timeout,
        updateDependencies: c.options.updateDependencies,
      })
      const deployOptions = { ...c.options }
      if (c.options.apply) {
        try {
          runDeploymentCommands(commands)
        } catch (error) {
          return c.error({
            code: 'DEPLOY_FAILED',
            message: error instanceof Error ? error.message : String(error),
            retryable: true,
            cta: deployFailureCta('k8s', deployOptions),
          })
        }
      }
      return c.ok(
        {
          applied: c.options.apply,
          commands: formatDeploymentCommands(commands),
        },
        {
          cta: deployCta('k8s', { ...deployOptions, applied: c.options.apply }),
        },
      )
    },
  })
  .command('k3s', {
    description: 'Deploy Centaur into the current local k3s-compatible Kubernetes context.',
    options: z.object({
      namespace: z.string().default('centaur'),
      release: z.string().default('centaur'),
      values: z.string().default('org/values.centaur.yaml').describe('Helm values file'),
      imageSource: imageSourceSchema.default('ghcr').describe('Use published GHCR images or local image names'),
      secretsFile: z.string().optional().describe('Optional dotenv file to apply as the infra Kubernetes Secret'),
      secretName: z.string().default('centaur-infra-env').describe('Kubernetes Secret name for --secrets-file'),
      wait: z.boolean().default(true).describe('Wait for Kubernetes resources to become ready'),
      timeout: z.string().default('10m').describe('Helm wait timeout'),
      updateDependencies: z.boolean().default(false).describe('Run helm dependency update before deploy'),
      apply: z.boolean().default(false).describe('Run the commands instead of printing them'),
    }),
    run(c) {
      const commands = k3sDeploymentCommands(c.options.namespace, c.options.release, c.options.values, {
        imageSource: c.options.imageSource,
        secretsFile: c.options.secretsFile,
        secretName: c.options.secretName,
        wait: c.options.wait,
        timeout: c.options.timeout,
        updateDependencies: c.options.updateDependencies,
      })
      const deployOptions = { ...c.options }
      if (c.options.apply) {
        try {
          runDeploymentCommands(commands)
        } catch (error) {
          return c.error({
            code: 'DEPLOY_FAILED',
            message: error instanceof Error ? error.message : String(error),
            retryable: true,
            cta: deployFailureCta('k3s', deployOptions),
          })
        }
      }
      return c.ok(
        {
          applied: c.options.apply,
          commands: formatDeploymentCommands(commands),
        },
        {
          cta: deployCta('k3s', { ...deployOptions, applied: c.options.apply }),
        },
      )
    },
  })
  .command('kind', {
    description: 'Create a local kind cluster and deploy Centaur into it.',
    options: z.object({
      clusterName: z.string().default('centaur').describe('kind cluster name'),
      namespace: z.string().default('centaur'),
      release: z.string().default('centaur'),
      values: z.string().default('org/values.centaur.yaml').describe('Helm values file'),
      imageSource: imageSourceSchema.default('ghcr').describe('Use published GHCR images or local image names'),
      secretsFile: z.string().optional().describe('Optional dotenv file to apply as the infra Kubernetes Secret'),
      secretName: z.string().default('centaur-infra-env').describe('Kubernetes Secret name for --secrets-file'),
      wait: z.boolean().default(true).describe('Wait for Kubernetes resources to become ready'),
      timeout: z.string().default('10m').describe('Helm wait timeout'),
      updateDependencies: z.boolean().default(false).describe('Run helm dependency update before deploy'),
      apply: z.boolean().default(false).describe('Run the commands instead of printing them'),
    }),
    run(c) {
      const commands = kindDeploymentCommands(c.options.clusterName, c.options.namespace, c.options.release, c.options.values, {
        imageSource: c.options.imageSource,
        secretsFile: c.options.secretsFile,
        secretName: c.options.secretName,
        wait: c.options.wait,
        timeout: c.options.timeout,
        updateDependencies: c.options.updateDependencies,
      })
      const deployOptions = { ...c.options }
      if (c.options.apply) {
        try {
          runDeploymentCommands(commands)
        } catch (error) {
          return c.error({
            code: 'DEPLOY_FAILED',
            message: error instanceof Error ? error.message : String(error),
            retryable: true,
            cta: deployFailureCta('kind', deployOptions),
          })
        }
      }
      return c.ok(
        {
          applied: c.options.apply,
          commands: formatDeploymentCommands(commands),
        },
        {
          cta: deployCta('kind', { ...deployOptions, applied: c.options.apply }),
        },
      )
    },
  })
  .command('ssh', {
    description: 'Print the SSH/k3s bootstrap plan for a new server.',
    args: z.object({
      host: z.string().describe('SSH host'),
    }),
    options: z.object({
      domain: z.string().describe('Public domain for this host'),
    }),
    run(c) {
      return {
        host: c.args.host,
        plan: [
          `ssh into ${c.args.host} and install k3s`,
          'copy kubeconfig locally',
          'install ingress-nginx, cert-manager, and ArgoCD',
          `point DNS for ${c.options.domain} at the host`,
          'run centaur deploy k8s once the kube context works',
        ],
      }
    },
  })

const slackbot = Cli.create('slackbot', {
  description: 'Verify deployed Slackbot setup',
}).command('smoke', {
  description: 'Send a signed synthetic Slack mention through Slackbot and wait for a completed Centaur execution.',
  options: z.object({
    namespace: z.string().default('centaur'),
    release: z.string().default('centaur'),
    prompt: z.string().default(DEFAULT_SMOKE_PROMPT).describe('Synthetic Slack mention text'),
    expect: z.string().default(DEFAULT_SMOKE_EXPECT).describe('Text expected in the final result'),
    teamId: z.string().default('TCLI').describe('Synthetic Slack team id'),
    channelId: z.string().default('CCLI').describe('Synthetic Slack channel id'),
    userId: z.string().default('UCLI').describe('Synthetic Slack user id'),
    botUserId: z.string().default('UCENTAUR').describe('Mentioned bot user id in the synthetic event'),
    threadTs: z.string().optional().describe('Optional Slack timestamp/thread id to reuse'),
    timeoutSeconds: z.number().int().positive().default(300).describe('Maximum wait for the execution'),
    pollMs: z.number().int().positive().default(1000).describe('Poll interval while waiting'),
    noRelease: z.boolean().default(false).describe('Leave the runtime assigned after the smoke test'),
  }),
  run(c) {
    const result = runSlackbotSmoke({
      namespace: c.options.namespace,
      release: c.options.release,
      prompt: c.options.prompt,
      expectText: c.options.expect,
      teamId: c.options.teamId,
      channelId: c.options.channelId,
      userId: c.options.userId,
      botUserId: c.options.botUserId,
      threadTs: c.options.threadTs,
      timeoutSeconds: c.options.timeoutSeconds,
      pollMs: c.options.pollMs,
      releaseThread: !c.options.noRelease,
    })
    setFailedExit(result.ok)
    return c.ok(result, {
      cta: {
        description: result.ok ? 'Next real Slack verification step:' : 'Slackbot smoke failed; retry or inspect logs:',
        commands: [
          ...(result.ok
            ? []
            : [{
                command: slackbotSmokeCommand({
                  namespace: c.options.namespace,
                  release: c.options.release,
                  prompt: c.options.prompt,
                  expect: c.options.expect,
                  teamId: c.options.teamId,
                  channelId: c.options.channelId,
                  userId: c.options.userId,
                  botUserId: c.options.botUserId,
                  timeoutSeconds: Math.max(c.options.timeoutSeconds, 300),
                }),
                description: 'retry Slackbot smoke with a normal timeout',
              }, {
                command: commandLine([
                  'logs',
                  '--component',
                  'api',
                  '--namespace',
                  c.options.namespace,
                  '--release',
                  c.options.release,
                ]),
                description: 'inspect API logs',
              }]),
          {
            command: commandLine([
              'logs',
              '--component',
              'slackbot',
              '--namespace',
              c.options.namespace,
              '--release',
              c.options.release,
              '--follow',
            ]),
            description: 'watch Slackbot logs while sending a real Slack mention',
          },
        ],
      },
    })
  },
})

export const app = Cli.create('centaur', {
  description: 'Centaur onboarding, deployment, and agent operations CLI',
  version: VERSION,
  sync: {
    depth: 2,
    suggestions: [
      'install Centaur CLI, inspect centaur --llms, then run the next CTA command',
      'drive Centaur onboarding with setup, init, integrations slack-manifest, secrets collect, doctor, deploy, run --local, and slackbot smoke',
      'run a one-shot Centaur agent turn with centaur run --format jsonl',
    ],
  },
  mcp: {
    agents: ['codex', 'claude-code'],
    command: 'centaur --mcp',
  },
})
  .command('setup', {
    description: 'Return the agent-driven setup command chain from install to verified CLI and Slackbot runs.',
    options: z.object({
      org: z.string().default('acme').describe('Organization name'),
      assistantName: z.string().default('centaur').describe('Assistant display name'),
      domain: z.string().default('centaur.example.com').describe('Public deployment domain'),
      installMode: installModeSchema.default('local').describe('local, k3s, k8s, or ssh'),
      imageSource: imageSourceSchema.default('ghcr').describe('Container image source for deploy commands'),
      backend: secretBackendSchema.default('local-env').describe('Secret backend'),
      harness: harnessSchema.default('codex').describe('Selected default harness'),
      authMode: authModeSchema.default('api_key').describe('Auth mode for the selected harness'),
      overlayPath: z.string().default('org').describe('Overlay directory'),
      bin: z.string().default('centaur').describe('CLI executable to prefix in returned commands'),
    }),
    run(c) {
      const plan = setupPlan(c.options)
      return c.ok(plan, { cta: setupPlanCta(plan, c.options.bin) })
    },
  })
  .command('run', {
    description: 'Run one Centaur agent turn and pipe API events.',
    args: z.object({
      prompt: z.string().describe('Prompt to send to the Centaur agent.'),
    }),
    options: z.object({
      thread: z.string().optional().describe('Thread key to reuse or create'),
      harness: z.string().optional().describe('Harness to run, for example codex, amp, or claude-code'),
      engine: z.string().optional().describe('Optional harness engine/model override'),
      persona: z.string().optional().describe('Optional Centaur persona id'),
      local: z.boolean().default(false).describe('Use kubectl exec into the deployed local API pod'),
      namespace: z.string().default('centaur').describe('Kubernetes namespace for --local'),
      release: z.string().default('centaur').describe('Helm release name for --local'),
      apiUrl: z
        .string()
        .optional()
        .describe('Centaur API URL. Defaults to CENTAUR_API_URL or http://127.0.0.1:8000.'),
      apiKey: z.string().optional().describe('Centaur API key. Defaults to CENTAUR_API_KEY.'),
      expect: z.string().optional().describe('Set a failing exit code unless the final result contains this text'),
      releaseThread: z.boolean().default(false).describe('Release the assigned runtime after the run completes'),
      noStream: z.boolean().default(false).describe('Skip SSE streaming and poll final state only'),
      pollMs: z.number().int().positive().optional().describe('Server stream polling interval in milliseconds'),
      timeoutSeconds: z.number().int().positive().default(300).describe('Maximum wait for --local execution polling'),
    }),
    env: z.object({
      CENTAUR_API_URL: z.string().optional().describe('Default Centaur API URL'),
      CENTAUR_API_KEY: z.string().optional().describe('Centaur API key'),
    }),
    run(c) {
      const apiKey = c.options.apiKey || c.env.CENTAUR_API_KEY
      const hasExplicitApiTarget = Boolean(c.options.apiUrl || c.env.CENTAUR_API_URL)
      const useLocal = c.options.local || (!apiKey && !hasExplicitApiTarget)
      const apiUrl = c.options.apiUrl || c.env.CENTAUR_API_URL || 'http://127.0.0.1:8000'

      if (!useLocal && !apiKey) {
        return c.error({
          code: 'MISSING_API_KEY',
          message: 'Set CENTAUR_API_KEY, pass --api-key, or use --local for a deployed local cluster.',
          retryable: true,
          cta: {
            commands: [
              {
                command: commandLine(['run', c.args.prompt, '--local']),
                description: 'run through the local Kubernetes API pod without a port-forward or external API key',
              },
              {
                command: commandLine(['run', c.args.prompt, '--api-url', apiUrl, '--api-key', '<api-key>']),
                description: 'retry against the explicit API URL with a Centaur API key',
              },
            ],
          },
        })
      }

      return (async function* () {
        if (useLocal) {
          const result = runClusterTurn({
            namespace: c.options.namespace,
            release: c.options.release,
            harness: c.options.harness,
            engine: c.options.engine,
            personaId: c.options.persona,
            prompt: c.args.prompt,
            threadKey: c.options.thread,
            timeoutSeconds: c.options.timeoutSeconds,
            pollMs: c.options.pollMs,
            releaseThread: c.options.releaseThread,
            platform: 'cli-local',
          })
          for (const phase of result.phases) yield phase

          const expectationMet =
            result.status === 'completed' && (!c.options.expect || result.resultText.includes(c.options.expect))
          setFailedExit(expectationMet)
          return c.ok(
            {
              ...result,
              mode: 'local',
              ok: expectationMet,
              expectedText: c.options.expect || undefined,
            },
            {
              cta: {
                commands: [
                  {
                    command: commandLine([
                      'run',
                      c.args.prompt,
                      '--local',
                      '--thread',
                      result.threadKey,
                      '--namespace',
                      c.options.namespace,
                      '--release',
                      c.options.release,
                      ...(c.options.harness ? ['--harness', c.options.harness] : []),
                    ]),
                    description: 'continue this same Centaur thread through the local API pod',
                  },
                ],
              },
            },
          )
        }

        if (!apiKey) throw new Error('missing API key')
        const stream = runAgent({
          apiUrl,
          apiKey,
          prompt: c.args.prompt,
          threadKey: c.options.thread,
          harness: c.options.harness,
          engine: c.options.engine,
          personaId: c.options.persona,
          stream: !c.options.noStream,
          pollMs: c.options.pollMs,
          releaseThread: c.options.releaseThread,
        })

        let next = await stream.next()
        while (!next.done) {
          yield next.value
          next = await stream.next()
        }

        const expectationMet =
          next.value.status === 'completed' && (!c.options.expect || next.value.resultText.includes(c.options.expect))
        setFailedExit(expectationMet)
        return c.ok({ ...next.value, ok: expectationMet, expectedText: c.options.expect || undefined }, {
          cta: {
            commands: [
              {
                command: commandLine(['run', c.args.prompt, '--thread', next.value.threadKey]),
                description: 'continue this same Centaur thread',
              },
            ],
          },
        })
      })()
    },
  })
  .command('init', {
    description: 'Start a Centaur setup run by scaffolding files and returning next-step CTAs.',
    options: z.object({
      org: z.string().default('acme').describe('Organization name'),
      assistantName: z.string().default('centaur').describe('Assistant display name'),
      domain: z.string().default('centaur.example.com').describe('Public deployment domain'),
      adminEmail: z.string().default('admin@example.com').describe('Admin email'),
      installMode: installModeSchema.default('local').describe('local, k3s, k8s, or ssh'),
      imageSource: imageSourceSchema.default('ghcr').describe('Use published GHCR images or local image names'),
      secretBackend: secretBackendSchema.default('local-env').describe('Secret backend'),
      harness: harnessSchema.default('codex').describe('Default harness: codex or claude-code'),
      authMode: authModeSchema.default('api_key').describe('Auth mode for the selected harness'),
      overlayPath: z.string().default('org').describe('Overlay directory to create or validate'),
      home: z.string().default(DEFAULT_HOME).describe('Centaur config directory'),
      resume: z.boolean().default(false).describe('Resume from existing onboarding state'),
      nonInteractive: z.boolean().default(false).describe('Use provided/default values without prompts'),
    }),
    run(c) {
      const prior = c.options.resume ? loadState(c.options.home) : emptyState()
      const state = { ...prior }
      state.org = c.options.org || prior.org || 'acme'
      state.assistantName = c.options.assistantName || prior.assistantName || 'centaur'
      state.domain = c.options.domain || prior.domain || 'centaur.example.com'
      state.adminEmail = c.options.adminEmail || prior.adminEmail || 'admin@example.com'
      state.installMode = c.options.installMode || prior.installMode || 'local'
      state.imageSource = c.options.imageSource || prior.imageSource || 'ghcr'
      state.secretBackend = c.options.secretBackend || prior.secretBackend || 'local-env'
      state.harness = c.options.harness || prior.harness || 'codex'
      state.authMode = c.options.authMode || prior.authMode || 'api_key'
      state.overlayPath = c.options.overlayPath

      const manifestPath = join(expandPath(state.overlayPath), 'slack-app-manifest.json')
      const manifestExisted = existsSync(manifestPath)
      const auth = harnessAuthPlan(state.harness, state.authMode)
      const written = writeOverlay({
        path: state.overlayPath,
        org: state.org,
        assistantName: state.assistantName,
        domain: state.domain,
        harness: state.harness,
        authMode: state.authMode,
        secretBackend: state.secretBackend,
      })
      writeSlackManifest(manifestPath, state.assistantName, state.domain, state.installMode === 'local')
      for (const step of ['local-state', 'overlay', 'slack-manifest', 'secrets-plan', 'deployment-plan']) {
        markDone(state, step)
      }
      state.data = { ...state.data, auth }
      const saved = saveState(state, c.options.home)
      const nextDeployCommand = `centaur ${deploymentCommandForInstallMode(state.installMode, {
        apply: true,
        imageSource: state.imageSource,
        values: join(state.overlayPath, 'values.centaur.yaml'),
        secretsFile: deploySecretsFileForBackend(state.secretBackend, state.overlayPath),
      })}`

      return c.ok(
        {
          statePath: saved.statePath,
          configPath: saved.configPath,
          overlayPath: expandPath(state.overlayPath),
          manifestPath,
          harness: state.harness,
          authMode: state.authMode,
          secretBackend: state.secretBackend,
          installMode: state.installMode,
          imageSource: state.imageSource,
          created: manifestExisted ? written : [...written, manifestPath],
          auth,
        },
        {
          cta: {
            description: 'Next setup commands:',
            commands: [
              {
                command: commandLine([
                  'integrations',
                  'slack-manifest',
                  '--domain',
                  state.domain,
                  '--app-name',
                  state.assistantName,
                  '--output',
                  manifestPath,
                  '--copy',
                  ...(state.installMode === 'local' ? ['--socket-mode'] : []),
                  '--backend',
                  state.secretBackend,
                  '--install-mode',
                  state.installMode,
                  '--image-source',
                  state.imageSource,
                  '--harness',
                  state.harness,
                  '--auth-mode',
                  state.authMode,
                  '--overlay-path',
                  state.overlayPath,
                ]),
                description: 'copy the Slack app manifest JSON to the clipboard',
              },
              {
                command: commandLine([
                  'secrets',
                  'collect',
                  '--backend',
                  state.secretBackend,
                  '--install-mode',
                  state.installMode,
                  '--image-source',
                  state.imageSource,
                  '--harness',
                  state.harness,
                  '--auth-mode',
                  state.authMode,
                  '--overlay-path',
                  state.overlayPath,
                ]),
                description: 'prompt for needed secrets and populate the selected backend',
              },
              {
                command: commandLine([
                  'doctor',
                  '--deep',
                  '--overlay-path',
                  state.overlayPath,
                  '--harness',
                  state.harness,
                  '--auth-mode',
                  state.authMode,
                  '--secret-backend',
                  state.secretBackend,
                  '--install-mode',
                  state.installMode,
                  '--image-source',
                  state.imageSource,
                ]),
                description: 'verify local tools and generated files after secrets are populated',
              },
              {
                command: nextDeployCommand,
                description: 'apply local secrets when needed and deploy Centaur with Helm',
              },
              {
                command: localRunVerificationCommand(state.harness),
                description: 'run one verified Centaur turn through the local API pod',
              },
              {
                command: commandLine(['slackbot', 'smoke']),
                description: 'prove Slackbot can turn a signed Slack mention into a completed Centaur execution',
              },
            ],
          },
        },
      )
    },
  })
  .command('doctor', {
    description: 'Check local prerequisites and generated Centaur setup files.',
    options: z.object({
      deep: z.boolean().default(false).describe('Include deploy and environment checks'),
      overlayPath: z.string().default('org').describe('Overlay path'),
      harness: harnessSchema.default('codex').describe('Selected default harness'),
      authMode: authModeSchema.default('api_key').describe('Auth mode for the selected harness'),
      secretBackend: secretBackendSchema.default('local-env').describe('Secret backend for repair CTAs'),
      installMode: installModeSchema.default('local').describe('Install mode for repair CTAs'),
      imageSource: imageSourceSchema.default('ghcr').describe('Container image source used by deploy'),
      localEnvPath: z.string().optional().describe('local-env source file for deep checks'),
    }),
    run(c) {
      const results = [...binaryChecks({ includeDeploy: c.options.deep }), ...overlayChecks(c.options.overlayPath)]
      if (c.options.deep) {
        results.push(
          ...secretBackendChecks({
            backend: c.options.secretBackend,
            harness: c.options.harness,
            authMode: c.options.authMode,
            overlayPath: c.options.overlayPath,
            localEnvPath: c.options.localEnvPath,
            installMode: c.options.installMode,
          }),
          ...brokeredTokenBackendCheck(c.options.secretBackend, c.options.authMode),
        )
        if (c.options.imageSource === 'local') {
          results.push(dockerDaemonCheck())
        }
        if (results.some(result => result.name === 'binary:kubectl' && result.ok)) {
          results.push(commandCheck('kubectl:cluster', ['kubectl', 'cluster-info'], 'Select a working Kubernetes context or use centaur deploy k3s.'))
        }
        if (results.some(result => result.name === 'binary:helm' && result.ok)) {
          results.push(commandCheck('helm:version', ['helm', 'version', '--short'], 'Install Helm before deploying to Kubernetes.'))
        }
      }
      const ok = allOk(results)
      setFailedExit(ok)
      const deployCommand = deploymentCommandForInstallMode(c.options.installMode, {
        apply: true,
        imageSource: c.options.imageSource,
        values: join(c.options.overlayPath, 'values.centaur.yaml'),
        secretsFile: deploySecretsFileForDoctor(
          c.options.secretBackend,
          c.options.overlayPath,
          c.options.localEnvPath,
        ),
      })
      const secretsCommand = {
        command: commandLine(secretsCollectCommandParts({
          backend: c.options.secretBackend,
          installMode: c.options.installMode,
          imageSource: c.options.imageSource,
          harness: c.options.harness,
          authMode: c.options.authMode,
          overlayPath: c.options.overlayPath,
          localEnvPath: c.options.localEnvPath,
        })),
        description: 'populate missing Slack, harness, and infra secrets',
      }
      const retryDoctorParts = [
        'doctor',
        ...(c.options.deep ? ['--deep'] : []),
        '--overlay-path',
        c.options.overlayPath,
        '--harness',
        c.options.harness,
        '--auth-mode',
        c.options.authMode,
        '--secret-backend',
        c.options.secretBackend,
        '--install-mode',
        c.options.installMode,
        '--image-source',
        c.options.imageSource,
      ]
      if (c.options.localEnvPath) retryDoctorParts.push('--local-env-path', c.options.localEnvPath)
      const failedResults = results.filter(result => !result.ok)
      const overlayMissing = failedResults.some(result => result.name.startsWith('overlay:'))
      const ctaCommands = ok
        ? [
            {
              command: deployCommand,
              description: 'deploy with Helm using the selected install mode and secret backend',
            },
            {
              command: localRunVerificationCommand(c.options.harness),
              description: 'run one verified Centaur turn through the local API pod',
            },
            {
              command: slackbotSmokeCommand(),
              description: 'prove Slackbot can turn a signed Slack mention into a completed Centaur execution',
            },
          ]
        : [
            ...(overlayMissing
              ? [{
                  command: commandLine([
                    'init',
                    '--install-mode',
                    c.options.installMode,
                    '--image-source',
                    c.options.imageSource,
                    '--secret-backend',
                    c.options.secretBackend,
                    '--harness',
                    c.options.harness,
                    '--auth-mode',
                    c.options.authMode,
                    '--overlay-path',
                    c.options.overlayPath,
                  ]),
                  description: 'scaffold missing overlay files before continuing setup',
                }]
              : []),
            ...(c.options.deep ? [secretsCommand] : []),
            {
              command: commandLine(retryDoctorParts),
              description: 'rerun doctor after repairing failed checks',
            },
          ]
      return c.ok(
        { ok, results },
        {
          cta: {
            description: ok ? 'Next deployment commands:' : 'Repair failing checks first:',
            commands: ctaCommands,
          },
        },
      )
    },
  })
  .command('status', {
    description: 'Show resumable onboarding state.',
    options: z.object({
      home: z.string().default(DEFAULT_HOME).describe('Centaur config directory'),
    }),
    run(c) {
      return loadState(c.options.home)
    },
  })
  .command('smoke', {
    description: 'Run one deployed Centaur agent turn through the API pod, without external API auth.',
    options: z.object({
      namespace: z.string().default('centaur'),
      release: z.string().default('centaur'),
      harness: harnessSchema.default('codex').describe('Harness to verify'),
      prompt: z.string().default(DEFAULT_SMOKE_PROMPT).describe('Smoke-test prompt'),
      expect: z.string().default(DEFAULT_SMOKE_EXPECT).describe('Text expected in the final result'),
      thread: z.string().optional().describe('Optional thread key to reuse'),
      timeoutSeconds: z.number().int().positive().default(300).describe('Maximum wait for the execution'),
      pollMs: z.number().int().positive().default(1000).describe('Poll interval while waiting'),
      noRelease: z.boolean().default(false).describe('Leave the runtime assigned after the smoke test'),
    }),
    run(c) {
      const result = runClusterSmoke({
        namespace: c.options.namespace,
        release: c.options.release,
        harness: c.options.harness,
        prompt: c.options.prompt,
        expectText: c.options.expect,
        threadKey: c.options.thread,
        timeoutSeconds: c.options.timeoutSeconds,
        pollMs: c.options.pollMs,
        releaseThread: !c.options.noRelease,
      })
      setFailedExit(result.ok)
      return c.ok({ ...result, slackInstruction: `Mention the Slack app in a test channel: @<bot> ${c.options.prompt}` }, {
        cta: {
          description: result.ok ? 'Next Slack verification step:' : 'Smoke failed; retry or inspect logs:',
          commands: [
            ...(result.ok
              ? []
              : [{
                  command: smokeCommand({
                    namespace: c.options.namespace,
                    release: c.options.release,
                    harness: c.options.harness,
                    prompt: c.options.prompt,
                    expect: c.options.expect,
                    timeoutSeconds: Math.max(c.options.timeoutSeconds, 300),
                  }),
                  description: 'retry local agent smoke with a normal timeout',
                }, {
                  command: commandLine([
                    'logs',
                    '--component',
                    'api',
                    '--namespace',
                    c.options.namespace,
                    '--release',
                    c.options.release,
                  ]),
                  description: 'inspect API logs',
                }]),
            {
              command: commandLine([
                'logs',
                '--component',
                'slackbot',
                '--namespace',
                c.options.namespace,
                '--release',
                c.options.release,
                '--follow',
              ]),
              description: 'watch Slackbot logs while sending the Slack mention',
            },
          ],
        },
      })
    },
  })
  .command('smoke-test', {
    description: 'Print the exact commands for an end-to-end Centaur smoke test.',
    options: z.object({
      namespace: z.string().default('centaur'),
      release: z.string().default('centaur'),
    }),
    run(c) {
      return {
        command: `centaur ${commandLine([
          'smoke',
          '--namespace',
          c.options.namespace,
          '--release',
          c.options.release,
        ])}`,
      }
    },
  })
  .command(overlay)
  .command(integrations)
  .command(secrets)
  .command(deploy)
  .command(slackbot)
  .command('logs', {
    description: 'Fetch logs for a deployed Centaur component.',
    options: z.object({
      component: z.string().default('api'),
      namespace: z.string().default('centaur'),
      release: z.string().default('centaur'),
      tail: z.number().int().positive().default(200).describe('Number of recent log lines to fetch'),
      follow: z.boolean().default(false).describe('Stream logs until interrupted'),
      previous: z.boolean().default(false).describe('Read logs from the previous crashed container'),
      plan: z.boolean().default(false).describe('Only print the kubectl command without running it'),
    }),
    run(c) {
      const command = componentLogCommand({
        component: c.options.component,
        namespace: c.options.namespace,
        release: c.options.release,
        tail: c.options.tail,
        follow: c.options.follow,
        previous: c.options.previous,
      })
      if (c.options.plan) return { command: commandLine(command) }
      if (c.options.follow) {
        const ok = runInteractive(command)
        setFailedExit(ok)
        return {
          command: commandLine(command),
          component: c.options.component,
          namespace: c.options.namespace,
          release: c.options.release,
          tail: c.options.tail,
          previous: c.options.previous,
          follow: true,
          ok,
        }
      }
      return readComponentLogs({
        component: c.options.component,
        namespace: c.options.namespace,
        release: c.options.release,
        tail: c.options.tail,
        previous: c.options.previous,
      })
    },
  })
  .command('repair', {
    description: 'Print focused repair instructions for one onboarding area.',
    args: z.object({
      step: z.string().describe('Repair area: slack, github, secrets, deploy, codex, or claude'),
    }),
    run(c) {
      const repairs: Record<string, string> = {
        slack:
          'Regenerate the manifest, update Slack request URLs, reinstall the app, then send a test mention.',
        github:
          'Check GitHub App permissions, installation id, private key formatting, webhook delivery status, or GITHUB_TOKEN scope.',
        secrets:
          'Run centaur secrets doctor --backend <backend> and sync missing keys into the selected backend.',
        deploy:
          'Run centaur doctor --deep, fix cluster/helm failures, then rerun centaur deploy k8s.',
        codex:
          'For CODEX_AUTH_MODE=access_token, run centaur secrets collect --harness codex --auth-mode access_token with a dedicated ChatGPT account.',
        claude:
          'For CLAUDE_CODE_AUTH_MODE=access_token, run centaur secrets collect --harness claude-code --auth-mode access_token with a dedicated Claude.ai Pro or Max account.',
      }
      return {
        step: c.args.step,
        repair: repairs[c.args.step] ?? 'Known repair steps: slack, github, secrets, deploy, codex, claude.',
      }
    },
  })

type ServeOptions = NonNullable<Parameters<typeof app.serve>[1]>

function kebabCaseFlag(flag: string) {
  return flag.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`)
}

export function normalizeLlmsMarkdown(markdown: string) {
  return markdown.replace(/`--([A-Za-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*)`/g, (_match, flag: string) => {
    return `\`--${kebabCaseFlag(flag)}\``
  })
}

export function shouldNormalizeLlmsMarkdown(argv: readonly string[]) {
  if (!argv.includes('--llms-full')) return false
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--json') return false
    if (token === '--format') {
      const format = argv[index + 1]
      if (format && format !== 'md') return false
      index += 1
    }
  }
  return true
}

export async function serveCentaur(argv = process.argv.slice(2), options?: ServeOptions) {
  if (!shouldNormalizeLlmsMarkdown(argv)) {
    await app.serve(argv, options)
    return
  }

  let stdout = ''
  await app.serve(argv, {
    ...options,
    stdout: chunk => {
      stdout += chunk
    },
  })

  const write = options?.stdout || ((chunk: string) => output.write(chunk))
  write(normalizeLlmsMarkdown(stdout))
}
