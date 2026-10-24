import { useEffect, useState } from 'react'
import { getMeta, type MediaType, type Meta } from './meta'

export interface Async<T> {
  data?: T
  error?: Error
  loading: boolean
}

export function useAsync<T>(fn: (signal: AbortSignal) => Promise<T>, deps: unknown[]): Async<T> {
  const [state, setState] = useState<Async<T>>({ loading: true })
  useEffect(() => {
    const ctrl = new AbortController()
    setState((s) => ({ data: s.data, loading: true }))
    fn(ctrl.signal).then(
      (data) => !ctrl.signal.aborted && setState({ data, loading: false }),
      (error: Error) => !ctrl.signal.aborted && setState({ error, loading: false }),
    )
    return () => ctrl.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return state
}

export function useMeta(type: MediaType, id: string): Async<Meta> {
  return useAsync((signal) => getMeta(type, id, signal), [type, id])
}

// Metadata for several titles at once (Continue watching needs episode lists).
export function useMetas(items: { id: string; type: MediaType }[]): Record<string, Meta> {
  const key = items.map((i) => `${i.type}/${i.id}`).join(',')
  const [metas, setMetas] = useState<Record<string, Meta>>({})
  useEffect(() => {
    let alive = true
    for (const it of items) {
      getMeta(it.type, it.id).then(
        (m) => alive && setMetas((prev) => ({ ...prev, [it.id]: m })),
        () => {},
      )
    }
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return metas
}
