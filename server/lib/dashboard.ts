import type { DashboardResponse } from './types.js'
import { getClaudeSnapshot } from './claude.js'
import { getCodexSnapshot } from './codex.js'

const CACHE_TTL_MS = 60_000
const REFRESH_INTERVAL_MS = 300_000

let cachedDashboard: DashboardResponse | null = null
let cachedAt = 0
let inflight: Promise<DashboardResponse> | null = null

async function buildDashboard(): Promise<DashboardResponse> {
  const [codex, claude] = await Promise.all([getCodexSnapshot(), getClaudeSnapshot()])

  const warnings: string[] = []

  if (codex.stale) {
    warnings.push('Codex is serving a stale or unavailable snapshot.')
  }

  if (claude.stale) {
    warnings.push('Claude is serving a stale or unavailable snapshot.')
  }

  return {
    fetchedAt: new Date().toISOString(),
    refreshIntervalMs: REFRESH_INTERVAL_MS,
    providers: [codex, claude],
    warnings,
  }
}

export async function getDashboardData() {
  const now = Date.now()

  if (cachedDashboard && now - cachedAt < CACHE_TTL_MS) {
    return cachedDashboard
  }

  if (inflight) {
    return inflight
  }

  inflight = buildDashboard()
    .then((result) => {
      cachedDashboard = result
      cachedAt = Date.now()
      return result
    })
    .finally(() => {
      inflight = null
    })

  return inflight
}
