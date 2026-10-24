import { useRef, useState } from 'react'
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
  sourcesStore,
  statusOf,
  TEMPLATE_VARS,
  type Source,
  type Target,
} from '../lib/sources'

const SAMPLE_MOVIE: Target = { type: 'movie', imdb: 'tt0468569', tmdb: '155', title: 'The Dark Knight', year: '2008', startAt: 0 }
const SAMPLE_EPISODE: Target = { type: 'series', imdb: 'tt0903747', tmdb: '1396', season: 1, episode: 2, title: 'Breaking Bad', year: '2008', startAt: 0 }

function updateSources(fn: (list: Source[]) => Source[]) {
  sourcesStore.set((st) => ({ ...st, sources: fn(st.sources) }))
}

export function Sources() {
  const { sources } = sourcesStore.use()
  const health = healthStore.use()
  const [editing, setEditing] = useState<Source | 'new' | null>(null)
  const [message, setMessage] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)

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
