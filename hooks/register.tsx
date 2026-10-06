import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Dag, Run } from '../types'
import { metro, parseDot, pipelineOf, STATION } from './dag'
import { applyCached, applyEvent, dagConfig, endToast, previewArgv, statusOf, tally, WEBLOG_CONFIG, withWeblog } from './weblog'
import type { WeblogEvent } from './weblog'

const PANE = 'metro-map'
const openPane = ($: EngineInterface) => $.ui.open({ id: PANE, title: 'Metro map' })
const run = atom({ plugin: 'metro-map-mod', key: 'run' } as const, null)
const dag = atom({ plugin: 'metro-map-mod', key: 'dag' } as const, null)
const lastPort = atom({ plugin: 'metro-map-mod', key: 'port' } as const, null)
// Columns the person moved the map from where it follows the run by itself.
const pan = atom({ plugin: 'metro-map-mod', key: 'pan' } as const, 0)

// A local endpoint for Nextflow's weblog: writes a config file pointing at it, prints its port and that file, then each
// event posted to it as one JSON line. It takes the port it had before a reload (argv[1]) if that frees up within ~2s,
// so runs already reporting keep their map.
const LISTENER = `
import http.server, os, sys, tempfile, time
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        sys.stdout.write(body.decode('utf-8', 'replace').replace('\\n', ' ') + '\\n'); sys.stdout.flush()
        self.send_response(200); self.end_headers()
    def log_message(self, *a): pass
srv = None
for _ in range(20):
    try: srv = http.server.ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1])), H); break
    except (OSError, ValueError, IndexError): time.sleep(0.1)
srv = srv or http.server.ThreadingHTTPServer(('127.0.0.1', 0), H)
port = srv.server_address[1]
config = os.path.join(tempfile.mkdtemp(prefix='metro-map-'), '${WEBLOG_CONFIG}')
with open(config, 'w') as f: f.write("weblog { enabled = true; url = 'http://127.0.0.1:%d/events' }\\n" % port)
print('PORT', port, config, flush=True)
srv.serve_forever()
`

let weblogUrl: string | undefined
let weblogConfig: string | undefined
let cachedTimer: Timer | undefined

// The session's weblog listener; a reload restarts it (session.start fires again) and kills the old one.
async function listen($: EngineInterface) {
  let buffer = ''
  try {
    const before = String(await read($, lastPort) ?? 0)
    for await (const { stream, text } of $.process.spawn({ argv: ['python3', '-c', LISTENER, before] })) {
      if (stream !== 'stdout') continue
      buffer += text
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        if (line.startsWith('PORT ')) {
          const [, port, config] = line.trim().split(' ')
          weblogUrl = `http://127.0.0.1:${port}/events`
          weblogConfig = config
          await update($, lastPort, () => Number(port))
        }
        else if (line.startsWith('{')) await onEvent($, JSON.parse(line) as WeblogEvent).catch(() => undefined)
      }
    }
  } finally {
    weblogUrl = undefined
    $.ui.status('metro map: weblog listener stopped (is python3 on PATH?)')
  }
}

async function onEvent($: EngineInterface, ev: WeblogEvent) {
  const before = await read($, run)
  const applied = applyEvent(before, ev)
  if (!applied || applied === before) return
  const next = ev.event === 'started' ? { ...applied, startedAt: Date.now() } : applied
  await update($, run, () => next)

  if (ev.event === 'started') {
    await update($, dag, () => null)
    await update($, pan, () => 0)
    void openPane($)
    void preview($, next)
    cachedTimer?.cancel()
    // ponytail: assumes the default .nextflow.log in the launch dir; a `-log elsewhere` resume shows cached stations as skipped
    if (next.isResume) cachedTimer = $.clock.every(2000, () => void fillCached($, next.id))
  }
  if (next.status !== 'running') {
    cachedTimer?.cancel()
    if (next.isResume) await fillCached($, next.id)
    const d = await read($, dag)
    const pipeline = (d?.runId === next.id && pipelineOf(d.nodes).title.toLowerCase()) || next.name || 'Nextflow run'
    $.ui.toast(endToast((await read($, run)) ?? next, pipeline, next.startedAt && Date.now() - next.startedAt))
  }
}

async function fillCached($: EngineInterface, id: string) {
  const r = await read($, run)
  if (!r || r.id !== id) return
  const text = await $.fs.read(`${r.dir}/.nextflow.log`).catch(() => '')
  await update($, run, cur => (cur && cur.id === id ? applyCached(cur, text) : cur))
}

// Re-runs the command with -preview for the DAG, since -with-dag only writes it when a run ends. NXF_CACHE_DIR keeps
// the preview out of the run's .nextflow/history.
async function preview($: EngineInterface, r: Run) {
  const tmp = `${r.dir}/.nextflow/metro-map`
  const argv = previewArgv(r.command, tmp)
  const fail = (error: string) => update($, dag, () => ({ runId: r.id, nodes: [], edges: [], error }) satisfies Dag)
  if (!argv) return fail('no `nextflow run` in the command line')
  try {
    await $.process.run(['mkdir', '-p', tmp])
    await $.fs.write(`${tmp}/dag.config`, dagConfig(tmp))
    // ponytail: ${tmp}/cache grows ~12 KB per preview and is never pruned
    const ran = await $.process.run(argv, { cwd: r.dir, env: { NXF_CACHE_DIR: `${tmp}/cache` }, timeoutMs: 5 * 60_000 })
    if (ran.exitCode !== 0) return fail(`preview exited ${ran.exitCode}: ${(ran.stderr || ran.stdout).trim().split('\n').pop() ?? ''}`)
    const parsed = parseDot(await $.fs.read(`${tmp}/dag.dot`))
    await update($, dag, () => ({ runId: r.id, ...parsed }) satisfies Dag)
  } catch (err) {
    await fail(String(err))
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'metro-map', description: 'Show the metro map of the current Nextflow run' })
    const started = await next(e)
    void listen($)
    return started
  })

  on('command.run', { command: 'metro-map' }, async $ => {
    await openPane($)
    return { text: 'Metro map opened.' }
  })

  // Every `nextflow run` the agent starts reports to the listener.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = weblogUrl && weblogConfig ? withWeblog(e.command, weblogUrl, weblogConfig) : undefined
    if (!command) return next(e)
    await update($, run, () => ({ id: '', name: '', dir: '', command: '', isResume: false, status: 'waiting', procs: [] }) satisfies Run)
    void openPane($)
    return next({ ...e, command })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const r = await read($, run)
    if (!r) return <Text dimColor>No Nextflow run yet. The map opens when one starts.</Text>

    const room = Math.max(3, (e.viewport?.rows ?? 30) - 5)
    const { failed } = tally(r.procs)
    const head = r.status === 'waiting' ? 'waiting for Nextflow to start…' : `${r.status}${failed ? ` · ${failed} failed` : ''}`
    const headColor = r.status === 'failed' ? 'red' : r.status === 'done' ? 'green' : undefined

    // The metro map once the -preview DAG is in.
    const d = await read($, dag)
    if (d && d.runId === r.id && d.nodes.length > 0) {
      const byName = new Map(r.procs.map(p => [p.name, p]))
      const { rows, title, from, follow, count, of } = metro(d.nodes, d.edges, n => {
        const st = statusOf(byName.get(n))
        return st === 'pending' && r.status !== 'running' ? 'skipped' : st
      }, e.props.bodyColumns ?? e.viewport?.columns ?? 100, await read($, pan))
      // A page less one column per press, so one station stays in view; set from where it shows, so an edge doesn't stick.
      const step = Math.max(1, count - 1)
      const move = (by: number) => () => void update($, pan, () => from + by - follow)
      return (
        <Box flexDirection="column">
          <Text bold color={headColor}>{head}</Text>
          <Box flexDirection="row">
            {from > 0 && <Button plain label="◀" onPress={move(-step)} />}
            <Text dimColor> {[title, r.name].filter(Boolean).join(' · ')} </Text>
            {from + count < of && <Button plain label="▶" onPress={move(step)} />}
          </Box>
          {rows.slice(0, room).map(row => (
            <Text wrap="truncate">
              {row.map(s => <Text color={s.color} bold={s.bold} dimColor={s.dim}>{s.text}</Text>)}
            </Text>
          ))}
        </Box>
      )
    }

    // Until then (or if the preview failed): the processes seen so far.
    return (
      <Box flexDirection="column">
        <Text bold color={headColor}>{head}</Text>
        {r.dir !== '' && <Text dimColor>{[r.name, d?.error ? `DAG preview failed: ${d.error}` : 'building the map…'].filter(Boolean).join(' · ')}</Text>}
        {r.procs.slice(-room).map(p => {
          const s = STATION[statusOf(p)]
          return (
            <Text wrap="truncate">
              <Text color={s.color} bold={s.bold} dimColor={s.dim}>{s.text}</Text> {p.name}
              {p.failed > 0 && <Text dimColor> ✖{p.failed}</Text>}
            </Text>
          )
        })}
      </Box>
    )
  })
}
