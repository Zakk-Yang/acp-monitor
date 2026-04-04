import { execFile } from 'node:child_process'
import { createReadStream, promises as fs } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'

import type { ProviderSnapshot, UsageMetric } from './types.js'
import { formatCompactCount, formatLocalTimestamp, homePath, toneForLeftPercent, walkFiles } from './utils.js'

const execFileAsync = promisify(execFile)
const CLAUDE_OAUTH_BETA_HEADER = 'oauth-2025-04-20'
const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const CLAUDE_USAGE_SCOPES = [
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
]
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

type ClaudeAuthStatus = {
  loggedIn: boolean
  orgName?: string
  subscriptionType?: string
  authMethod?: string
  email?: string
}

type ClaudeRateLimit = {
  utilization: number | null
  resets_at: string | null
}

type ClaudeUtilization = {
  five_hour?: ClaudeRateLimit | null
  seven_day?: ClaudeRateLimit | null
  seven_day_sonnet?: ClaudeRateLimit | null
}

type ClaudeUsageState = {
  currentSession: {
    usedPercent: number | null
    resetLabel: string | null
  }
  weeklyAllModels: {
    usedPercent: number | null
    resetLabel: string | null
    limit: ClaudeRateLimit | null
  }
  weeklySonnetOnly: {
    usedPercent: number | null
    resetLabel: string | null
  }
}

type ClaudeCredentialsFile = {
  claudeAiOauth?: {
    accessToken?: string
    refreshToken?: string
    expiresAt?: number
    scopes?: string[]
  }
}

type ClaudeOAuthTokenResponse = {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  scope?: string
}

type ClaudeTranscriptUsage = {
  timestampMs: number
  requestKey: string
  file: string
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

type ClaudeWeeklyTokenUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  total_tokens: number
  sourceFiles: number
  requestCount: number
}

type ClaudeTranscriptLine = {
  type?: string
  requestId?: string
  sessionId?: string
  timestamp?: string
  message?: {
    role?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
  }
}

class ClaudeApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ClaudeApiError'
    this.status = status
  }
}

function createMetric(
  key: string,
  label: string,
  usedPercent: number | null,
  resetLabel: string | null,
  note?: string,
) {
  const leftPercent = usedPercent === null ? null : Math.max(0, 100 - usedPercent)

  return {
    key,
    label,
    status: usedPercent === null ? 'unavailable' : 'available',
    leftPercent,
    usedPercent,
    resetLabel,
    note: note ?? null,
    tone: toneForLeftPercent(leftPercent),
  } satisfies UsageMetric
}

function valueMetric(
  key: string,
  label: string,
  displayValue: string | null,
  displayCaption: string | null,
  footerLabel: string | null,
  note: string | null = null,
): UsageMetric {
  return {
    key,
    label,
    status: displayValue === null ? 'unavailable' : 'available',
    leftPercent: null,
    usedPercent: null,
    resetLabel: null,
    note,
    tone: 'unknown',
    displayValue,
    displayCaption,
    footerLabel,
  }
}

function envTruthy(value: string | undefined) {
  if (!value) {
    return false
  }

  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

function getClaudeOauthConfig() {
  const customBaseUrl = process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL?.replace(/\/$/, '')
  if (customBaseUrl) {
    return {
      baseApiUrl: customBaseUrl,
      tokenUrl: `${customBaseUrl}/v1/oauth/token`,
    }
  }

  if (process.env.USER_TYPE === 'ant' && envTruthy(process.env.USE_LOCAL_OAUTH)) {
    const localApiBase = process.env.CLAUDE_LOCAL_OAUTH_API_BASE?.replace(/\/$/, '') ?? 'http://localhost:8000'
    return {
      baseApiUrl: localApiBase,
      tokenUrl: `${localApiBase}/v1/oauth/token`,
    }
  }

  if (process.env.USER_TYPE === 'ant' && envTruthy(process.env.USE_STAGING_OAUTH)) {
    return {
      baseApiUrl: 'https://api-staging.anthropic.com',
      tokenUrl: 'https://platform.staging.ant.dev/v1/oauth/token',
    }
  }

  return {
    baseApiUrl: 'https://api.anthropic.com',
    tokenUrl: 'https://platform.claude.com/v1/oauth/token',
  }
}

function getClaudeCredentialsPath() {
  return homePath('.claude', '.credentials.json')
}

function formatTokenCount(value: number | null | undefined) {
  return formatCompactCount(value)
}

function buildResetLabelFromIso(value: string | null | undefined) {
  if (!value) {
    return null
  }

  const timestampMs = Date.parse(value)
  if (!Number.isFinite(timestampMs)) {
    return null
  }

  return `Resets ${formatLocalTimestamp(timestampMs)} (Europe/London)`
}

function buildUsageStateFromUtilization(utilization: ClaudeUtilization): ClaudeUsageState {
  return {
    currentSession: {
      usedPercent: utilization.five_hour?.utilization ?? null,
      resetLabel: buildResetLabelFromIso(utilization.five_hour?.resets_at),
    },
    weeklyAllModels: {
      usedPercent: utilization.seven_day?.utilization ?? null,
      resetLabel: buildResetLabelFromIso(utilization.seven_day?.resets_at),
      limit: utilization.seven_day ?? null,
    },
    weeklySonnetOnly: {
      usedPercent: utilization.seven_day_sonnet?.utilization ?? null,
      resetLabel: buildResetLabelFromIso(utilization.seven_day_sonnet?.resets_at),
    },
  }
}

function buildTokenBreakdownLabel(tokenUsage: ClaudeWeeklyTokenUsage | null) {
  if (!tokenUsage) {
    return null
  }

  const parts = [
    { label: 'Input', value: tokenUsage.input_tokens },
    { label: 'Cache read', value: tokenUsage.cache_read_input_tokens },
    { label: 'Cache write', value: tokenUsage.cache_creation_input_tokens },
    { label: 'Output', value: tokenUsage.output_tokens },
  ]
    .filter((part) => part.value > 0)
    .map((part) => `${part.label} ${formatTokenCount(part.value)}`)

  return parts.length > 0 ? parts.join(' · ') : null
}

function createEmptyWeeklyTokenUsage(): ClaudeWeeklyTokenUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    total_tokens: 0,
    sourceFiles: 0,
    requestCount: 0,
  }
}

function numericOrZero(value: number | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function parseClaudeTranscriptUsage(line: string, file: string): ClaudeTranscriptUsage | null {
  if (!line.includes('"requestId"') || !line.includes('"usage"')) {
    return null
  }

  try {
    const parsed = JSON.parse(line) as ClaudeTranscriptLine
    const usage = parsed.message?.usage

    if ((parsed.type !== 'assistant' && parsed.message?.role !== 'assistant') || !parsed.requestId || !usage) {
      return null
    }

    const timestampMs = Date.parse(parsed.timestamp ?? '')
    if (!Number.isFinite(timestampMs)) {
      return null
    }

    return {
      timestampMs,
      requestKey: `${parsed.sessionId ?? file}:${parsed.requestId}`,
      file,
      input_tokens: numericOrZero(usage.input_tokens),
      output_tokens: numericOrZero(usage.output_tokens),
      cache_read_input_tokens: numericOrZero(usage.cache_read_input_tokens),
      cache_creation_input_tokens: numericOrZero(usage.cache_creation_input_tokens),
    }
  } catch {
    return null
  }
}

function buildClaudeWeeklyTokenMetric(
  weeklyWindow: ClaudeRateLimit | null | undefined,
  weeklyTokenUsage: ClaudeWeeklyTokenUsage | null,
): UsageMetric {
  const footerLabel = buildResetLabelFromIso(weeklyWindow?.resets_at)

  if (!weeklyWindow?.resets_at) {
    return valueMetric(
      'claude-week-tokens',
      'Week tokens',
      null,
      null,
      null,
      'Claude /usage did not expose a weekly reset window for this account.',
    )
  }

  if (!weeklyTokenUsage || weeklyTokenUsage.requestCount === 0) {
    return valueMetric(
      'claude-week-tokens',
      'Week tokens',
      null,
      null,
      footerLabel,
      'No Claude transcript usage records were found in the current weekly window.',
    )
  }

  return valueMetric(
    'claude-week-tokens',
    'Week tokens',
    formatTokenCount(weeklyTokenUsage.total_tokens),
    buildTokenBreakdownLabel(weeklyTokenUsage),
    footerLabel,
  )
}

async function getClaudeAuthStatus(): Promise<ClaudeAuthStatus> {
  const { stdout } = await execFileAsync('claude', ['auth', 'status'], {
    cwd: process.cwd(),
  })

  return JSON.parse(stdout) as ClaudeAuthStatus
}

async function readClaudeCredentials() {
  const contents = await fs.readFile(getClaudeCredentialsPath(), 'utf8')
  return JSON.parse(contents) as ClaudeCredentialsFile
}

async function writeClaudeCredentials(credentials: ClaudeCredentialsFile) {
  await fs.writeFile(getClaudeCredentialsPath(), JSON.stringify(credentials), 'utf8')
}

function isAccessTokenExpired(expiresAt: number | undefined) {
  return typeof expiresAt === 'number' && expiresAt <= Date.now() + 60_000
}

async function refreshClaudeAccessToken(credentials: ClaudeCredentialsFile) {
  const refreshToken = credentials.claudeAiOauth?.refreshToken
  if (!refreshToken) {
    throw new Error('Claude OAuth refresh token is unavailable.')
  }

  const oauthConfig = getClaudeOauthConfig()
  const response = await fetch(oauthConfig.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLAUDE_OAUTH_CLIENT_ID,
      scope: CLAUDE_USAGE_SCOPES.join(' '),
    }),
  })

  if (!response.ok) {
    throw new Error(`Claude OAuth refresh failed (${response.status}).`)
  }

  const payload = (await response.json()) as ClaudeOAuthTokenResponse
  if (!payload.access_token || !payload.expires_in) {
    throw new Error('Claude OAuth refresh returned an incomplete token payload.')
  }

  const nextCredentials: ClaudeCredentialsFile = {
    ...credentials,
    claudeAiOauth: {
      ...credentials.claudeAiOauth,
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token ?? refreshToken,
      expiresAt: Date.now() + payload.expires_in * 1000,
      scopes: payload.scope?.split(' ').filter(Boolean) ?? credentials.claudeAiOauth?.scopes,
    },
  }

  await writeClaudeCredentials(nextCredentials)
  const nextAccessToken = nextCredentials.claudeAiOauth?.accessToken
  if (!nextAccessToken) {
    throw new Error('Claude OAuth refresh did not produce an access token.')
  }

  return nextAccessToken
}

async function requestClaudeUtilization(accessToken: string) {
  const oauthConfig = getClaudeOauthConfig()
  const response = await fetch(`${oauthConfig.baseApiUrl}/api/oauth/usage`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'anthropic-beta': CLAUDE_OAUTH_BETA_HEADER,
      'Content-Type': 'application/json',
      'User-Agent': 'acp-monitor/0.1.0',
    },
  })

  if (!response.ok) {
    throw new ClaudeApiError(`Claude /usage request failed (${response.status}).`, response.status)
  }

  return (await response.json()) as ClaudeUtilization
}

async function getClaudeUtilization() {
  const credentials = await readClaudeCredentials()
  let accessToken = credentials.claudeAiOauth?.accessToken ?? null

  if (!accessToken || isAccessTokenExpired(credentials.claudeAiOauth?.expiresAt)) {
    accessToken = await refreshClaudeAccessToken(credentials)
  }

  try {
    return await requestClaudeUtilization(accessToken)
  } catch (error) {
    if (!(error instanceof ClaudeApiError) || error.status !== 401) {
      throw error
    }

    const refreshedToken = await refreshClaudeAccessToken(await readClaudeCredentials())
    return requestClaudeUtilization(refreshedToken)
  }
}

async function listClaudeTranscriptFiles(windowStartMs: number) {
  const transcriptRoot = homePath('.claude', 'projects')
  const candidates = (await walkFiles(transcriptRoot).catch(() => [])).filter((file) => file.endsWith('.jsonl'))

  const filesWithStats = await Promise.all(
    candidates.map(async (file) => ({
      file,
      mtimeMs: (await stat(file)).mtimeMs,
    })),
  )

  return filesWithStats
    .filter((file) => file.mtimeMs >= windowStartMs)
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
}

async function getClaudeWeeklyTokenUsage(weeklyWindow: ClaudeRateLimit | null | undefined) {
  const resetAtMs = Date.parse(weeklyWindow?.resets_at ?? '')
  if (!Number.isFinite(resetAtMs)) {
    return null
  }

  const windowStartMs = resetAtMs - SEVEN_DAYS_MS
  const relevantFiles = await listClaudeTranscriptFiles(windowStartMs)
  if (relevantFiles.length === 0) {
    return null
  }

  const latestRequests = new Map<string, ClaudeTranscriptUsage>()

  for (const candidate of relevantFiles) {
    const reader = createInterface({
      input: createReadStream(candidate.file, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    })

    for await (const line of reader) {
      const parsed = parseClaudeTranscriptUsage(line, candidate.file)
      if (!parsed || parsed.timestampMs < windowStartMs || parsed.timestampMs > Date.now()) {
        continue
      }

      const previous = latestRequests.get(parsed.requestKey)
      if (!previous || parsed.timestampMs >= previous.timestampMs) {
        latestRequests.set(parsed.requestKey, parsed)
      }
    }
  }

  if (latestRequests.size === 0) {
    return null
  }

  const aggregate = createEmptyWeeklyTokenUsage()
  const sourceFiles = new Set<string>()

  for (const entry of latestRequests.values()) {
    aggregate.input_tokens += entry.input_tokens
    aggregate.output_tokens += entry.output_tokens
    aggregate.cache_read_input_tokens += entry.cache_read_input_tokens
    aggregate.cache_creation_input_tokens += entry.cache_creation_input_tokens
    sourceFiles.add(entry.file)
  }

  aggregate.total_tokens =
    aggregate.input_tokens +
    aggregate.output_tokens +
    aggregate.cache_read_input_tokens +
    aggregate.cache_creation_input_tokens
  aggregate.sourceFiles = sourceFiles.size
  aggregate.requestCount = latestRequests.size

  return aggregate
}

export async function getClaudeSnapshot(): Promise<ProviderSnapshot> {
  try {
    const auth = await getClaudeAuthStatus()
    if (!auth.loggedIn) {
      throw new Error('Claude is not logged in.')
    }

    const utilization = await getClaudeUtilization()
    const usage = buildUsageStateFromUtilization(utilization)
    const weeklyTokenUsage = await getClaudeWeeklyTokenUsage(usage.weeklyAllModels.limit).catch(() => null)
    const observedAt = new Date().toISOString()

    return {
      id: 'claude',
      name: 'Claude Code',
      plan: (auth.subscriptionType ?? 'unknown').toUpperCase(),
      accountLabel: auth.orgName?.trim() || auth.email?.trim() || auth.authMethod?.trim() || null,
      sourceLabel: 'Claude /usage API + local ~/.claude transcript logs',
      observedAt,
      stale: false,
      headline: [
        createMetric(
          'claude-weekly',
          'Weekly left',
          usage.weeklyAllModels.usedPercent,
          usage.weeklyAllModels.resetLabel,
        ),
        buildClaudeWeeklyTokenMetric(usage.weeklyAllModels.limit, weeklyTokenUsage),
        {
          key: 'claude-monthly',
          label: 'Monthly left',
          status: 'unavailable',
          leftPercent: null,
          usedPercent: null,
          resetLabel: null,
          note: 'Anthropic does not expose monthly Claude Code analytics for individual Pro or Max plans.',
          tone: 'unknown',
        },
      ],
      extras: [
        createMetric(
          'claude-session',
          'Session left',
          usage.currentSession.usedPercent,
          usage.currentSession.resetLabel,
        ),
        createMetric(
          'claude-sonnet-week',
          'Sonnet week left',
          usage.weeklySonnetOnly.usedPercent,
          usage.weeklySonnetOnly.resetLabel,
        ),
      ],
      notes: [
        'Claude weekly and session percentages come from the same /usage endpoint used by the CLI Usage screen.',
        'Week tokens are summed from local ~/.claude project transcripts inside the current /usage weekly window.',
        'Claude /cost is session-scoped, so weekly totals are derived from transcript usage records instead.',
      ],
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown Claude usage error'

    return {
      id: 'claude',
      name: 'Claude Code',
      plan: 'Unavailable',
      accountLabel: null,
      sourceLabel: 'Claude /usage API + local ~/.claude transcript logs',
      observedAt: null,
      stale: true,
      headline: [
        {
          key: 'claude-weekly',
          label: 'Weekly left',
          status: 'unavailable',
          leftPercent: null,
          usedPercent: null,
          resetLabel: null,
          note: message,
          tone: 'unknown',
        },
        {
          key: 'claude-week-tokens',
          label: 'Week tokens',
          status: 'unavailable',
          leftPercent: null,
          usedPercent: null,
          resetLabel: null,
          note: 'Unavailable because Claude usage could not be refreshed.',
          tone: 'unknown',
          displayValue: null,
          displayCaption: null,
          footerLabel: null,
        },
        {
          key: 'claude-monthly',
          label: 'Monthly left',
          status: 'unavailable',
          leftPercent: null,
          usedPercent: null,
          resetLabel: null,
          note: 'Unavailable because Claude usage could not be refreshed.',
          tone: 'unknown',
        },
      ],
      extras: [],
      notes: ['Claude usage is currently unavailable.'],
    }
  }
}
