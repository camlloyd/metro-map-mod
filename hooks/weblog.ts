import type { Proc, Run } from '../types'
import type { Status } from './dag'

/** One event as Nextflow posts it to `weblog.url`. */
export type WeblogEvent = {
  event: string // started | process_submitted | process_started | process_completed | error | completed
  runId: string
  runName?: string
  metadata?: { workflow?: { commandLine?: string; launchDir?: string; resume?: boolean; success?: boolean } }
  trace?: { process: string; name?: string; status: string; exit?: number }
}

const blank = (name: string): Proc => ({ name, submitted: 0, completed: 0, failed: 0, cached: 0 })

function bump(run: Run, name: string, change: (p: Proc) => Proc): Run {
  const at = run.procs.findIndex(p => p.name === name)
  const procs = [...run.procs]
  if (at < 0) procs.push(change(blank(name)))
  else procs[at] = change(procs[at]!)
  return { ...run, procs }
}

/** Folds one weblog event into the run it belongs to; `started` begins a new run. */
export function applyEvent(run: Run | null, e: WeblogEvent): Run | null {
  const wf = e.metadata?.workflow
  if (e.event === 'started') {
    return { id: e.runId, name: e.runName ?? '', dir: wf?.launchDir ?? '', command: wf?.commandLine ?? '', isResume: wf?.resume === true, status: 'running', procs: [] }
  }
  if (!run || run.id !== e.runId) return run
  const process = e.trace?.process
  if (e.event === 'process_submitted' && process) return bump(run, process, p => ({ ...p, submitted: p.submitted + 1 }))
  if (e.event === 'process_completed' && process) {
    const isOk = e.trace!.status === 'COMPLETED'
    return bump(run, process, p => (isOk ? { ...p, completed: p.completed + 1 } : { ...p, failed: p.failed + 1 }))
  }
  // A failure sends `error` then `completed`: the first one ends the run, so it toasts once.
  if ((e.event === 'error' || e.event === 'completed') && run.status !== 'running') return run
  if (e.event === 'error') return { ...run, status: 'failed' }
  if (e.event === 'completed') return { ...run, status: wf?.success === false ? 'failed' : 'done' }
  return run
}

/** The weblog sends nothing for tasks a `-resume` skips; their "Cached process" log lines fill them in. */
export function applyCached(run: Run, logText: string): Run {
  const counts = new Map<string, number>()
  for (const m of logText.matchAll(/Cached process > (.+?)(?:\s+\(.*\))?\s*$/gm)) counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + 1)
  let next = run
  for (const [name, cached] of counts) next = bump(next, name, p => ({ ...p, cached }))
  return next
}

/** The command with what's inside quotes and heredoc bodies replaced by spaces (newlines kept), same length. */
function textBlanked(command: string): string {
  const spaces = (s: string) => s.replace(/[^\n]/g, ' ')
  return command
    .replace(/(<<-?\s*(['"]?)(\w+)\2[^\n]*\n)([\s\S]*?\n)(\s*\3)(?=\n|$)/g,
      (_, head: string, _q, _tag, body: string, end: string) => head + spaces(body) + end)
    .replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, spaces)
}

/** The config file the listener writes, holding `weblog.url`; its name marks it in a command line. */
export const WEBLOG_CONFIG = 'metro-map-weblog.config'

/** The Bash command with its `nextflow run` reporting to the listener (`-c <config>`), or undefined when it runs none
 * (or already reports somewhere). `-C` drops every `-c`, so there it falls back to the deprecated `-with-weblog <url>`. */
export function withWeblog(command: string, url: string, config: string): string | undefined {
  if (/-with-weblog\b/.test(command) || command.includes(WEBLOG_CONFIG)) return undefined
  // `nextflow` where a command starts (after `;`, `&&`, `|`, `(` or a newline; `time`, `nohup`, `env`, `VAR=…`
  // prefixes; any path), searched in a copy with quoted text and heredoc bodies blanked, so the same index fits both.
  // ponytail: no `bash -c "…"` (quoted, so skipped) and no escaped quotes outside strings
  const run = textBlanked(command).match(
    /((?:^|[;&|(\n])\s*(?:(?:\w+=\S*|time|nohup|env|exec)\s+)*(?:[^\s;&|()]*\/)?nextflow)((?:\s+-\S+(?:\s+[^-\s]\S*)?)*?)\s+run\b/)
  if (!run) return undefined
  const end = run.index! + run[0].length
  if (/\s-C\s/.test(run[2]!)) return `${command.slice(0, end)} -with-weblog ${url}${command.slice(end)}`
  const bin = run.index! + run[1]!.length
  return `${command.slice(0, bin)} -c ${config}${command.slice(bin)}`
}

/** Task counts over processes: cached tasks count as done. */
export const tally = (procs: Proc[]) => {
  let done = 0, total = 0, failed = 0, running = 0
  for (const p of procs) {
    done += p.completed + p.cached
    total += p.submitted + p.cached
    failed += p.failed
    running += Math.max(0, p.submitted - p.completed - p.failed)
  }
  return { done, total, failed, running }
}

/** How long a run took, Nextflow-style: `45s`, `23m 10s`, `2h 5m`. */
export const took = (ms: number) => {
  const s = Math.round(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60)
  return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`
}

/** The end-of-run toast: `genomeqc done in 23m 10s · 52 succeeded · 49 cached`, or `genomeqc failed after 4m 2s at BUSCO_BUSCO +1 more`. */
export function endToast(run: Run, pipeline: string, ms?: number): string {
  if (run.status === 'failed') {
    const [first, ...rest] = run.procs.filter(p => p.failed > 0).map(p => p.name.split(':').pop()!)
    return `${pipeline} failed${ms === undefined ? '' : ` after ${took(ms)}`}` +
      (first ? ` at ${first}${rest.length ? ` +${rest.length} more` : ''}` : '')
  }
  const done = run.procs.reduce((n, p) => n + p.completed, 0), cached = run.procs.reduce((n, p) => n + p.cached, 0)
  return `${pipeline} done${ms === undefined ? '' : ` in ${took(ms)}`} · ${done} succeeded${cached ? ` · ${cached} cached` : ''}`
}

/** A process's station state from its task counts. */
export const statusOf = (p: Proc | undefined): Status => {
  if (!p) return 'pending'
  const c = tally([p])
  if (c.running > 0) return 'running'
  if (c.failed > 0 && c.done === 0) return 'failed'
  return c.total > 0 && c.done + c.failed === c.total ? 'done' : 'pending' // failed then retried ok: done
}

/** A run's command line (the weblog's `commandLine`) turned into a no-task preview that writes the DAG. */
export function previewArgv(line: string, tmp: string): string[] | undefined {
  // ponytail: whitespace split, quotes stripped per word; an argument with spaces in it breaks the preview (the live view still works)
  const argv = line.trim().split(/\s+/).map(a => a.replace(/^'(.*)'$|^"(.*)"$/, '$1$2'))
  const runAt = argv.indexOf('run')
  if (runAt < 0) return undefined
  const globals: string[] = []
  for (let i = 1; i < runAt; i++) {
    if (argv[i] === '-log' || argv[i] === '-q' || argv[i] === '-quiet') { if (argv[i] === '-log') i++; continue }
    if (argv[i] === '-c' && argv[i + 1]?.endsWith(WEBLOG_CONFIG)) { i++; continue } // else the preview would report to our own listener
    globals.push(argv[i]!)
  }
  const keep: string[] = []
  for (let i = runAt + 1; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '-bg' || a === '-preview') continue // -preview: we add our own, and Nextflow refuses two
    if (a === '-with-weblog') { i++; continue } // else the preview would report to our own listener
    if (a === '-with-dag') { if (argv[i + 1] && !argv[i + 1]!.startsWith('-')) i++; continue } // its file would override ours
    // Nextflow only takes `last` or a session UUID as -resume's value; any other next word is its own argument.
    if (a === '-resume') { if (/^(last|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(argv[i + 1] ?? '')) i++; continue }
    keep.push(a)
  }
  return [argv[0]!, '-q', '-log', `${tmp}/preview.log`, ...globals, 'run', ...keep,
    '-preview', '-c', `${tmp}/dag.config`, '--outdir', `${tmp}/out`]
}

export const dagConfig = (tmp: string) =>
  `dag { enabled = true; file = '${tmp}/dag.dot'; overwrite = true }\n` +
  `trace.enabled = false\nreport.enabled = false\ntimeline.enabled = false\n`
