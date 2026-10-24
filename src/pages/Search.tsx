import { Card, Empty, Grid, Spinner } from '../components/ui'
import { useAsync } from '../lib/hooks'
import { searchTitles } from '../lib/meta'
import { libraryStore } from '../lib/library'
import { titlePath } from '../lib/router'

export function Search({ query }: { query: string }) {
  const library = libraryStore.use()
  const results = useAsync(
    async (signal) => {
      if (query.trim().length < 2) return null
      const [movies, series] = await Promise.all([
        searchTitles('movie', query, signal),
        searchTitles('series', query, signal),
      ])
      return { movies, series }
    },
    [query],
  )

  if (query.trim().length < 2) return <div className="page"><Empty title="Type at least two letters to search" /></div>
  if (results.loading && !results.data) return <div className="page"><Spinner label="Searching" /></div>
  if (results.error) return <div className="page"><Empty title="Search failed">{results.error.message}</Empty></div>

  const { movies = [], series = [] } = results.data ?? {}
  if (!movies.length && !series.length) return <div className="page"><Empty title={`Nothing found for “${query}”`} /></div>

  const tracked = (id: string) => {
    const item = library[id]
    if (!item) return undefined
    if (Object.values(item.progress).some((p) => p.watched)) return 'Watched'
    if (item.lastWatchedAt) return 'Watching'
    if (item.watchlist) return 'Watchlist'
    return undefined
  }

  return (
    <div className="page">
      {series.length > 0 && (
        <section>
          <h2 className="section-title">Series</h2>
          <Grid>
            {series.map((m) => (
              <Card key={m.id} id={m.id} name={m.name} poster={m.poster} to={titlePath('series', m.id)} subtitle={m.year} badge={tracked(m.id)} />
            ))}
          </Grid>
        </section>
      )}
      {movies.length > 0 && (
        <section>
          <h2 className="section-title">Movies</h2>
          <Grid>
            {movies.map((m) => (
              <Card key={m.id} id={m.id} name={m.name} poster={m.poster} to={titlePath('movie', m.id)} subtitle={m.year} badge={tracked(m.id)} />
            ))}
          </Grid>
        </section>
      )}
    </div>
  )
}
