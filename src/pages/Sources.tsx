import { useEffect, useRef, useState } from 'react'
import { Empty, StatusDot } from '../components/ui'
import { settingsStore } from '../lib/library'
import { download } from '../lib/backup'
import {
  addSources,
  candidatesFor,
  healthStore,
  loadLocalSourceFile,
  normalizeSource,
  originsOf,
  parseSourceList,
  probe,
  SAMPLE_EPISODE,
  SAMPLE_MOVIE,
  siteName,
  sourcesStore,
  statusOf,
  TEMPLATE_VARS,
  deriveTemplate,
  isSearchTemplate,
  type Source,
  type Target,
} from '../lib/sources'
import { navigate } from '../lib/router'
import { applyGrab, bookmarklet, parseGrab } from '../lib/grab'

function updateSources(fn: (list: Source[]) => Source[]) {
  sourcesStore.set((st) => ({ ...st, sources: fn(st.sources) }))
}

export function Sources({ grab }: { grab?: string | null }) {
  const { sources } = sourcesStore.use()
  const health = healthStore.use()
  const [editing, setEditing] = useState<Source | 'new' | null>(null)
  const [message, setMessage] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)

  // A player handed over by the grab bookmarklet.
  useEffect(() => {
    if (!grab) return
    const payload = parseGrab(grab)
    setMessage(payload ? applyGrab(payload).message : 'That grab came through cut off. Click the bookmark again.')
    navigate('/sources', true)
  }, [grab])

  const checkAll = () => sources.flatMap(originsOf).forEach((o) => probe(o))

  function move(index: number, by: number) {
    updateSources((list) => {
      const next = [...list]
      const [s] = next.splice(index, 1)
      next.splice(Math.max(0, Math.min(next.length, index + by)), 0, s)
      return next
    })
  }

  async function importFile(file: File) {
    try {
      const added = addSources(parseSourceList(JSON.parse(await file.text())))
      setMessage(added ? `Added ${added} source${added === 1 ? '' : 's'}.` : 'No new sources in that file.')
    } catch {
      setMessage("That file isn't a JSON list of sources.")
    }
  }

  async function reloadLocal() {
    const added = await loadLocalSourceFile(true)
    setMessage(added == null ? 'No public/sources.local.json found.' : `Added ${added} new source${added === 1 ? '' : 's'} from sources.local.json.`)
  }

  return (
    <div className="page narrow">
      <div className="page-head">
        <h1>Sources</h1>
        <div className="actions">
          <button className="btn primary" onClick={() => setEditing('new')}>+ Add source</button>
          {sources.length > 0 && <button className="btn" onClick={checkAll}>Check all</button>}
        </div>
      </div>
      <p className="lede">
        A source is a site whose player can be embedded from a URL. lastframe tries your enabled sources top to bottom,
        skips any that don't answer, and remembers which one played each title. It comes with none. Add the sites
        you use here, or keep them in <code>public/sources.local.json</code> (gitignored) and they load on first run.
      </p>
      {message && <div className="notice" onClick={() => setMessage('')}>{message}</div>}

      <GrabPanel />

      {editing && (
        <SourceForm
          initial={editing === 'new' ? undefined : editing}
          onCancel={() => setEditing(null)}
          onSave={(s) => {
            updateSources((list) => (list.some((x) => x.id === s.id) ? list.map((x) => (x.id === s.id ? s : x)) : [...list, s]))
            originsOf(s).forEach((o) => probe(o))
            setEditing(null)
          }}
        />
      )}

      {sources.length ? (
        <ol className="source-list">
          {sources.map((s, i) => (
            <li key={s.id} className={s.enabled ? '' : 'disabled'}>
              <div className="source-main">
                <div className="source-name">
                  <span className="muted">{i + 1}.</span> {s.name}
                  {!s.enabled && <span className="pill">off</span>}
                  {s.sandbox && <span className="pill" title="Popups and redirects out of the player are blocked">sandboxed</span>}
                  {(isSearchTemplate(s.movie) || isSearchTemplate(s.episode)) && (
                    <span className="pill" title="Opens the site's search; you pick the title in the player">search mode</span>
                  )}
                </div>
                <div className="source-hosts">
                  {originsOf(s).map((o) => {
                    const h = health[o]
                    const status = statusOf(o, health)
                    return (
                      <span key={o} className="host">
                        <StatusDot status={status} /> {o.replace(/^https?:\/\//, '')}
                        {status === 'up' && h && <span className="muted"> {h.ms}ms</span>}
                      </span>
                    )
                  })}
                  {!originsOf(s).length && <span className="warn">No usable URL: add a host or fix the templates</span>}
                </div>
              </div>
              <div className="source-actions">
                <button className="icon-btn" title="Move up" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                <button className="icon-btn" title="Move down" disabled={i === sources.length - 1} onClick={() => move(i, 1)}>↓</button>
                <button className="btn small" onClick={() => updateSources((l) => l.map((x) => (x.id === s.id ? { ...x, enabled: !x.enabled } : x)))}>
                  {s.enabled ? 'Disable' : 'Enable'}
                </button>
                <button className="btn small" onClick={() => setEditing(s)}>Edit</button>
                <button
                  className="btn small ghost"
                  onClick={() => confirm(`Delete ${s.name}?`) && updateSources((l) => l.filter((x) => x.id !== s.id))}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        !editing && (
          <Empty title="No sources yet">
            <p>Add one with the button above, import a JSON list, or drop a file at public/sources.local.json.</p>
          </Empty>
        )
      )}

      <section className="panel">
        <h2>Import and export</h2>
        <p className="muted">Keep your list somewhere private and load it into any browser running lastframe.</p>
        <div className="actions">
          <button className="btn" onClick={() => fileInput.current?.click()}>Import JSON…</button>
          <button className="btn" disabled={!sources.length} onClick={() => download('lastframe-sources.json', sources)}>Export JSON</button>
          <button className="btn" onClick={reloadLocal}>Load sources.local.json</button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) importFile(f)
              e.target.value = ''
            }}
          />
        </div>
      </section>

      <section className="panel">
        <h2>URL templates</h2>
        <p className="muted">
          Write the URL a site uses for its embeddable player and put these where the ids go. If the site moves
          between domains a lot, write <code>{'https://{host}/…'}</code> and list every mirror under Hosts: they're
          tried in order.
        </p>
        <table className="vars">
          <tbody>
            {TEMPLATE_VARS.map(([v, d]) => (
              <tr key={v}>
                <td><code>{v}</code></td>
                <td>{d}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">
          Example: <code>{'https://{host}/embed/movie/{imdb}'}</code> and <code>{'https://{host}/embed/tv/{imdb}/{season}/{episode}'}</code>.
          See <code>sources.example.json</code> in the repo for the file format.
        </p>
      </section>
    </div>
  )
}

function SourceForm({ initial, onSave, onCancel }: { initial?: Source; onSave: (s: Source) => void; onCancel: () => void }) {
  const [name, setName] = useState(initial?.name ?? '')
  const [hosts, setHosts] = useState(initial?.hosts.join('\n') ?? '')
  const [movie, setMovie] = useState(initial?.movie ?? '')
  const [episode, setEpisode] = useState(initial?.episode ?? '')
  const [sandbox, setSandbox] = useState(initial?.sandbox ?? settingsStore.get().sandboxDefault)
  const draft = normalizeSource({ id: initial?.id, enabled: initial?.enabled ?? true, name, hosts, movie, episode, sandbox })
  const fillFrom = (set: (t: string) => void) => (d: { template: string; host: string }) => {
    set(d.template)
    setHosts((h) => (h.split(/[\s,]+/).includes(d.host) ? h : h.trim() ? `${h.trim()}\n${d.host}` : d.host))
    setName((n) => n || siteName(d.host))
  }
  const usesHost = movie.includes('{host}') || episode.includes('{host}')
  const preview = draft
    ? [...candidatesFor(draft, SAMPLE_MOVIE).slice(0, 1), ...candidatesFor(draft, SAMPLE_EPISODE).slice(0, 1)]
    : []

  return (
    <form
      className="panel source-form"
      onSubmit={(e) => {
        e.preventDefault()
        if (draft) onSave(draft)
      }}
    >
      <h2>{initial ? `Edit ${initial.name}` : 'New source'}</h2>
      <details className="from-example" open={!initial}>
        <summary>Fill in from an example</summary>
        <p className="muted">
          On the site, open the player for each title below and paste the player's address. The URL templates and the
          host fill themselves in. If the site puts its player inside its own page, you need the inner player's
          address: in Chrome, right-click the video, choose View frame source, and copy the address after{' '}
          <code>view-source:</code>.
        </p>
        <FromExample sample={SAMPLE_MOVIE} label="The Dark Knight (2008)" onDerived={fillFrom(setMovie)} />
        <FromExample sample={SAMPLE_EPISODE} label="Breaking Bad, season 3, episode 7" onDerived={fillFrom(setEpisode)} />
      </details>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="What you call it" autoFocus />
      </label>
      <label>
        Hosts <span className="muted">one per line, used for {'{host}'}, tried in order</span>
        <textarea value={hosts} onChange={(e) => setHosts(e.target.value)} rows={3} placeholder={'example.com\nexample.net'} />
      </label>
      <label>
        Movie URL
        <input value={movie} onChange={(e) => setMovie(e.target.value)} placeholder="https://{host}/embed/movie/{imdb}" spellCheck={false} />
      </label>
      <label>
        Episode URL
        <input value={episode} onChange={(e) => setEpisode(e.target.value)} placeholder="https://{host}/embed/tv/{imdb}/{season}/{episode}" spellCheck={false} />
      </label>
      <label className="check-row">
        <input type="checkbox" checked={sandbox} onChange={(e) => setSandbox(e.target.checked)} />
        Sandbox the player: block popups, new tabs and redirects. Turn off only if a site refuses to play inside it.
      </label>
      {usesHost && !hosts.trim() && <div className="warn">The templates use {'{host}'} but no hosts are listed.</div>}
      {preview.length > 0 && (
        <div className="preview">
          <div className="muted">Preview</div>
          {preview.map((c) => (
            <code key={c.url}>{c.url}</code>
          ))}
        </div>
      )}
      <div className="actions">
        <button className="btn primary" disabled={!draft || (usesHost && !hosts.trim())}>Save</button>
        <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}

function FromExample({ sample, label, onDerived }: { sample: Target; label: string; onDerived: (d: { template: string; host: string }) => void }) {
  const [text, setText] = useState('')
  const result = text.trim() ? deriveTemplate(text, sample) : null
  return (
    <div className="example">
      <label>
        <span>
          Player address for {label}
        </span>
        <input
          value={text}
          spellCheck={false}
          placeholder="https://…"
          onChange={(e) => {
            setText(e.target.value)
            const r = deriveTemplate(e.target.value, sample)
            if ('template' in r) onDerived(r)
          }}
        />
      </label>
      {result && ('error' in result ? <div className="warn">{result.error}</div> : <div className="ok small">✓ {result.template}</div>)}
    </div>
  )
}

function GrabPanel() {
  const link = useRef<HTMLAnchorElement>(null)
  const [copied, setCopied] = useState(false)
  const code = bookmarklet(`${location.origin}${location.pathname}`)

  // React refuses javascript: hrefs, so set it on the element directly.
  useEffect(() => {
    link.current?.setAttribute('href', code)
  }, [code])

  return (
    <section className="panel grab">
      <h2>Grab players from any site</h2>
      <ol>
        <li>
          Drag this to your bookmarks bar (⌘⇧B shows the bar):{' '}
          <a
            ref={link}
            className="btn primary small bookmarklet"
            onClick={(e) => {
              e.preventDefault()
              alert('Drag this button to your bookmarks bar, then click it on a streaming site.')
            }}
          >
            ⤓ Grab for lastframe
          </a>{' '}
          <button
            className="link-btn"
            onClick={() => navigator.clipboard.writeText(code).then(() => setCopied(true), () => setCopied(false))}
          >
            {copied ? 'copied' : 'or copy it'}
          </button>
        </li>
        <li>
          On a site, open <strong>The Dark Knight</strong>, press play, and click the
          bookmark. The site's player is added as a source for movies.
        </li>
        <li>
          On the same site, open <strong>Breaking Bad season 3, episode 7</strong>, press play, and click it again. Now it plays episodes too.
        </li>
      </ol>
      <p className="muted">
        The bookmark reads the players embedded in the page, so blocked right-click and devtools don't matter. What it
        finds goes only to this tab. If a site's players use its own codes instead of the title's id, search the site
        for “The Dark Knight” and click the bookmark on the results page: the source then works in search mode, opening
        the site's search for each title so you click the right episode there.
      </p>
    </section>
  )
}
