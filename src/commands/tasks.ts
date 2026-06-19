// commands/tasks.ts — read-out / observability across identities.
//
// Plural to the singular `coord task` (which manages your own
// queue). `coord tasks` walks `<root>/<*>/tasks/` and surfaces what
// every identity has on its plate. The load-bearing use case is
// "agent observability via the coord folder" — a manager runs
// `coord tasks worker-claude --status doing` and sees what
// worker-claude is currently working on, without ever touching pty.
//
//   coord tasks                 # every identity's tasks
//   coord tasks <identity>      # one identity's tasks
//   coord tasks ... --status STATE | --tag T | --priority P
//   coord tasks ... --json [--include-body]
//   coord tasks ... --watch [--interval MS]
//
// --watch follows mtime changes (and new file arrivals). The initial
// snapshot is NOT emitted; only subsequent changes — matching the
// "tail follow" intent of the brief ("emits lines as task files
// change"). For a snapshot, run without --watch.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { CliContext } from '../cli-context.ts';
import { tasksDir, validIdentity } from '../common.ts';
import { InvalidIdentityError } from '../errors.ts';

import {
  listTaskRecords,
  type TaskRecord,
} from './task.ts';

export interface TaskRecordWithIdentity extends TaskRecord {
  identity: string;
}

// ─── Read (snapshot) ────────────────────────────────────────────────────

export interface TasksReadInput {
  /** Restrict to one identity. Omit for cross-tree. */
  identity?: string | undefined;
  status?: string | undefined;
  tag?: string | undefined;
  priority?: string | undefined;
  /** When false (default for --json), the body is stripped from the
   * returned records. Always present in the non-JSON path. */
  includeBody?: boolean | undefined;

  env: NodeJS.ProcessEnv;
  coordRoot: string;
}

export interface TasksReadResult {
  items: TaskRecordWithIdentity[];
}

/**
 * Build the cross-tree task list. Always returns items sorted by
 * (identity, filename); the filename's <unix-ms>-... prefix gives
 * chronological ordering within an identity.
 */
export function cmdTasks(input: TasksReadInput): TasksReadResult {
  const identities = listIdentities(input.identity, input.coordRoot);
  const items: TaskRecordWithIdentity[] = [];
  for (const id of identities) {
    const dir = tasksDir(id, input.coordRoot);
    if (!existsSync(dir)) continue;
    // cmdTaskLs is normally $COORD_IDENTITY-bound, but in this read
    // path we want each identity's view — call the underlying file
    // walk directly via a small inline copy that doesn't go through
    // resolveIdentity (which insists on env + folder-exists).
    for (const t of readIdentityTasks(id, input.coordRoot)) {
      if (
        input.status !== undefined &&
        input.status !== '' &&
        t.status !== input.status
      ) {
        continue;
      }
      if (
        input.tag !== undefined &&
        input.tag !== '' &&
        !t.tags.includes(input.tag)
      ) {
        continue;
      }
      if (
        input.priority !== undefined &&
        input.priority !== '' &&
        t.priority !== input.priority
      ) {
        continue;
      }
      const record: TaskRecordWithIdentity = { identity: id, ...t };
      if (input.includeBody !== true) {
        record.body = '';
      }
      items.push(record);
    }
  }
  return { items };
}

/** Return the identity sub-folders to consider — either [explicit]
 * or every directory under root. */
function listIdentities(
  explicit: string | undefined,
  root: string
): string[] {
  if (explicit !== undefined && explicit !== '') {
    if (!validIdentity(explicit)) {
      throw new InvalidIdentityError(explicit);
    }
    return [explicit];
  }
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  return entries.filter((id) => validIdentity(id)).sort();
}

/**
 * Read every task file in `<id>/tasks/`. Uses the bare-file-walk
 * helper from task.ts (NOT cmdTaskLs) so the cross-tree read path
 * doesn't materialize `<id>/{inbox,archive}` for every identity it
 * visits — resolveIdentity auto-creates those when called via env,
 * which is the wrong behavior for a passive observability scan.
 */
function readIdentityTasks(identity: string, root: string): TaskRecord[] {
  return listTaskRecords(identity, root);
}

// ─── Watch (follow) ─────────────────────────────────────────────────────

const DEFAULT_WATCH_INTERVAL_MS = 500;

export interface TasksWatchInput extends TasksReadInput {
  intervalMs?: number;
  signal?: AbortSignal;
  /** Override now() for deterministic tests. Defaults to Date.now. */
  now?: () => number;
}

export interface TasksWatchEvent {
  identity: string;
  filename: string;
  /** "added" the first time we see a file post-baseline; "changed"
   * when its mtime increases. We don't emit "removed" today. */
  kind: 'added' | 'changed';
  task: TaskRecordWithIdentity;
}

type FileKey = string; // `<identity>/<filename>`

/**
 * Async iterable that polls every interval, comparing mtimes to a
 * baseline captured on the first tick. The first tick fills the
 * baseline silently — subsequent ticks emit on new files or changed
 * mtimes. Aborts cleanly when the AbortSignal aborts.
 */
export async function* tasksWatch(
  input: TasksWatchInput
): AsyncIterable<TasksWatchEvent> {
  const intervalMs = input.intervalMs ?? DEFAULT_WATCH_INTERVAL_MS;
  const signal = input.signal;
  const baseline = new Map<FileKey, number>();
  let baselineSeeded = false;

  while (true) {
    if (signal?.aborted === true) return;
    const snapshot = scanMtimes(input);
    if (!baselineSeeded) {
      // First tick: seed baseline silently. Anything newer on the
      // next tick is an emit.
      for (const [k, m] of snapshot) baseline.set(k, m);
      baselineSeeded = true;
    } else {
      // Diff: new keys = added; keys whose mtime grew = changed.
      const tasksByKey = readTasksByKey(input);
      for (const [k, m] of snapshot) {
        const prev = baseline.get(k);
        const t = tasksByKey.get(k);
        if (t === undefined) continue; // filter excluded it
        if (prev === undefined) {
          baseline.set(k, m);
          yield { identity: t.identity, filename: t.filename, kind: 'added', task: t };
        } else if (m > prev) {
          baseline.set(k, m);
          yield { identity: t.identity, filename: t.filename, kind: 'changed', task: t };
        }
      }
    }
    await sleepAbortable(intervalMs, signal);
  }
}

/** Stat every matching task file. Returns Map<key, mtimeMs>. */
function scanMtimes(input: TasksReadInput): Map<FileKey, number> {
  const out = new Map<FileKey, number>();
  const identities = listIdentities(input.identity, input.coordRoot);
  for (const id of identities) {
    const dir = tasksDir(id, input.coordRoot);
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name === 'README.md') continue;
      if (!name.endsWith('.md')) continue;
      const path = join(dir, name);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      out.set(`${id}/${name}`, st.mtimeMs);
    }
  }
  return out;
}

/** Parse every matching file. Used by the watch loop to attach the
 * full record to each emission. Could share scan with mtimes; kept
 * separate for clarity. */
function readTasksByKey(input: TasksReadInput): Map<FileKey, TaskRecordWithIdentity> {
  const out = new Map<FileKey, TaskRecordWithIdentity>();
  const r = cmdTasks(input);
  for (const t of r.items) {
    out.set(`${t.identity}/${t.filename}`, t);
  }
  return out;
}

function sleepAbortable(
  ms: number,
  signal: AbortSignal | undefined
): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ─── CLI wrapper ────────────────────────────────────────────────────────

const TASKS_HELP =
  'usage: coord tasks [<identity>] [--status STATE] [--tag T] [--priority P]\n' +
  '                   [--json [--include-body]] [--watch [--interval MS]]\n\n' +
  '  Cross-tree read of every identity\'s tasks/ folder. With <identity>,\n' +
  '  scopes to just that one. --watch follows mtime changes; the initial\n' +
  '  snapshot is not emitted (run without --watch for a snapshot).\n';

export async function cmdTasksCli(
  args: readonly string[],
  ctx: CliContext
): Promise<number> {
  let identity: string | undefined;
  let status: string | undefined;
  let tag: string | undefined;
  let priority: string | undefined;
  let json = false;
  let includeBody = false;
  let watch = false;
  let intervalMs: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case '--status':
        status = args[++i];
        break;
      case '--tag':
        tag = args[++i];
        break;
      case '--priority':
        priority = args[++i];
        break;
      case '--json':
        json = true;
        break;
      case '--include-body':
        includeBody = true;
        break;
      case '--watch':
        watch = true;
        break;
      case '--interval': {
        const v = args[++i];
        if (v === undefined || !/^[0-9]+$/.test(v)) {
          throw new Error('--interval must be a positive integer (ms)');
        }
        intervalMs = Number(v);
        break;
      }
      case '-h':
      case '--help':
        ctx.stderr(TASKS_HELP);
        return 0;
      default:
        if (a.startsWith('-')) throw new Error(`unknown flag: ${a}`);
        if (identity === undefined) identity = a;
        else throw new Error(`unexpected arg: ${a}`);
    }
  }
  if (watch) {
    return await runWatch(ctx, {
      ...(identity !== undefined && { identity }),
      ...(status !== undefined && { status }),
      ...(tag !== undefined && { tag }),
      ...(priority !== undefined && { priority }),
      includeBody,
      ...(intervalMs !== undefined && { intervalMs }),
      env: ctx.env,
      coordRoot: ctx.coordRoot,
    });
  }
  const r = cmdTasks({
    ...(identity !== undefined && { identity }),
    ...(status !== undefined && { status }),
    ...(tag !== undefined && { tag }),
    ...(priority !== undefined && { priority }),
    includeBody: json ? includeBody : true,
    env: ctx.env,
    coordRoot: ctx.coordRoot,
  });
  if (json) {
    // Drop the (possibly-empty) body when --include-body wasn't set.
    const items = r.items.map((t) => {
      const copy: Record<string, unknown> = {
        identity: t.identity,
        filename: t.filename,
        title: t.title,
        status: t.status,
        priority: t.priority,
        tags: t.tags,
        due: t.due,
      };
      if (includeBody) copy.body = t.body;
      return copy;
    });
    ctx.stdout(`${JSON.stringify(items)}\n`);
    return 0;
  }
  for (const t of r.items) {
    ctx.stdout(
      `${t.identity}\t${t.filename}\t${t.status}\t${t.priority ?? '-'}\t${t.title}\n`
    );
  }
  return 0;
}

async function runWatch(
  ctx: CliContext,
  input: TasksWatchInput
): Promise<number> {
  const ac = new AbortController();
  const onSig = (): void => ac.abort();
  process.once('SIGINT', onSig);
  process.once('SIGTERM', onSig);
  try {
    for await (const ev of tasksWatch({ ...input, signal: ac.signal })) {
      const t = ev.task;
      ctx.stdout(
        `${ev.kind}\t${t.identity}\t${t.filename}\t${t.status}\t${t.priority ?? '-'}\t${t.title}\n`
      );
    }
  } finally {
    process.removeListener('SIGINT', onSig);
    process.removeListener('SIGTERM', onSig);
  }
  return 0;
}
