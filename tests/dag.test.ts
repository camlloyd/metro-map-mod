import { expect, test } from 'claude-code/testing'

import { DIM, metro, PALETTE, parseDot, STATION } from '../hooks/dag'
import type { Seg, Status } from '../hooks/dag'

const DOT = "digraph \"dag\" {\nrankdir=TB;\nv0 [shape=point,label=\"\",fixedsize=true,width=0.1,xlabel=\"Channel.of\"];\nv1 [label=\"NFCORE_TOY:RNASEQ:FASTQ_QC_TRIM:FASTQC\"];\nv0 -> v1 [label=\"r\"];\n\nv1 [label=\"NFCORE_TOY:RNASEQ:FASTQ_QC_TRIM:FASTQC\"];\nv2 [label=\"NFCORE_TOY:RNASEQ:FASTQ_QC_TRIM:TRIMGALORE\"];\nv1 -> v2 [label=\"s\"];\n\nv2 [label=\"NFCORE_TOY:RNASEQ:FASTQ_QC_TRIM:TRIMGALORE\"];\nv3 [label=\"NFCORE_TOY:RNASEQ:ALIGN_STAR:STAR_ALIGN\"];\nv2 -> v3 [label=\"r\"];\n\nv3 [label=\"NFCORE_TOY:RNASEQ:ALIGN_STAR:STAR_ALIGN\"];\nv4 [label=\"NFCORE_TOY:RNASEQ:ALIGN_STAR:SAMTOOLS_SORT\"];\nv3 -> v4 [label=\"s\"];\n\nv4 [label=\"NFCORE_TOY:RNASEQ:ALIGN_STAR:SAMTOOLS_SORT\"];\nv6 [shape=circle,label=\"\",fixedsize=true,width=0.1,xlabel=\"mix\"];\nv4 -> v6 [label=\"s\"];\n\nv2 [label=\"NFCORE_TOY:RNASEQ:FASTQ_QC_TRIM:TRIMGALORE\"];\nv5 [label=\"NFCORE_TOY:RNASEQ:SALMON_QUANT\"];\nv2 -> v5 [label=\"r\"];\n\nv5 [label=\"NFCORE_TOY:RNASEQ:SALMON_QUANT\"];\nv6 [shape=circle,label=\"\",fixedsize=true,width=0.1,xlabel=\"mix\"];\nv5 -> v6 [label=\"s\"];\n\nv6 [shape=circle,label=\"\",fixedsize=true,width=0.1,xlabel=\"mix\"];\nv7 [shape=circle,label=\"\",fixedsize=true,width=0.1,xlabel=\"collect\"];\nv6 -> v7;\n\nv7 [shape=circle,label=\"\",fixedsize=true,width=0.1,xlabel=\"collect\"];\nv8 [label=\"NFCORE_TOY:RNASEQ:MULTIQC\"];\nv7 -> v8;\n\n}\n"

test('folds operators away, keeping process->process edges', async () => {
  const { nodes, edges } = parseDot(DOT)
  const short = (s: string) => s.split(':').pop()
  expect(nodes.map(short)).toEqual(['FASTQC', 'TRIMGALORE', 'STAR_ALIGN', 'SAMTOOLS_SORT', 'SALMON_QUANT', 'MULTIQC'])
  expect(edges.map(([a, b]) => `${short(a)}>${short(b)}`).sort()).toEqual(
    ['FASTQC>TRIMGALORE', 'SALMON_QUANT>MULTIQC', 'SAMTOOLS_SORT>MULTIQC', 'STAR_ALIGN>SAMTOOLS_SORT', 'TRIMGALORE>SALMON_QUANT', 'TRIMGALORE>STAR_ALIGN'].sort())
})

test('draws a metro map: one track per route, branch and join links, sections', async () => {
  const { nodes, edges } = parseDot(DOT)
  const status = (n: string): Status => (n.endsWith('FASTQC') ? 'done' : n.endsWith('TRIMGALORE') ? 'running' : 'pending')
  const { rows, title, count, of } = metro(nodes, edges, status, 120)
  const text = rows.map(r => r.map(s => s.text).join('').trimEnd()).join('\n')
  expect(count).toBe(of) // it all fits
  expect(text).toContain('┳')
  expect(text).toContain('┗')
  expect(text).toContain('┛')
  expect(text).toContain('╰ FASTQ_QC_TRIM ')
  expect(text).toContain('╰ ALIGN_STAR ')
  // The pipeline's own workflow is the title, not a section.
  expect(text).not.toContain('RNASEQ')
  expect(title).toBe('RNASEQ')
})

test('lights only the route actually taken; the rest is dimmed', async () => {
  const { nodes, edges } = parseDot(DOT)
  // Salmon route ran, the STAR branch never did.
  const status = (n: string): Status => (/STAR_ALIGN|SAMTOOLS_SORT/.test(n) ? 'skipped' : 'done')
  const { rows } = metro(nodes, edges, status, 120)
  const tracks = (row: Seg[]) => row.filter(s => /[━┃┳┻┣┫┏┓┗┛╋]/.test(s.text))
  // Track rows hold stations; the first is the main line, the one with ◌ stations the STAR branch.
  const trackRows = rows.filter(r => r.some(s => /[●◌]/.test(s.text)))
  const branch = trackRows.find(r => r.some(s => s.text === STATION.skipped.text))!
  expect(tracks(trackRows[0]!).some(s => s.color === PALETTE[0])).toBe(true)
  expect(tracks(branch).length).toBeGreaterThan(0)
  expect(tracks(branch).every(s => s.color === DIM)).toBe(true)
})

test('an untaken branch leaving between two run stations does not dim the trunk', async () => {
  const nodes = ['W:A', 'W:B', 'W:C', 'W:D', 'W:E']
  const edges: [string, string][] = [['W:A', 'W:B'], ['W:B', 'W:C'], ['W:B', 'W:D'], ['W:B', 'W:E']]
  // Light whichever of C/D/E continues the first line.
  const first = metro(nodes, edges, () => 'done', 200).rows[0]!.map(s => s.text).join('')
  const next = ['C', 'D', 'E'].find(n => first.includes(n)) ?? 'C'
  const { rows } = metro(nodes, edges, n => (['W:A', 'W:B', `W:${next}`].includes(n) ? 'done' : 'pending'), 200)
  const track = rows[0]!
  const at = track.map((s, i) => (/^[●◉]$/.test(s.text) ? i : -1)).filter(i => i >= 0)
  expect(at.length).toBe(3)
  expect(track.slice(at[0]!, at.at(-1)! + 1).filter(s => s.color === DIM).map(s => s.text)).toEqual([])
})

test('a fan-out junction is lit when the taken route leaves through it, whichever branch is listed first', async () => {
  const nodes = ['W:A', 'W:B', 'W:C', 'W:D', 'W:E']
  const edges: [string, string][] = [['W:A', 'W:B'], ['W:B', 'W:C'], ['W:B', 'W:D'], ['W:B', 'W:E']]
  const colorAt = (row: Seg[], col: number) => {
    for (const s of row) { if (col < s.text.length) return s.color; col -= s.text.length }
  }
  for (const taken of ['W:D', 'W:E']) {
    const { rows } = metro(nodes, edges, n => (['W:A', 'W:B', taken].includes(n) ? 'done' : 'pending'), 200)
    const top = rows[0]!.map(s => s.text).join('')
    const b = top.lastIndexOf('●'), j = top.indexOf('┳')
    expect(j).toBeGreaterThan(b)
    for (let c = b + 1; c <= j; c++) expect(colorAt(rows[0]!, c)).not.toBe(DIM) // B -> junction
    expect(colorAt(rows[1]!, j)).not.toBe(DIM) // the drop below the junction
  }
})

test('a join never rides a track through a station it does not feed (fetchngs: downloads past sratools)', async () => {
  const W = (n: string) => `W:${n}`
  const nodes = ['A', 'F', 'ASPERA', 'FTP', 'DL', 'NCBI', 'PREFETCH', 'DUMP', 'MQC'].map(W)
  const edges = ([['A', 'F'], ['F', 'NCBI'], ['F', 'ASPERA'], ['F', 'FTP'], ['F', 'DL'], ['F', 'PREFETCH'], ['NCBI', 'PREFETCH'],
    ['NCBI', 'DUMP'], ['PREFETCH', 'DUMP'], ['DUMP', 'MQC'], ['ASPERA', 'MQC'], ['FTP', 'MQC'], ['DL', 'MQC']] as const)
    .map(([a, b]) => [W(a), W(b)] as [string, string])
  const { rows } = metro(nodes, edges, () => 'done', 200)
  const t = rows.findIndex(r => r.filter(s => s.text === '●').length >= 5) // the trunk, through the sratools route
  const text = rows[t]!.map(s => s.text).join('')
  // Joins come onto the trunk only after its last station before MQC.
  const stations = [...text].flatMap((c, i) => (c === '●' ? [i] : []))
  const mqc = stations.at(-1)!, before = stations.at(-2)!
  const firstJoin = [...text].findIndex((c, i) => i > stations[2]! && /[┳┻╋┫┣]/.test(c))
  expect(firstJoin).toBeGreaterThan(before)
  expect(firstJoin).toBeLessThan(mqc)
})

test('a shortcut edge is drawn once, through the path that already makes it (transitive reduction)', async () => {
  // X feeds B and C, but C already follows B on the main line: X -> C needs no line of its own.
  const nodes = ['W:A', 'W:B', 'W:C', 'W:X']
  const edges: [string, string][] = [['W:A', 'W:B'], ['W:B', 'W:C'], ['W:X', 'W:B'], ['W:X', 'W:C']]
  const { rows } = metro(nodes, edges, () => 'done', 200)
  const x = rows.find(r => r.filter(s => s.text === '●').length === 1)!.map(s => s.text).join('') // X's track
  expect(x.match(/[┳┻┣┫┏┓┗┛╋]/g)?.length).toBe(1) // one link, to B
})

test('a link with no clear path is left out rather than drawn through another station', async () => {
  // A -> D must ride its own track past B or D's track past Y: either way it would read as feeding one.
  const nodes = ['W:A', 'W:B', 'W:C', 'W:X', 'W:Y', 'W:D']
  const edges: [string, string][] = [['W:A', 'W:B'], ['W:B', 'W:C'], ['W:X', 'W:Y'], ['W:Y', 'W:D'], ['W:A', 'W:D']]
  const { rows } = metro(nodes, edges, () => 'done', 200)
  const text = rows.map(r => r.map(s => s.text).join(''))
  // A -> D is the only edge between the two tracks, so nothing vertical is drawn at all.
  expect(text.some(t => /[┃┳┻┣┫┏┓┗┛╋]/.test(t))).toBe(false)
  expect(text.filter(t => t.includes('●')).length).toBe(2) // both tracks still drawn
})

test('two sources fanning out through one gap get a vertical each', async () => {
  // S and Q both feed A and B (nanoseq's SAMPLESHEET_CHECK and QCAT): one shared vertical can't say who feeds whom.
  const nodes = ['W:S', 'W:Q', 'W:A', 'W:B']
  const edges: [string, string][] = [['W:S', 'W:A'], ['W:S', 'W:B'], ['W:Q', 'W:A'], ['W:Q', 'W:B']]
  const text = metro(nodes, edges, () => 'done', 200).rows.map(r => r.map(s => s.text).join(''))
  expect(text[0]).toContain('┳━┳')
  expect(text[2]).toContain('┻━┻')
})

test('a link crossing a track it does not join is bridged, not drawn as a junction', async () => {
  // A -> W runs down past X's track.
  const nodes = ['W:A', 'W:X', 'W:B', 'W:W', 'W:Y']
  const edges: [string, string][] = [['W:A', 'W:B'], ['W:A', 'W:W'], ['W:X', 'W:Y']]
  const x = metro(nodes, edges, () => 'done', 200).rows[2]!.map(s => s.text).join('')
  expect(x).toMatch(/━ ┃ ━/)
  expect(x).not.toContain('╋')
})

test('a long station name wraps onto a second label row at an underscore', async () => {
  const { rows } = metro(['W:GATK4_MARKDUPLICATES', 'W:FASTQC'], [['W:GATK4_MARKDUPLICATES', 'W:FASTQC']], () => 'done', 60)
  const text = rows.map(r => r.map(s => s.text).join(''))
  expect(text[1]).toContain('GATK4_')
  expect(text[2]).toMatch(/MARKDUPL/)
  expect(text[1]).toContain('FASTQC')
})

test('names cut to fit keep their ends, so near-twins stay apart', async () => {
  const { rows } = metro(['W:SPRING_DECOMPRESS_TO_R1_FQ', 'W:SPRING_DECOMPRESS_TO_R2_FQ'], [], () => 'done', 60)
  const text = rows.map(r => r.map(s => s.text).join('')).join('\n')
  expect(text).toMatch(/…\S*R1_FQ/)
  expect(text).toMatch(/…\S*R2_FQ/)
})

test('a taken route stays lit along a shared track past an untaken route joining it', async () => {
  // S branches to T1 (on the top track), T2 and U->V; all three join at E. Only S -> T2 -> E ran.
  const nodes = ['W:S', 'W:T1', 'W:T2', 'W:U', 'W:V', 'W:E']
  const edges: [string, string][] = [['W:S', 'W:T1'], ['W:S', 'W:T2'], ['W:S', 'W:U'], ['W:U', 'W:V'],
    ['W:T1', 'W:E'], ['W:T2', 'W:E'], ['W:V', 'W:E']]
  const { rows } = metro(nodes, edges, n => (['W:S', 'W:T2', 'W:E'].includes(n) ? 'done' : 'skipped'), 120)
  const top = rows[0]!, text = top.map(s => s.text).join('')
  const from = text.indexOf('┳', text.indexOf('◌')), to = text.lastIndexOf('●') // where T2 rejoins, to E
  let col = 0
  for (const s of top) {
    if (col + s.text.length > from && col < to) expect(s.color).not.toBe(DIM)
    col += s.text.length
  }
})

test('a map too wide for the pane shows a window that shifts and stops at the ends', async () => {
  const nodes = Array.from({ length: 12 }, (_, i) => `NF:P:STEP_${i}`)
  const edges = nodes.slice(1).map((n, i) => [nodes[i]!, n] as const)
  const first = (n: string): Status => (n === nodes[0] ? 'running' : 'pending')
  const auto = metro(nodes, edges, first, 60)
  expect(auto.count).toBeLessThan(auto.of)
  expect([auto.from, auto.follow]).toEqual([0, 0])
  expect(metro(nodes, edges, first, 60, 2).from).toBe(2)
  expect(metro(nodes, edges, first, 60, 99).from).toBe(auto.of - auto.count) // clamped at the right
  expect(metro(nodes, edges, first, 60, -5).from).toBe(0) // and the left
})
