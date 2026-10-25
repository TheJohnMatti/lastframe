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
  ['{title}', 'URL-encoded title (spaces as %20)'],
  ['{q}', 'title with spaces as +, as most search boxes send it'],
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
    q: encodeURIComponent(target.title).replace(/%20/g, '+'),
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

// Known titles for previews and for reading templates out of example URLs.
export const SAMPLE_MOVIE: Target = { type: 'movie', imdb: 'tt0468569', tmdb: '155', title: 'The Dark Knight', year: '2008', startAt: 0 }
export const SAMPLE_EPISODE: Target = { type: 'series', imdb: 'tt0903747', tmdb: '1396', season: 3, episode: 7, title: 'Breaking Bad', year: '2008', startAt: 0 }

export function originsOf(source: Source): string[] {
  const fromMovie = candidatesFor(source, SAMPLE_MOVIE)
  const fromEpisode = candidatesFor(source, SAMPLE_EPISODE)
  return [...new Set([...fromMovie, ...fromEpisode].map((c) => c.origin))]
}

export function siteName(host: string): string {
  if (/^[\d.:[\]]+$/.test(host)) return host
  const labels = host.replace(/:\d+$/, '').replace(/^www\./, '').split('.')
  const label = labels.length > 1 ? labels[labels.length - 2] : labels[0]
  return label.charAt(0).toUpperCase() + label.slice(1)
}

export type Derived = { template: string; host: string } | { error: string }

// Turn a player URL for a known sample title back into a template: its ids
// become {imdb}/{tmdb}, its season and episode numbers {season}/{episode},
// and its domain {host}.
export function templateFromExample(raw: string, sample: Target): Derived {
  const url = toUrl(raw)
  if (!url) return { error: 'Paste the whole address, starting with https://' }
  const whole = (n: string) => new RegExp(`(^|[^0-9])${n}(?![0-9])`, 'g')
  let path = url.pathname + url.search + url.hash
  const hasImdb = path.includes(sample.imdb)
  const hasTmdb = !!sample.tmdb && whole(sample.tmdb).test(path)
  if (!hasImdb && !hasTmdb)
    return {
      error: `No id for ${sample.title} in that address (IMDb ${sample.imdb}, TMDB ${sample.tmdb}). It has to be the player's own address, opened on ${sample.title}.`,
    }
  if (hasImdb) path = path.split(sample.imdb).join('{imdb}')
  if (hasTmdb) path = path.replace(whole(sample.tmdb!), '$1{tmdb}')

  if (sample.type === 'series') {
    const number = (n: number) => new RegExp(`([/=_-])0?${n}(?![0-9])`)
    const idAt = Math.max(path.indexOf('{imdb}'), path.indexOf('{tmdb}'))
    // numbers usually follow the id; fall back to anywhere in the address
    const start = number(sample.season!).test(path.slice(idAt)) ? idAt : 0
    const head = path.slice(0, start)
    let tail = path.slice(start)
    if (!number(sample.season!).test(tail))
      return { error: `Found the show but not season ${sample.season}. Paste the player for season ${sample.season}, episode ${sample.episode}.` }
    tail = tail.replace(number(sample.season!), '$1{season}')
    const at = tail.indexOf('{season}') + '{season}'.length
    const rest = tail.slice(at)
    if (!number(sample.episode!).test(rest))
      return { error: `Found season ${sample.season} but not episode ${sample.episode}.` }
    path = head + tail.slice(0, at) + rest.replace(number(sample.episode!), '$1{episode}')
  }
  path = path.replace(/([?&](?:t|start|startat|time|progress|resume|resumeat)=)\d+/i, '$1{t}')
  return { template: `${url.protocol}//{host}${path}`, host: url.host }
}

function toUrl(raw: string): URL | null {
  try {
    const text = raw.trim()
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`)
    return url.hostname.includes('.') || url.hostname === 'localhost' ? url : null
  } catch {
    return null
  }
}

const SEARCH_PAGE = /search|find|keyword|query|[?&](q|s|k|kw|term)=/i
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// For sites whose player addresses are opaque per-title codes: a search page
// for the sample title becomes a template that opens the site's own search,
// and you pick the episode inside the player frame.
export function searchTemplateFromExample(raw: string, sample: Target): Derived {
  const url = toUrl(raw)
  if (!url) return { error: 'Paste the whole address, starting with https://' }
  let path = url.pathname + url.search + url.hash
  if (!SEARCH_PAGE.test(path)) return { error: `That isn't a search page. Search the site for “${sample.title}” and use the results page's address.` }
  const words = sample.title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(escapeRe)
  const forms: [RegExp, string][] = [
    [new RegExp(words.join('(?:%20|\\s)+'), 'i'), '{title}'],
    [new RegExp(words.join('\\+'), 'i'), '{q}'],
    [new RegExp(words.join('[-_]'), 'i'), '{slug}'],
  ]
  for (const [re, placeholder] of forms) {
    if (re.test(path)) {
      path = path.replace(re, placeholder)
      return { template: `${url.protocol}//{host}${path}`, host: url.host }
    }
  }
  return { error: `That search page isn't for “${sample.title}”. Search for exactly that title and try again.` }
}

// Ids first; a search page when there are none.
export function deriveTemplate(raw: string, sample: Target): Derived {
  const byId = templateFromExample(raw, sample)
  if ('template' in byId) return byId
  const bySearch = searchTemplateFromExample(raw, sample)
  return 'template' in bySearch ? bySearch : byId
}

export const isSearchTemplate = (t: string) => !!t && !/\{(imdb|tmdb)\}/.test(t) && /\{(title|q|slug)\}/.test(t)
