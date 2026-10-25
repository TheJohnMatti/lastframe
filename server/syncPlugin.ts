// Lets your phone use lastframe and share history with your Mac. lastframe's
// own dev/preview server keeps one merged copy of the library in
// .lastframe/state.json (gitignored); each device posts its copy and gets the
// merge back. The Mac itself (loopback) needs no key; other devices on your
// network need the pairing key from Settings, shown there as a QR code.
import type { Plugin, PreviewServer, ViteDevServer } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join, resolve } from 'node:path'
import { emptyState, mergeState, type SyncState } from '../src/lib/merge.ts'

// LASTFRAME_DATA points a second server (tests) at its own folder
const DIR = resolve(process.env.LASTFRAME_DATA || '.lastframe')
const STATE = join(DIR, 'state.json')
const PAIR = join(DIR, 'pair.json')
const MAX_BODY = 20 * 1024 * 1024

function pairingKey(): string {
  mkdirSync(DIR, { recursive: true })
  try {
    const saved = JSON.parse(readFileSync(PAIR, 'utf8'))
    if (typeof saved.key === 'string' && saved.key.length >= 20) return saved.key
  } catch {
    // first run
  }
  const key = randomBytes(18).toString('base64url')
  writeFileSync(PAIR, JSON.stringify({ key }), { mode: 0o600 })
  return key
}

function loadState(): SyncState {
  try {
    return existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : emptyState()
  } catch {
    return emptyState()
  }
}

function saveState(state: SyncState) {
  mkdirSync(DIR, { recursive: true })
  const tmp = `${STATE}.tmp`
  writeFileSync(tmp, JSON.stringify(state))
  renameSync(tmp, STATE)
}

const isLoopback = (addr?: string) => !!addr && (addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1')

function sameKey(given: unknown, key: string) {
  if (typeof given !== 'string') return false
  const a = Buffer.from(given)
  const b = Buffer.from(key)
  return a.length === b.length && timingSafeEqual(a, b)
}

function lanAddresses(): string[] {
  const out: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const n of list ?? []) if (n.family === 'IPv4' && !n.internal) out.push(n.address)
  }
  return out
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((ok, fail) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        fail(new Error('too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')))
    req.on('error', fail)
  })
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

export function syncPlugin(): Plugin {
  const key = pairingKey()

  const middleware = (server: ViteDevServer | PreviewServer) => async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const path = (req.url ?? '').split('?')[0]
    if (!path.startsWith('/api/')) return next()
    const local = isLoopback(req.socket.remoteAddress)
    try {
      if (path === '/api/pair' && req.method === 'GET') {
        // only the Mac itself may see the key
        if (!local) return send(res, 403, { error: 'only from this computer' })
        const addr = server.httpServer?.address() as AddressInfo | string | null
        const onLan = !!addr && typeof addr === 'object' && (addr.address === '::' || addr.address === '0.0.0.0')
        const port = addr && typeof addr === 'object' ? addr.port : 5178
        const urls = lanAddresses().map((ip) => `http://${ip}:${port}/#/pair?key=${key}`)
        return send(res, 200, { lan: onLan, urls })
      }
      if (path === '/api/sync' && req.method === 'POST') {
        if (!local && !sameKey(req.headers['x-lastframe-key'], key)) return send(res, 401, { error: 'not paired' })
        const incoming = JSON.parse(await readBody(req)) as SyncState
        if (process.env.LASTFRAME_SYNC_LOG) {
          const titles = Object.values(incoming.library ?? {}).map((i) => (i as { name?: string }).name).join(', ')
          const sources = (incoming.sources?.list ?? []).map((s) => (s as { name?: string }).name).join(', ')
          console.log(`[sync] ${req.socket.remoteAddress} ${String(req.headers['user-agent']).slice(0, 90)} | titles: ${titles} | sources (${incoming.sources?.updatedAt}): ${sources}`)
        }
        const merged = mergeState(loadState(), incoming)
        saveState(merged)
        return send(res, 200, merged)
      }
      return send(res, 404, { error: 'not found' })
    } catch (e) {
      return send(res, 400, { error: (e as Error).message })
    }
  }

  return {
    name: 'lastframe-sync',
    configureServer(server) {
      server.middlewares.use(middleware(server))
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware(server))
    },
  }
}
