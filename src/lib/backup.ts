import { DEFAULT_SETTINGS, libraryStore, removedStore, settingsStore, type Library } from './library'
import { mergeLibrary } from './merge'
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
  libraryStore.set((lib) => mergeLibrary(lib, library, removedStore.get()))
  return { titles: Object.keys(library).length, sources: addSources(sources) }
}
