import { expect, test } from 'claude-code/testing'

import { DIM, metro } from '../hooks/dag'
import type { Seg, Status } from '../hooks/dag'
import { applyCached, applyEvent, previewArgv, withWeblog } from '../hooks/weblog'
import type { WeblogEvent } from '../hooks/weblog'
import type { Run } from '../types'

// Property tests without a library: a seeded PRNG, many cases, the seed in every failure message to replay one.
const RUNS = 300
function rng(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1))
  const pick = <T,>(xs: readonly T[]) => xs[int(0, xs.length - 1)]!
  const shuffle = <T,>(xs: T[]) => {
    for (let i = xs.length - 1; i > 0; i--) {
      const j = int(0, i)
      ;[xs[i], xs[j]] = [xs[j]!, xs[i]!]
    }
    return xs
  }
  return { next, int, pick, shuffle }
}
function forAll(name: string, body: (r: ReturnType<typeof rng>, seed: number) => void) {
  for (let seed = 1; seed <= RUNS; seed++) {
    try {
      body(rng(seed), seed)
    } catch (err) {
      throw new Error(`${name}: failed at seed ${seed}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

// A random DAG shaped like a pipeline: names WF:PIPE[:SUB]:PROC, edges only forward (i < j) so it is acyclic.
function randomDag(r: ReturnType<typeof rng>) {
  const n = r.int(1, 18)
  const subs = ['', '', 'QC', 'ALIGN', 'QUANT_SALMON_PSEUDO_LONG_NAME']
  const nodes = Array.from({ length: n }, (_, i) => {
    const sub = r.pick(subs)
    return `NFCORE_X:X:${sub ? sub + ':' : ''}P${i}_${'A'.repeat(r.int(0, 20))}`
  })
  const edges: [string, string][] = []
  for (let j = 1; j < n; j++) {
    const fanIn = r.int(0, 3)
    for (let k = 0; k < fanIn; k++) edges.push([nodes[r.int(0, j - 1)]!, nodes[j]!])
  }
  return { nodes, edges }
}
const text = (row: Seg[]) => row.map(s => s.text).join('')
const STATUSES: Status[] = ['pending', 'running', 'done', 'failed', 'skipped']

test('metro: any DAG draws, every process once, no row wider than the pane', async () => {
  forAll('metro', r => {
    const { nodes, edges } = randomDag(r)
    const width = r.int(60, 220)
    const status = new Map(nodes.map(n => [n, r.pick(STATUSES)]))
    const { rows, note } = metro(nodes, edges, n => status.get(n)!, width)
    for (const row of rows) expect(text(row).length).toBeLessThanOrEqual(width)
    if (note.startsWith('columns')) return // windowed: only some columns show
    const glyphs = rows.flatMap(row => row.filter(s => /^[○◉●✖◌]$/.test(s.text)))
    expect(glyphs.length).toBe(nodes.length)
  })
})

test('metro: all done lights everything; nothing run lights nothing', async () => {
  const isTrack = (s: Seg) => /[━┃┳┻┣┫┏┓┗┛╋]/.test(s.text)
  forAll('lighting', r => {
    const { nodes, edges } = randomDag(r)
    const done = metro(nodes, edges, () => 'done', 400).rows.flat().filter(isTrack)
    expect(done.filter(s => s.color === DIM).map(s => s.text)).toEqual([])
    const idle = new Map(nodes.map(n => [n, r.pick(['pending', 'skipped'] as const)]))
    const none = metro(nodes, edges, n => idle.get(n)!, 400).rows.flat().filter(isTrack)
    expect(none.filter(s => s.color !== DIM).map(s => s.text)).toEqual([])
  })
})

test('events: counts do not depend on arrival order, never go negative, ignore other runs', async () => {
  forAll('events', r => {
    const procs = ['A:B:P1', 'A:B:S:P2', 'A:B:P3']
    const tasks: WeblogEvent[] = []
    const want = new Map(procs.map(p => [p, { submitted: 0, completed: 0, failed: 0 }]))
    for (let i = r.int(0, 25); i > 0; i--) {
      const process = r.pick(procs), w = want.get(process)!
      tasks.push({ event: 'process_submitted', runId: 'r', trace: { process, status: 'SUBMITTED' } })
      w.submitted++
      const end = r.pick(['COMPLETED', 'FAILED', 'ABORTED', null])
      if (end) {
        tasks.push({ event: 'process_completed', runId: 'r', trace: { process, status: end } })
        end === 'COMPLETED' ? w.completed++ : w.failed++
      }
      if (r.next() < 0.3) tasks.push({ event: 'process_submitted', runId: 'other', trace: { process, status: 'SUBMITTED' } })
    }
    const start: WeblogEvent = { event: 'started', runId: 'r', metadata: { workflow: { commandLine: 'nextflow run x', launchDir: '/w' } } }
    let run = applyEvent(null, start)
    for (const e of r.shuffle([...tasks])) {
      run = applyEvent(run, e)
      for (const p of run!.procs) for (const k of ['submitted', 'completed', 'failed'] as const) expect(p[k]).toBeGreaterThanOrEqual(0)
    }
    for (const p of run!.procs) expect({ submitted: p.submitted, completed: p.completed, failed: p.failed }).toEqual(want.get(p.name))
    expect(applyCached(applyCached(run!, 'Cached process > A:B:P1 (x)\n'), 'Cached process > A:B:P1 (x)\n'))
      .toEqual(applyCached(run!, 'Cached process > A:B:P1 (x)\n'))
  })
})

test('commands: one weblog hook added, removable, idempotent; preview never inherits run-only flags', async () => {
  const url = 'http://127.0.0.1:5/events'
  const cfg = '/tmp/x/metro-map-weblog.config'
  const words = ['main.nf', 'nf-core/fetchngs', '-r', '1.12.0', '-profile', 'test,docker', '--outdir', 'results',
    '-resume', '-bg', '-c', 'my.config', '-params-file', 'p.yml', "'quoted arg'", '--input', 's.csv']
  forAll('commands', r => {
    const args = Array.from({ length: r.int(0, 8) }, () => r.pick(words)).join(' ')
    const globals = r.pick(['', ' -log run.log', ' -q', ' -C base.config'])
    const before = r.pick(['', 'cd work && ', 'export X=1; ', 'time ', 'NXF_VER=25.10.4 ', 'nohup '])
    const bin = r.pick(['nextflow', './nextflow', '/opt/bin/nextflow'])
    const after = r.pick(['', ' | tee out.txt', ' && echo done', ' 2>&1'])
    const command = `${before}${bin}${globals} run ${args}${after}`.replace(/\s+$/, '')
    const out = withWeblog(command, url, cfg)
    expect(out).toBeDefined()
    const hook = globals === ' -C base.config' ? ` -with-weblog ${url}` : ` -c ${cfg}` // -C drops -c
    expect(out!.split(hook).length - 1).toBe(1)
    expect(out!.replace(hook, '')).toBe(command)
    expect(withWeblog(out!, url, cfg)).toBe(undefined)
    expect(withWeblog(command.replace(/nextflow(?=\s)/, 'nextfloww'), url, cfg)).toBe(undefined)
    expect(withWeblog(`echo ${command.replace(/nextflow/g, 'nxf')}`, url, cfg)).toBe(undefined)
    expect(withWeblog(`echo "${command}"`, url, cfg)).toBe(undefined) // quoted: text, not a command
    expect(withWeblog(`cat <<'EOF'\n${command}\nEOF`, url, cfg)).toBe(undefined) // heredoc body: text too

    const argv = previewArgv(out!.slice(before.length).replace(/ \| tee out\.txt| && echo done| 2>&1/, ''), '/t')!
    expect(argv).toBeDefined()
    for (const flag of ['-with-weblog', '-resume', '-bg', cfg]) expect(argv.includes(flag)).toBe(false)
    expect(argv.filter(a => a === '-log')).toEqual(['-log'])
    expect(argv.slice(-5)).toEqual(['-preview', '-c', '/t/dag.config', '--outdir', '/t/out'])
  })
})

test('a started event resets the run; a stale run id keeps the current one', async () => {
  forAll('runs', r => {
    let run: Run | null = null
    for (let i = 0; i < 6; i++) {
      const id = `r${r.int(1, 3)}`
      const e: WeblogEvent = r.next() < 0.4
        ? { event: 'started', runId: id, metadata: { workflow: { launchDir: `/d${id}`, commandLine: 'nextflow run x' } } }
        : { event: 'process_submitted', runId: id, trace: { process: 'A:P', status: 'SUBMITTED' } }
      const prev: Run | null = run
      run = applyEvent(run, e)
      if (e.event === 'started') expect(run).toMatchObject({ id, dir: `/d${id}`, procs: [] })
      else if (!prev || prev.id !== id) expect(run).toBe(prev)
    }
  })
})
