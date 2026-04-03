import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import * as pty from 'node-pty'
import stripAnsi from 'strip-ansi'

import type { ProviderSnapshot, UsageMetric } from './types.js'
import { toneForLeftPercent } from './utils.js'

const execFileAsync = promisify(execFile)

type ClaudeAuthStatus = {
  loggedIn: boolean
  orgName?: string
  subscriptionType?: string
  authMethod?: string
}

type ClaudeUsageState = {
  currentSession: {
    usedPercent: number
    resetLabel: string
  }
  weeklyAllModels: {
    usedPercent: number
    resetLabel: string
  }
  weeklySonnetOnly: {
    usedPercent: number
    resetLabel: string
  }
}

function createMetric(key: string, label: string, usedPercent: number | null, resetLabel: string | null, note?: string) {
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

async function getClaudeAuthStatus(): Promise<ClaudeAuthStatus> {
  const { stdout } = await execFileAsync('claude', ['auth', 'status'], {
    cwd: process.cwd(),
  })

  return JSON.parse(stdout) as ClaudeAuthStatus
}

function collapseTerminalText(input: string) {
  return stripAnsi(input)
    .replaceAll('\u0007', ' ')
    .replaceAll('\r', '\n')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseClaudeUsageText(rawText: string): ClaudeUsageState {
  const collapsed = collapseTerminalText(rawText)
  const relevantStart = collapsed.lastIndexOf('Current session')
  const relevant = relevantStart >= 0 ? collapsed.slice(relevantStart) : collapsed

  const currentSessionMatch = relevant.match(
    /Current session\s+.*?(\d+)%used\s+Rese(?:ts|s)?\s*(.+?)\s+Current week \(all models\)/,
  )
  const weeklyAllMatch = relevant.match(
    /Current week \(all models\)\s+.*?(\d+)%used\s+Rese(?:ts|s)?\s*(.+?)\s+Current week \(Sonnet only\)/,
  )
  const weeklySonnetMatch = relevant.match(
    /Current week \(Sonnet only\)\s+.*?(\d+)%used\s+Rese(?:ts|s)?\s*(.+?)(?:\s+Esc to cancel|$)/,
  )

  if (!currentSessionMatch || !weeklyAllMatch || !weeklySonnetMatch) {
    throw new Error('Unable to parse Claude usage from the /status Usage tab.')
  }

  return {
    currentSession: {
      usedPercent: Number.parseInt(currentSessionMatch[1], 10),
      resetLabel: `Resets ${currentSessionMatch[2]}`,
    },
    weeklyAllModels: {
      usedPercent: Number.parseInt(weeklyAllMatch[1], 10),
      resetLabel: `Resets ${weeklyAllMatch[2]}`,
    },
    weeklySonnetOnly: {
      usedPercent: Number.parseInt(weeklySonnetMatch[1], 10),
      resetLabel: `Resets ${weeklySonnetMatch[2]}`,
    },
  }
}

async function collectClaudeUsageScreen(): Promise<string> {
  return new Promise((resolve, reject) => {
    const term = pty.spawn('claude', [], {
      name: 'xterm-256color',
      cols: 100,
      rows: 32,
      cwd: process.cwd(),
      env: process.env,
    })

    let output = ''
    let phase: 'boot' | 'status' | 'usage' = 'boot'
    let finished = false

    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('Timed out while collecting Claude /status usage data.'))
    }, 20_000)

    const cleanup = () => {
      if (finished) {
        return
      }
      finished = true
      clearTimeout(timeout)
      try {
        term.kill()
      } catch {
        // Ignore shutdown errors.
      }
    }

    const advanceIfReady = () => {
      const collapsed = collapseTerminalText(output)

      if (phase === 'boot' && (collapsed.includes('ClaudeCode') || collapsed.includes('Welcomeback'))) {
        phase = 'status'
        term.write('/status\r')
        return
      }

      if (phase === 'status' && collapsed.includes('Version:') && collapsed.includes('SessionID:')) {
        phase = 'usage'
        term.write('\u001b[C')
        setTimeout(() => term.write('\u001b[C'), 180)
        return
      }

      if (
        phase === 'usage' &&
        collapsed.includes('Current session') &&
        collapsed.includes('Current week (all models)') &&
        collapsed.includes('Current week (Sonnet only)')
      ) {
        cleanup()
        resolve(output)
      }
    }

    term.onData((chunk) => {
      output += chunk
      advanceIfReady()
    })

    term.onExit(() => {
      if (!finished) {
        cleanup()
        reject(new Error('Claude exited before the usage screen could be collected.'))
      }
    })
  })
}

export async function getClaudeSnapshot(): Promise<ProviderSnapshot> {
  try {
    const [auth, rawUsageText] = await Promise.all([getClaudeAuthStatus(), collectClaudeUsageScreen()])
    const usage = parseClaudeUsageText(rawUsageText)
    const observedAt = new Date().toISOString()

    return {
      id: 'claude',
      name: 'Claude Code',
      plan: (auth.subscriptionType ?? 'unknown').toUpperCase(),
      accountLabel: auth.orgName?.trim() ? auth.orgName : auth.authMethod?.trim() ? auth.authMethod : null,
      sourceLabel: 'Interactive Claude /status Usage tab',
      observedAt,
      stale: false,
      headline: [
        createMetric(
          'claude-weekly',
          'Weekly left',
          usage.weeklyAllModels.usedPercent,
          usage.weeklyAllModels.resetLabel,
        ),
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
        'Claude data is collected by opening the supported /status screen in a PTY and parsing the Usage tab.',
        'Monthly analytics are intentionally marked unavailable for individual plans because Anthropic does not publish them there.',
      ],
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown Claude usage error'

    return {
      id: 'claude',
      name: 'Claude Code',
      plan: 'Unavailable',
      accountLabel: null,
      sourceLabel: 'Interactive Claude /status Usage tab',
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
