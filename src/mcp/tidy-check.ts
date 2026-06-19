// mcp/tidy-check.ts — drift detector for the MCP tidy-check tick.
//
// brief-030: myobie audited two coord agents and caught a real pattern
// of execution drifting from the boot-ritual contract: one had 16
// unarchived inbox messages and was journaling ~10 briefs behind. The
// instructions are clear; agents drift anyway. So the MCP server gets
// a passive correction — a tidy-check tick that runs every
// TIDY_CHECK_INTERVAL_MS and, if any drift condition holds, emits a
// synthetic `notifications/claude/channel` frame asking the agent to
// catch up.
//
// This file is the pure data-producing half. The tick scheduling +
// emit + dedup logic lives in mcp/index.ts (next task's work).
//
// Drift conditions (loose initial tuning per the brief):
//   - inbox      — any inbox file mtime > STALE_INBOX_MS old AND inbox count > 0
//   - doingTask  — any task with status:doing AND file mtime > STALE_DOING_TASK_MS old
//   - journal    — latest journal entry mtime > STALE_JOURNAL_MS old AND a task has
//                  transitioned to `done` since that entry (so the agent shipped
//                  without journaling)

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  inboxDir,
  journalDir,
  STALE_DOING_TASK_MS,
  STALE_INBOX_MS,
  STALE_JOURNAL_MS,
  tasksDir,
  validFilename,
} from '../common.ts';
import { listTaskRecords } from '../commands/task.ts';

// Journal filename grammar mirrors commands/journal.ts — permissive on
// the slug. Duplicated locally to avoid pulling journal.ts (which
// pulls editor/spawnSync deps) into the MCP module hot path.
const JOURNAL_FILENAME_RE = /^[0-9]{13}-[A-Za-z0-9._-]+\.md$/;

export interface DriftDetail {
  /** Count of inbox files older than STALE_INBOX_MS. 0 when the inbox
   *  condition didn't fire. */
  inboxStaleCount: number;
  /** Age (ms) of the oldest stale inbox file, or 0. */
  oldestInboxAgeMs: number;
  /** Title of the longest-untouched `doing` task, or null. */
  staleDoingTaskTitle: string | null;
  /** Age (ms) of that task's last-touched timestamp, or 0. */
  staleDoingTaskAgeMs: number;
  /** Age (ms) since the most recent task→done that the journal hasn't
   *  caught up with, or 0. */
  journalLagMs: number;
}

export interface DriftResult {
  inbox: boolean;
  doingTask: boolean;
  journal: boolean;
  /** Human-readable summary suitable for use as the synthetic channel
   *  frame's `content`. Empty when no condition fired. */
  body: string;
  /** Structured detail behind the booleans, exposed for tests and for
   *  the emit-side dedup logic that may want to log specifics. */
  detail: DriftDetail;
}

export interface EvaluateDriftOpts {
  /** Override Date.now() for deterministic tests. */
  now?: () => number;
}

/**
 * Evaluate the three drift conditions against the identity's folders
 * under `root`. Read-only — no I/O beyond statSync / readdirSync.
 *
 * Returns the booleans plus a pre-formatted body and structured
 * detail. Caller (the tick) decides whether to emit based on dedup
 * state.
 */
export function evaluateDrift(
  identity: string,
  root: string,
  opts: EvaluateDriftOpts = {}
): DriftResult {
  const now = opts.now ?? Date.now;
  const nowMs = now();

  const detail: DriftDetail = {
    inboxStaleCount: 0,
    oldestInboxAgeMs: 0,
    staleDoingTaskTitle: null,
    staleDoingTaskAgeMs: 0,
    journalLagMs: 0,
  };

  // ─ Inbox condition ─
  const ibox = inboxDir(identity, root);
  if (existsSync(ibox)) {
    let entries: string[];
    try {
      entries = readdirSync(ibox);
    } catch {
      entries = [];
    }
    for (const name of entries) {
      if (!validFilename(name)) continue;
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(join(ibox, name));
      } catch {
        continue;
      }
      const age = nowMs - st.mtimeMs;
      if (age > STALE_INBOX_MS) {
        detail.inboxStaleCount++;
        if (age > detail.oldestInboxAgeMs) detail.oldestInboxAgeMs = age;
      }
    }
  }
  const inbox = detail.inboxStaleCount > 0;

  // ─ Doing-task condition ─
  // Walk task records and pick the longest-untouched `doing` whose
  // file mtime is past the threshold.
  const tdir = tasksDir(identity, root);
  if (existsSync(tdir)) {
    const records = listTaskRecords(identity, root, { status: 'doing' });
    for (const rec of records) {
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(join(tdir, rec.filename));
      } catch {
        continue;
      }
      const age = nowMs - st.mtimeMs;
      if (age > STALE_DOING_TASK_MS && age > detail.staleDoingTaskAgeMs) {
        detail.staleDoingTaskAgeMs = age;
        detail.staleDoingTaskTitle = rec.title;
      }
    }
  }
  const doingTask = detail.staleDoingTaskTitle !== null;

  // ─ Journal-lag condition ─
  // Find the latest journal entry's mtime; find the latest done-task
  // mtime; if a done-task happened after the last journal AND the
  // journal is older than STALE_JOURNAL_MS, that's drift. A missing
  // journal folder behaves as "no entries" (mtime 0), which triggers
  // when there's any done task.
  let latestJournalMtime = 0;
  const jdir = journalDir(identity, root);
  if (existsSync(jdir)) {
    let names: string[];
    try {
      names = readdirSync(jdir);
    } catch {
      names = [];
    }
    for (const name of names) {
      if (!JOURNAL_FILENAME_RE.test(name)) continue;
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(join(jdir, name));
      } catch {
        continue;
      }
      if (st.mtimeMs > latestJournalMtime) latestJournalMtime = st.mtimeMs;
    }
  }

  let latestDoneTaskAfterJournalMtime = 0;
  if (existsSync(tdir)) {
    const done = listTaskRecords(identity, root, { status: 'done' });
    for (const rec of done) {
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(join(tdir, rec.filename));
      } catch {
        continue;
      }
      if (
        st.mtimeMs > latestJournalMtime &&
        st.mtimeMs > latestDoneTaskAfterJournalMtime
      ) {
        latestDoneTaskAfterJournalMtime = st.mtimeMs;
      }
    }
  }
  const journalIsStale = nowMs - latestJournalMtime > STALE_JOURNAL_MS;
  const doneSinceJournal = latestDoneTaskAfterJournalMtime > 0;
  const journal = journalIsStale && doneSinceJournal;
  if (journal) {
    detail.journalLagMs = nowMs - latestDoneTaskAfterJournalMtime;
  }

  // ─ Body ─
  const body = formatBody(inbox, doingTask, journal, detail);

  return { inbox, doingTask, journal, body, detail };
}

/** Convert a duration in ms to a short human reading: `47m`, `2h`, `3d`. */
function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 24 * 60 * 60_000) return `${Math.round(ms / (60 * 60_000))}h`;
  return `${Math.round(ms / (24 * 60 * 60_000))}d`;
}

function formatBody(
  inbox: boolean,
  doingTask: boolean,
  journal: boolean,
  detail: DriftDetail
): string {
  if (!inbox && !doingTask && !journal) return '';
  const lines: string[] = ['Tidy check (drift detected):'];
  if (inbox) {
    const n = detail.inboxStaleCount;
    const noun = n === 1 ? 'message' : 'messages';
    lines.push(
      `- inbox: ${n} unaddressed ${noun} (oldest ${formatAge(detail.oldestInboxAgeMs)} old)`
    );
  }
  if (doingTask) {
    lines.push(
      `- doing-task: "${detail.staleDoingTaskTitle}" untouched ${formatAge(detail.staleDoingTaskAgeMs)}`
    );
  }
  if (journal) {
    lines.push(
      `- No journal entry since last task→done ${formatAge(detail.journalLagMs)} ago. Consider draining inbox + dropping a terse journal entry.`
    );
  }
  return lines.join('\n');
}
