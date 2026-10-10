import type { Dag } from '../types'

/** Reads Nextflow's `-with-dag x.dot` into process nodes and process->process edges (operators folded away). */
export function parseDot(dot: string): Pick<Dag, 'nodes' | 'edges'> {
  const label = new Map<string, string>() // vN -> process name; operators/channels have none
  const out = new Map<string, string[]>()
  for (const line of dot.split('\n')) {
    const node = line.match(/^\s*(v\d+) \[(.*)\];\s*$/)
    if (node && !/shape=/.test(node[2]!)) {
      const name = node[2]!.match(/label="([^"]*)"/)?.[1]
      if (name) label.set(node[1]!, name)
    }
    const edge = line.match(/^\s*(v\d+) -> (v\d+)/)
    if (edge) out.set(edge[1]!, [...(out.get(edge[1]!) ?? []), edge[2]!])
  }
  const nodes = [...new Set(label.values())]
  const edges: [string, string][] = []
  for (const [v, name] of label) {
    // Walk through operator nodes to the next processes.
    const seen = new Set<string>(), stack = [...(out.get(v) ?? [])], hit = new Set<string>()
    while (stack.length) {
      const w = stack.pop()!
      if (seen.has(w)) continue
      seen.add(w)
      const to = label.get(w)
      if (to) hit.add(to)
      else stack.push(...(out.get(w) ?? []))
    }
    for (const to of hit) if (to !== name) edges.push([name, to])
  }
  return { nodes, edges }
}

export type Status = 'pending' | 'running' | 'done' | 'failed' | 'skipped'
export type Seg = { text: string; color?: string; bold?: boolean; dim?: boolean }

// Transit-map line colours, one per route.
export const PALETTE = ['#e4002b', '#0098d4', '#00a651', '#f3a900', '#9b5ba5', '#ef7b10', '#00afad', '#b26300']
// Track not taken (yet): never ran, or not reached.
export const DIM = '#555555'
export const STATION: Record<Status, Seg> = {
  skipped: { text: '◌', dim: true },
  pending: { text: '○', dim: true },
  running: { text: '◉', color: '#ffd700', bold: true },
  done: { text: '●', color: '#ffffff' },
  failed: { text: '✖', color: '#ff4040', bold: true },
}
const LABEL: Record<Status, Omit<Seg, 'text'>> = {
  pending: { dim: true }, skipped: { dim: true }, running: { color: '#ffd700', bold: true }, done: {}, failed: { color: '#ff4040' },
}
// Heavy box glyph by which sides connect: up, down, left, right.
const BOX: Record<string, string> = { // horizontal-only falls back to ━
  '1100': '┃', '1000': '┃', '0100': '┃',
  '0101': '┏', '0110': '┓', '1001': '┗', '1010': '┛', '0111': '┳', '1011': '┻',
  '1101': '┣', '1110': '┫', '1111': '╋',
}
export const short = (n: string) => n.split(':').pop() ?? n

/** Every process shares the pipeline's own workflow path (NFCORE_X:X): its last part is the title, `depth` its length. */
export function pipelineOf(nodes: readonly string[]): { title: string; depth: number } {
  const paths = nodes.map(n => n.split(':').slice(0, -1))
  let depth = 0
  while (paths.length && paths.every(p => p.length > depth && p[depth] === paths[0]![depth])) depth++
  return { title: paths[0]?.slice(0, depth).at(-1) ?? '', depth }
}

/**
 * Draws the DAG as an nf-core-style metro map, left to right: each analysis route a coloured line through
 * its stations (processes) by graph depth, forks and merges as vertical links, subworkflows as bracketed sections.
 * Returns rows of styled segments sized to `width` columns, and which columns they show
 * (`count` of `of` from `from`; `follow` is where the window sits unshifted).
 */
export function metro(nodes: readonly string[], edges: readonly (readonly [string, string])[],
  statusOf: (n: string) => Status, width: number, shift = 0): { rows: Seg[][]; title: string; from: number; follow: number; count: number; of: number } {
  if (nodes.length === 0) return { rows: [], title: '', from: 0, follow: 0, count: 0, of: 0 }
  // Transitive reduction: drop a -> c when another of a's children already reaches c (a reference file handed to every
  // later step), so the map keeps every connection but draws each only once.
  const out = new Map<string, string[]>()
  for (const [a, b] of edges) out.set(a, [...(out.get(a) ?? []), b])
  const reach = (from: string, seen = new Set<string>()): Set<string> => {
    for (const k of out.get(from) ?? []) if (!seen.has(k)) { seen.add(k); reach(k, seen) }
    return seen
  }
  edges = edges.filter(([a, c]) => !(out.get(a) ?? []).some(b => b !== c && reach(b).has(c)))
  const { title, depth } = pipelineOf(nodes)
  const section = (n: string) => n.split(':').slice(depth, -1)[0] ?? ''
  const kids = new Map<string, string[]>(), parents = new Map<string, string[]>(), indeg = new Map(nodes.map(n => [n, 0]))
  for (const [a, b] of edges) {
    kids.set(a, [...(kids.get(a) ?? []), b])
    parents.set(b, [...(parents.get(b) ?? []), a])
    indeg.set(b, (indeg.get(b) ?? 0) + 1)
  }
  // Kahn's sort, ties broken by the DOT's own order. ponytail: O(n²), fine for a few hundred processes.
  const order: string[] = [], pending = [...nodes]
  while (pending.length) {
    const i = Math.max(0, pending.findIndex(n => (indeg.get(n) ?? 0) === 0))
    const n = pending.splice(i, 1)[0]!
    order.push(n)
    for (const k of kids.get(n) ?? []) indeg.set(k, (indeg.get(k) ?? 1) - 1)
  }
  const layer = new Map<string, number>()
  for (const n of order) layer.set(n, Math.max(0, ...(parents.get(n) ?? []).map(p => (layer.get(p) ?? 0) + 1)))
  const L = Math.max(...layer.values()) + 1

  // Routes: greedy path cover in topo order, each path one track.
  const lineOf = new Map<string, number>(), lines: string[][] = []
  for (const n of order) {
    if (lineOf.has(n)) continue
    const path = [n]
    lineOf.set(n, lines.length)
    for (let cur = n; ;) {
      const next = (kids.get(cur) ?? []).filter(k => !lineOf.has(k)).sort((a, b) => layer.get(a)! - layer.get(b)!)[0]
      if (!next) break
      lineOf.set(next, lines.length)
      path.push(next)
      cur = next
    }
    lines.push(path)
  }
  const R = lines.length // x: even = gap before column x/2, odd = station column
  const span = lines.map(p => [2 * layer.get(p[0]!)! + 1, 2 * layer.get(p[p.length - 1]!)! + 1] as [number, number])
  const taken = (n: string) => statusOf(n) !== 'pending' && statusOf(n) !== 'skipped'
  const links: { a: string; b: string; x: number; r1: number; r2: number; color: string; isLit: boolean; ra: number; rb: number }[] = []
  for (const [a, b] of edges) {
    const ra = lineOf.get(a)!, rb = lineOf.get(b)!
    if (ra === rb) continue
    const isBranch = lines[rb]![0] === b, isJoin = lines[ra]!.at(-1) === a
    // The link rides a's track to x, then b's: pick an x where neither ride passes a station it does not connect,
    // so it never reads as feeding one. With no such x (both tracks busy all the way) the link isn't drawn: a missing
    // line is a gap in the map, a misplaced one is a wrong edge.
    const xa = 2 * layer.get(a)! + 1, xb = 2 * layer.get(b)! + 1, clear = (r: number, lo: number, hi: number) =>
      !lines[r]!.some(n => lo < 2 * layer.get(n)! + 1 && 2 * layer.get(n)! + 1 < hi)
    const fits = (x: number) => clear(ra, xa, x) && clear(rb, x, xb)
    const preferred = isJoin && !isBranch ? xa + 1 : xb - 1
    const gaps = Array.from({ length: (xb - xa) / 2 }, (_, i) => xa + 1 + 2 * i)
    const x = [preferred, ...gaps].find(fits)
    if (x === undefined) continue
    links.push({ a, b, x, r1: Math.min(ra, rb), r2: Math.max(ra, rb), ra, rb, isLit: taken(a) && taken(b),
      color: PALETTE[(isBranch || !isJoin ? rb : ra) % PALETTE.length]! })
    for (const r of [ra, rb]) span[r] = [Math.min(span[r]![0], x), Math.max(span[r]![1], x)]
  }

  // Channels: links with no end in common that would overlap in a gap get side-by-side verticals, so each vertical
  // carries one source's fan-out or one target's fan-in, never two unrelated links.
  type Link = (typeof links)[number]
  const chan = new Map<Link, number>(), chans = new Map<number, number>() // link -> channel, gap x -> channel count
  for (const l of links) {
    const clash = links.filter(q => chan.has(q) && q.x === l.x && q.r1 <= l.r2 && l.r1 <= q.r2 && q.a !== l.a && q.b !== l.b)
    let c = 0
    while (clash.some(q => chan.get(q) === c)) c++
    chan.set(l, c)
    chans.set(l.x, Math.max(chans.get(l.x) ?? 1, c + 1))
  }
  const at = (l: Link) => 1 + 2 * chan.get(l)! // a channel's column within its gap

  // Lit stretches per track: where each edge that ran is drawn. A link runs along its source's track to its x,
  // then along its target's track.
  const litSpans: [number, number][][] = lines.map(() => [])
  for (const [a, b] of edges) {
    if (!taken(a) || !taken(b)) continue
    const ra = lineOf.get(a)!, rb = lineOf.get(b)!, xa = 2 * layer.get(a)! + 1, xb = 2 * layer.get(b)! + 1
    const l = links.find(k => k.a === a && k.b === b)
    if (!l) { litSpans[ra]!.push([xa, xb]); continue }
    litSpans[ra]!.push([Math.min(xa, l.x), Math.max(xa, l.x)])
    litSpans[rb]!.push([Math.min(l.x, xb), Math.max(l.x, xb)])
  }
  const isLit = (r: number, x: number, side: 'left' | 'right') =>
    litSpans[r]!.some(([lo, hi]) => (side === 'left' ? lo < x && x <= hi : lo <= x && x < hi))

  // Fit: shrink station columns, then window around the first column still running or pending, moved `shift` columns.
  const cellW = (x: number) => (x % 2 === 0 ? 2 * (chans.get(x) ?? 1) + 1 : W)
  let gaps = 0
  for (let x = 0; x <= 2 * L; x += 2) gaps += cellW(x)
  const W = Math.max(10, Math.min(14, Math.floor((width - gaps) / L)))
  // Columns c..c+n-1 with the gaps either side, at their real widths.
  const widthOf = (c: number, n: number) => {
    let w = cellW(2 * c)
    for (let i = c; i < c + n; i++) w += W + cellW(2 * i + 2)
    return w
  }
  // Start from a window that fits even if every gap were the widest, then widen it while its real gaps still fit.
  const G = 2 * Math.max(1, ...chans.values()) + 1
  let k = Math.max(1, Math.min(L, Math.floor((width - G) / (W + G))))
  const active = order.find(n => statusOf(n) !== 'done')
  const window = (at: number) => Math.max(0, Math.min(L - k, at))
  const follow = window((active ? layer.get(active)! : L) - 1)
  let c0 = window(follow + shift)
  while (c0 + k < L && widthOf(c0, k + 1) <= width) k++
  while (c0 > 0 && widthOf(c0 - 1, k + 1) <= width) { c0--; k++ } // at the right end, widen leftwards
  const x0 = 2 * c0, x1 = 2 * (c0 + k)
  const station = new Map<string, string>() // "r,x" -> node
  for (const [n, l] of layer) station.set(`${lineOf.get(n)},${2 * l + 1}`, n)

  const rows: Seg[][] = []
  const push = (row: Seg[], seg: Seg) => {
    const last = row.at(-1)
    if (last && last.color === seg.color && last.bold === seg.bold && last.dim === seg.dim) last.text += seg.text
    else row.push({ ...seg })
  }
  // Too long for one row: break after the last `_` that fits (GATK4_ / MARKDUPLICATES).
  const wrap = (name: string, w: number): [string, string] => {
    if (name.length <= w) return [name, '']
    const cut = name.lastIndexOf('_', w - 1)
    return cut > 0 ? [name.slice(0, cut + 1), name.slice(cut + 1)] : [name.slice(0, w), name.slice(w)]
  }
  const centred = (text: string, w: number) => {
    // Cut in the middle: the end often tells names apart (…_R1_FQ / …_R2_FQ).
    const head = Math.ceil((w - 1) / 2)
    const t = text.length > w ? text.slice(0, head) + '…' + text.slice(text.length - (w - 1 - head)) : text
    const left = Math.floor((w - t.length) / 2)
    return ' '.repeat(left) + t + ' '.repeat(w - t.length - left)
  }

  // The links in a gap's channel (column i of the cell) that span track r, lit one first.
  const inChannel = (x: number, i: number, r: number, below = false) =>
    links.filter(l => l.x === x && at(l) === i && l.r1 <= r && (below ? r < l.r2 : r <= l.r2)).sort((p, q) => +q.isLit - +p.isLit)

  // A label or bracket cell: blank, or the links passing down through it.
  const under = (row: Seg[], r: number, x: number) => {
    if (x % 2) return push(row, { text: ' '.repeat(cellW(x)) })
    for (let i = 0; i < cellW(x); i++) {
      const l = inChannel(x, i, r, true)[0]
      push(row, l ? { text: '┃', color: l.isLit ? l.color : DIM } : { text: ' ' })
    }
  }

  for (let r = 0; r < R; r++) {
    const color = PALETTE[r % PALETTE.length]!
    const track: Seg[] = [], label: Seg[] = [], label2: Seg[] = []
    for (let x = x0; x <= x1; x++) {
      const w = cellW(x), mid = Math.floor(w / 2)
      const [lo, hi] = span[r]!
      const left = x > lo && x <= hi, right = x >= lo && x < hi
      const node = station.get(`${r},${x}`)
      if (x % 2 === 0) {
        // A gap: the track where it runs, a junction for each channel that joins it, and a bridge where a channel only
        // crosses: the track stops a column short either side, so the crossing never reads as a connection.
        const joins = links.filter(l => l.x === x && (l.ra === r || l.rb === r)).map(at)
        const from = left ? 0 : Math.min(...joins), to = right ? w - 1 : Math.max(...joins)
        const litL = isLit(r, x, 'left'), litR = isLit(r, x, 'right')
        const jlo = joins.length ? Math.min(...joins) : mid, jhi = joins.length ? Math.max(...joins) : mid
        const cell: Seg[] = [], bridges = new Set<number>()
        for (let i = 0; i < w; i++) {
          const ls = inChannel(x, i, r), on = from <= i && i <= to
          const trackLit = i < jlo ? litL : i > jhi ? litR : litL || litR
          if (ls.some(l => l.ra === r || l.rb === r)) {
            const u = ls.some(l => l.r1 < r), d = ls.some(l => l.r2 > r)
            cell.push({ text: BOX[`${+u}${+d}${+(i > from && on)}${+(i < to && on)}`] ?? '━',
              color: ls[0]!.isLit ? ls[0]!.color : trackLit ? color : u || d ? DIM : color })
          } else if (ls.length) {
            cell.push({ text: '┃', color: ls[0]!.isLit ? ls[0]!.color : DIM })
            if (on) bridges.add(i)
          }
          else cell.push(on ? { text: '━', color: trackLit ? color : DIM } : { text: ' ' })
        }
        cell.forEach((c, i) => push(track, c.text === '━' && (bridges.has(i - 1) || bridges.has(i + 1)) ? { text: ' ' } : c))
        for (const row of [label, label2]) under(row, r, x)
        continue
      }
      const fill = (on: boolean, side: 'left' | 'right', n: number): Seg =>
        on ? { text: '━'.repeat(n), color: isLit(r, x, side) ? color : DIM } : { text: ' '.repeat(n) }
      push(track, fill(left, 'left', mid))
      // A station column: the station, or the track running through.
      push(track, node ? STATION[statusOf(node)] : left || right
        ? { text: '━', color: isLit(r, x, 'left') || isLit(r, x, 'right') ? color : DIM } : { text: ' ' })
      push(track, fill(right, 'right', w - mid - 1))
      // Label rows: station names, and links passing down to the next track.
      if (node) {
        const [a, b] = wrap(short(node), w)
        push(label, { text: centred(a, w), ...LABEL[statusOf(node)] })
        push(label2, { text: centred(b, w), ...LABEL[statusOf(node)] })
      } else for (const row of [label, label2]) under(row, r, x)
    }
    rows.push(track, label)
    if (lines[r]!.some(n => { const x = 2 * layer.get(n)! + 1; return x >= x0 && x <= x1 && short(n).length > W })) rows.push(label2)

    // Section brackets: runs of this line's stations inside one subworkflow, under their labels.
    const runs: { from: number; to: number; name: string }[] = []
    for (const n of lines[r]!) {
      const x = 2 * layer.get(n)! + 1, name = section(n), last = runs.at(-1)
      if (name && last?.name === name) last.to = x
      else if (name) runs.push({ from: x, to: x, name })
    }
    if (runs.length === 0) continue
    const bracket: Seg[] = []
    for (let x = x0; x <= x1; x++) {
      const run = runs.find(u => u.from <= x && x <= u.to)
      if (run) {
        let total = 0
        for (let y = Math.max(run.from, x0); y <= Math.min(run.to, x1); y++) total += cellW(y)
        if (x === Math.max(run.from, x0)) {
          const name = ` ${run.name} `.slice(0, Math.max(0, total - 3))
          push(bracket, { text: total < 3 ? ' '.repeat(total) : '╰' + name + '─'.repeat(total - 2 - name.length) + '╯', dim: true })
        }
        continue
      }
      under(bracket, r, x)
    }
    rows.push(bracket)
  }
  return { rows, title, from: c0, follow, count: k, of: L }
}
