import { useEffect, useRef, useState } from 'react'
import { href, navigate, useRoute } from './lib/router'
import { loadLocalSourceFile, sourcesStore } from './lib/sources'
import { connectExtension } from './lib/extension'
import { savePairKey, startSync, syncNow } from './lib/sync'
import type { MediaType } from './lib/meta'
import { Home } from './pages/Home'
import { Search } from './pages/Search'
import { Title } from './pages/Title'
import { Watch } from './pages/Watch'
import { Library } from './pages/Library'
import { Sources } from './pages/Sources'
import { Settings } from './pages/Settings'
import { Empty } from './components/ui'

const asType = (t?: string): MediaType => (t === 'series' ? 'series' : 'movie')
const asNumber = (v?: string | null) => (v == null || v === '' ? undefined : Number(v))

export default function App() {
  const { parts, query, path } = useRoute()

  useEffect(() => {
    loadLocalSourceFile()
    connectExtension()
    startSync()
  }, [])

  // The link in the QR code from Settings on the Mac: #/pair?key=...
  useEffect(() => {
    if (parts[0] !== 'pair') return
    const key = query.get('key')
    if (key) savePairKey(key)
    navigate('/', true)
    syncNow()
  }, [parts, query])

  useEffect(() => {
    window.scrollTo(0, 0)
  }, [path])

  let page
  switch (parts[0]) {
    case undefined:
      page = <Home />
      break
    case 'search':
      page = <Search query={query.get('q') ?? ''} />
      break
    case 'title':
      page = <Title type={asType(parts[1])} id={parts[2]} season={asNumber(query.get('s'))} />
      break
    case 'watch':
      page = <Watch type={asType(parts[1])} id={parts[2]} season={asNumber(parts[3])} episode={asNumber(parts[4])} />
      break
    case 'library':
      page = <Library tab={query.get('tab') ?? ''} />
      break
    case 'sources':
      page = <Sources grab={query.get('grab')} />
      break
    case 'settings':
      page = <Settings />
      break
    case 'pair':
      page = (
        <div className="page">
          <Empty title="Pairing with your Mac…" />
        </div>
      )
      break
    default:
      page = (
        <div className="page">
          <Empty title="Nothing here">
            <a href={href('/')}>Go home</a>
          </Empty>
        </div>
      )
  }

  return (
    <>
      <Header section={parts[0] ?? ''} query={parts[0] === 'search' ? (query.get('q') ?? '') : ''} />
      <main>{page}</main>
    </>
  )
}

function Header({ section, query }: { section: string; query: string }) {
  const { sources } = sourcesStore.use()
  const [text, setText] = useState(query)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setText((t) => (t.trim() === query ? t : query))
  }, [query])

  useEffect(() => {
    const q = text.trim()
    if (q === query || q.length < 2) return
    const t = setTimeout(() => navigate(`/search?q=${encodeURIComponent(q)}`, section === 'search'), 350)
    return () => clearTimeout(t)
  }, [text, query, section])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement
      if (e.key === '/' && !typing) {
        e.preventDefault()
        input.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const link = (to: string, label: string, name: string) => (
    <a href={href(to)} className={section === name ? 'active' : ''}>
      {label}
    </a>
  )

  return (
    <header className="topbar">
      <a className="logo" href={href('/')} aria-label="lastframe home">
        <span className="logo-mark" aria-hidden="true" />
        <span>
          last<em>frame</em>
        </span>
      </a>
      <form
        className="search"
        role="search"
        onSubmit={(e) => {
          e.preventDefault()
          if (text.trim()) navigate(`/search?q=${encodeURIComponent(text.trim())}`)
        }}
      >
        <input
          ref={input}
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search movies and series"
          aria-label="Search movies and series"
        />
        <kbd>/</kbd>
      </form>
      <nav>
        {link('/', 'Home', '')}
        {link('/library', 'Library', 'library')}
        <a href={href('/sources')} className={section === 'sources' ? 'active' : ''}>
          Sources{sources.length === 0 && <span className="nav-warn" title="No sources yet" />}
        </a>
        {link('/settings', 'Settings', 'settings')}
      </nav>
    </header>
  )
}
