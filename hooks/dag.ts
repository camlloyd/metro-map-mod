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
 * Returns rows of styled segments sized to `width` columns.
 */
export function metro(nodes: readonly string[], edges: readonly (readonly [string, string])[],
  statusOf: (n: string) => Status, width: number): { rows: Seg[][]; note: string; title: string } {
  if (nodes.length === 0) return { rows: [], note: 'empty DAG', title: '' }
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
    const x = isJoin && !isBranch ? 2 * layer.get(a)! + 2 : 2 * layer.get(b)!
    links.push({ a, b, x, r1: Math.min(ra, rb), r2: Math.max(ra, rb), ra, rb, isLit: taken(a) && taken(b),
      color: PALETTE[(isBranch || !isJoin ? rb : ra) % PALETTE.length]! })
    for (const r of [ra, rb]) span[r] = [Math.min(span[r]![0], x), Math.max(span[r]![1], x)]
  }

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

  // Fit: shrink station columns, then window around the first column still running or pending.
  const fitW = (cols: number) => Math.floor((width - 3 * (cols + 1)) / cols)
  const W = Math.max(10, Math.min(14, fitW(L)))
  const k = Math.max(1, Math.min(L, Math.floor((width - 3) / (W + 3))))
  const active = order.find(n => statusOf(n) !== 'done')
  const c0 = Math.max(0, Math.min(L - k, (active ? layer.get(active)! : L) - 1))
  const x0 = 2 * c0, x1 = 2 * (c0 + k)
  const cellW = (x: number) => (x % 2 === 0 ? 3 : W)
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

  // The link passing down from track r at x, preferring a lit one.
  const linkBelow = (r: number, x: number) => {
    const here = links.filter(l => l.x === x && l.r1 <= r && r < l.r2)
    return here.find(l => l.isLit) ?? here[0]
  }

  // A label or bracket cell: blank, or the link passing down through it.
  const under = (row: Seg[], r: number, x: number) => {
    const w = cellW(x), mid = Math.floor(w / 2), below = linkBelow(r, x)
    if (!below) return push(row, { text: ' '.repeat(w) })
    push(row, { text: ' '.repeat(mid) })
    push(row, { text: '┃', color: below.isLit ? below.color : DIM })
    push(row, { text: ' '.repeat(w - mid - 1) })
  }

  for (let r = 0; r < R; r++) {
    const color = PALETTE[r % PALETTE.length]!
    const track: Seg[] = [], label: Seg[] = [], label2: Seg[] = []
    for (let x = x0; x <= x1; x++) {
      const w = cellW(x), mid = Math.floor(w / 2)
      const [lo, hi] = span[r]!
      const left = x > lo && x <= hi, right = x >= lo && x < hi
      const vs = links.filter(l => l.x === x && l.r1 <= r && r <= l.r2)
      const up = vs.some(l => l.r1 < r), down = vs.some(l => l.r2 > r)
      const node = station.get(`${r},${x}`)
      const fill = (on: boolean, side: 'left' | 'right', n: number): Seg =>
        on ? { text: '━'.repeat(n), color: isLit(r, x, side) ? color : DIM } : { text: ' '.repeat(n) }
      push(track, fill(left, 'left', mid))
      if (node) push(track, STATION[statusOf(node)])
      else {
        const key = `${+up}${+down}${+left}${+right}`
        const g = BOX[key] ?? (left || right ? '━' : ' ')
        const lit = vs.find(l => l.isLit)
        const litL = isLit(r, x, 'left'), litR = isLit(r, x, 'right')
        push(track, { text: g, color: lit ? lit.color : litL && litR ? color : up || down || !(litL || litR) ? DIM : color })
      }
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
  const note = k < L ? `columns ${c0 + 1}–${c0 + k} of ${L}` : ''
  return { rows, note, title }
}
