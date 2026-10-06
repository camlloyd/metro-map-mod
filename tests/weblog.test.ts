import { expect, test } from 'claude-code/testing'

import { applyCached, applyEvent, previewArgv, statusOf, withWeblog } from '../hooks/weblog'
import type { WeblogEvent } from '../hooks/weblog'

// Shapes as Nextflow 25.10 posts them to weblog.url.
const P = 'NFCORE_TOY:RNASEQ:FASTQ_QC_TRIM:FASTQC'
const started: WeblogEvent = {
  event: 'started', runId: 'r1', runName: 'happy_turing',
  metadata: { workflow: { commandLine: "nextflow run main.nf -with-weblog 'http://127.0.0.1:1/events'", launchDir: '/w', resume: false } },
}
const task = (event: string, status: string, exit?: number): WeblogEvent =>
  ({ event, runId: 'r1', trace: { process: P, name: `${P} (WT_REP1)`, status, exit } })

test('folds weblog events into per-process counts', async () => {
  let run = applyEvent(null, started)
  expect(run).toEqual({ id: 'r1', name: 'happy_turing', dir: '/w', command: started.metadata!.workflow!.commandLine, isResume: false, status: 'running', procs: [] })
  run = applyEvent(run, task('process_submitted', 'SUBMITTED'))
  run = applyEvent(run, task('process_submitted', 'SUBMITTED'))
  run = applyEvent(run, task('process_started', 'RUNNING'))
  run = applyEvent(run, task('process_completed', 'COMPLETED', 0))
  run = applyEvent(run, task('process_completed', 'FAILED', 1))
  expect(run!.procs).toEqual([{ name: P, submitted: 2, completed: 1, failed: 1, cached: 0 }])
  // Another run's events don't touch this one.
  expect(applyEvent(run, { ...task('process_submitted', 'SUBMITTED'), runId: 'other' })).toBe(run)
  expect(applyEvent(run, { event: 'completed', runId: 'r1', metadata: { workflow: { success: true } } })!.status).toBe('done')
  expect(applyEvent(run, { event: 'completed', runId: 'r1', metadata: { workflow: { success: false } } })!.status).toBe('failed')
  expect(applyEvent(run, { event: 'error', runId: 'r1' })!.status).toBe('failed')
  // A failure's `completed` after its `error` changes nothing, so the run ends (and toasts) once.
  const failed = applyEvent(run, { event: 'error', runId: 'r1' })
  expect(applyEvent(failed, { event: 'completed', runId: 'r1', metadata: { workflow: { success: false } } })).toBe(failed)
})

test('cached tasks, which the weblog never sends, come from the log', async () => {
  const run = applyEvent(null, { ...started, metadata: { workflow: { ...started.metadata!.workflow!, resume: true } } })!
  const log = [`x [main] INFO  nextflow.Session - [9b/64232f] Cached process > ${P} (WT_REP1)`,
    `x [main] INFO  nextflow.Session - [9c/64232f] Cached process > ${P} (WT_REP2)`].join('\n')
  expect(applyCached(applyCached(run, log), log).procs).toEqual([{ name: P, submitted: 0, completed: 0, failed: 0, cached: 2 }])
})

const url = 'http://127.0.0.1:9/events'
const cfg = '/t/metro-map-weblog.config'

test('points a nextflow run at the listener, and only one', async () => {
  expect(withWeblog('ls -la', url, cfg)).toBe(undefined)
  expect(withWeblog('python run.py --nextflow', url, cfg)).toBe(undefined)
  expect(withWeblog('nextflow run main.nf', url, cfg)).toBe(`nextflow -c ${cfg} run main.nf`)
  expect(withWeblog('cd x && nextflow -log a.log run nf-core/fetchngs -profile test,docker --outdir r | tee out.txt', url, cfg))
    .toBe(`cd x && nextflow -c ${cfg} -log a.log run nf-core/fetchngs -profile test,docker --outdir r | tee out.txt`)
  expect(withWeblog('nextflow run main.nf -with-weblog http://elsewhere', url, cfg)).toBe(undefined)
  // -C drops every -c, so the deprecated flag there.
  expect(withWeblog('nextflow -C base.config run main.nf', url, cfg)).toBe(`nextflow -C base.config run -with-weblog ${url} main.nf`)
})

test('leaves `nextflow run` alone when it is text, not a command', async () => {
  expect(withWeblog('echo "try: nextflow run main.nf"', url, cfg)).toBe(undefined)
  expect(withWeblog("git commit -m 'make nextflow run faster'", url, cfg)).toBe(undefined)
  expect(withWeblog("cat > README.md <<'EOF'\nnextflow run nf-core/fetchngs\nEOF", url, cfg)).toBe(undefined)
  expect(withWeblog('python3 - <<EOF\nprint("nextflow run x")\nEOF\nls', url, cfg)).toBe(undefined)
  expect(withWeblog('grep nextflow run.log', url, cfg)).toBe(undefined)
  // ...but a real one next to such text still is.
  expect(withWeblog('echo "go" && nextflow run main.nf', url, cfg)).toBe(`echo "go" && nextflow -c ${cfg} run main.nf`)
  expect(withWeblog("cat <<EOF > p.yml\na: 1\nEOF\nnextflow run main.nf -params-file p.yml", url, cfg))
    .toBe(`cat <<EOF > p.yml\na: 1\nEOF\nnextflow -c ${cfg} run main.nf -params-file p.yml`)
  expect(withWeblog("cat <<- 'EOF' > p.yml\n\ta: 1\n\tEOF\nnextflow run main.nf", url, cfg))
    .toBe(`cat <<- 'EOF' > p.yml\n\ta: 1\n\tEOF\nnextflow -c ${cfg} run main.nf`)
  expect(withWeblog('env NXF_VER=25.10.4 nextflow run main.nf', url, cfg)).toBe(`env NXF_VER=25.10.4 nextflow -c ${cfg} run main.nf`)
})

test('turns the logged command into a preview', async () => {
  const line = "nextflow run nf-core/rnaseq -r 3.26.0 -profile 'test,docker' -resume -params-file p.yml -with-weblog 'http://127.0.0.1:1/events'"
  expect(previewArgv(line, '/t')).toEqual(['nextflow', '-q', '-log', '/t/preview.log', 'run', 'nf-core/rnaseq', '-r', '3.26.0',
    '-profile', 'test,docker', '-params-file', 'p.yml', '-preview', '-c', '/t/dag.config', '--outdir', '/t/out'])
  expect(previewArgv(`nextflow -c ${cfg} -log my.log -c x.config run main.nf`, '/t')).toEqual(['nextflow', '-q', '-log', '/t/preview.log',
    '-c', 'x.config', 'run', 'main.nf', '-preview', '-c', '/t/dag.config', '--outdir', '/t/out'])
  expect(previewArgv('nextflow run main.nf -preview', '/t')!.filter(a => a === '-preview')).toEqual(['-preview'])
  expect(previewArgv('no command here', '/t')).toBe(undefined)
})

test('station state from task counts', async () => {
  const p = (submitted: number, completed: number, failed = 0, cached = 0) => ({ name: 'P', submitted, completed, failed, cached })
  expect(statusOf(undefined)).toBe('pending')
  expect(statusOf(p(0, 0))).toBe('pending')
  expect(statusOf(p(2, 1))).toBe('running')
  expect(statusOf(p(2, 2))).toBe('done')
  expect(statusOf(p(0, 0, 0, 3))).toBe('done') // all cached on -resume
  expect(statusOf(p(1, 0, 1))).toBe('failed')
  expect(statusOf(p(2, 1, 1))).toBe('done') // failed, then retried ok
})
