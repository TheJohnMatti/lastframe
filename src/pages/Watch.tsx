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
import { launchInTab, useExtension } from '../lib/extension'
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

type Failure = 'unreachable' | 'never loaded' | 'not playing'

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
  const ext = useExtension()
  // Sites open in their own tab; playing inside lastframe is the fallback.
  const [embedded, setEmbedded] = useState(false)
  const [opened, setOpened] = useState<{ source: string; tracked: boolean } | null>(null)
  const [launchFailed, setLaunchFailed] = useState<string | null>(null)
  const mountedAt = useRef(Date.now())

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
  // why each player was dropped; only "not playing" (your word) rules one out for good
  const failures = useRef<Map<string, Failure>>(new Map())
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

  const viable = useCallback(
    (c: Candidate) => !failures.current.has(c.url) && statusOf(c.origin, healthStore.get()) !== 'down',
    [],
  )

  // Best: untried and reachable. Then anything you haven't ruled out, because
  // the reachability check and the load timer can both be wrong about a site.
  const pickNext = useCallback(() => {
    const open = candidates.filter((c) => failures.current.get(c.url) !== 'not playing')
    show(open.find(viable) ?? open.find((c) => !failures.current.has(c.url)) ?? open[0], false)
  }, [candidates, show, viable])

  const drop = useCallback((urls: string[], why: Failure) => {
    urls.forEach((u) => failures.current.set(u, why))
    pickNext()
  }, [pickNext])

  // Automatic drops only happen when there's something better to switch to.
  const hasAlternative = useCallback((url: string) => candidates.some((c) => c.url !== url && viable(c)), [candidates, viable])

  useEffect(() => {
    for (const origin of new Set(candidates.map((c) => c.origin))) {
      if (statusOf(origin, healthStore.get()) === 'unknown') probe(origin)
    }
  }, [candidates])

  useEffect(() => {
    if (!current && !exhausted && candidates.length) pickNext()
  }, [current, exhausted, candidates, pickNext])

  // The host behind the current player didn't answer the reachability check.
  useEffect(() => {
    if (current && !manual && statusOf(current.origin, health) === 'down' && hasAlternative(current.url)) drop([current.url], 'unreachable')
  }, [health, current, manual, hasAlternative, drop])

  // The player never finished loading. A host that answered is probably just a
  // heavy page still pulling in ads, so only time out hosts that didn't.
  useEffect(() => {
    if (!embedded || !current || loaded || manual) return
    const t = setTimeout(() => {
      if (statusOf(current.origin, healthStore.get()) !== 'up' && hasAlternative(current.url)) drop([current.url], 'never loaded')
    }, settings.loadTimeout * 1000)
    return () => clearTimeout(t)
  }, [embedded, current, loaded, manual, settings.loadTimeout, hasAlternative, drop])

  function notPlaying() {
    if (!current) return
    markSourceFailed(meta, current.source.id)
    // the title is missing from that site, so its other mirrors won't have it either
    drop(candidates.filter((c) => c.source.id === current.source.id).map((c) => c.url), 'not playing')
  }

  function chooseSource(sourceId: string) {
    const h = healthStore.get()
    const own = candidates.filter((c) => c.source.id === sourceId)
    show(own.find((c) => statusOf(c.origin, h) !== 'down') ?? own[0], true)
  }

  function retryAll() {
    failures.current.clear()
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

  // The extension reports from the tab: follow it, unless this page's own
  // embedded player is the one being watched.
  useEffect(() => {
    if (!progress || progress.updatedAt <= mountedAt.current || (embedded && engagedRef.current)) return
    pos.current = progress.position
    if (progress.duration) dur.current = progress.duration
    rerender()
  }, [progress, embedded, engagedRef])

  function watchInTab() {
    if (!current) return
    const p = libraryStore.get()[meta.id]?.progress[key]
    const resumeAt = p && !p.watched && p.position > 30 ? Math.max(0, p.position - settings.rewind) : 0
    // rebuild the address with today's spot, for sites that take a start time
    const url = candidatesFor(current.source, { ...target, startAt: resumeAt }).find((c) => c.host === current.host)?.url ?? current.url
    setLaunchFailed(null)
    if (!ext.installed) {
      // must happen inside the click, or the popup blocker steps in
      window.open(url, '_blank', 'noopener')
      setOpened({ source: current.source.name, tracked: false })
      return
    }
    const item = { id: meta.id, type: meta.type, key, name: meta.name, poster: meta.poster, sourceId: current.source.id }
    launchInTab({ url, item, resumeAt, expectedDuration: parseRuntime(meta.runtime) }).then((ok) => {
      if (ok) setOpened({ source: current.source.name, tracked: true })
      else setLaunchFailed(url)
    })
  }

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
  const tabLive = progress?.via === 'tab' && Date.now() - progress.updatedAt < 25_000
  const resumable = progress && !progress.watched && progress.position > 30 ? progress.position : 0
  const what = isMovie ? meta.name : `${meta.name} ${epLabel(season!, episode!)}`

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
        {current && !embedded ? (
          <div className="launch" style={meta.background ? { backgroundImage: `url(${meta.background})` } : undefined}>
            <div className="launch-body">
              <button className="btn primary big" onClick={watchInTab}>
                ▶ {resumable ? `Resume at ${clock(resumable)}` : 'Watch'} on {current.source.name}
              </button>
              <div className="launch-note">
                {tabLive ? (
                  <span className="ok">● Playing in a tab · {clock(progress!.position)}</span>
                ) : opened?.tracked ? (
                  <>Opened in a new tab. Press play there; this page follows along by itself.</>
                ) : opened ? (
                  <>Opened in a new tab. Without the extension, set your spot below when you stop.</>
                ) : ext.installed ? (
                  <>Opens in a new tab{resumable ? ' and jumps to where you stopped' : ''}. Your place comes back here by itself.</>
                ) : (
                  <>
                    Opens in a new tab. <a href={href('/settings')}>Add the lastframe extension</a> and your place is tracked by
                    itself.
                  </>
                )}
              </div>
              {launchFailed && (
                <div className="warn">
                  The extension didn't answer.{' '}
                  <a href={launchFailed} target="_blank" rel="noopener noreferrer">
                    Open it directly
                  </a>
                </div>
              )}
              <button className="link-btn" onClick={() => setEmbedded(true)}>
                Play it inside lastframe instead
              </button>
            </div>
          </div>
        ) : current ? (
          <iframe
            ref={frame}
            key={`${current.url}|${current.source.sandbox}`}
            src={current.url}
            title={`${meta.name} via ${current.source.name}`}
            allow="autoplay *; fullscreen *; encrypted-media *; picture-in-picture *"
            allowFullScreen
            sandbox={current.source.sandbox ? EMBED_SANDBOX : undefined}
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
              <Empty title="You marked every source as not playing">
                <p>None of your sources had this one. Try them again, or add another site.</p>
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
                const why = items.map((c) => failures.current.get(c.url)).find(Boolean)
                return (
                  <button
                    key={source.id}
                    className={`chip${active ? ' active' : ''}`}
                    title={why ? `Dropped: ${why}. Click to load it anyway.` : `Load ${source.name}`}
                    onClick={() => chooseSource(source.id)}
                  >
                    <StatusDot status={statusOf(shown.origin, health)} />
                    {source.name}
                    {active && current?.host && items.length > 1 && <span className="chip-host">{current.host}</span>}
                  </button>
                )
              })}
            </div>
            {current && (
              <button className="btn small" onClick={notPlaying} title="Skip this source for this title and try the next one">
                Didn't play? Next source →
              </button>
            )}
            {embedded && current && (
              <button className="btn small" onClick={() => setEmbedded(false)}>
                Open in a tab instead
              </button>
            )}
          </div>
        )}

        {current && isSearchTemplate(template) && (
          <div className="hint">
            {current.source.name} opens its own search: pick <strong>{what}</strong> there.
            {ext.installed ? ' The extension knows which title the tab is for.' : ''}
          </div>
        )}

        {embedded && initial.resumeFrom > 0 && current && (
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
              {tabLive ? (
                <span className="ok">● Synced from the tab by the extension</span>
              ) : !embedded ? (
                <span>
                  {opened?.tracked
                    ? 'Waiting for the video to play in the tab.'
                    : ext.installed
                      ? 'Updates by itself while you watch in a tab.'
                      : 'Set your spot by hand when you stop.'}
                </span>
              ) : live ? (
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
            {embedded && !live && engaged && settings.estimate && (
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

// Lets the site's own links, dialogs, downloads and new tabs work, but never
// lets it navigate lastframe's tab away.
const EMBED_SANDBOX =
  'allow-scripts allow-same-origin allow-forms allow-presentation allow-pointer-lock allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads'

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
