// @ts-check
// Keeps which tabs lastframe opened (and for what), and records progress that
// detectors in those tabs report. lastframe's page reads it through bridge.js.
const PROGRESS = 'lf.progress' // chrome.storage.local: what the app merges in
const LINKS = 'lf.links' // chrome.storage.local: page URL -> item, from "track this tab"
const LAUNCHES = 'lf.launches' // chrome.storage.session: tab id -> launch
const MAX_ENTRIES = 400
const MAX_LINKS = 300
const APP = /^http:\/\/(localhost|127\.0\.0\.1):5178\//

/**
 * @typedef {{ id: string, type: 'movie' | 'series', key: string, name: string, poster?: string, sourceId?: string }} Item
 * @typedef {{ key: string, label: string, url?: string }} NextEp
 * @typedef {{ movie: string, episode: string, hosts: string[] }} Templates
 * @typedef {{ item: Item, resumeAt: number, pending: boolean, expected: number, at: number,
 *   tmdb?: string, templates?: Templates, next: NextEp[], watchedAt: number, announced: boolean, since?: number }} Launch
 * @typedef {Item & { position: number, duration: number, updatedAt: number, url?: string }} Entry
 */

// The service worker can handle several messages at once; storage updates go one at a time.
/** @type {Promise<unknown>} */
let queue = Promise.resolve()
/** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
function serial(fn) {
  const run = queue.then(fn, fn)
  queue = run.catch(() => {})
  return run
}

/** @returns {Promise<Record<string, Launch>>} */
async function launches() {
  const got = /** @type {Record<string, Launch> | undefined} */ ((await chrome.storage.session.get(LAUNCHES))[LAUNCHES])
  return got || {}
}

/** @param {Record<string, Launch>} all */
const saveLaunches = (all) => chrome.storage.session.set({ [LAUNCHES]: all })

/** @returns {Promise<Record<string, Entry>>} */
async function progressEntries() {
  const got = /** @type {Record<string, Entry> | undefined} */ ((await chrome.storage.local.get(PROGRESS))[PROGRESS])
  return got || {}
}

/** @returns {Promise<Record<string, Item>>} */
async function links() {
  const got = /** @type {Record<string, Item> | undefined} */ ((await chrome.storage.local.get(LINKS))[LINKS])
  return got || {}
}

/** @param {unknown} v */
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
/** @param {unknown} v @param {number} max */
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '')

/** @param {unknown} raw */
function cleanItem(raw) {
  if (!raw || typeof raw !== 'object') return null
  const i = /** @type {Record<string, unknown>} */ (raw)
  if (typeof i.id !== 'string' || !/^tt\d+$/.test(i.id)) return null
  if (typeof i.key !== 'string' || !/^(movie|\d+:\d+)$/.test(i.key)) return null
  /** @type {Item} */
  const item = { id: i.id, type: i.type === 'series' ? 'series' : 'movie', key: i.key, name: str(i.name, 200) }
  if (typeof i.poster === 'string' && /^https:\/\//.test(i.poster)) item.poster = i.poster.slice(0, 500)
  if (typeof i.sourceId === 'string') item.sourceId = i.sourceId.slice(0, 40)
  return item
}

/** @param {unknown} raw */
function safeUrl(raw) {
  try {
    const url = new URL(String(raw))
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

/** @param {string} url */
const pageKey = (url) => url.replace(/#.*$/, '')

/** @param {Item} item */
function label(item) {
  if (item.key === 'movie') return item.name
  const [s, e] = item.key.split(':')
  return `${item.name} S${s} · E${e}`
}

/** @param {unknown} raw @returns {NextEp[]} */
function cleanNext(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .slice(0, 12)
    .map((n) => ({ key: str(n?.key, 12), label: str(n?.label, 200), url: safeUrl(n?.url) ?? undefined }))
    .filter((n) => /^\d+:\d+$/.test(n.key))
}

/** @param {unknown} raw @returns {Templates | undefined} */
function cleanTemplates(raw) {
  if (!raw || typeof raw !== 'object') return undefined
  const t = /** @type {Record<string, unknown>} */ (raw)
  const hosts = Array.isArray(t.hosts) ? t.hosts.map((h) => str(h, 200)).filter(Boolean).slice(0, 20) : []
  return { movie: str(t.movie, 1000), episode: str(t.episode, 1000), hosts }
}

// ---- reading a page address back through a source's template ---------------

const escapeRe = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Turn "https://{host}/tv/{imdb}/{season}/{episode}" into a pattern that pulls
 * those values back out of an address.
 * @param {string} template @param {string[]} hosts
 * @returns {{ re: RegExp, names: string[] } | null}
 */
function compile(template, hosts) {
  if (!template) return null
  /** @type {Record<string, string>} */
  const capture = { imdb: '(tt\\d+)', tmdb: '(\\d+)', season: '0*(\\d+)', episode: '0*(\\d+)' }
  /** @type {Record<string, string>} */
  const skip = {
    host: hosts.length ? `(?:${hosts.map(escapeRe).join('|')})` : '[^/?#]+',
    t: '\\d*',
    type: '[a-z]+',
    year: '\\d{4}',
  }
  const names = []
  let re = ''
  let last = 0
  for (const m of template.matchAll(/\{(\w+)\}/g)) {
    re += escapeRe(template.slice(last, m.index))
    const name = m[1]
    if (capture[name]) {
      re += capture[name]
      names.push(name)
    } else re += skip[name] ?? '[^/?#&]+'
    last = (m.index ?? 0) + m[0].length
  }
  re += escapeRe(template.slice(last))
  // http and https, and anything after the template's own end
  re = re.replace(/^https?:/, 'https?:')
  try {
    return { re: new RegExp(`^${re}(?=$|[/?#&])`, 'i'), names }
  } catch {
    return null
  }
}

/** @param {Launch} l @param {string} url @returns {string | null} the episode key the address is for */
function episodeFromUrl(l, url) {
  if (l.item.type !== 'series' || !l.templates) return null
  const pattern = compile(l.templates.episode, l.templates.hosts)
  const m = pattern && url.match(pattern.re)
  if (!pattern || !m) return null
  /** @type {Record<string, string>} */
  const got = {}
  pattern.names.forEach((n, i) => (got[n] = m[i + 1]))
  const sameShow = (got.imdb && got.imdb === l.item.id) || (got.tmdb && got.tmdb === l.tmdb)
  if (!sameShow || !got.season || !got.episode) return null
  return `${Number(got.season)}:${Number(got.episode)}`
}

// Move a launch to another episode of the same show: drop the episodes it
// skipped from "next", and resume that episode if the extension saw it before.
/** @param {Launch} l @param {string} key */
async function moveTo(l, key) {
  if (key === l.item.key) return false
  const at = l.next.findIndex((n) => n.key === key)
  l.next = at >= 0 ? l.next.slice(at + 1) : l.next
  l.item = { ...l.item, key }
  const seen = (await progressEntries())[`${l.item.id}|${key}`]
  const resumable = seen && seen.position > 30 && seen.duration && seen.position < seen.duration * l.watchedAt
  l.resumeAt = resumable ? Math.max(0, seen.position - 10) : 0
  l.pending = l.resumeAt > 0
  l.announced = false
  return true
}

// ---- messages ----------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  serial(() => handle(msg, sender)).then(reply, (e) => reply({ error: String(e?.message || e) }))
  return true
})

/** @param {any} msg @param {chrome.runtime.MessageSender} sender */
async function handle(msg, sender) {
  // the extension's own pages; content scripts report their web page's address instead
  const fromPopup = sender.id === chrome.runtime.id && (sender.url || '').startsWith(chrome.runtime.getURL(''))
  switch (msg?.type) {
    case 'launch':
      return launch(msg.payload, sender)
    case 'playback':
      return playback(msg.state, sender)
    case 'resumed':
      return resumed(sender)
    case 'next':
      return goNext(sender)
    case 'popup-state':
      return fromPopup ? popupState(msg.tabId) : { error: 'not allowed' }
    case 'link':
      return fromPopup ? link(msg.tabId, msg.item, !!msg.remember) : { error: 'not allowed' }
    case 'unlink':
      return fromPopup ? unlink(msg.tabId) : { error: 'not allowed' }
    default:
      return { error: 'unknown message' }
  }
}

// Only lastframe's own page, in its top frame, may open tabs.
/** @param {any} p @param {chrome.runtime.MessageSender} sender */
async function launch(p, sender) {
  if (sender.frameId !== 0 || !APP.test(sender.url || '')) return { error: 'not allowed' }
  const url = safeUrl(p?.url)
  const item = cleanItem(p?.item)
  if (!url || !item) return { error: 'bad launch' }
  const resumeAt = num(p.resumeAt)
  // open blank, register, then navigate: the page can't report before we know it
  const tab = await chrome.tabs.create({ url: 'about:blank', active: true, openerTabId: sender.tab?.id })
  if (tab.id == null) return { error: 'no tab' }
  const all = await launches()
  all[tab.id] = {
    item,
    resumeAt,
    pending: resumeAt > 0,
    expected: num(p.expectedDuration),
    at: Date.now(),
    tmdb: str(p.tmdb, 20) || undefined,
    templates: cleanTemplates(p.templates),
    next: cleanNext(p.next),
    watchedAt: num(p.watchedAt) || 0.9,
    announced: false,
  }
  await saveLaunches(all)
  await chrome.tabs.update(tab.id, { url })
  return { ok: true, tabId: tab.id }
}

/** @param {any} state @param {chrome.runtime.MessageSender} sender */
async function playback(state, sender) {
  const tabId = sender.tab?.id
  if (tabId == null || !state) return { tracked: false }
  const all = await launches()
  const l = all[tabId]
  if (!l) return { tracked: false }
  // a page from before "Up next" switched episodes, saying goodbye: not this episode
  if (l.since && num(state.born) && state.born < l.since) return { tracked: true, key: l.item.key }
  // the player frame's own address can name the episode even when the page's doesn't
  const fromFrame = sender.frameId ? episodeFromUrl(l, sender.url || '') : null
  let changed = fromFrame ? await moveTo(l, fromFrame) : false
  const duration = num(state.duration)
  const announce = !l.announced
  if (announce) {
    l.announced = true
    changed = true
  }
  if (changed) await saveLaunches(all)
  // far shorter than the title: an ad or a trailer playing in the same tab
  if (l.expected && duration < l.expected * 0.4) return { tracked: true, resumeAt: 0, key: l.item.key }
  if (state.report) await record(l, num(state.position), duration, !!state.ended, sender.tab?.url)
  const next = l.next[0]
  return {
    tracked: true,
    key: l.item.key,
    label: label(l.item),
    announce,
    resumeAt: l.pending ? l.resumeAt : 0,
    expected: l.expected,
    watchedAt: l.watchedAt,
    next: next ? { label: next.label, hasUrl: !!next.url } : null,
  }
}

/** @param {chrome.runtime.MessageSender} sender */
async function resumed(sender) {
  const tabId = sender.tab?.id
  if (tabId == null) return { ok: false }
  const all = await launches()
  if (all[tabId]) {
    all[tabId].pending = false
    await saveLaunches(all)
  }
  return { ok: true }
}

// "Up next → Play" in the tab: same tab, next episode, same source.
/** @param {chrome.runtime.MessageSender} sender */
async function goNext(sender) {
  const tabId = sender.tab?.id
  if (tabId == null) return { ok: false }
  const all = await launches()
  const l = all[tabId]
  const next = l?.next[0]
  if (!l || !next?.url) return { ok: false }
  await moveTo(l, next.key)
  l.since = Date.now()
  await saveLaunches(all)
  await chrome.tabs.update(tabId, { url: next.url })
  return { ok: true }
}

/** @param {Launch} l @param {number} position @param {number} duration @param {boolean} ended @param {string | undefined} tabUrl */
async function record(l, position, duration, ended, tabUrl) {
  const all = await progressEntries()
  const url = safeUrl(tabUrl)
  all[`${l.item.id}|${l.item.key}`] = {
    ...l.item,
    position: ended ? duration : position,
    duration,
    updatedAt: Date.now(),
    url: url ? pageKey(url) : undefined,
  }
  const keys = Object.keys(all)
  if (keys.length > MAX_ENTRIES) {
    keys.sort((a, b) => all[a].updatedAt - all[b].updatedAt)
    for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete all[k]
  }
  await chrome.storage.local.set({ [PROGRESS]: all })
}

// ---- the toolbar popup: see what a tab is tracked as, or link it -------------

/** @param {number} tabId */
async function popupState(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null)
  if (!tab) return { error: 'no tab' }
  const l = (await launches())[tabId]
  const entry = l ? (await progressEntries())[`${l.item.id}|${l.item.key}`] : undefined
  const linked = tab.url ? !!(await links())[pageKey(tab.url)] : false
  return {
    url: tab.url,
    title: tab.title,
    tracking: l ? { label: label(l.item), item: l.item } : null,
    position: entry?.position,
    duration: entry?.duration,
    linked,
  }
}

/** @param {number} tabId @param {unknown} rawItem @param {boolean} remember */
async function link(tabId, rawItem, remember) {
  const item = cleanItem(rawItem)
  const tab = await chrome.tabs.get(tabId).catch(() => null)
  if (!item || !tab) return { error: 'bad link' }
  const all = await launches()
  const prev = all[tabId]
  /** @type {Launch} */
  const l = { item, resumeAt: 0, pending: false, expected: 0, at: Date.now(), next: [], watchedAt: prev?.watchedAt || 0.9, announced: true }
  const seen = (await progressEntries())[`${item.id}|${item.key}`]
  if (seen && seen.position > 30 && seen.duration && seen.position < seen.duration * l.watchedAt) {
    l.resumeAt = Math.max(0, seen.position - 10)
    l.pending = true
  }
  all[tabId] = l
  await saveLaunches(all)
  if (remember && tab.url) {
    const saved = await links()
    saved[pageKey(tab.url)] = item
    const keys = Object.keys(saved)
    if (keys.length > MAX_LINKS) delete saved[keys[0]]
    await chrome.storage.local.set({ [LINKS]: saved })
  }
  return { ok: true }
}

/** @param {number} tabId */
async function unlink(tabId) {
  const all = await launches()
  delete all[tabId]
  await saveLaunches(all)
  const tab = await chrome.tabs.get(tabId).catch(() => null)
  if (tab?.url) {
    const saved = await links()
    delete saved[pageKey(tab.url)]
    await chrome.storage.local.set({ [LINKS]: saved })
  }
  return { ok: true }
}

// ---- tabs --------------------------------------------------------------------

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (!change.url) return
  const url = change.url
  serial(async () => {
    const all = await launches()
    const l = all[tabId]
    if (l) {
      // you moved to another episode on the site itself
      const key = episodeFromUrl(l, url)
      if (key && (await moveTo(l, key))) await saveLaunches(all)
      return
    }
    // a page you linked by hand before
    const item = (await links())[pageKey(url)]
    if (item) await link(tabId, item, false)
  })
})

chrome.tabs.onRemoved.addListener((tabId) => {
  serial(async () => {
    const all = await launches()
    if (all[tabId]) {
      delete all[tabId]
      await saveLaunches(all)
    }
  })
})

// After install or reload, tabs that were already open have no content
// scripts (or orphaned ones), so give them fresh copies.
chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] })
  for (const t of tabs) {
    if (t.id == null) continue
    chrome.scripting.executeScript({ target: { tabId: t.id, allFrames: true }, files: ['detector.js'] }).catch(() => {})
    if (APP.test(t.url || '')) chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['bridge.js'] }).catch(() => {})
  }
})
