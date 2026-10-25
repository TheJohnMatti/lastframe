import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { Empty, ProgressBar, Spinner, StatusDot } from '../components/ui'
import { useMeta } from '../lib/hooks'
import type { MediaType, Meta } from '../lib/meta'
import {
  epKey,
  libraryStore,
  markSourceFailed,
  MOVIE_KEY,
  orderedEpisodes,
  recordProgress,
  setPreferredSource,
  settingsStore,
  setWatched,
  touch,
} from '../lib/library'
import {
  candidatesFor,
  healthStore,
  isSearchTemplate,
  orderSources,
  probe,
  sourcesStore,
  statusOf,
  type Candidate,
  type Target,
} from '../lib/sources'
import { extractTimes, isFromFrame } from '../lib/playerMessages'
import { clock, epLabel, parseClock, parseRuntime } from '../lib/format'
import { href, titlePath, watchPath } from '../lib/router'

export function Watch({ type, id, season, episode }: { type: MediaType; id: string; season?: number; episode?: number }) {
  const meta = useMeta(type, id)
  if (meta.loading && !meta.data) return <div className="page"><Spinner /></div>
  if (meta.error || !meta.data) return <div className="page"><Empty title="Couldn't load this title">{meta.error?.message}</Empty></div>
  if (type === 'series' && (season == null || episode == null || Number.isNaN(season) || Number.isNaN(episode)))
    return <div className="page"><Empty title="Pick an episode"><a href={href(titlePath(type, id))}>Back to {meta.data.name}</a></Empty></div>
  return <Player key={`${id}/${season}/${episode}`} meta={meta.data} season={season} episode={episode} />
}

function useRefState<T>(initial: T) {
  const [value, setValue] = useState(initial)
  const ref = useRef(initial)
  const set = useCallback((v: T) => {
    ref.current = v
    setValue(v)
  }, [])
  return [value, set, ref] as const
}

function Player({ meta, season, episode }: { meta: Meta; season?: number; episode?: number }) {
  const isMovie = meta.type === 'movie'
  const key = isMovie ? MOVIE_KEY : epKey(season!, episode!)
  const ep = meta.episodes.find((e) => e.season === season && e.episode === episode)
  const settings = settingsStore.use()
  const { sources } = sourcesStore.use()
  const health = healthStore.use()
  const progress = libraryStore.use()[meta.id]?.progress[key]

  // Everything that goes into the player's URL is fixed when it opens, so saving
  // progress or crediting a source never reloads it.
  const [initial] = useState(() => {
    const item = libraryStore.get()[meta.id]
    const p = item?.progress[key]
    const resumeFrom = p && !p.watched && p.position > 30 ? p.position : 0
    return {
      item,
      lastWorking: sourcesStore.get().lastWorking,
      resumeFrom,
      startAt: resumeFrom ? Math.max(0, resumeFrom - settingsStore.get().rewind) : 0,
    }
  })
  const target: Target = useMemo(
    () => ({ type: meta.type, imdb: meta.id, tmdb: meta.tmdb, season, episode, title: meta.name, year: meta.year, startAt: initial.startAt }),
    [meta, season, episode, initial.startAt],
  )
  const candidates = useMemo(
    () => orderSources(sources, initial.item, initial.lastWorking).flatMap((s) => candidatesFor(s, target)),
    [sources, target, initial],
  )

  // ---- choosing a source -------------------------------------------------
  const [currentUrl, setCurrentUrl] = useState<string | null>(null)
  const [exhausted, setExhausted] = useState(false)
  const [manual, setManual] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const skipped = useRef<Set<string>>(new Set())
  const current = candidates.find((c) => c.url === currentUrl)

  const [live, setLive, liveRef] = useRefState(false)
  const [engaged, setEngaged, engagedRef] = useRefState(false)
  const [clockOn, setClockOn, clockRef] = useRefState(false)

  const pos = useRef(initial.resumeFrom)
  const dur = useRef(progress?.duration || parseRuntime(meta.runtime) || 0)
  const lastMessage = useRef(0)
  const firstLive = useRef<number | null>(null)
  const credited = useRef<string | null>(null)
  const lastSaved = useRef(-1)
  const frame = useRef<HTMLIFrameElement>(null)
  const [, rerender] = useReducer((x: number) => x + 1, 0)

  const show = useCallback((c: Candidate | undefined, byHand: boolean) => {
    setLoaded(false)
    setLive(false)
    firstLive.current = null
    setManual(byHand)
    setCurrentUrl(c?.url ?? null)
    setExhausted(!c)
  }, [setLive])

  const pickNext = useCallback(() => {
    const h = healthStore.get()
    show(candidates.find((c) => !skipped.current.has(c.url) && statusOf(c.origin, h) !== 'down'), false)
  }, [candidates, show])

  const skip = useCallback((urls: string[]) => {
    urls.forEach((u) => skipped.current.add(u))
    pickNext()
  }, [pickNext])

  useEffect(() => {
    for (const origin of new Set(candidates.map((c) => c.origin))) {
      if (statusOf(origin, healthStore.get()) === 'unknown') probe(origin)
    }
  }, [candidates])

  useEffect(() => {
    if (!current && !exhausted && candidates.length) pickNext()
  }, [current, exhausted, candidates, pickNext])

  // The host behind the current player turned out to be unreachable.
  useEffect(() => {
    if (current && !manual && statusOf(current.origin, health) === 'down') skip([current.url])
  }, [health, current, manual, skip])

  // The player never finished loading.
  useEffect(() => {
    if (!current || loaded || manual) return
    const t = setTimeout(() => skip([current.url]), settings.loadTimeout * 1000)
    return () => clearTimeout(t)
  }, [current, loaded, manual, settings.loadTimeout, skip])

  function notPlaying() {
    if (!current) return
    markSourceFailed(meta, current.source.id)
    // the title is missing from that site, so its other mirrors won't have it either
    skip(candidates.filter((c) => c.source.id === current.source.id).map((c) => c.url))
  }

  function chooseSource(sourceId: string) {
    const h = healthStore.get()
    const own = candidates.filter((c) => c.source.id === sourceId)
    show(own.find((c) => statusOf(c.origin, h) !== 'down') ?? own[0], true)
  }

  function retryAll() {
    skipped.current.clear()
    for (const origin of new Set(candidates.map((c) => c.origin))) probe(origin)
    show(candidates[0], false)
  }

  // ---- tracking where you are ---------------------------------------------
  const save = useCallback(() => {
    const rounded = Math.round(pos.current)
    if (rounded === lastSaved.current) return
    lastSaved.current = rounded
    recordProgress(meta, key, pos.current, dur.current, !liveRef.current)
  }, [meta, key, liveRef])

  useEffect(() => {
    touch(meta, key)
  }, [meta, key])

  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      const win = frame.current?.contentWindow
      if (!win || !isFromFrame(ev.source, win)) return
      const t = extractTimes(ev.data)
      if (!t) return
      if (t.duration && t.duration > 60) dur.current = t.duration
      // a player sitting at 0:00 before you press play shouldn't erase your spot
      if (firstLive.current == null) firstLive.current = t.position
      if (Math.abs(t.position - firstLive.current) < 2 && !liveRef.current) return
      pos.current = t.position
      lastMessage.current = Date.now()
      setLive(true)
      setEngaged(true)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [liveRef, setLive, setEngaged])

  // Clicking into the player is the best sign playback started.
  useEffect(() => {
    function onBlur() {
      setTimeout(() => {
        if (document.activeElement !== frame.current) return
        setEngaged(true)
        if (settingsStore.get().estimate && !liveRef.current) setClockOn(true)
      }, 0)
    }
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [liveRef, setEngaged, setClockOn])

  // The on-page clock: counts wall time while running and the player is quiet.
  useEffect(() => {
    let last = Date.now()
    let ticks = 0
    const id = setInterval(() => {
      const now = Date.now()
      const elapsed = Math.min((now - last) / 1000, 90)
      last = now
      if (clockRef.current && now - lastMessage.current > 10_000) {
        pos.current = dur.current ? Math.min(pos.current + elapsed, dur.current) : pos.current + elapsed
      }
      if (engagedRef.current && ++ticks % 5 === 0) save()
      rerender()
    }, 1000)
    return () => clearInterval(id)
  }, [clockRef, engagedRef, save])

  useEffect(() => {
    const flush = () => engagedRef.current && save()
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', flush)
      flush()
    }
  }, [engagedRef, save])

  // Remember which source works: right away if it reports times, else after a while engaged.
  useEffect(() => {
    if (!current || (!live && !engaged)) return
    const credit = () => {
      if (credited.current === current.source.id) return
      credited.current = current.source.id
      setPreferredSource(meta, current.source.id)
      sourcesStore.set((st) => ({ ...st, lastWorking: current.source.id }))
    }
    if (live) return credit()
    const t = setTimeout(credit, 90_000)
    return () => clearTimeout(t)
  }, [current, live, engaged, meta])

  function nudge(seconds: number) {
    pos.current = Math.max(0, dur.current ? Math.min(pos.current + seconds, dur.current) : pos.current + seconds)
    setEngaged(true)
    save()
    rerender()
  }

  function setTo(seconds: number) {
    pos.current = seconds
    setEngaged(true)
    save()
    rerender()
  }

  // ---- layout --------------------------------------------------------------
  const order = isMovie ? [] : orderedEpisodes(meta)
  const at = order.findIndex((e) => e.season === season && e.episode === episode)
  const prev = at > 0 ? order[at - 1] : undefined
  const next = at >= 0 ? order[at + 1] : undefined
  const watched = !!progress?.watched
  const template = current ? (isMovie ? current.source.movie : current.source.episode) : ''
  const bySource = groupBySource(candidates)

  return (
    <div className="watch">
      <div className="watch-top wide">
        <a className="back" href={href(titlePath(meta.type, meta.id))}>
          ← {meta.name}
        </a>
        <div className="watch-title">
          {!isMovie && season != null && episode != null && (
            <>
              <span className="episode-num">{epLabel(season, episode)}</span> {ep?.name}
            </>
          )}
        </div>
        {!isMovie && (
          <div className="ep-nav">
            {prev && (
              <a className="btn small" href={href(watchPath('series', meta.id, prev.season, prev.episode))}>
                ‹ Previous
              </a>
            )}
            {next && (
              <a className="btn small" href={href(watchPath('series', meta.id, next.season, next.episode))}>
                Next ›
              </a>
            )}
          </div>
        )}
      </div>

      <div className="player-wrap">
        {current ? (
          <iframe
            ref={frame}
            key={`${current.url}|${current.source.sandbox}`}
            src={current.url}
            title={`${meta.name} via ${current.source.name}`}
            allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
            allowFullScreen
            sandbox={current.source.sandbox ? 'allow-scripts allow-same-origin allow-forms allow-presentation allow-pointer-lock' : undefined}
            onLoad={() => setLoaded(true)}
          />
        ) : (
          <div className="player-state">
            {sources.length === 0 ? (
              <Empty title="No sources yet">
                <p>lastframe doesn't ship with any streaming sites. Add the ones you use and they'll be tried in order.</p>
                <a className="btn primary" href={href('/sources')}>Add a source</a>
              </Empty>
            ) : candidates.length === 0 ? (
              <Empty title="None of your sources can play this">
                <p>Each enabled source needs a {isMovie ? 'movie' : 'episode'} template{meta.tmdb ? '' : ', and this title has no TMDB id for templates that use {tmdb}'}.</p>
                <a className="btn" href={href('/sources')}>Edit sources</a>
              </Empty>
            ) : exhausted ? (
              <Empty title="Every source failed for this one">
                <p>They were unreachable, never loaded, or you marked them as not playing.</p>
                <div className="actions center">
                  <button className="btn primary" onClick={retryAll}>Try them all again</button>
                  <a className="btn" href={href('/sources')}>Manage sources</a>
                </div>
              </Empty>
            ) : (
              <Spinner label="Finding a source" />
            )}
          </div>
        )}
      </div>

      <div className="watch-panel wide">
        {candidates.length > 0 && (
          <div className="source-bar">
            <span className="label">Source</span>
            <div className="chips">
              {bySource.map(({ source, items }) => {
                const active = current?.source.id === source.id
                const shown = active ? current! : items[0]
                return (
                  <button key={source.id} className={`chip${active ? ' active' : ''}`} onClick={() => chooseSource(source.id)}>
                    <StatusDot status={statusOf(shown.origin, health)} />
                    {source.name}
                    {active && current?.host && items.length > 1 && <span className="chip-host">{current.host}</span>}
                  </button>
                )
              })}
            </div>
            {current && (
              <button className="btn small" onClick={notPlaying} title="Skip this source for this title and try the next one">
                Not playing? Next source →
              </button>
            )}
          </div>
        )}

        {current && isSearchTemplate(template) && (
          <div className="hint">
            {current.source.name} opens its own search. Pick{' '}
            <strong>{isMovie ? meta.name : `${meta.name} ${epLabel(season!, episode!)}`}</strong> in the player. lastframe still keeps
            your place. If clicking does nothing, the site wants a new tab: turn off the sandbox for this source.
          </div>
        )}

        {initial.resumeFrom > 0 && current && (
          <div className="hint">
            {template.includes('{t}')
              ? `Resuming at ${clock(initial.startAt)}, a few seconds before where you stopped.`
              : `You stopped at ${clock(initial.resumeFrom)}. This source can't jump there itself, so seek to it in the player.`}
          </div>
        )}

        <div className="tracker">
          <div className="tracker-time">
            <span className="big">
              {!live && engaged ? '~' : ''}
              {clock(pos.current)}
            </span>
            {dur.current > 0 && <span className="muted"> / {clock(dur.current)}</span>}
            <ProgressBar value={dur.current ? pos.current / dur.current : 0} className="tracker-bar" />
            <div className="tracker-status">
              {live ? (
                <span className="ok">● Synced with the player</span>
              ) : clockOn ? (
                <span>Clock running. This player doesn't report its time, so pause the clock when you pause.</span>
              ) : settings.estimate ? (
                <span>Click into the player to start the clock, or set your spot by hand.</span>
              ) : (
                <span>Set your spot by hand when you stop.</span>
              )}
            </div>
          </div>
          <div className="tracker-controls">
            {!live && engaged && settings.estimate && (
              <button className="btn small" onClick={() => setClockOn(!clockOn)}>
                {clockOn ? '❚❚ Pause clock' : '▶ Resume clock'}
              </button>
            )}
            <button className="btn small" onClick={() => nudge(-300)}>−5m</button>
            <button className="btn small" onClick={() => nudge(-60)}>−1m</button>
            <button className="btn small" onClick={() => nudge(60)}>+1m</button>
            <button className="btn small" onClick={() => nudge(300)}>+5m</button>
            <SetTime onSet={setTo} />
            <button className={`btn small${watched ? ' on' : ''}`} onClick={() => setWatched(meta, [key], !watched)}>
              {watched ? '✓ Watched' : 'Mark watched'}
            </button>
          </div>
        </div>

        {watched && next && (
          <a className="up-next" href={href(watchPath('series', meta.id, next.season, next.episode))}>
            <span className="muted">Up next</span>
            <strong>
              {epLabel(next.season, next.episode)} · {next.name}
            </strong>
            <span className="btn primary small">▶ Play</span>
          </a>
        )}
      </div>
    </div>
  )
}

function SetTime({ onSet }: { onSet: (seconds: number) => void }) {
  const [text, setText] = useState('')
  const parsed = parseClock(text)
  return (
    <form
      className="set-time"
      onSubmit={(e) => {
        e.preventDefault()
        if (parsed != null) {
          onSet(parsed)
          setText('')
        }
      }}
    >
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder="mm:ss" aria-label="Set position" size={7} />
      <button className="btn small" disabled={parsed == null}>Set</button>
    </form>
  )
}

function groupBySource(candidates: Candidate[]) {
  const groups: { source: Candidate['source']; items: Candidate[] }[] = []
  for (const c of candidates) {
    const g = groups.find((x) => x.source.id === c.source.id)
    if (g) g.items.push(c)
    else groups.push({ source: c.source, items: [c] })
  }
  return groups
}
