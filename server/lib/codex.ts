import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { stat } from 'node:fs/promises'
import { promisify } from 'node:util'

import type { ProviderSnapshot, UsageMetric } from './types.js'
import { buildResetLabelFromEpoch, formatCompactCount, homePath, toneForLeftPercent, walkFiles } from './utils.js'

const execFileAsync = promisify(execFile)

type CodexRateLimits = {
  primary?: {
    used_percent?: number
    window_minutes?: number
    resets_at?: number
  }
  secondary?: {
    used_percent?: number
    window_minutes?: number
    resets_at?: number
  }
  plan_type?: string | null
}

type CodexTokenUsage = {
  input_tokens?: number
  cached_input_tokens?: number
  output_tokens?: number
  reasoning_output_tokens?: number
  total_tokens?: number
}

type CodexSessionFile = {
  file: string
  mtimeMs: number
}

type ParsedCodexTokenCount = {
  timestamp: string | null
  rateLimits: CodexRateLimits
  totalTokenUsage: CodexTokenUsage | null
}

type CodexWeeklyTokenUsage = {
  input_tokens: number
  cached_input_tokens: number
  output_tokens: number
  reasoning_output_tokens: number
  total_tokens: number
  sourceFiles: number
}

type CodexTokenCountPayload = {
  timestamp?: string
  payload?: {
    type?: string
    info?: { total_token_usage?: CodexTokenUsage | null }
    rate_limits?: CodexRateLimits
  }
}

function metricFromUsedPercent(
  key: string,
  label: string,
  usedPercent: number | null,
  resetLabel: string | null,
  note: string | null = null,
): UsageMetric {
  const leftPercent = usedPercent === null ? null : Math.max(0, 100 - usedPercent)

  return {
    key,
    label,
    status: usedPercent === null ? 'unavailable' : 'available',
    leftPercent,
    usedPercent,
    resetLabel,
    note,
    tone: toneForLeftPercent(leftPercent),
  }
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

function formatTokenCount(value: number | null | undefined) {
  return formatCompactCount(value)
}

function buildTokenBreakdownLabel(tokenUsage: CodexTokenUsage | null) {
  if (!tokenUsage) {
    return null
  }

  const parts = [
    { label: 'Input', value: tokenUsage.input_tokens },
    { label: 'Cached', value: tokenUsage.cached_input_tokens },
    { label: 'Output', value: tokenUsage.output_tokens },
    { label: 'Reasoning', value: tokenUsage.reasoning_output_tokens },
  ]
    .filter(
      (part): part is { label: string; value: number } =>
        typeof part.value === 'number' && Number.isFinite(part.value),
    )
    .map((part) => `${part.label} ${formatTokenCount(part.value)}`)

  return parts.length > 0 ? parts.join(' · ') : null
}

function parseCodexTokenCount(line: string): ParsedCodexTokenCount | null {
  if (!line.includes('"token_count"') || !line.includes('"rate_limits"')) {
    return null
  }

  try {
    const parsed = JSON.parse(line) as CodexTokenCountPayload
    if (parsed.payload?.type !== 'token_count' || !parsed.payload.rate_limits?.primary) {
      return null
    }

    return {
      timestamp: parsed.timestamp ?? null,
      rateLimits: parsed.payload.rate_limits,
      totalTokenUsage: parsed.payload.info?.total_token_usage ?? null,
    }
  } catch {
    return null
  }
}

function tokenValueDiff(current: number | undefined, baseline: number | undefined) {
  if (typeof current !== 'number' || !Number.isFinite(current)) {
    return 0
  }

  const baselineValue = typeof baseline === 'number' && Number.isFinite(baseline) ? baseline : 0
  return Math.max(0, current - baselineValue)
}

function diffTokenUsage(current: CodexTokenUsage, baseline: CodexTokenUsage | null): Omit<CodexWeeklyTokenUsage, 'sourceFiles'> {
  return {
    input_tokens: tokenValueDiff(current.input_tokens, baseline?.input_tokens),
    cached_input_tokens: tokenValueDiff(current.cached_input_tokens, baseline?.cached_input_tokens),
    output_tokens: tokenValueDiff(current.output_tokens, baseline?.output_tokens),
    reasoning_output_tokens: tokenValueDiff(current.reasoning_output_tokens, baseline?.reasoning_output_tokens),
    total_tokens: tokenValueDiff(current.total_tokens, baseline?.total_tokens),
  }
}

function createEmptyWeeklyTokenUsage(): CodexWeeklyTokenUsage {
  return {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
    sourceFiles: 0,
  }
}

function buildWeeklyTokenMetric(
  weeklyWindow: CodexRateLimits['secondary'],
  weeklyTokenUsage: CodexWeeklyTokenUsage | null,
): UsageMetric {
  if (!weeklyWindow?.resets_at || !weeklyWindow.window_minutes) {
    return valueMetric(
      'codex-week-tokens',
      'Week tokens',
      null,
      null,
      null,
      'Codex did not expose a weekly window in the local rate-limit payload.',
    )
  }

  if (!weeklyTokenUsage || weeklyTokenUsage.sourceFiles === 0) {
    return valueMetric(
      'codex-week-tokens',
      'Week tokens',
      null,
      null,
      buildResetLabelFromEpoch(weeklyWindow.resets_at),
      'Weekly token totals could not be derived from the local Codex session logs.',
    )
  }

  return valueMetric(
    'codex-week-tokens',
    'Week tokens',
    formatTokenCount(weeklyTokenUsage.total_tokens),
    buildTokenBreakdownLabel(weeklyTokenUsage),
    buildResetLabelFromEpoch(weeklyWindow.resets_at),
  )
}

async function listCodexSessionFiles() {
  const sessionRoot = homePath('.codex', 'sessions')
  const archiveRoot = homePath('.codex', 'archived_sessions')
  const candidates = [
    ...(await walkFiles(sessionRoot).catch(() => [])),
    ...(await walkFiles(archiveRoot).catch(() => [])),
  ].filter((file) => file.endsWith('.jsonl'))

  const filesWithStats = await Promise.all(
    candidates.map(async (file) => ({
      file,
      mtimeMs: (await stat(file)).mtimeMs,
    })),
  )

  filesWithStats.sort((left, right) => right.mtimeMs - left.mtimeMs)
  return filesWithStats
}

async function findLatestCodexSnapshot(filesWithStats: CodexSessionFile[]) {
  for (const candidate of filesWithStats) {
    const contents = await fs.readFile(candidate.file, 'utf8')
    const lines = contents.trim().split('\n')

    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const parsed = parseCodexTokenCount(lines[index])
      if (parsed) {
        return {
          file: candidate.file,
          timestamp: parsed.timestamp,
          rateLimits: parsed.rateLimits,
        }
      }
    }
  }

  throw new Error('No Codex rate-limit snapshot was found in local session logs.')
}

async function getWeeklyTokenUsage(filesWithStats: CodexSessionFile[], weeklyWindow: CodexRateLimits['secondary']) {
  if (!weeklyWindow?.resets_at || !weeklyWindow.window_minutes) {
    return null
  }

  const windowStartMs = weeklyWindow.resets_at * 1000 - weeklyWindow.window_minutes * 60 * 1000
  const windowEndMs = Date.now()
  const relevantFiles = filesWithStats.filter((file) => file.mtimeMs >= windowStartMs)

  if (relevantFiles.length === 0) {
    return null
  }

  const aggregate = createEmptyWeeklyTokenUsage()

  for (const file of relevantFiles) {
    const contents = await fs.readFile(file.file, 'utf8')
    const lines = contents.trim().split('\n')
    let baselineUsage: CodexTokenUsage | null = null
    let latestWindowUsage: CodexTokenUsage | null = null

    for (const line of lines) {
      const parsed = parseCodexTokenCount(line)
      if (!parsed?.timestamp || !parsed.totalTokenUsage) {
        continue
      }

      const timestampMs = Date.parse(parsed.timestamp)
      if (!Number.isFinite(timestampMs)) {
        continue
      }

      if (timestampMs < windowStartMs) {
        baselineUsage = parsed.totalTokenUsage
        continue
      }

      if (timestampMs <= windowEndMs) {
        latestWindowUsage = parsed.totalTokenUsage
      }
    }

    if (!latestWindowUsage) {
      continue
    }

    const contribution = diffTokenUsage(latestWindowUsage, baselineUsage)
    aggregate.input_tokens += contribution.input_tokens
    aggregate.cached_input_tokens += contribution.cached_input_tokens
    aggregate.output_tokens += contribution.output_tokens
    aggregate.reasoning_output_tokens += contribution.reasoning_output_tokens
    aggregate.total_tokens += contribution.total_tokens
    aggregate.sourceFiles += 1
  }

  return aggregate.sourceFiles > 0 ? aggregate : null
}

async function getCodexAccountLabel() {
  const { stdout } = await execFileAsync('codex', ['login', 'status'], {
    cwd: process.cwd(),
  })

  const trimmed = stdout.trim()
  if (!trimmed) {
    return null
  }

  return trimmed.replace(/^Logged in using\s+/i, '').trim() || trimmed
}

export async function getCodexSnapshot(): Promise<ProviderSnapshot> {
  try {
    const filesWithStats = await listCodexSessionFiles()
    const [snapshot, accountLabel] = await Promise.all([
      findLatestCodexSnapshot(filesWithStats),
      getCodexAccountLabel().catch(() => null),
    ])
    const primaryWindow = snapshot.rateLimits.primary
    const weeklyWindow = snapshot.rateLimits.secondary
    const weeklyTokenUsage = await getWeeklyTokenUsage(filesWithStats, weeklyWindow)
    const shortWindowHours = primaryWindow?.window_minutes
      ? `${Math.round(primaryWindow.window_minutes / 60)}-hour left`
      : 'Short-window left'

    return {
      id: 'codex',
      name: 'Codex',
      plan: (snapshot.rateLimits.plan_type ?? 'subscription').toUpperCase(),
      accountLabel,
      sourceLabel: 'Latest local ~/.codex session log snapshot',
      observedAt: snapshot.timestamp,
      stale: false,
      headline: [
        metricFromUsedPercent(
          'codex-weekly',
          'Weekly left',
          weeklyWindow?.used_percent ?? null,
          buildResetLabelFromEpoch(weeklyWindow?.resets_at),
        ),
        {
          key: 'codex-monthly',
          label: 'Monthly left',
          status: 'unavailable',
          leftPercent: null,
          usedPercent: null,
          resetLabel: null,
          note: 'Codex local subscription data exposes short-window and weekly limits, not a monthly percentage.',
          tone: 'unknown',
        },
      ],
      extras: [
        metricFromUsedPercent(
          'codex-primary',
          shortWindowHours,
          primaryWindow?.used_percent ?? null,
          buildResetLabelFromEpoch(primaryWindow?.resets_at),
        ),
        buildWeeklyTokenMetric(weeklyWindow, weeklyTokenUsage),
      ],
      notes: [
        'Codex numbers come from the latest local CLI session record rather than a public consumer usage API.',
        'The monthly card stays unavailable because the local rate-limit payload does not expose a monthly window.',
        'Week tokens are summed from local token_count telemetry across sessions in the current weekly Codex window.',
      ],
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown Codex usage error'

    return {
      id: 'codex',
      name: 'Codex',
      plan: 'Unavailable',
      accountLabel: null,
      sourceLabel: 'Local ~/.codex session logs',
      observedAt: null,
      stale: true,
      headline: [
        {
          key: 'codex-weekly',
          label: 'Weekly left',
          status: 'unavailable',
          leftPercent: null,
          usedPercent: null,
          resetLabel: null,
          note: message,
          tone: 'unknown',
        },
        {
          key: 'codex-monthly',
          label: 'Monthly left',
          status: 'unavailable',
          leftPercent: null,
          usedPercent: null,
          resetLabel: null,
          note: 'Unavailable because Codex usage could not be read.',
          tone: 'unknown',
        },
      ],
      extras: [],
      notes: ['Codex usage is currently unavailable.'],
    }
  }
}
