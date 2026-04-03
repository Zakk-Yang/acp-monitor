import { promises as fs, createReadStream } from 'node:fs'
import crypto from 'node:crypto'

import { homePath, walkFiles } from './utils.js'
import type { AcpProvider, CompletionEvent } from './types.js'

const POLL_INTERVAL_MS = 3_000

type Listener = (event: CompletionEvent) => void

const offsets = new Map<string, number>()
const listeners = new Set<Listener>()

async function discoverJsonlFiles(root: string): Promise<string[]> {
  try {
    const all = await walkFiles(root)
    return all.filter((f) => f.endsWith('.jsonl'))
  } catch {
    return []
  }
}

function readNewBytes(filePath: string, start: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const stream = createReadStream(filePath, { start, encoding: undefined })
    stream.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    stream.on('error', reject)
  })
}

function isClaudeCompletion(line: string): string | null {
  try {
    const data = JSON.parse(line)
    if (
      data.type === 'assistant' &&
      data.message?.stop_reason === 'end_turn' &&
      data.timestamp
    ) {
      return data.timestamp
    }
  } catch {
    // malformed line
  }
  return null
}

function isCodexCompletion(line: string): string | null {
  try {
    const data = JSON.parse(line)
    if (
      data.type === 'response_item' &&
      data.payload?.type === 'message' &&
      data.payload?.role === 'assistant' &&
      data.timestamp
    ) {
      return data.timestamp
    }
  } catch {
    // malformed line
  }
  return null
}

function emit(event: CompletionEvent) {
  for (const listener of listeners) {
    try {
      listener(event)
    } catch {
      // listener error should not crash the watcher
    }
  }
}

async function scanFile(
  filePath: string,
  provider: AcpProvider,
) {
  let size: number
  try {
    const stat = await fs.stat(filePath)
    size = stat.size
  } catch {
    return
  }

  const offset = offsets.get(filePath)

  if (offset === undefined) {
    // First time seeing this file — skip existing content
    offsets.set(filePath, size)
    return
  }

  if (size <= offset) {
    return
  }

  let raw: string
  try {
    raw = await readNewBytes(filePath, offset)
  } catch {
    return
  }

  offsets.set(filePath, size)

  const lines = raw.split('\n')
  const checker = provider === 'claude' ? isClaudeCompletion : isCodexCompletion

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    const timestamp = checker(trimmed)
    if (timestamp) {
      emit({
        id: crypto.randomUUID(),
        provider,
        timestamp,
        detectedAt: new Date().toISOString(),
      })
    }
  }
}

async function poll() {
  const claudeRoot = homePath('.claude', 'projects')
  const codexRoot = homePath('.codex', 'sessions')

  const [claudeFiles, codexFiles] = await Promise.all([
    discoverJsonlFiles(claudeRoot),
    discoverJsonlFiles(codexRoot),
  ])

  const tasks: Promise<void>[] = []

  for (const f of claudeFiles) {
    tasks.push(scanFile(f, 'claude'))
  }

  for (const f of codexFiles) {
    tasks.push(scanFile(f, 'codex'))
  }

  await Promise.all(tasks)
}

export function startWatcher() {
  // Run the first poll to seed offsets (no notifications will fire)
  void poll()

  setInterval(() => {
    void poll()
  }, POLL_INTERVAL_MS)
}

export function onCompletion(callback: Listener): () => void {
  listeners.add(callback)
  return () => {
    listeners.delete(callback)
  }
}
