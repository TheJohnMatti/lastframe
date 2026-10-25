import { useSyncExternalStore } from 'react'
import { applyExternalProgress, setPreferredSource } from './library'
import { sourcesStore } from './sources'
import type { MediaType } from './meta'

// Talks to the lastframe browser extension through its bridge content script,
// which only runs on this page. Messages carry a marker so nothing else on the
// page is mistaken for them.

export interface ExtensionState {
  installed: boolean
  version?: string
}

export interface LaunchItem {
  id: string
  type: MediaType
  key: string
  name: string
  poster?: string
  sourceId?: string
}

interface ProgressEntry extends LaunchItem {
  position: number
  duration: number
  updatedAt: number
  url?: string
}

let state: ExtensionState = { installed: false }
const listeners = new Set<() => void>()
const pending = new Map<number, (reply: unknown) => void>()
const merged = new Map<string, number>() // entry -> updatedAt already applied
let nextId = 1

function setState(next: ExtensionState) {
  state = next
  listeners.forEach((l) => l())
}

function post(msg: Record<string, unknown>) {
  window.postMessage({ __lastframe: 'app', ...msg }, location.origin)
}

function merge(entries: Record<string, ProgressEntry>) {
  for (const [k, e] of Object.entries(entries ?? {})) {
    if (!e || typeof e.updatedAt !== 'number' || merged.get(k) === e.updatedAt) continue
    merged.set(k, e.updatedAt)
    const meta = { id: e.id, type: e.type, name: e.name, poster: e.poster }
    const applied = applyExternalProgress(meta, e.key, e)
    // real playback is proof this source has the title
    if (applied && e.sourceId && e.position > 60) {
      setPreferredSource(meta, e.sourceId)
      if (sourcesStore.get().lastWorking !== e.sourceId) sourcesStore.set((st) => ({ ...st, lastWorking: e.sourceId }))
    }
  }
}

window.addEventListener('message', (ev) => {
  if (ev.source !== window || ev.origin !== location.origin) return
  const m = ev.data
  if (!m || m.__lastframe !== 'ext') return
  if (m.type === 'hello') setState({ installed: true, version: m.payload?.version })
  else if (m.type === 'progress') merge(m.payload)
  else if (m.type === 'reply') {
    pending.get(m.id)?.(m.payload)
    pending.delete(m.id)
  }
})

// The bridge says hello on load, which can be before this listener existed.
export function connectExtension() {
  post({ type: 'ping' })
}

export function useExtension(): ExtensionState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => state,
  )
}

export interface LaunchRequest {
  url: string
  item: LaunchItem
  resumeAt: number
  expectedDuration?: number
}

// Ask the extension to open a tracked tab. Resolves false if it didn't answer.
export function launchInTab(req: LaunchRequest, timeoutMs = 4000): Promise<boolean> {
  if (!state.installed) return Promise.resolve(false)
  const id = nextId++
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve(false)
    }, timeoutMs)
    pending.set(id, (reply) => {
      clearTimeout(timer)
      resolve(!!(reply as { ok?: boolean } | undefined)?.ok)
    })
    post({ type: 'launch', id, payload: req })
  })
}
