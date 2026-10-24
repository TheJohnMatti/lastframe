const pad = (n: number) => String(n).padStart(2, '0')

export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`
}

// "12:34", "1:02:03" or a bare number of minutes ("42") into seconds.
export function parseClock(text: string): number | null {
  const t = text.trim()
  if (!t) return null
  if (/^\d+$/.test(t)) return Number(t) * 60
  const parts = t.split(':').map(Number)
  if (parts.length > 3 || parts.some((p) => !Number.isFinite(p) || p < 0)) return null
  return parts.reduce((acc, p) => acc * 60 + p, 0)
}

export function minutesLeft(seconds: number): string {
  const m = Math.round(seconds / 60)
  if (m < 1) return 'under a minute'
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${pad(m % 60)}m`
}

// Cinemeta runtimes look like "152 min" or "1h 30min".
export function parseRuntime(runtime?: string): number | undefined {
  if (!runtime) return undefined
  const h = runtime.match(/(\d+)\s*h/)
  const m = runtime.match(/(\d+)\s*m/)
  const total = (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0)
  return total > 0 ? total * 60 : undefined
}

export function epLabel(season: number, episode: number): string {
  return season === 0 ? `Special ${episode}` : `S${season} · E${episode}`
}

export function shortDate(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export function ago(ts?: number): string {
  if (!ts) return ''
  const s = (Date.now() - ts) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`
  return new Date(ts).toLocaleDateString()
}
