import { DEFAULT_SETTINGS, libraryStore, settingsStore, type Library, type LibraryItem } from './library'
import { addSources, parseSourceList, sourcesStore } from './sources'

export function exportAll() {
  return {
    app: 'lastframe',
    version: 1,
    exportedAt: new Date().toISOString(),
    library: libraryStore.get(),
    sources: sourcesStore.get().sources,
    settings: settingsStore.get(),
  }
}

export function download(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

function mergeItem(a: LibraryItem, b: LibraryItem): LibraryItem {
  const progress = { ...a.progress }
  for (const [key, p] of Object.entries(b.progress ?? {})) {
    if (!progress[key] || p.updatedAt > progress[key].updatedAt) progress[key] = p
  }
  const newer = (b.lastWatchedAt ?? 0) > (a.lastWatchedAt ?? 0) ? b : a
  return {
    ...a,
    ...newer,
    watchlist: a.watchlist || b.watchlist,
    addedAt: Math.min(a.addedAt, b.addedAt),
    progress,
  }
}

export interface ImportResult {
  titles: number
  sources: number
}

export function importAll(data: unknown, mode: 'merge' | 'replace'): ImportResult {
  if (!data || typeof data !== 'object') throw new Error('Not a lastframe backup')
  const d = data as { library?: Library; sources?: unknown; settings?: unknown }
  if (!d.library && !d.sources) throw new Error('Not a lastframe backup')
  const library = d.library ?? {}
  const sources = parseSourceList(d.sources ?? [])
  if (mode === 'replace') {
    libraryStore.set(library)
    sourcesStore.set((st) => ({ ...st, sources }))
    if (d.settings) settingsStore.set({ ...DEFAULT_SETTINGS, ...(d.settings as object) })
    return { titles: Object.keys(library).length, sources: sources.length }
  }
  libraryStore.set((lib) => {
    const next = { ...lib }
    for (const [id, item] of Object.entries(library)) next[id] = next[id] ? mergeItem(next[id], item) : item
    return next
  })
  return { titles: Object.keys(library).length, sources: addSources(sources) }
}
