import { useState, type ReactNode } from 'react'
import { href } from '../lib/router'
import { posterFor } from '../lib/meta'

export function ProgressBar({ value, className = '' }: { value: number; className?: string }) {
  if (!(value > 0)) return null
  return (
    <div className={`progress ${className}`}>
      <div style={{ width: `${Math.min(100, value * 100)}%` }} />
    </div>
  )
}

export function Poster({ id, src, name }: { id: string; src?: string; name: string }) {
  const [attempt, setAttempt] = useState(0)
  const urls = [src, posterFor(id)].filter((u, i, all): u is string => !!u && all.indexOf(u) === i)
  if (attempt >= urls.length) return <div className="poster-fallback">{name}</div>
  return <img src={urls[attempt]} alt="" loading="lazy" onError={() => setAttempt((a) => a + 1)} />
}

export interface CardProps {
  id: string
  name: string
  poster?: string
  to: string
  subtitle?: ReactNode
  progress?: number
  badge?: ReactNode
  onRemove?: () => void
}

export function Card({ id, name, poster, to, subtitle, progress = 0, badge, onRemove }: CardProps) {
  return (
    <div className="card">
      <a href={href(to)} className="card-link" title={name}>
        <div className="poster">
          <Poster id={id} src={poster} name={name} />
          {badge && <span className="badge">{badge}</span>}
          <ProgressBar value={progress} className="on-poster" />
        </div>
        <div className="card-title">{name}</div>
        {subtitle && <div className="card-sub">{subtitle}</div>}
      </a>
      {onRemove && (
        <button className="card-remove" title="Remove from this row" onClick={onRemove}>
          ×
        </button>
      )}
    </div>
  )
}

export function Row({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="row">
      <div className="row-head">
        <h2>{title}</h2>
        {action}
      </div>
      <div className="row-scroll">{children}</div>
    </section>
  )
}

export function Grid({ children }: { children: ReactNode }) {
  return <div className="grid">{children}</div>
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="spinner-wrap" role="status">
      <div className="spinner" />
      <span>{label}…</span>
    </div>
  )
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children}
    </div>
  )
}

export function StatusDot({ status }: { status: 'up' | 'down' | 'unknown' | 'checking' }) {
  const label = { up: 'reachable', down: 'not reachable', unknown: 'not checked yet', checking: 'checking' }[status]
  return <span className={`dot dot-${status}`} title={label} aria-label={label} />
}
