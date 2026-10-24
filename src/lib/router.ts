import { useSyncExternalStore } from 'react'

// Hash routes, so the app works from any static file server:
//   #/  #/search?q=  #/title/:type/:id  #/watch/movie/:id  #/watch/series/:id/:s/:e
//   #/library  #/sources  #/settings
const current = () => location.hash.slice(1) || '/'

function subscribe(cb: () => void) {
  window.addEventListener('hashchange', cb)
  return () => window.removeEventListener('hashchange', cb)
}

export function useRoute() {
  const hash = useSyncExternalStore(subscribe, current)
  const [path, qs = ''] = hash.split('?')
  return {
    path,
    parts: path.split('/').filter(Boolean).map(decodeURIComponent),
    query: new URLSearchParams(qs),
  }
}

export function navigate(to: string, replace = false) {
  if (replace) {
    history.replaceState(null, '', `#${to}`)
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  } else {
    location.hash = to
  }
}

export const href = (to: string) => `#${to}`

export const titlePath = (type: string, id: string) => `/title/${type}/${id}`

export const watchPath = (type: string, id: string, season?: number, episode?: number) =>
  type === 'movie' || season == null ? `/watch/movie/${id}` : `/watch/series/${id}/${season}/${episode}`
