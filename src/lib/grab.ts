import { normalizeSource, SAMPLE_EPISODE, SAMPLE_MOVIE, siteName, sourcesStore, templateFromExample, type Target } from './sources'

// What the bookmarklet sends back from the page it was clicked on.
export interface GrabPayload {
  page: string
  title: string
  frames: { src: string; w: number; h: number }[]
}

// A bookmark that collects every embedded player on the current page,
// including frames nested in same-origin frames, and hands them to lastframe.
// It works where right-click and devtools are blocked.
export function bookmarklet(appUrl: string): string {
  const code = `(function(){
function walk(doc,depth,out){[].forEach.call(doc.querySelectorAll('iframe'),function(f){
var r=f.getBoundingClientRect(),s=f.src||f.getAttribute('data-src')||f.getAttribute('data-lazy-src')||'';
if(/^https?:/.test(s))out.push({src:s,w:Math.round(r.width),h:Math.round(r.height)});
if(depth<3){try{walk(f.contentDocument,depth+1,out)}catch(e){}}});return out}
var d={page:location.href,title:document.title.slice(0,120),frames:walk(document,0,[]).slice(0,25)};
if(!d.frames.length){alert('lastframe: no embedded player on this page yet. Press play first, then click the bookmark again.');return}
window.open(${JSON.stringify(appUrl)}+'#/sources?grab='+encodeURIComponent(JSON.stringify(d)),'lastframe')})()`
  return `javascript:${encodeURIComponent(code.replace(/\n/g, ''))}`
}

export function parseGrab(raw: string): GrabPayload | null {
  try {
    const d = JSON.parse(raw)
    if (!d || !Array.isArray(d.frames)) return null
    return {
      page: String(d.page ?? ''),
      title: String(d.title ?? ''),
      frames: d.frames
        .filter((f: { src?: unknown }) => typeof f?.src === 'string')
        .map((f: { src: string; w?: number; h?: number }) => ({ src: f.src, w: Number(f.w) || 0, h: Number(f.h) || 0 })),
    }
  } catch {
    return null
  }
}

// Find the frame that's a player for one of the sample titles, turn it into a
// template, and add it to the source with that host (or a new source).
export function applyGrab(grab: GrabPayload): { ok: boolean; message: string } {
  const frames = [...grab.frames].sort((a, b) => b.w * b.h - a.w * a.h)
  const tries: ['movie' | 'episode', Target][] = [
    ['movie', SAMPLE_MOVIE],
    ['episode', SAMPLE_EPISODE],
  ]
  const found: { field: 'movie' | 'episode'; template: string; host: string }[] = []
  for (const [field, sample] of tries) {
    for (const f of frames) {
      const d = templateFromExample(f.src, sample)
      if ('template' in d) {
        found.push({ field, ...d })
        break
      }
    }
  }

  if (!found.length) {
    const where = grab.title ? `“${grab.title}”` : 'that page'
    return {
      ok: false,
      message: frames.length
        ? `Found ${frames.length} embedded frame${frames.length === 1 ? '' : 's'} on ${where}, but none is a player for The Dark Knight or Breaking Bad S3 E7. Open one of those two on the site, press play, and grab again.`
        : `No embedded player on ${where}. Press play first; if there's still none, the site plays video itself and can't be wrapped.`,
    }
  }

  const names: string[] = []
  for (const { field, template, host } of found) {
    sourcesStore.set((st) => {
      const at = st.sources.findIndex((s) => s.hosts.includes(host))
      if (at >= 0) {
        names.push(st.sources[at].name)
        return { ...st, sources: st.sources.map((s, i) => (i === at ? { ...s, [field]: template, enabled: true } : s)) }
      }
      const created = normalizeSource({ name: siteName(host), hosts: [host], [field]: template })!
      names.push(created.name)
      return { ...st, sources: [...st.sources, created] }
    })
  }

  const source = sourcesStore.get().sources.find((s) => s.hosts.includes(found[0].host))
  const name = names[0]
  if (source?.movie && source.episode) return { ok: true, message: `${name} is ready for movies and episodes.` }
  if (source?.movie)
    return { ok: true, message: `Added ${name} for movies. Open Breaking Bad S3 E7 on the same site and grab again to add episodes.` }
  return { ok: true, message: `Added ${name} for episodes. Open The Dark Knight on the same site and grab again to add movies.` }
}
