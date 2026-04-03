import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { stat } from 'node:fs/promises'
import { promisify } from 'node:util'

import type { ProviderSnapshot, UsageMetric } from './types.js'
import { buildResetLabelFromEpoch, homePath, toneForLeftPercent, walkFiles } from './utils.js'

const execFileAsync = promisify(execFile)

type CodexTokenCountPayload = {
  timestamp?: string
  payload?: {
    type?: string
    rate_limits?: {
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

async function findLatestCodexSnapshot() {
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

  for (const candidate of filesWithStats) {
    const contents = await fs.readFile(candidate.file, 'utf8')
    const lines = contents.trim().split('\n')

    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]
      if (!line.includes('"token_count"') || !line.includes('"rate_limits"')) {
        continue
      }

      try {
        const parsed = JSON.parse(line) as CodexTokenCountPayload
        if (parsed.payload?.type === 'token_count' && parsed.payload.rate_limits?.primary) {
          return {
            file: candidate.file,
            timestamp: parsed.timestamp ?? null,
            rateLimits: parsed.payload.rate_limits,
          }
        }
      } catch {
        continue
      }
    }
  }

  throw new Error('No Codex rate-limit snapshot was found in local session logs.')
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
    const [snapshot, accountLabel] = await Promise.all([findLatestCodexSnapshot(), getCodexAccountLabel().catch(() => null)])
    const primaryWindow = snapshot.rateLimits.primary
    const weeklyWindow = snapshot.rateLimits.secondary
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
      ],
      notes: [
        'Codex numbers come from the latest local CLI session record rather than a public consumer usage API.',
        'The monthly card stays unavailable because the local rate-limit payload does not expose a monthly window.',
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
