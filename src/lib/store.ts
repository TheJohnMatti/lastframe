import { useSyncExternalStore } from 'react'

export interface Store<T> {
  get(): T
  set(next: T | ((prev: T) => T)): void
  use(): T
}

// A value kept in localStorage, shared across components and synced across tabs.
export function createStore<T>(key: string, initial: () => T, migrate?: (raw: unknown) => T): Store<T> {
  const listeners = new Set<() => void>()
  let state = load()

  function load(): T {
    try {
      const raw = localStorage.getItem(key)
      if (raw) return migrate ? migrate(JSON.parse(raw)) : (JSON.parse(raw) as T)
    } catch {
      // corrupt or unavailable storage falls back to the initial value
    }
    return initial()
  }

  function emit() {
    listeners.forEach((l) => l())
  }

  function subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  window.addEventListener('storage', (e) => {
    if (e.key === key) {
      state = load()
      emit()
    }
  })

  return {
    get: () => state,
    set(next) {
      state = typeof next === 'function' ? (next as (prev: T) => T)(state) : next
      try {
        localStorage.setItem(key, JSON.stringify(state))
      } catch {
        // quota exceeded: keep the in-memory value for this session
      }
      emit()
    },
    use: () => useSyncExternalStore(subscribe, () => state),
  }
}
