import { createStore } from './store'
import { settingsStore, type LibraryItem } from './library'
import type { MediaType } from './meta'

// A source is a site whose player can be embedded from a URL template.
// lastframe ships with none; you add your own on the Sources page or in
// public/sources.local.json (gitignored).
export interface Source {
  id: string
  name: string
  enabled: boolean
  hosts: string[] // mirror domains, tried in order, substituted for {host}
  movie: string // URL template for a movie
  episode: string // URL template for an episode
  sandbox: boolean // block popups and redirects out of the player
}

export interface SourcesState {
  sources: Source[]
  seeded: boolean // sources.local.json has been looked for
  lastWorking?: string // source id that most recently played anything
}

export interface Health {
  ok: boolean
  ms: number
  at: number
}

export const sourcesStore = createStore<SourcesState>('lastframe.sources.v1', () => ({ sources: [], seeded: false }))
export const healthStore = createStore<Record<string, Health>>('lastframe.health.v1', () => ({}))

export const TEMPLATE_VARS: [string, string][] = [
  ['{host}', 'the mirror being tried, from the hosts list'],
  ['{imdb}', 'IMDb id, e.g. tt0903747'],
  ['{tmdb}', 'TMDB id, e.g. 1396 (sources needing it are skipped for titles without one)'],
  ['{season}', 'season number'],
  ['{episode}', 'episode number'],
  ['{t}', 'seconds to resume from (0 when starting fresh)'],
  ['{type}', '"movie" or "tv"'],
  ['{title}', 'URL-encoded title'],
  ['{slug}', 'title as a lowercase-hyphenated slug'],
  ['{year}', 'first release year'],
]

export function newId(): string {
  return Math.random().toString(36).slice(2, 10)
}

export function normalizeSource(raw: unknown): Source | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const movie = typeof r.movie === 'string' ? r.movie.trim() : ''
  const episode = typeof r.episode === 'string' ? r.episode.trim() : ''
  if (!movie && !episode) return null
  const hosts = Array.isArray(r.hosts)
    ? r.hosts
    : typeof r.hosts === 'string'
      ? r.hosts.split(/[\s,]+/)
      : []
  return {
    id: typeof r.id === 'string' && r.id ? r.id : newId(),
    name: typeof r.name === 'string' && r.name.trim() ? r.name.trim() : 'Untitled source',
    enabled: r.enabled !== false,
    hosts: hosts.map((h) => String(h).trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')).filter(Boolean),
    movie,
    episode,
    sandbox: typeof r.sandbox === 'boolean' ? r.sandbox : settingsStore.get().sandboxDefault,
  }
}

export function parseSourceList(data: unknown): Source[] {
  const list = Array.isArray(data) ? data : (data as { sources?: unknown[] })?.sources
  return Array.isArray(list) ? list.map(normalizeSource).filter((s): s is Source => !!s) : []
}

export function addSources(incoming: Source[]): number {
  const existing = sourcesStore.get().sources
  const fresh = incoming.filter(
    (s) => !existing.some((e) => e.id === s.id || (e.movie === s.movie && e.episode === s.episode)),
  )
  if (fresh.length) sourcesStore.set((st) => ({ ...st, sources: [...st.sources, ...fresh] }))
  return fresh.length
}

// On first run, pick up a personal source list from public/sources.local.json.
export async function loadLocalSourceFile(force = false): Promise<number | null> {
  if (!force && sourcesStore.get().seeded) return null
  sourcesStore.set((st) => ({ ...st, seeded: true }))
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}sources.local.json`, { cache: 'no-store' })
    if (!res.ok || !res.headers.get('content-type')?.includes('json')) return null
    return addSources(parseSourceList(await res.json()))
  } catch {
    return null
  }
}

export interface Target {
  type: MediaType
  imdb: string
  tmdb?: string
  season?: number
  episode?: number
  title: string
  year?: string
  startAt: number
}

export interface Candidate {
  source: Source
  host?: string
  url: string
  origin: string
}

function fill(template: string, vars: Record<string, string | undefined>): string | null {
  let missing = false
  const out = template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    if (!(name in vars)) return whole
    const v = vars[name]
    if (v == null || v === '') missing = true
    return v ?? ''
  })
  return missing ? null : out
}

// Every URL a source can offer for a target: one per mirror host.
export function candidatesFor(source: Source, target: Target): Candidate[] {
  const template = target.type === 'movie' ? source.movie : source.episode
  if (!template) return []
  const vars: Record<string, string | undefined> = {
    imdb: target.imdb,
    tmdb: target.tmdb,
    season: target.season?.toString(),
    episode: target.episode?.toString(),
    t: String(Math.floor(target.startAt)),
    type: target.type === 'movie' ? 'movie' : 'tv',
    title: encodeURIComponent(target.title),
    slug: target.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    year: target.year?.match(/\d{4}/)?.[0],
  }
  const hosts: (string | undefined)[] = template.includes('{host}') ? source.hosts : [undefined]
  const out: Candidate[] = []
  for (const host of hosts) {
    const url = fill(template, { ...vars, host })
    if (!url) continue
    try {
      out.push({ source, host, url, origin: new URL(url).origin })
    } catch {
      // template produced something that isn't a URL
    }
  }
  return out
}

// Fallback order for one title: what played it last, then what played anything
// last, then your list order; sources that failed on this title go to the back.
export function orderSources(sources: Source[], item?: LibraryItem, lastWorking?: string): Source[] {
  const rank = (s: Source) => {
    if (item?.failedSources?.[s.id]) return 3
    if (s.id === item?.preferredSource) return 0
    if (s.id === lastWorking) return 1
    return 2
  }
  return sources
    .filter((s) => s.enabled)
    .map((s, i) => ({ s, i }))
    .sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i)
    .map(({ s }) => s)
}

const UP_TTL = 15 * 60 * 1000
const DOWN_TTL = 3 * 60 * 1000

export type Status = 'up' | 'down' | 'unknown' | 'checking'

const inFlight = new Map<string, Promise<Health>>()

export function statusOf(origin: string, health: Record<string, Health>): Status {
  if (inFlight.has(origin)) return 'checking'
  const h = health[origin]
  if (!h) return 'unknown'
  if (Date.now() - h.at > (h.ok ? UP_TTL : DOWN_TTL)) return 'unknown'
  return h.ok ? 'up' : 'down'
}

// Can the site be reached at all? An opaque no-cors request resolves for any
// HTTP answer and rejects on DNS failure, refused connections and timeouts,
// which is how these sites usually die. It can't tell whether a title plays.
export function probe(origin: string, timeoutMs = 7000): Promise<Health> {
  const running = inFlight.get(origin)
  if (running) return running
  const job = (async () => {
    const started = performance.now()
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    let ok = false
    try {
      await fetch(`${origin}/`, {
        method: 'HEAD',
        mode: 'no-cors',
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: ctrl.signal,
      })
      ok = true
    } catch {
      ok = false
    } finally {
      clearTimeout(timer)
    }
    const result = { ok, ms: Math.round(performance.now() - started), at: Date.now() }
    inFlight.delete(origin)
    healthStore.set((h) => ({ ...h, [origin]: result }))
    return result
  })()
  inFlight.set(origin, job)
  healthStore.set((h) => ({ ...h })) // re-render so callers see "checking"
  return job
}

export function originsOf(source: Source): string[] {
  const sample: Target = { type: 'movie', imdb: 'tt0468569', tmdb: '155', title: 'The Dark Knight', year: '2008', startAt: 0 }
  const fromMovie = candidatesFor(source, sample)
  const fromEpisode = candidatesFor(source, { ...sample, type: 'series', season: 1, episode: 1 })
  return [...new Set([...fromMovie, ...fromEpisode].map((c) => c.origin))]
}
