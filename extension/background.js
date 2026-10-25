// @ts-check
// Keeps which tabs lastframe opened (and for what), and records progress that
// detectors in those tabs report. lastframe's page reads it through bridge.js.
const PROGRESS = 'lf.progress' // chrome.storage.local: what the app merges in
const LAUNCHES = 'lf.launches' // chrome.storage.session: tab id -> launch
const MAX_ENTRIES = 400
const APP = /^http:\/\/(localhost|127\.0\.0\.1):5178\//

/**
 * @typedef {{ id: string, type: 'movie' | 'series', key: string, name: string, poster?: string, sourceId?: string }} Item
 * @typedef {{ item: Item, resumeAt: number, pending: boolean, expected: number, at: number }} Launch
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

/** @param {unknown} v */
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)

/** @param {unknown} raw */
function cleanItem(raw) {
  if (!raw || typeof raw !== 'object') return null
  const i = /** @type {Record<string, unknown>} */ (raw)
  if (typeof i.id !== 'string' || !/^tt\d+$/.test(i.id)) return null
  if (typeof i.key !== 'string' || !/^(movie|\d+:\d+)$/.test(i.key)) return null
  /** @type {Item} */
  const item = {
    id: i.id,
    type: i.type === 'series' ? 'series' : 'movie',
    key: i.key,
    name: typeof i.name === 'string' ? i.name.slice(0, 200) : '',
  }
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

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  serial(() => handle(msg, sender)).then(reply, (e) => reply({ error: String(e?.message || e) }))
  return true
})

/** @param {any} msg @param {chrome.runtime.MessageSender} sender */
async function handle(msg, sender) {
  switch (msg?.type) {
    case 'launch':
      return launch(msg.payload, sender)
    case 'playback':
      return playback(msg.state, sender)
    case 'resumed':
      return resumed(sender)
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
  all[tab.id] = { item, resumeAt, pending: resumeAt > 0, expected: num(p.expectedDuration), at: Date.now() }
  await saveLaunches(all)
  await chrome.tabs.update(tab.id, { url })
  return { ok: true, tabId: tab.id }
}

/** @param {any} state @param {chrome.runtime.MessageSender} sender */
async function playback(state, sender) {
  const tabId = sender.tab?.id
  if (tabId == null || !state) return { tracked: false }
  const l = (await launches())[tabId]
  if (!l) return { tracked: false }
  const duration = num(state.duration)
  // far shorter than the title: an ad or a trailer playing in the same tab
  if (l.expected && duration < l.expected * 0.4) return { tracked: true, resumeAt: 0 }
  if (state.report) await record(l, num(state.position), duration, !!state.ended, sender.tab?.url)
  return { tracked: true, resumeAt: l.pending ? l.resumeAt : 0, expected: l.expected }
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

/** @param {Launch} l @param {number} position @param {number} duration @param {boolean} ended @param {string | undefined} tabUrl */
async function record(l, position, duration, ended, tabUrl) {
  /** @typedef {Item & { position: number, duration: number, updatedAt: number, url?: string }} Entry */
  const stored = /** @type {Record<string, Entry> | undefined} */ ((await chrome.storage.local.get(PROGRESS))[PROGRESS])
  const all = stored || {}
  const url = safeUrl(tabUrl)
  all[`${l.item.id}|${l.item.key}`] = {
    ...l.item,
    position: ended ? duration : position,
    duration,
    updatedAt: Date.now(),
    url: url ? url.replace(/#.*$/, '') : undefined,
  }
  const keys = Object.keys(all)
  if (keys.length > MAX_ENTRIES) {
    keys.sort((a, b) => all[a].updatedAt - all[b].updatedAt)
    for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete all[k]
  }
  await chrome.storage.local.set({ [PROGRESS]: all })
}

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
