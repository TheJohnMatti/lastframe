// @ts-check
// Runs only on lastframe's own page (localhost:5178). It passes the page's
// requests to the background and hands recorded progress to the page.
;(() => {
  // @ts-ignore
  window.__lastframeBridgeStop?.()

  const ORIGIN = location.origin
  const PROGRESS = 'lf.progress'
  let stopped = false

  /** @param {Record<string, unknown>} msg */
  const toPage = (msg) => window.postMessage({ __lastframe: 'ext', ...msg }, ORIGIN)

  function alive() {
    try {
      return !stopped && !!chrome.runtime?.id
    } catch {
      return false
    }
  }

  async function snapshot() {
    if (!alive()) return stop()
    const data = (await chrome.storage.local.get(PROGRESS))[PROGRESS] || {}
    toPage({ type: 'progress', payload: data })
  }

  function hello() {
    toPage({ type: 'hello', payload: { version: chrome.runtime.getManifest().version } })
    snapshot()
  }

  /** @param {MessageEvent} e */
  function onMessage(e) {
    if (e.source !== window || e.origin !== ORIGIN) return
    const m = e.data
    if (!m || m.__lastframe !== 'app') return
    if (!alive()) return stop()
    if (m.type === 'ping') return hello()
    if (m.type === 'launch') {
      chrome.runtime.sendMessage({ type: 'launch', payload: m.payload }, (res) => {
        const error = chrome.runtime.lastError?.message
        toPage({ type: 'reply', id: m.id, payload: error ? { error } : res })
      })
    }
  }

  /** @param {Record<string, chrome.storage.StorageChange>} changes @param {string} area */
  function onChanged(changes, area) {
    if (!alive()) return stop()
    if (area === 'local' && changes[PROGRESS]) toPage({ type: 'progress', payload: changes[PROGRESS].newValue || {} })
  }

  window.addEventListener('message', onMessage)
  chrome.storage.onChanged.addListener(onChanged)
  hello()

  function stop() {
    if (stopped) return
    stopped = true
    window.removeEventListener('message', onMessage)
    try {
      chrome.storage.onChanged.removeListener(onChanged)
    } catch {
      // extension context already gone
    }
  }
  // @ts-ignore
  window.__lastframeBridgeStop = stop
})()
