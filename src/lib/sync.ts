import { useSyncExternalStore } from 'react'
import { libraryStore, removedStore, type Library, type LibraryItem } from './library'
import { sourcesStore, type Source } from './sources'
import { sourcesWin, type SyncState } from './merge'

// Keeps this device's library in step with the copy on the Mac running
// lastframe's server (see server/syncPlugin.ts). Each sync posts everything
// and takes the merge back; the server applies the same rules as backups.
const KEY = 'lastframe.sync.key'
const EVERY = 30_000

export interface SyncStatus {
  available: boolean // the server has a sync endpoint
  paired: boolean // this device may use it
  lastSync?: number
  error?: string
}

let status: SyncStatus = { available: false, paired: false }
const listeners = new Set<() => void>()
function setStatus(next: Partial<SyncStatus>) {
  status = { ...status, ...next }
  listeners.forEach((l) => l())
}

export function useSync(): SyncStatus {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => status,
  )
}

export const isThisComputer = () => location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.hostname === '[::1]'

function pairKey(): string | null {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

export function savePairKey(key: string) {
  try {
    localStorage.setItem(KEY, key)
  } catch {
    // private mode: pairing lasts for this visit only
  }
}

function localState(): SyncState<LibraryItem, Source> {
  const st = sourcesStore.get()
  return {
    library: libraryStore.get(),
    removed: removedStore.get(),
    sources: { list: st.sources, updatedAt: st.updatedAt ?? 0, lastWorking: st.lastWorking },
  }
}

let applying = false
function apply(remote: SyncState<LibraryItem, Source>) {
  applying = true
  try {
    if (JSON.stringify(remote.library) !== JSON.stringify(libraryStore.get())) libraryStore.set(remote.library as Library)
    if (JSON.stringify(remote.removed) !== JSON.stringify(removedStore.get())) removedStore.set(remote.removed)
    const st = sourcesStore.get()
    if (remote.sources && sourcesWin(remote.sources, { list: st.sources, updatedAt: st.updatedAt ?? 0 })) {
      sourcesStore.set({ ...st, sources: remote.sources.list, updatedAt: remote.sources.updatedAt, lastWorking: remote.sources.lastWorking ?? st.lastWorking })
    }
  } finally {
    applying = false
  }
}

let running = false
let again = false
let stopped = false

export async function syncNow(): Promise<void> {
  if (stopped) return
  if (running) {
    again = true
    return
  }
  running = true
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    const key = pairKey()
    if (key) headers['X-Lastframe-Key'] = key
    const res = await fetch('/api/sync', { method: 'POST', headers, body: JSON.stringify(localState()) })
    if (res.status === 404 || !res.headers.get('content-type')?.includes('json')) {
      // served without lastframe's server (a static build): nothing to sync with
      stopped = true
      setStatus({ available: false, paired: false })
      return
    }
    if (res.status === 401) return setStatus({ available: true, paired: false, error: undefined })
    if (!res.ok) return setStatus({ available: true, error: `sync failed (${res.status})` })
    apply(await res.json())
    setStatus({ available: true, paired: true, lastSync: Date.now(), error: undefined })
  } catch {
    setStatus({ error: "can't reach the computer running lastframe" })
  } finally {
    running = false
    if (again) {
      again = false
      syncNow()
    }
  }
}

let debounce = 0
function changedHere() {
  if (applying) return
  clearTimeout(debounce)
  debounce = window.setTimeout(syncNow, 1500)
}

export function startSync() {
  // A list saved before syncing existed has no date: older than any edit, but
  // newer than a new device's empty list.
  const initial = sourcesStore.get()
  if (initial.updatedAt == null && initial.sources.length) sourcesStore.set({ ...initial, updatedAt: 1 })
  // a source list edited here becomes the newest one
  let prevSources = sourcesStore.get().sources
  sourcesStore.subscribe(() => {
    const st = sourcesStore.get()
    if (st.sources !== prevSources) {
      prevSources = st.sources
      if (!applying) sourcesStore.set({ ...st, updatedAt: Date.now() })
    }
    changedHere()
  })
  libraryStore.subscribe(changedHere)
  removedStore.subscribe(changedHere)
  setInterval(syncNow, EVERY)
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && syncNow())
  syncNow()
}

export interface PairInfo {
  lan: boolean
  urls: string[]
}

// Only answers on the Mac itself.
export async function pairInfo(): Promise<PairInfo | null> {
  try {
    const res = await fetch('/api/pair', { cache: 'no-store' })
    if (!res.ok || !res.headers.get('content-type')?.includes('json')) return null
    return await res.json()
  } catch {
    return null
  }
}
