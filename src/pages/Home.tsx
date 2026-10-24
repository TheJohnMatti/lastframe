import { useMemo } from 'react'
import { Card, Row, Empty } from '../components/ui'
import { useAsync, useMetas, type Async } from '../lib/hooks'
import { catalog, type Meta, type MetaPreview } from '../lib/meta'
import { dropFromContinue, libraryStore, MOVIE_KEY, nextUp, type Library, type LibraryItem } from '../lib/library'
import { epLabel, minutesLeft } from '../lib/format'
import { href, titlePath, watchPath } from '../lib/router'
import { sourcesStore } from '../lib/sources'

interface ContinueEntry {
  item: LibraryItem
  to: string
  subtitle: string
  progress: number
}

export function continueEntries(library: Library, metas: Record<string, Meta>): ContinueEntry[] {
  const out: ContinueEntry[] = []
  const recent = Object.values(library)
    .filter((i) => i.lastWatchedAt)
    .sort((a, b) => (b.lastWatchedAt ?? 0) - (a.lastWatchedAt ?? 0))
  for (const item of recent) {
    if (item.type === 'movie') {
      const p = item.progress[MOVIE_KEY]
      if (p?.watched) continue
      const left = p && p.duration ? p.duration - p.position : 0
      out.push({
        item,
        to: watchPath('movie', item.id),
        subtitle: p && p.position > 30 && left > 0 ? `${minutesLeft(left)} left` : 'Not started',
        progress: p && p.duration ? p.position / p.duration : 0,
      })
      continue
    }
    const meta = metas[item.id]
    if (!meta) continue
    const up = nextUp(meta, item)
    if (!up || up.upcoming) continue
    const { season, episode } = up.episode
    const p = up.progress
    const started = p && p.position > 30 && !p.watched
    out.push({
      item,
      to: watchPath('series', item.id, season, episode),
      subtitle: `${epLabel(season, episode)} · ${started && p.duration ? `${minutesLeft(p.duration - p.position)} left` : 'Up next'}`,
      progress: started && p.duration ? p.position / p.duration : 0,
    })
  }
  return out
}

export function Home() {
  const library = libraryStore.use()
  const { sources } = sourcesStore.use()
  const seriesInProgress = useMemo(
    () => Object.values(library).filter((i) => i.type === 'series' && i.lastWatchedAt),
    [library],
  )
  const metas = useMetas(seriesInProgress)
  const watching = useMemo(() => continueEntries(library, metas), [library, metas])
  const watchlist = useMemo(
    () =>
      Object.values(library)
        .filter((i) => i.watchlist)
        .sort((a, b) => b.addedAt - a.addedAt),
    [library],
  )
  const movies = useAsync((signal) => catalog('movie', 'top', signal), [])
  const series = useAsync((signal) => catalog('series', 'top', signal), [])

  return (
    <div className="page">
      {sources.length === 0 && (
        <div className="notice">
          <strong>No sources yet.</strong> lastframe tracks what you watch and wraps other sites' players, but it
          doesn't come with any. <a href={href('/sources')}>Add the sites you use</a> and they'll be tried in order,
          falling back when one is down.
        </div>
      )}

      {watching.length > 0 && (
        <Row title="Continue watching">
          {watching.map((e) => (
            <Card
              key={e.item.id}
              id={e.item.id}
              name={e.item.name}
              poster={e.item.poster}
              to={e.to}
              subtitle={e.subtitle}
              progress={e.progress}
              onRemove={() => dropFromContinue(e.item.id)}
            />
          ))}
        </Row>
      )}

      {watchlist.length > 0 && (
        <Row title="Watchlist">
          {watchlist.map((i) => (
            <Card key={i.id} id={i.id} name={i.name} poster={i.poster} to={titlePath(i.type, i.id)} subtitle={i.year} />
          ))}
        </Row>
      )}

      {watching.length === 0 && watchlist.length === 0 && (
        <Empty title="Nothing in progress">
          <p>Search for a movie or show above. Anything you open is remembered here, down to the minute.</p>
        </Empty>
      )}

      <CatalogRow title="Popular movies" state={movies} />
      <CatalogRow title="Popular series" state={series} />
    </div>
  )
}

function CatalogRow({ title, state }: { title: string; state: Async<MetaPreview[]> }) {
  if (state.error) return null
  return (
    <Row title={title}>
      {state.loading && !state.data
        ? Array.from({ length: 8 }, (_, i) => <div key={i} className="card skeleton" />)
        : state.data?.slice(0, 30).map((m) => (
            <Card key={m.id} id={m.id} name={m.name} poster={m.poster} to={titlePath(m.type, m.id)} subtitle={m.year} />
          ))}
    </Row>
  )
}
