// @ts-check
// Runs in every frame of every page. It stays passive until a long <video>
// plays, then asks the background whether this tab is one lastframe launched.
// Only then does it report the position, and resume where you left off.
;(() => {
  // A previous copy (from before an extension reload) steps aside.
  // @ts-ignore
  window.__lastframeStop?.()

  const MIN_DURATION = 240 // seconds; shorter videos are previews and ads
  const REPORT_EVERY = 10_000
  const RECHECK_UNTRACKED = 30_000

  /** @type {HTMLVideoElement | null} */
  let main = null
  /** @type {boolean | null} */
  let tracked = null
  let checkedAt = 0
  let lastSent = 0
  let playedFor = 0
  /** @type {number | null} */
  let lastTime = null
  /** @type {'idle' | 'waiting' | 'done'} */
  let resume = 'idle'
  let resumeAt = 0
  let expected = 0
  let seekTries = 0
  let seekAt = 0
  let stopped = false
  const watched = new WeakSet()

  const alive = () => {
    try {
      return !stopped && !!chrome.runtime?.id
    } catch {
      return false
    }
  }

  /** @param {HTMLVideoElement} v */
  const qualifies = (v) => Number.isFinite(v.duration) && v.duration >= MIN_DURATION

  /** @param {Event} e */
  function onMedia(e) {
    if (!alive()) return stop()
    const v = e.target
    if (!(v instanceof HTMLVideoElement) || !qualifies(v)) return
    // follow the long video that's actually playing; prefer the longer one if two are
    if (v !== main && !v.paused && (!main || main.paused || v.duration > main.duration)) {
      main = v
      playedFor = 0
      lastTime = null
    }
    if (v !== main) return

    if (!v.paused && !v.seeking && lastTime != null) {
      const step = v.currentTime - lastTime
      if (step > 0 && step < 5) playedFor += step
    }
    lastTime = v.currentTime
    tryResume()

    const now = Date.now()
    const important = e.type === 'pause' || e.type === 'ended' || e.type === 'seeked'
    if (tracked === false && now - checkedAt < RECHECK_UNTRACKED && e.type !== 'playing') return
    if (important || tracked == null || now - lastSent >= REPORT_EVERY) send()
  }

  function send() {
    const v = main
    if (!v || !alive()) return
    lastSent = Date.now()
    checkedAt = lastSent
    // never write a position before real playback, or while a resume is pending
    const report = playedFor >= 3 && resume !== 'waiting'
    const state = { position: v.currentTime, duration: v.duration, paused: v.paused, ended: v.ended, report }
    try {
      chrome.runtime.sendMessage({ type: 'playback', state }, (res) => {
        if (chrome.runtime.lastError || !res) return
        tracked = !!res.tracked
        if (tracked && res.resumeAt > 0 && resume === 'idle') {
          resume = 'waiting'
          resumeAt = res.resumeAt
          expected = res.expected || 0
          tryResume()
        }
      })
    } catch {
      stop()
    }
  }

  // Seek to the saved spot once the real video (not an ad) is playing, check
  // it held, retry twice, then offer a button instead of fighting the player.
  function tryResume() {
    const v = main
    if (resume !== 'waiting' || !v || v.seeking || v.paused) return
    if (expected && v.duration < expected * 0.4) return // still an ad
    if (resumeAt >= v.duration - 60) return finishResume(true) // nothing left to resume into
    if (Math.abs(v.currentTime - resumeAt) < 5) return finishResume(true)
    if (Date.now() - seekAt < 2500) return
    if (seekTries >= 3) return finishResume(false)
    seekTries++
    seekAt = Date.now()
    v.currentTime = resumeAt
  }

  /** @param {boolean} ok */
  function finishResume(ok) {
    resume = 'done'
    try {
      chrome.runtime.sendMessage({ type: 'resumed', ok })
    } catch {
      // extension went away
    }
    if (ok) toast(`lastframe: resumed at ${clock(resumeAt)}`)
    else toast(`lastframe: you stopped at ${clock(resumeAt)}`, 'Jump there', () => main && (main.currentTime = resumeAt))
  }

  /** @param {number} s */
  function clock(s) {
    const t = Math.max(0, Math.floor(s))
    const h = Math.floor(t / 3600)
    const m = Math.floor((t % 3600) / 60)
    const sec = String(t % 60).padStart(2, '0')
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
  }

  /**
   * @param {string} text
   * @param {string} [action]
   * @param {() => void} [onAction]
   */
  function toast(text, action, onAction) {
    const host = document.createElement('div')
    const root = host.attachShadow({ mode: 'closed' })
    const box = document.createElement('div')
    box.setAttribute(
      'style',
      'position:fixed;left:16px;bottom:16px;z-index:2147483647;display:flex;gap:10px;align-items:center;' +
        'background:rgba(15,16,20,.92);color:#eceef3;font:14px system-ui,sans-serif;padding:10px 14px;border-radius:10px;' +
        'border:1px solid rgba(242,181,68,.5);box-shadow:0 6px 24px rgba(0,0,0,.5)',
    )
    box.textContent = text
    if (action && onAction) {
      const b = document.createElement('button')
      b.textContent = action
      b.setAttribute('style', 'background:#f2b544;color:#1b1405;border:0;border-radius:6px;padding:5px 10px;font:600 13px system-ui;cursor:pointer')
      b.onclick = () => {
        onAction()
        host.remove()
      }
      box.append(b)
    }
    root.append(box)
    ;(document.fullscreenElement || document.documentElement).append(host)
    setTimeout(() => host.remove(), action ? 12_000 : 4_000)
  }

  // Media events don't bubble, but a capturing listener on the document sees
  // every video in the light DOM. Videos inside shadow roots get their own.
  const EVENTS = ['playing', 'timeupdate', 'pause', 'ended', 'seeked', 'durationchange']
  for (const type of EVENTS) document.addEventListener(type, onMedia, true)

  /** @param {Document | ShadowRoot} root */
  function scanShadows(root) {
    for (const el of root.querySelectorAll('*')) {
      // only custom elements can host a closed shadow root worth asking chrome.dom about
      // @ts-ignore chrome.dom reaches closed shadow roots too
      const shadow = el.shadowRoot || (el.localName.includes('-') ? chrome.dom?.openOrClosedShadowRoot?.(el) : null)
      if (!shadow) continue
      for (const v of shadow.querySelectorAll('video')) {
        if (watched.has(v)) continue
        watched.add(v)
        for (const type of EVENTS) v.addEventListener(type, onMedia)
      }
      scanShadows(shadow)
    }
  }

  // Light-DOM videos need no scanning at all; this only looks into shadow
  // roots, at most every few seconds, and stops once a main video is known.
  let scanTimer = 0
  const observer = new MutationObserver(() => {
    if (scanTimer || main) return
    scanTimer = setTimeout(() => {
      scanTimer = 0
      if (alive() && !main) scanShadows(document)
    }, 3000)
  })
  observer.observe(document, { childList: true, subtree: true })

  const flush = () => main && tracked && send()
  window.addEventListener('pagehide', flush)

  function stop() {
    if (stopped) return
    stopped = true
    for (const type of EVENTS) document.removeEventListener(type, onMedia, true)
    observer.disconnect()
    window.removeEventListener('pagehide', flush)
  }
  // @ts-ignore
  window.__lastframeStop = stop
})()
