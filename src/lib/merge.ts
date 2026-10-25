// Merging two copies of the library, for backups and for syncing a phone with
// the Mac. Pure functions with no browser APIs, so the sync server runs them
// too. The rule everywhere: the newer change wins, nothing is lost by merging
// the same data twice, and a forgotten title stays forgotten unless it's
// watched again afterwards.

interface ProgressLike {
  updatedAt: number
  url?: string
}

export interface ItemLike {
  id: string
  addedAt: number
  watchlist: boolean
  watchlistAt?: number
  lastWatchedAt?: number
  droppedAt?: number
  last?: string
  progress: Record<string, ProgressLike>
  failedSources?: Record<string, number>
}

export interface SyncState<Item extends ItemLike = ItemLike, Source = unknown> {
  library: Record<string, Item>
  removed: Record<string, number> // title id -> when it was forgotten
  sources: { list: Source[]; updatedAt: number; lastWorking?: string }
}

// The latest moment anything happened to a title.
export function activityOf(item: ItemLike): number {
  let t = Math.max(item.addedAt || 0, item.lastWatchedAt || 0, item.watchlistAt || 0, item.droppedAt || 0)
  for (const p of Object.values(item.progress || {})) t = Math.max(t, p.updatedAt || 0)
  return t
}

export function mergeItem<Item extends ItemLike>(a: Item, b: Item): Item {
  const newer = activityOf(b) > activityOf(a) ? b : a
  const progress: Record<string, ProgressLike> = { ...a.progress }
  for (const [key, p] of Object.entries(b.progress || {})) {
    const mine = progress[key]
    if (!mine || p.updatedAt > mine.updatedAt) progress[key] = { ...p, url: p.url ?? mine?.url }
  }
  const failed: Record<string, number> = { ...a.failedSources }
  for (const [id, t] of Object.entries(b.failedSources || {})) failed[id] = Math.max(failed[id] || 0, t)
  const aList = a.watchlistAt ?? a.addedAt
  const bList = b.watchlistAt ?? b.addedAt
  const lastWatchedAt = Math.max(a.lastWatchedAt || 0, b.lastWatchedAt || 0) || undefined
  return {
    ...a,
    ...newer,
    addedAt: Math.min(a.addedAt || Infinity, b.addedAt || Infinity),
    watchlist: bList > aList ? b.watchlist : a.watchlist,
    watchlistAt: Math.max(aList || 0, bList || 0) || undefined,
    lastWatchedAt,
    droppedAt: Math.max(a.droppedAt || 0, b.droppedAt || 0) || undefined,
    last: (b.lastWatchedAt || 0) > (a.lastWatchedAt || 0) ? b.last : a.last,
    progress,
    failedSources: Object.keys(failed).length ? failed : undefined,
  }
}

export function mergeRemoved(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out = { ...a }
  for (const [id, t] of Object.entries(b || {})) out[id] = Math.max(out[id] || 0, t)
  return out
}

export function mergeLibrary<Item extends ItemLike>(
  a: Record<string, Item>,
  b: Record<string, Item>,
  removed: Record<string, number> = {},
): Record<string, Item> {
  const out: Record<string, Item> = { ...a }
  for (const [id, item] of Object.entries(b || {})) out[id] = out[id] ? mergeItem(out[id], item) : item
  for (const [id, t] of Object.entries(removed)) if (out[id] && activityOf(out[id]) <= t) delete out[id]
  return out
}

type SourceList = { list: unknown[]; updatedAt: number }

// Whether list x should replace list y. A date of 1 marks a list saved before
// syncing existed: it can fill an empty list but never replace one with entries.
export function sourcesWin(x: SourceList, y: SourceList): boolean {
  const xt = x.updatedAt || 0
  return xt > (y.updatedAt || 0) && (xt > 1 || !y.list.length)
}

export function mergeState<Item extends ItemLike, Source>(a: SyncState<Item, Source>, b: SyncState<Item, Source>): SyncState<Item, Source> {
  const removed = mergeRemoved(a.removed || {}, b.removed || {})
  const sa = a.sources || { list: [], updatedAt: 0 }
  const sb = b.sources || { list: [], updatedAt: 0 }
  return {
    library: mergeLibrary(a.library || {}, b.library || {}, removed),
    removed,
    // the source list is small and edited in one place at a time: newest list wins
    sources: sourcesWin(sb, sa) ? sb : sa,
  }
}

export function emptyState<Item extends ItemLike, Source>(): SyncState<Item, Source> {
  return { library: {}, removed: {}, sources: { list: [], updatedAt: 0 } }
}
