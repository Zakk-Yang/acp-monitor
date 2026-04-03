import { startTransition, useEffect, useEffectEvent, useRef, useState } from 'react'
import './App.css'

type MetricStatus = 'available' | 'unavailable'
type MetricTone = 'healthy' | 'caution' | 'tight' | 'unknown'

type UsageMetric = {
  key: string
  label: string
  status: MetricStatus
  leftPercent: number | null
  usedPercent: number | null
  resetLabel: string | null
  note: string | null
  tone: MetricTone
}

type ProviderSnapshot = {
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

type DashboardResponse = {
  fetchedAt: string
  refreshIntervalMs: number
  providers: ProviderSnapshot[]
  warnings: string[]
}

type AcpProvider = 'claude' | 'codex'

const FALLBACK_REFRESH_MS = 300_000

function playNotificationSound(provider: AcpProvider) {
  const ctx = new AudioContext()
  const now = ctx.currentTime
  const frequencies = provider === 'claude' ? [523, 659] : [440, 554]

  for (let i = 0; i < frequencies.length; i++) {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = frequencies[i]
    gain.gain.setValueAtTime(0.3, now + i * 0.15)
    gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.15 + 0.3)
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(now + i * 0.15)
    osc.stop(now + i * 0.15 + 0.35)
  }

  setTimeout(() => ctx.close(), 1000)
}

function formatTimestamp(value: string | null) {
  if (!value) {
    return 'Unavailable'
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function MetricCard({
  metric,
  emphasis = 'default',
}: {
  metric: UsageMetric
  emphasis?: 'default' | 'primary'
}) {
  const percentLabel =
    metric.status === 'available' && metric.leftPercent !== null
      ? `${Math.round(metric.leftPercent)}%`
      : 'N/A'

  return (
    <article className={`metric-card metric-card--${emphasis}`} data-tone={metric.tone}>
      <div className="metric-card__eyebrow">{metric.label}</div>
      <div className="metric-card__value">{percentLabel}</div>
      <div className="metric-card__caption">
        {metric.status === 'available'
          ? `${Math.round(metric.usedPercent ?? 0)}% used`
          : metric.note ?? 'This window is not exposed.'}
      </div>
      <div className="metric-card__reset">{metric.resetLabel ?? 'No reset window available'}</div>
    </article>
  )
}

function ProviderPanel({ provider }: { provider: ProviderSnapshot }) {
  const metrics = [...provider.headline, ...provider.extras].filter((metric) => !metric.key.includes('monthly'))

  return (
    <section className="provider-panel" data-provider={provider.id}>
      <header className="provider-panel__header">
        <div className="provider-panel__title-block">
          {provider.accountLabel ? <p className="provider-panel__kicker">{provider.accountLabel}</p> : null}
          <h2>{provider.name}</h2>
        </div>
        <div className="provider-panel__meta">
          <span className="provider-panel__plan">{provider.plan}</span>
          <span className={`provider-panel__freshness${provider.stale ? ' is-stale' : ''}`}>
            {provider.stale ? 'cached' : 'live'}
          </span>
          <span className="provider-panel__timestamp">{formatTimestamp(provider.observedAt)}</span>
        </div>
      </header>

      <div className="metric-grid metric-grid--compact">
        {metrics.map((metric, index) => (
          <MetricCard key={metric.key} metric={metric} emphasis={index === 0 ? 'primary' : 'default'} />
        ))}
      </div>

      <div className="provider-panel__source">{provider.sourceLabel}</div>
    </section>
  )
}

function App() {
  const [data, setData] = useState<DashboardResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [soundEnabled, setSoundEnabled] = useState(true)
  const soundEnabledRef = useRef(true)

  async function requestDashboard(mode: 'initial' | 'manual' | 'poll') {
    if (mode === 'initial') {
      setLoading(true)
    }

    if (mode === 'manual') {
      startTransition(() => {
        setRefreshing(true)
      })
    }

    try {
      let response: Response
      try {
        response = await fetch('/api/usage', {
          headers: {
            Accept: 'application/json',
          },
        })
      } catch {
        throw new Error('Could not reach the server — is the backend running?')
      }

      if (!response.ok) {
        let detail = `Request failed (${response.status})`
        try {
          const body = (await response.json()) as { error?: string }
          if (body.error) {
            detail = body.error
          }
        } catch {
          // response body wasn't JSON, keep the status-based message
        }
        throw new Error(detail)
      }

      const nextData = (await response.json()) as DashboardResponse
      setData(nextData)
      setError(null)
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : 'Unknown refresh error'
      setError(message)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  const loadDashboard = useEffectEvent((mode: 'initial' | 'manual' | 'poll') => {
    void requestDashboard(mode)
  })

  useEffect(() => {
    void loadDashboard('initial')

    const interval = window.setInterval(() => {
      void loadDashboard('poll')
    }, data?.refreshIntervalMs ?? FALLBACK_REFRESH_MS)

    return () => {
      window.clearInterval(interval)
    }
  }, [data?.refreshIntervalMs])

  useEffect(() => {
    const source = new EventSource('/api/events')

    source.onmessage = (event) => {
      const data = JSON.parse(event.data) as { provider: AcpProvider }
      if (soundEnabledRef.current) {
        playNotificationSound(data.provider)
      }
    }

    return () => source.close()
  }, [])

  function toggleSound() {
    setSoundEnabled((prev) => {
      soundEnabledRef.current = !prev
      return !prev
    })
  }

  return (
    <main className="shell">
      <section className="masthead">
        <h1 className="masthead__title">ACP USAGE DASHBOARD</h1>
        <div className="masthead__actions">
          <button
            className="sound-toggle"
            onClick={toggleSound}
            title={soundEnabled ? 'Mute task notifications' : 'Unmute task notifications'}
            data-active={soundEnabled}
          >
            {soundEnabled ? 'Sound on' : 'Sound off'}
          </button>
          <button
            className="refresh-button"
            onClick={() => void requestDashboard('manual')}
            disabled={loading || refreshing}
          >
            {refreshing ? 'Refreshing...' : 'Refresh now'}
          </button>
        </div>
      </section>

      {error ? <p className="status-banner status-banner--error">Refresh error: {error}</p> : null}

      {data?.warnings.length ? (
        <ul className="status-list">
          {data.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}

      {loading && !data ? <p className="loading-state">Collecting the first snapshot...</p> : null}

      {data ? (
        <section className="provider-grid">
          {data.providers.map((provider) => (
            <ProviderPanel key={provider.id} provider={provider} />
          ))}
        </section>
      ) : null}
    </main>
  )
}

export default App
