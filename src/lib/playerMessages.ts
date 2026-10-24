// Many embeddable players announce playback with window.postMessage. Their
// shapes differ, so rather than knowing any one site, look for a plausible
// (position, duration) pair anywhere in the message.
const POSITION_KEYS = ['currentTime', 'current_time', 'currenttime', 'playedSeconds', 'position', 'timestamp', 'time', 'seconds']
const DURATION_KEYS = ['duration', 'totalTime', 'total_time', 'total', 'length']
const MAX_SECONDS = 48 * 3600 // anything bigger is a clock timestamp, not a position

export interface PlayerTimes {
  position: number
  duration?: number
  ended?: boolean
}

function seconds(o: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = typeof o[k] === 'string' ? Number(o[k]) : o[k]
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < MAX_SECONDS) return v
  }
  return undefined
}

export function extractTimes(data: unknown, depth = 0): PlayerTimes | null {
  if (depth > 4 || data == null) return null
  if (typeof data === 'string') {
    if (data.length > 50_000 || !/^\s*[[{]/.test(data)) return null
    try {
      return extractTimes(JSON.parse(data), depth + 1)
    } catch {
      return null
    }
  }
  if (typeof data !== 'object') return null
  const o = data as Record<string, unknown>
  const duration = seconds(o, DURATION_KEYS)
  let position = seconds(o, POSITION_KEYS)
  if (position === undefined && duration) {
    const pct = seconds(o, ['progress', 'percent', 'percentage'])
    if (pct !== undefined) position = pct <= 1 ? pct * duration : pct <= 100 ? (pct / 100) * duration : undefined
  }
  if (position !== undefined && (duration === undefined || position <= duration + 5)) {
    const label = [o.event, o.type, o.name, o.status].filter((v) => typeof v === 'string').join(' ')
    return { position, duration: duration && duration > 0 ? duration : undefined, ended: /\b(ended|complete)/i.test(label) }
  }
  for (const v of Object.values(o)) {
    const found = extractTimes(v, depth + 1)
    if (found) return found
  }
  return null
}

// Messages from the embed or from any frame nested inside it.
export function isFromFrame(source: MessageEventSource | null, frame: Window): boolean {
  let w = source as Window | null
  for (let i = 0; w && i < 10; i++) {
    if (w === frame) return true
    if (w === window || w.parent === w) return false
    w = w.parent
  }
  return false
}
