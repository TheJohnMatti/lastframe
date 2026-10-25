// @ts-check
// The toolbar popup: says what the current tab is tracked as, and lets you
// link a tab you opened yourself to a title (searched on Cinemeta, the same
// metadata lastframe uses), optionally remembering that page.
const CINEMETA = 'https://v3-cinemeta.strem.io'

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id))
const statusBox = $('status')
const linker = $('linker')
const query = /** @type {HTMLInputElement} */ ($('query'))
const results = $('results')
const episodeRow = $('episode-row')
const seasonSel = /** @type {HTMLSelectElement} */ ($('season'))
const episodeSel = /** @type {HTMLSelectElement} */ ($('episode'))
const linkBtn = /** @type {HTMLButtonElement} */ ($('link'))
const remember = /** @type {HTMLInputElement} */ ($('remember'))

/** @type {number | undefined} */
let tabId
/** @type {{ id: string, type: 'movie' | 'series', name: string, poster?: string } | null} */
let chosen = null
/** @type {{ season: number, episode: number }[]} */
let episodes = []
/** @type {{ season: number, episode: number } | null} */
let guessEp = null

/** @param {any} msg */
const ask = (msg) => chrome.runtime.sendMessage(msg)

/** @param {number} s */
function clock(s) {
  const t = Math.max(0, Math.floor(s))
  const h = Math.floor(t / 3600)
  const m = String(Math.floor((t % 3600) / 60)).padStart(h ? 2 : 1, '0')
  return `${h ? `${h}:` : ''}${m}:${String(t % 60).padStart(2, '0')}`
}

// What the page title says: a show or movie name, maybe a season and episode.
/** @param {string} title @param {string} url */
function guess(title, url) {
  const text = `${title} ${decodeURIComponent(url).replace(/[-_/+]/g, ' ')}`
  const m =
    text.match(/\bs(\d{1,2})\s*e(\d{1,3})\b/i) ||
    text.match(/\b(\d{1,2})x(\d{1,3})\b/) ||
    text.match(/season\s*(\d{1,2})\D{1,20}?episode\s*(\d{1,3})/i)
  const name = title
    .split(/\s[|\-–—:]\s/)[0]
    .replace(/\bs\d{1,2}\s*e\d{1,3}\b.*$/i, '')
    .replace(/\b(season|episode)\s*\d+.*$/i, '')
    .replace(/\((19|20)\d{2}\)|\b(watch|online|free|full|movie|hd|streaming)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
  return { name, ep: m ? { season: Number(m[1]), episode: Number(m[2]) } : null }
}

async function search() {
  const q = query.value.trim()
  results.textContent = ''
  if (q.length < 2) return
  /** @type {any[]} */
  const found = []
  for (const type of ['series', 'movie']) {
    try {
      const res = await fetch(`${CINEMETA}/catalog/${type}/top/search=${encodeURIComponent(q)}.json`)
      const data = await res.json()
      for (const m of (data.metas || []).slice(0, 5)) found.push({ ...m, type })
    } catch {
      // offline or Cinemeta down: nothing to show
    }
  }
  if (q !== query.value.trim()) return
  for (const m of found) {
    const id = m.imdb_id || m.id
    if (!/^tt\d+$/.test(id)) continue
    const b = document.createElement('button')
    b.className = 'result'
    const img = document.createElement('img')
    img.src = m.poster || ''
    img.alt = ''
    const text = document.createElement('div')
    const n = document.createElement('span')
    n.textContent = m.name
    const sub = document.createElement('span')
    sub.className = 'muted'
    sub.textContent = `${m.type === 'series' ? 'Series' : 'Movie'}${m.releaseInfo ? ` · ${m.releaseInfo}` : ''}`
    text.append(n, sub)
    b.append(img, text)
    b.onclick = () => choose({ id, type: m.type, name: m.name, poster: m.poster }, b)
    results.append(b)
  }
  if (!results.children.length) results.innerHTML = '<div class="muted">No matches.</div>'
}

/** @param {{ id: string, type: 'movie' | 'series', name: string, poster?: string }} item @param {HTMLElement} el */
async function choose(item, el) {
  chosen = item
  for (const r of results.children) r.classList.toggle('on', r === el)
  episodeRow.hidden = item.type !== 'series'
  linkBtn.disabled = item.type === 'series'
  if (item.type !== 'series') return
  const res = await fetch(`${CINEMETA}/meta/series/${item.id}.json`).then((r) => r.json()).catch(() => null)
  episodes = (res?.meta?.videos || [])
    .filter((/** @type {any} */ v) => typeof v.season === 'number' && v.season > 0)
    .map((/** @type {any} */ v) => ({ season: v.season, episode: v.episode ?? v.number }))
    .sort((/** @type {any} */ a, /** @type {any} */ b) => a.season - b.season || a.episode - b.episode)
  const seasons = [...new Set(episodes.map((e) => e.season))]
  seasonSel.innerHTML = seasons.map((s) => `<option value="${s}">Season ${s}</option>`).join('')
  if (guessEp && seasons.includes(guessEp.season)) seasonSel.value = String(guessEp.season)
  fillEpisodes()
  linkBtn.disabled = !episodes.length
}

function fillEpisodes() {
  const s = Number(seasonSel.value)
  const eps = episodes.filter((e) => e.season === s)
  episodeSel.innerHTML = eps.map((e) => `<option value="${e.episode}">Episode ${e.episode}</option>`).join('')
  if (guessEp && guessEp.season === s && eps.some((e) => e.episode === guessEp?.episode)) episodeSel.value = String(guessEp.episode)
}

async function linkTab() {
  if (!chosen || tabId == null) return
  const key = chosen.type === 'series' ? `${seasonSel.value}:${episodeSel.value}` : 'movie'
  linkBtn.disabled = true
  const res = await ask({ type: 'link', tabId, item: { ...chosen, key }, remember: remember.checked })
  if (res?.ok) await render()
  else linkBtn.disabled = false
}

async function render() {
  // ?tab=<id> targets a given tab (when this page is opened as a tab, for testing)
  const forced = Number(new URLSearchParams(location.search).get('tab'))
  const [tab] = forced ? [await chrome.tabs.get(forced)] : await chrome.tabs.query({ active: true, currentWindow: true })
  tabId = tab?.id
  if (tabId == null || !/^https?:/.test(tab.url || '')) {
    statusBox.innerHTML = '<span class="muted">Open a video page to track it.</span>'
    return
  }
  const st = await ask({ type: 'popup-state', tabId })
  statusBox.textContent = ''
  if (st?.tracking) {
    const strong = document.createElement('strong')
    strong.textContent = st.tracking.label
    const line = document.createElement('div')
    line.className = 'muted'
    line.innerHTML = '<span class="ok">●</span> '
    line.append(st.position ? `Tracking · at ${clock(st.position)}${st.duration ? ` of ${clock(st.duration)}` : ''}` : 'Tracking · waiting for the video to play')
    const row = document.createElement('div')
    row.className = 'row'
    row.style.marginTop = '8px'
    const change = document.createElement('button')
    change.textContent = 'Wrong title?'
    change.onclick = () => openLinker(tab, 'Track this tab as:')
    const stop = document.createElement('button')
    stop.textContent = 'Stop tracking'
    stop.onclick = async () => {
      await ask({ type: 'unlink', tabId })
      render()
    }
    row.append(change, stop)
    statusBox.append(strong, line, row)
    linker.hidden = true
  } else {
    statusBox.innerHTML = '<strong>Not tracking this tab</strong><div class="muted">Pick what\'s playing and lastframe keeps your place, like a title opened from lastframe.</div>'
    openLinker(tab, 'Track this tab as:')
  }
}

/** @param {chrome.tabs.Tab} tab @param {string} title */
function openLinker(tab, title) {
  linker.hidden = false
  $('linker-title').textContent = title
  const g = guess(tab.title || '', tab.url || '')
  guessEp = g.ep
  if (!query.value) query.value = g.name
  search()
  query.focus()
}

let timer = 0
query.addEventListener('input', () => {
  clearTimeout(timer)
  timer = setTimeout(search, 300)
})
seasonSel.addEventListener('change', fillEpisodes)
linkBtn.addEventListener('click', linkTab)
render()
