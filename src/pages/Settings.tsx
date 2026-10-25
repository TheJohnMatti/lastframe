import { useRef, useState } from 'react'
import { ConfirmButton } from '../components/ui'
import { libraryStore, settingsStore, type Settings as SettingsShape } from '../lib/library'
import { download, exportAll, importAll } from '../lib/backup'
import { healthStore } from '../lib/sources'

function set<K extends keyof SettingsShape>(key: K, value: SettingsShape[K]) {
  settingsStore.set((s) => ({ ...s, [key]: value }))
}

export function Settings() {
  const settings = settingsStore.use()
  const library = libraryStore.use()
  const [mode, setMode] = useState<'merge' | 'replace'>('merge')
  const [message, setMessage] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)

  async function restore(file: File) {
    try {
      const result = importAll(JSON.parse(await file.text()), mode)
      setMessage(`Imported ${result.titles} titles and ${result.sources} sources (${mode}).`)
    } catch (e) {
      setMessage((e as Error).message || 'That file could not be read.')
    }
  }

  return (
    <div className="page narrow">
      <div className="page-head">
        <h1>Settings</h1>
      </div>
      {message && <div className="notice" onClick={() => setMessage('')}>{message}</div>}

      <section className="panel">
        <h2>Tracking</h2>
        <label className="field">
          <span>Count as watched at</span>
          <input
            type="range"
            min={70}
            max={100}
            step={1}
            value={Math.round(settings.watchedAt * 100)}
            onChange={(e) => set('watchedAt', Number(e.target.value) / 100)}
          />
          <strong>{Math.round(settings.watchedAt * 100)}%</strong>
        </label>
        <label className="field">
          <span>Rewind when resuming</span>
          <input type="number" min={0} max={120} value={settings.rewind} onChange={(e) => set('rewind', Math.max(0, Number(e.target.value)))} />
          <span className="muted">seconds</span>
        </label>
        <label className="check-row">
          <input type="checkbox" checked={settings.estimate} onChange={(e) => set('estimate', e.target.checked)} />
          When a player doesn't report its time, run a clock from the moment you click into it.
        </label>
      </section>

      <section className="panel">
        <h2>Sources</h2>
        <label className="field">
          <span>Give up on a player that hasn't loaded after</span>
          <input
            type="number"
            min={5}
            max={120}
            value={settings.loadTimeout}
            onChange={(e) => set('loadTimeout', Math.max(5, Number(e.target.value)))}
          />
          <span className="muted">seconds</span>
        </label>
        <label className="check-row">
          <input type="checkbox" checked={settings.sandboxDefault} onChange={(e) => set('sandboxDefault', e.target.checked)} />
          Sandbox new sources by default (blocks popup ads and redirects).
        </label>
        <button className="btn small" onClick={() => healthStore.set({})}>Forget which sites were down</button>
      </section>

      <section className="panel">
        <h2>Your data</h2>
        <p className="muted">
          Everything lives in this browser's storage for <code>{location.origin}</code>. Another browser, profile or
          port starts empty, so export a backup to move or keep it. {Object.keys(library).length} titles tracked.
        </p>
        <div className="actions">
          <button className="btn primary" onClick={() => download(`lastframe-backup-${new Date().toISOString().slice(0, 10)}.json`, exportAll())}>
            Export backup
          </button>
          <select value={mode} onChange={(e) => setMode(e.target.value as 'merge' | 'replace')} aria-label="Import mode">
            <option value="merge">Merge into what's here</option>
            <option value="replace">Replace what's here</option>
          </select>
          <button className="btn" onClick={() => fileInput.current?.click()}>Import backup…</button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) restore(f)
              e.target.value = ''
            }}
          />
        </div>
        <div className="actions">
          <ConfirmButton className="btn ghost danger" ask="Erase all history and the watchlist?" onConfirm={() => libraryStore.set({})}>
            Erase watch history
          </ConfirmButton>
        </div>
      </section>
    </div>
  )
}
