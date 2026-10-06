export type Proc = { name: string; submitted: number; completed: number; failed: number; cached: number }
export type RunStatus = 'waiting' | 'running' | 'done' | 'failed'
/** A Nextflow run as its weblog events describe it. */
export type Run = { id: string; name: string; dir: string; command: string; isResume: boolean; status: RunStatus; procs: Proc[]; startedAt?: number }
/** The pipeline's DAG from `nextflow -preview -with-dag`: process names and process->process edges. */
export type Dag = { runId: string; nodes: string[]; edges: [string, string][]; error?: string }

declare module 'claude-code' {
  interface PluginState {
    'metro-map-mod': { run: Run | null; dag: Dag | null; port: number | null; pan: number }
  }
}
