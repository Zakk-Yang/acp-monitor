import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function formatLocalTimestamp(value: Date | number) {
  return new Intl.DateTimeFormat('en-GB', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'Europe/London',
  }).format(value)
}

export function buildResetLabelFromEpoch(epochSeconds: number | null | undefined) {
  if (!epochSeconds) {
    return null
  }

  return `Resets ${formatLocalTimestamp(epochSeconds * 1000)} (Europe/London)`
}

const compactCountFormatter = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
})

export function formatCompactCount(value: number | null | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null
  }

  return value >= 1_000 ? compactCountFormatter.format(value) : value.toString()
}

export function toneForLeftPercent(leftPercent: number | null) {
  if (leftPercent === null) {
    return 'unknown' as const
  }

  if (leftPercent < 20) {
    return 'tight' as const
  }

  if (leftPercent < 45) {
    return 'caution' as const
  }

  return 'healthy' as const
}

export function homePath(...segments: string[]) {
  return path.join(os.homedir(), ...segments)
}

export async function walkFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(root, entry.name)
      if (entry.isDirectory()) {
        return walkFiles(fullPath)
      }
      return [fullPath]
    }),
  )

  return files.flat()
}
