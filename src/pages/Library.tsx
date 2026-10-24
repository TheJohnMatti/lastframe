import { useMemo } from 'react'
import { Card, Empty, Grid } from '../components/ui'
import { libraryStore, MOVIE_KEY, type LibraryItem } from '../lib/library'
import { ago, epLabel } from '../lib/format'
import { href, titlePath } from '../lib/router'

const TABS = [
  ['history', 'History'],
  ['watchlist', 'Watchlist'],
  ['movies', 'Movies'],
  ['series', 'Series'],
] as const

type Tab = (typeof TABS)[number][0]

function lastLabel(item: LibraryItem): string {
  if (!item.last) return item.year ?? ''
  if (item.last === MOVIE_KEY) return item.progress[MOVIE_KEY]?.watched ? 'Watched' : 'In progress'
  const [s, e] = item.last.split(':').map(Number)
  return epLabel(s, e)
}

export function Library({ tab }: { tab: string }) {
  const library = libraryStore.use()
  const active: Tab = TABS.some(([t]) => t === tab) ? (tab as Tab) : 'history'
  const items = useMemo(() => {
    const all = Object.values(library)
    const recent = (a: LibraryItem, b: LibraryItem) => (b.lastWatchedAt ?? b.addedAt) - (a.lastWatchedAt ?? a.addedAt)
    const touched = (i: LibraryItem) => i.lastWatchedAt || Object.keys(i.progress).length > 0
    switch (active) {
      case 'watchlist':
        return all.filter((i) => i.watchlist).sort((a, b) => b.addedAt - a.addedAt)
      case 'movies':
        return all.filter((i) => i.type === 'movie').sort(recent)
      case 'series':
        return all.filter((i) => i.type === 'series').sort(recent)
      default:
        return all.filter(touched).sort(recent)
    }
  }, [library, active])

  const watchedEpisodes = Object.values(library).reduce(
    (n, i) => n + Object.entries(i.progress).filter(([k, p]) => k !== MOVIE_KEY && p.watched).length,
    0,
  )
  const watchedMovies = Object.values(library).filter((i) => i.progress[MOVIE_KEY]?.watched).length

  return (
    <div className="page">
      <div className="page-head">
        <h1>Library</h1>
        <span className="muted">
          {watchedMovies} movies and {watchedEpisodes} episodes watched
        </span>
      </div>
      <div className="tabs">
        {TABS.map(([t, label]) => (
          <a key={t} className={t === active ? 'tab active' : 'tab'} href={href(`/library?tab=${t}`)}>
            {label}
          </a>
        ))}
      </div>
      {items.length ? (
        <Grid>
          {items.map((i) => (
            <Card
              key={i.id}
              id={i.id}
              name={i.name}
              poster={i.poster}
              to={titlePath(i.type, i.id)}
              subtitle={[lastLabel(i), ago(i.lastWatchedAt)].filter(Boolean).join(' · ')}
            />
          ))}
        </Grid>
      ) : (
        <Empty title="Nothing here yet" />
      )}
    </div>
  )
}
