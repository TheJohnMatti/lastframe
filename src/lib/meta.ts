// Titles, posters and episode lists come from Cinemeta, Stremio's free metadata
// service: no API key, CORS open, keyed by IMDb id.
const BASE = 'https://v3-cinemeta.strem.io'
const CACHE_PREFIX = 'lastframe.meta:'
const CACHE_TTL = 12 * 3600 * 1000

export type MediaType = 'movie' | 'series'

export interface MetaPreview {
  id: string
  type: MediaType
  name: string
  poster?: string
  background?: string
  year?: string
  imdbRating?: string
}

export interface Episode {
  season: number
  episode: number
  name: string
  overview?: string
  thumbnail?: string
  released?: string
}

export interface Meta extends MetaPreview {
  tmdb?: string
  description?: string
  logo?: string
  runtime?: string
  genres?: string[]
  cast?: string[]
  episodes: Episode[]
}

type Raw = Record<string, unknown>
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)

export function posterFor(id: string): string {
  return `https://images.metahub.space/poster/medium/${id}/img`
}

function toPreview(raw: Raw, fallbackType: MediaType): MetaPreview {
  const id = str(raw.imdb_id) ?? str(raw.id) ?? ''
  return {
    id,
    type: raw.type === 'series' ? 'series' : raw.type === 'movie' ? 'movie' : fallbackType,
    name: str(raw.name) ?? 'Untitled',
    poster: str(raw.poster) ?? (id ? posterFor(id) : undefined),
    background: str(raw.background),
    year: str(raw.releaseInfo) ?? (raw.year != null ? String(raw.year) : undefined),
    imdbRating: str(raw.imdbRating),
  }
}

function toMeta(raw: Raw, type: MediaType): Meta {
  const videos = Array.isArray(raw.videos) ? (raw.videos as Raw[]) : []
  const episodes: Episode[] = videos
    .filter((v) => typeof v.season === 'number' && typeof (v.episode ?? v.number) === 'number')
    .map((v) => ({
      season: v.season as number,
      episode: (v.episode ?? v.number) as number,
      name: str(v.name) ?? str(v.title) ?? `Episode ${v.episode ?? v.number}`,
      overview: str(v.overview) ?? str(v.description),
      thumbnail: str(v.thumbnail),
      released: str(v.released) ?? str(v.firstAired),
    }))
    .sort((a, b) => a.season - b.season || a.episode - b.episode)
  return {
    ...toPreview(raw, type),
    tmdb: raw.moviedb_id != null ? String(raw.moviedb_id) : undefined,
    description: str(raw.description),
    logo: str(raw.logo),
    runtime: str(raw.runtime),
    genres: Array.isArray(raw.genres) ? (raw.genres as string[]) : undefined,
    cast: Array.isArray(raw.cast) ? (raw.cast as string[]).slice(0, 6) : undefined,
    episodes,
  }
}

async function getJson(url: string, signal?: AbortSignal): Promise<Raw> {
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`Metadata request failed (${res.status})`)
  return res.json()
}

export async function searchTitles(type: MediaType, query: string, signal?: AbortSignal): Promise<MetaPreview[]> {
  const data = await getJson(`${BASE}/catalog/${type}/top/search=${encodeURIComponent(query)}.json`, signal)
  return ((data.metas as Raw[]) ?? []).map((m) => toPreview(m, type)).filter((m) => m.id.startsWith('tt'))
}

export async function catalog(type: MediaType, id = 'top', signal?: AbortSignal): Promise<MetaPreview[]> {
  const data = await getJson(`${BASE}/catalog/${type}/${id}.json`, signal)
  return ((data.metas as Raw[]) ?? []).map((m) => toPreview(m, type)).filter((m) => m.id.startsWith('tt'))
}

const memory = new Map<string, Meta>()

export async function getMeta(type: MediaType, id: string, signal?: AbortSignal): Promise<Meta> {
  const key = `${type}/${id}`
  const hit = memory.get(key)
  if (hit) return hit
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_PREFIX + key) ?? 'null')
    if (cached && Date.now() - cached.at < CACHE_TTL) {
      memory.set(key, cached.meta)
      return cached.meta
    }
  } catch {
    // ignore a bad cache entry
  }
  const data = await getJson(`${BASE}/meta/${type}/${id}.json`, signal)
  if (!data.meta) throw new Error('Title not found')
  const meta = toMeta(data.meta as Raw, type)
  memory.set(key, meta)
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ at: Date.now(), meta }))
  } catch {
    pruneMetaCache()
  }
  return meta
}

function pruneMetaCache() {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i)
    if (k?.startsWith(CACHE_PREFIX)) localStorage.removeItem(k)
  }
}
