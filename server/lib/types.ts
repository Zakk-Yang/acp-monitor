export type MetricStatus = 'available' | 'unavailable'
export type MetricTone = 'healthy' | 'caution' | 'tight' | 'unknown'

export type UsageMetric = {
  key: string
  label: string
  status: MetricStatus
  leftPercent: number | null
  usedPercent: number | null
  resetLabel: string | null
  note: string | null
  tone: MetricTone
  displayValue?: string | null
  displayCaption?: string | null
  footerLabel?: string | null
}

export type ProviderSnapshot = {
  id: string
  name: string
  plan: string
  accountLabel: string | null
  sourceLabel: string
  observedAt: string | null
  stale: boolean
  headline: UsageMetric[]
  extras: UsageMetric[]
  notes: string[]
}

export type DashboardResponse = {
  fetchedAt: string
  refreshIntervalMs: number
  providers: ProviderSnapshot[]
  warnings: string[]
}

export type AcpProvider = 'claude' | 'codex'

export type CompletionEvent = {
  id: string
  provider: AcpProvider
  timestamp: string
  detectedAt: string
}
