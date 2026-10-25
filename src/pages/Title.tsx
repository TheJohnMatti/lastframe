import { useMemo, useState } from 'react'
import { ConfirmButton, Empty, Poster, ProgressBar, Spinner } from '../components/ui'
import { useMeta } from '../lib/hooks'
import type { Episode, MediaType, Meta } from '../lib/meta'
import {
  epKey,
  isReleased,
  libraryStore,
  markUpTo,
  MOVIE_KEY,
  nextUp,
  removeFromLibrary,
  seriesStats,
  setWatched,
  toggleWatchlist,
  type LibraryItem,
} from '../lib/library'
import { clock, epLabel, minutesLeft, shortDate } from '../lib/format'
import { href, navigate, watchPath } from '../lib/router'

export function Title({ type, id, season }: { type: MediaType; id: string; season?: number }) {
  const meta = useMeta(type, id)
  const library = libraryStore.use()
  if (meta.loading && !meta.data) return <div className="page"><Spinner /></div>
  if (meta.error || !meta.data) return <div className="page"><Empty title="Couldn't load this title">{meta.error?.message}</Empty></div>
  return <TitleView key={id} meta={meta.data} item={library[id]} initialSeason={season} />
}

function TitleView({ meta, item, initialSeason }: { meta: Meta; item?: LibraryItem; initialSeason?: number }) {
  const isMovie = meta.type === 'movie'
  const up = isMovie ? null : nextUp(meta, item)
  const seasons = useMemo(() => {
    const all = [...new Set(meta.episodes.map((e) => e.season))]
    return [...all.filter((s) => s > 0), ...all.filter((s) => s === 0)]
  }, [meta])
  const [season, setSeason] = useState(() => initialSeason ?? up?.episode.season ?? seasons[0] ?? 1)
  const episodes = meta.episodes.filter((e) => e.season === season)

  return (
    <div className="title-page">
      <div className="hero" style={meta.background ? { backgroundImage: `url(${meta.background})` } : undefined}>
        <div className="hero-shade" />
        <div className="hero-body page">
          <div className="hero-poster">
            <Poster id={meta.id} src={meta.poster} name={meta.name} />
          </div>
          <div className="hero-info">
            <h1>{meta.name}</h1>
            <div className="facts">
              {[meta.year, meta.runtime, meta.imdbRating && `★ ${meta.imdbRating}`, meta.genres?.slice(0, 3).join(', ')]
                .filter(Boolean)
                .map((f) => (
                  <span key={String(f)}>{f}</span>
                ))}
            </div>
            {meta.description && <p className="description">{meta.description}</p>}
            {meta.cast && <p className="cast">With {meta.cast.join(', ')}</p>}
            <Actions meta={meta} item={item} />
          </div>
        </div>
      </div>

      {!isMovie && (
        <div className="page">
          <div className="season-bar">
            <div className="tabs" role="tablist">
              {seasons.map((s) => (
                <button key={s} role="tab" aria-selected={s === season} className={s === season ? 'tab active' : 'tab'} onClick={() => setSeason(s)}>
                  {s === 0 ? 'Specials' : `Season ${s}`}
                </button>
              ))}
            </div>
            <SeasonActions meta={meta} item={item} episodes={episodes} />
          </div>
          <ol className="episodes">
            {episodes.map((ep) => (
              <EpisodeRow key={epKey(ep.season, ep.episode)} meta={meta} item={item} ep={ep} isNext={up?.episode === ep} />
            ))}
          </ol>
          {!episodes.length && <Empty title="No episodes listed" />}
        </div>
      )}
    </div>
  )
}

function Actions({ meta, item }: { meta: Meta; item?: LibraryItem }) {
  let play: { label: string; to?: string; note?: string }
  if (meta.type === 'movie') {
    const p = item?.progress[MOVIE_KEY]
    const to = watchPath('movie', meta.id)
    if (p && !p.watched && p.position > 30)
      play = { label: `Resume from ${clock(p.position)}`, to, note: p.duration ? `${minutesLeft(p.duration - p.position)} left` : undefined }
    else play = { label: p?.watched ? 'Watch again' : 'Play', to }
  } else {
    const up = nextUp(meta, item)
    const stats = seriesStats(meta, item)
    const note = stats.watched ? `${stats.watched} of ${stats.aired} episodes watched` : undefined
    if (!up) {
      const first = meta.episodes.find((e) => e.season > 0)
      play = first
        ? { label: 'Caught up · watch from the start', to: watchPath('series', meta.id, first.season, first.episode), note }
        : { label: 'No episodes yet' }
    } else {
      const { season, episode, released } = up.episode
      const to = watchPath('series', meta.id, season, episode)
      const p = up.progress
      if (up.upcoming) play = { label: `Next: ${epLabel(season, episode)} airs ${shortDate(released)}`, to, note }
      else if (p && !p.watched && p.position > 30) play = { label: `Resume ${epLabel(season, episode)} at ${clock(p.position)}`, to, note }
      else play = { label: `${item?.last ? 'Continue' : 'Play'} ${epLabel(season, episode)}`, to, note }
    }
  }

  const movieWatched = meta.type === 'movie' && item?.progress[MOVIE_KEY]?.watched
  return (
    <div className="actions">
      {play.to ? (
        <a className="btn primary" href={href(play.to)}>
          ▶ {play.label}
        </a>
      ) : (
        <span className="btn primary disabled">{play.label}</span>
      )}
      <button className="btn" onClick={() => toggleWatchlist(meta)}>
        {item?.watchlist ? '✓ In watchlist' : '+ Watchlist'}
      </button>
      {meta.type === 'movie' && (
        <button className="btn" onClick={() => setWatched(meta, [MOVIE_KEY], !movieWatched)}>
          {movieWatched ? 'Mark unwatched' : 'Mark watched'}
        </button>
      )}
      {item && (
        <ConfirmButton className="btn ghost" ask="Forget its progress too?" onConfirm={() => removeFromLibrary(meta.id)}>
          Forget
        </ConfirmButton>
      )}
      {play.note && <span className="action-note">{play.note}</span>}
    </div>
  )
}

function SeasonActions({ meta, item, episodes }: { meta: Meta; item?: LibraryItem; episodes: Episode[] }) {
  const aired = episodes.filter(isReleased)
  if (!aired.length) return null
  const keys = aired.map((e) => epKey(e.season, e.episode))
  const allWatched = keys.every((k) => item?.progress[k]?.watched)
  return (
    <button className="btn small" onClick={() => setWatched(meta, keys, !allWatched)}>
      {allWatched ? 'Unmark season' : 'Mark season watched'}
    </button>
  )
}

function EpisodeRow({ meta, item, ep, isNext }: { meta: Meta; item?: LibraryItem; ep: Episode; isNext: boolean }) {
  const key = epKey(ep.season, ep.episode)
  const p = item?.progress[key]
  const released = isReleased(ep)
  const to = watchPath('series', meta.id, ep.season, ep.episode)
  const ratio = p && p.duration && !p.watched ? p.position / p.duration : 0
  return (
    <li className={`episode${p?.watched ? ' watched' : ''}${released ? '' : ' upcoming'}${isNext ? ' next' : ''}`}>
      <a className="episode-thumb" href={href(to)}>
        {ep.thumbnail ? <img src={ep.thumbnail} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} /> : null}
        <span className="play-glyph">▶</span>
        <ProgressBar value={ratio} className="on-poster" />
      </a>
      <div className="episode-body" onClick={() => navigate(to)}>
        <div className="episode-head">
          <span className="episode-num">{epLabel(ep.season, ep.episode)}</span>
          <span className="episode-name">{ep.name}</span>
          {isNext && <span className="pill">{p && p.position > 30 && !p.watched ? `Resume ${clock(p.position)}` : 'Up next'}</span>}
        </div>
        <div className="episode-date">{released ? shortDate(ep.released) : `Airs ${shortDate(ep.released)}`}</div>
        {ep.overview && <p className="episode-overview">{ep.overview}</p>}
      </div>
      <div className="episode-actions">
        <button
          className={`check${p?.watched ? ' on' : ''}`}
          title={p?.watched ? 'Mark unwatched' : 'Mark watched'}
          aria-pressed={!!p?.watched}
          onClick={() => setWatched(meta, [key], !p?.watched)}
        >
          ✓
        </button>
        {ep.season > 0 && released && (
          <button className="link-btn" title="Mark this and every earlier episode watched" onClick={() => markUpTo(meta, ep)}>
            up to here
          </button>
        )}
      </div>
    </li>
  )
}
