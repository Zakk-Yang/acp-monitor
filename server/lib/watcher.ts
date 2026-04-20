import { promises as fs, createReadStream } from 'node:fs'
import crypto from 'node:crypto'

import { homePath, walkFiles } from './utils.js'
import type { AcpProvider, CompletionEvent } from './types.js'

const POLL_INTERVAL_MS = 3_000
const IDLE_WINDOW_MS = 10_000

type Listener = (event: CompletionEvent) => void
type ActivitySignal = {
  timestamp: string
  shouldScheduleIdle: boolean
  isTaskComplete: boolean
  toolStarts: string[]
  toolEnds: string[]
}
type FileActivityState = {
  idleTimer: NodeJS.Timeout | null
  lastTimestamp: string | null
  pendingToolCalls: Set<string>
}

const offsets = new Map<string, number>()
const listeners = new Set<Listener>()
const fileStates = new Map<string, FileActivityState>()

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

function getFileState(filePath: string): FileActivityState {
  const existing = fileStates.get(filePath)
  if (existing) {
    return existing
  }

  const created: FileActivityState = {
    idleTimer: null,
    lastTimestamp: null,
    pendingToolCalls: new Set<string>(),
  }
  fileStates.set(filePath, created)
  return created
}

function clearIdleTimer(state: FileActivityState) {
  if (!state.idleTimer) {
    return
  }

  clearTimeout(state.idleTimer)
  state.idleTimer = null
}

function resetFileState(filePath: string) {
  const state = fileStates.get(filePath)
  if (!state) {
    return
  }

  clearIdleTimer(state)
  fileStates.delete(filePath)
}

function parseClaudeActivity(line: string): ActivitySignal | null {
  try {
    const data = JSON.parse(line)
    if (data.type === 'assistant' && data.timestamp) {
      const msg = data.message
      const stopReason = msg?.stop_reason as string | null
      const content = Array.isArray(msg?.content) ? msg.content : []
      const toolStarts = content.flatMap((item: { id?: string; type?: string }) =>
        item.type === 'tool_use' && item.id ? [item.id] : [],
      )

      return {
        timestamp: data.timestamp,
        shouldScheduleIdle: stopReason === 'end_turn',
        isTaskComplete: false,
        toolStarts,
        toolEnds: [],
      }
    }

    if (data.type === 'user' && data.timestamp) {
      const content = Array.isArray(data.message?.content) ? data.message.content : []
      const toolEnds = content.flatMap((item: { tool_use_id?: string; type?: string }) =>
        item.type === 'tool_result' && item.tool_use_id ? [item.tool_use_id] : [],
      )

      if (toolEnds.length > 0) {
        return {
          timestamp: data.timestamp,
          shouldScheduleIdle: false,
          isTaskComplete: false,
          toolStarts: [],
          toolEnds,
        }
      }
    }
  } catch {
    // malformed line
  }
  return null
}

function parseCodexActivity(line: string): ActivitySignal | null {
  try {
    const data = JSON.parse(line)
    if (!data.timestamp) {
      return null
    }

    if (data.type === 'event_msg' && data.payload?.type === 'task_complete') {
      return {
        timestamp: data.timestamp,
        shouldScheduleIdle: false,
        isTaskComplete: true,
        toolStarts: [],
        toolEnds: [],
      }
    }

    if (data.type === 'event_msg' && data.payload?.type === 'token_count') {
      return {
        timestamp: data.timestamp,
        shouldScheduleIdle: false,
        isTaskComplete: false,
        toolStarts: [],
        toolEnds: [],
      }
    }

    if (data.type === 'response_item' && data.payload?.type === 'function_call' && data.payload.call_id) {
      return {
        timestamp: data.timestamp,
        shouldScheduleIdle: false,
        isTaskComplete: false,
        toolStarts: [data.payload.call_id],
        toolEnds: [],
      }
    }

    if (data.type === 'response_item' && data.payload?.type === 'function_call_output' && data.payload.call_id) {
      return {
        timestamp: data.timestamp,
        shouldScheduleIdle: false,
        isTaskComplete: false,
        toolStarts: [],
        toolEnds: [data.payload.call_id],
      }
    }

    if (data.type === 'response_item' && data.payload?.role === 'assistant') {
      return {
        timestamp: data.timestamp,
        shouldScheduleIdle: false,
        isTaskComplete: false,
        toolStarts: [],
        toolEnds: [],
      }
    }
  } catch {
    // malformed line
  }
  return null
}

function parseActivity(provider: AcpProvider, line: string): ActivitySignal | null {
  return provider === 'claude' ? parseClaudeActivity(line) : parseCodexActivity(line)
}

function scheduleIdleNotification(filePath: string, provider: AcpProvider, state: FileActivityState) {
  if (!state.lastTimestamp || state.pendingToolCalls.size > 0) {
    return
  }

  const timer = setTimeout(() => {
    const current = fileStates.get(filePath)
    if (!current || current.idleTimer !== timer || !current.lastTimestamp || current.pendingToolCalls.size > 0) {
      return
    }

    current.idleTimer = null

    emit({
      id: crypto.randomUUID(),
      provider,
      timestamp: current.lastTimestamp,
      detectedAt: new Date().toISOString(),
    })
  }, IDLE_WINDOW_MS)

  state.idleTimer = timer
}

function recordActivity(filePath: string, provider: AcpProvider, signal: ActivitySignal) {
  const state = getFileState(filePath)

  clearIdleTimer(state)
  state.lastTimestamp = signal.timestamp

  for (const toolStart of signal.toolStarts) {
    state.pendingToolCalls.add(toolStart)
  }

  for (const toolEnd of signal.toolEnds) {
    state.pendingToolCalls.delete(toolEnd)
  }

  if (signal.isTaskComplete) {
    emit({
      id: crypto.randomUUID(),
      provider,
      timestamp: signal.timestamp,
      detectedAt: new Date().toISOString(),
    })
    resetFileState(filePath)
    return
  }

  if (signal.shouldScheduleIdle && state.pendingToolCalls.size === 0) {
    scheduleIdleNotification(filePath, provider, state)
  }
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

  if (size < offset) {
    offsets.set(filePath, size)
    resetFileState(filePath)
    return
  }

  if (size === offset) {
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

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    const activity = parseActivity(provider, trimmed)
    if (activity) {
      recordActivity(filePath, provider, activity)
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
