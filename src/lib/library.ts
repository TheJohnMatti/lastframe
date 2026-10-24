import { createStore } from './store'
import type { Episode, MediaType, Meta, MetaPreview } from './meta'

export const MOVIE_KEY = 'movie'
export const epKey = (season: number, episode: number) => `${season}:${episode}`

export interface Progress {
  position: number // seconds
  duration: number // seconds, 0 when unknown
  watched: boolean
  updatedAt: number
  estimated?: boolean // position came from the on-page clock, not the player
}

export interface LibraryItem {
  id: string
  type: MediaType
  name: string
  poster?: string
  background?: string
  year?: string
  watchlist: boolean
  addedAt: number
  lastWatchedAt?: number
  last?: string // progress key of the most recent activity
  progress: Record<string, Progress>
  preferredSource?: string // source id that last played this title
  failedSources?: Record<string, number> // source id -> when it failed for this title
}

export type Library = Record<string, LibraryItem>

export interface Settings {
  watchedAt: number // fraction of the runtime that counts as watched
  rewind: number // seconds to back up when resuming
  estimate: boolean // run an on-page clock when the player sends no times
  loadTimeout: number // seconds before an unresponsive source is skipped
  sandboxDefault: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  watchedAt: 0.9,
  rewind: 10,
  estimate: true,
  loadTimeout: 20,
  sandboxDefault: true,
}

export const libraryStore = createStore<Library>('lastframe.library.v1', () => ({}))
export const settingsStore = createStore<Settings>('lastframe.settings.v1', () => DEFAULT_SETTINGS, (raw) => ({
  ...DEFAULT_SETTINGS,
  ...(raw as Partial<Settings>),
}))

function update(meta: MetaPreview, fn: (item: LibraryItem) => LibraryItem) {
  libraryStore.set((lib) => {
    const prev: LibraryItem = lib[meta.id] ?? {
      id: meta.id,
      type: meta.type,
      name: meta.name,
      watchlist: false,
      addedAt: Date.now(),
      progress: {},
    }
    const refreshed = {
      ...prev,
      name: meta.name || prev.name,
      poster: meta.poster ?? prev.poster,
      background: meta.background ?? prev.background,
      year: meta.year ?? prev.year,
    }
    return { ...lib, [meta.id]: fn(refreshed) }
  })
}

export function toggleWatchlist(meta: MetaPreview) {
  update(meta, (item) => ({ ...item, watchlist: !item.watchlist, addedAt: item.watchlist ? item.addedAt : Date.now() }))
}

// Opening the player counts as starting it, so it shows up under Continue watching.
export function touch(meta: MetaPreview, key: string) {
  update(meta, (item) => ({ ...item, last: key, lastWatchedAt: Date.now() }))
}

export function recordProgress(meta: MetaPreview, key: string, position: number, duration: number, estimated: boolean) {
  const threshold = settingsStore.get().watchedAt
  update(meta, (item) => {
    const prev = item.progress[key]
    const reached = duration > 0 && position / duration >= threshold
    const next: Progress = {
      position: Math.round(position),
      duration: Math.round(duration),
      watched: (prev?.watched ?? false) || reached,
      updatedAt: Date.now(),
      estimated,
    }
    return { ...item, last: key, lastWatchedAt: Date.now(), progress: { ...item.progress, [key]: next } }
  })
}

export function setWatched(meta: MetaPreview, keys: string[], watched: boolean) {
  if (!keys.length) return
  update(meta, (item) => {
    const progress = { ...item.progress }
    for (const key of keys) {
      const prev = progress[key]
      progress[key] = {
        position: watched ? (prev?.position ?? 0) : 0,
        duration: prev?.duration ?? 0,
        watched,
        updatedAt: Date.now(),
      }
    }
    // Marking things watched moves your place forward to the furthest of them.
    const furthest = watched ? keys.reduce((a, b) => (keyOrder(b) > keyOrder(a) ? b : a)) : item.last
    return { ...item, progress, last: furthest, lastWatchedAt: watched ? Date.now() : item.lastWatchedAt }
  })
}

export function markUpTo(meta: Meta, ep: Episode) {
  const keys = regularEpisodes(meta)
    .filter((e) => keyOrder(epKey(e.season, e.episode)) <= keyOrder(epKey(ep.season, ep.episode)))
    .map((e) => epKey(e.season, e.episode))
  setWatched(meta, keys, true)
}

export function dropFromContinue(id: string) {
  libraryStore.set((lib) => (lib[id] ? { ...lib, [id]: { ...lib[id], lastWatchedAt: undefined } } : lib))
}

export function removeFromLibrary(id: string) {
  libraryStore.set((lib) => {
    const next = { ...lib }
    delete next[id]
    return next
  })
}

export function setPreferredSource(meta: MetaPreview, sourceId: string) {
  update(meta, (item) => {
    const failed = { ...item.failedSources }
    delete failed[sourceId]
    return { ...item, preferredSource: sourceId, failedSources: failed }
  })
}

export function markSourceFailed(meta: MetaPreview, sourceId: string) {
  update(meta, (item) => ({
    ...item,
    preferredSource: item.preferredSource === sourceId ? undefined : item.preferredSource,
    failedSources: { ...item.failedSources, [sourceId]: Date.now() },
  }))
}

// Specials (season 0) sort after every regular season.
function keyOrder(key: string): number {
  const [s, e] = key.split(':').map(Number)
  return (s === 0 ? 10_000 : s) * 10_000 + e
}

export const isReleased = (ep: Episode) => !ep.released || Date.parse(ep.released) <= Date.now()

export function regularEpisodes(meta: Meta): Episode[] {
  return meta.episodes.filter((e) => e.season > 0)
}

export function orderedEpisodes(meta: Meta): Episode[] {
  return [...meta.episodes].sort((a, b) => keyOrder(epKey(a.season, a.episode)) - keyOrder(epKey(b.season, b.episode)))
}

export interface UpNext {
  episode: Episode
  progress?: Progress
  upcoming: boolean // not aired yet
}

// Where to pick a series back up: the unfinished episode you were on, else the
// first unwatched episode after it. Null when you're caught up.
export function nextUp(meta: Meta, item?: LibraryItem): UpNext | null {
  const regular = regularEpisodes(meta)
  if (!regular.length) return null
  const wrap = (episode: Episode): UpNext => ({
    episode,
    progress: item?.progress[epKey(episode.season, episode.episode)],
    upcoming: !isReleased(episode),
  })
  if (!item?.last || item.last === MOVIE_KEY) return wrap(regular[0])

  // the episode you were last on, unless you finished it
  const current = meta.episodes.find((e) => epKey(e.season, e.episode) === item.last)
  if (current && !item.progress[item.last]?.watched) return wrap(current)

  let from = regular.findIndex((e) => epKey(e.season, e.episode) === item.last)
  if (from < 0) {
    // last activity was a special: continue after the furthest watched regular episode
    regular.forEach((e, i) => {
      if (item.progress[epKey(e.season, e.episode)]?.watched) from = i
    })
  }
  for (let i = from + 1; i < regular.length; i++) {
    const e = regular[i]
    if (!item.progress[epKey(e.season, e.episode)]?.watched) return wrap(e)
  }
  return null
}

export function seriesStats(meta: Meta, item?: LibraryItem) {
  const aired = regularEpisodes(meta).filter(isReleased)
  const watched = aired.filter((e) => item?.progress[epKey(e.season, e.episode)]?.watched).length
  return { aired: aired.length, watched }
}
