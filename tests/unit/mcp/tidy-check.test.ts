// tests/unit/mcp/tidy-check.test.ts — drift detector (brief-030 task 1).
//
// Pure-function tests against /tmp fixtures. Each drift condition is
// exercised in isolation, then combined. The tick wiring + dedup
// machinery lives in src/mcp/index.ts and is covered by the
// integration test in tests/integration/mcp-tidy-check.test.ts.

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  STALE_DOING_TASK_MS,
  STALE_INBOX_MS,
  STALE_JOURNAL_MS,
} from '../../../src/common.ts';
import { evaluateDrift } from '../../../src/mcp/tidy-check.ts';

let scratch: string;
let coordRoot: string;
let identityRoot: string;

const ID = 'alice';

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'coord-tidy-unit-'));
  coordRoot = join(scratch, 'coord');
  mkdirSync(join(coordRoot, ID, 'inbox'), { recursive: true });
  mkdirSync(join(coordRoot, ID, 'archive'), { recursive: true });
  identityRoot = join(coordRoot, ID);
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function plantInbox(filename: string, ageMs: number): string {
  const path = join(identityRoot, 'inbox', filename);
  writeFileSync(path, '---\nfrom: bob\n---\nbody\n');
  if (ageMs > 0) {
    const t = new Date(Date.now() - ageMs);
    utimesSync(path, t, t);
  }
  return path;
}

function plantTask(
  filename: string,
  status: 'todo' | 'doing' | 'done' | 'blocked',
  title: string,
  ageMs: number
): string {
  const dir = join(identityRoot, 'tasks');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, filename);
  writeFileSync(path, `---\nstatus: ${status}\n---\n# ${title}\n`);
  if (ageMs > 0) {
    const t = new Date(Date.now() - ageMs);
    utimesSync(path, t, t);
  }
  return path;
}

function plantJournal(filename: string, ageMs: number): string {
  const dir = join(identityRoot, 'journal');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, filename);
  writeFileSync(path, 'entry body\n');
  if (ageMs > 0) {
    const t = new Date(Date.now() - ageMs);
    utimesSync(path, t, t);
  }
  return path;
}

// ─── Empty / clean cases ───────────────────────────────────────────────

describe('evaluateDrift — clean fixtures', () => {
  it('empty identity → no drift', () => {
    const r = evaluateDrift(ID, coordRoot);
    expect(r.inbox).toBe(false);
    expect(r.doingTask).toBe(false);
    expect(r.journal).toBe(false);
    expect(r.body).toBe('');
  });

  it('inbox file fresher than STALE_INBOX_MS → no inbox drift', () => {
    plantInbox('1714826789010-aaaaaa.md', STALE_INBOX_MS - 60_000);
    const r = evaluateDrift(ID, coordRoot);
    expect(r.inbox).toBe(false);
  });

  it('doing-task fresher than STALE_DOING_TASK_MS → no doingTask drift', () => {
    plantTask(
      '1714826789010-tdoing.md',
      'doing',
      'in flight',
      STALE_DOING_TASK_MS - 60_000
    );
    const r = evaluateDrift(ID, coordRoot);
    expect(r.doingTask).toBe(false);
  });
});

// ─── Inbox drift ───────────────────────────────────────────────────────

describe('evaluateDrift — inbox condition', () => {
  it('a single stale inbox file fires inbox drift', () => {
    plantInbox('1714826789010-aaaaaa.md', STALE_INBOX_MS + 60_000);
    const r = evaluateDrift(ID, coordRoot);
    expect(r.inbox).toBe(true);
    expect(r.detail.inboxStaleCount).toBe(1);
    expect(r.detail.oldestInboxAgeMs).toBeGreaterThan(STALE_INBOX_MS);
    expect(r.body).toContain('inbox: 1 unaddressed message');
  });

  it('multiple stale files report the count + the oldest age', () => {
    plantInbox('1714826789010-aaaaaa.md', STALE_INBOX_MS + 60_000);
    plantInbox('1714826789020-bbbbbb.md', STALE_INBOX_MS + 30 * 60_000);
    plantInbox('1714826789030-cccccc.md', STALE_INBOX_MS + 5 * 60_000);
    const r = evaluateDrift(ID, coordRoot);
    expect(r.inbox).toBe(true);
    expect(r.detail.inboxStaleCount).toBe(3);
    // oldest is the +30min one
    expect(r.detail.oldestInboxAgeMs).toBeGreaterThan(STALE_INBOX_MS + 25 * 60_000);
    expect(r.body).toContain('3 unaddressed messages');
  });

  it('non-grammar files in inbox are skipped', () => {
    plantInbox('1714826789010-aaaaaa.md', STALE_INBOX_MS + 60_000);
    // bare README without the <ts>-<rand6>.md grammar
    const noisePath = join(identityRoot, 'inbox', 'README');
    writeFileSync(noisePath, 'docs');
    const oldT = new Date(Date.now() - STALE_INBOX_MS * 10);
    utimesSync(noisePath, oldT, oldT);
    const r = evaluateDrift(ID, coordRoot);
    expect(r.detail.inboxStaleCount).toBe(1);
  });
});

// ─── Doing-task drift ──────────────────────────────────────────────────

describe('evaluateDrift — doing-task condition', () => {
  it('a stale doing task fires doingTask drift', () => {
    plantTask(
      '1714826789010-refactor-x.md',
      'doing',
      'refactor X',
      STALE_DOING_TASK_MS + 60_000
    );
    const r = evaluateDrift(ID, coordRoot);
    expect(r.doingTask).toBe(true);
    expect(r.detail.staleDoingTaskTitle).toBe('refactor X');
    expect(r.body).toContain('doing-task: "refactor X" untouched');
  });

  it('stale `todo` or `done` tasks do NOT fire (status filter)', () => {
    plantTask(
      '1714826789010-old-todo.md',
      'todo',
      'idea',
      STALE_DOING_TASK_MS * 5
    );
    plantTask(
      '1714826789020-old-done.md',
      'done',
      'shipped',
      STALE_DOING_TASK_MS * 5
    );
    const r = evaluateDrift(ID, coordRoot);
    expect(r.doingTask).toBe(false);
  });

  it('with multiple stale doing tasks, the longest-untouched wins for the body', () => {
    plantTask(
      '1714826789010-recent.md',
      'doing',
      'recent',
      STALE_DOING_TASK_MS + 30 * 60_000
    );
    plantTask(
      '1714826789020-ancient.md',
      'doing',
      'ancient',
      STALE_DOING_TASK_MS + 5 * 60 * 60_000
    );
    const r = evaluateDrift(ID, coordRoot);
    expect(r.detail.staleDoingTaskTitle).toBe('ancient');
  });
});

// ─── Journal drift ─────────────────────────────────────────────────────

describe('evaluateDrift — journal condition', () => {
  it('done task AFTER the last journal AND journal is stale → fires', () => {
    plantJournal(
      '1714826789010-old.md',
      STALE_JOURNAL_MS + 30 * 60_000
    );
    plantTask(
      '1714826789020-done.md',
      'done',
      'shipped',
      10 * 60_000 // shipped 10 min ago, after the old journal
    );
    const r = evaluateDrift(ID, coordRoot);
    expect(r.journal).toBe(true);
    expect(r.body).toContain('No journal entry since last task→done');
  });

  it('done task BEFORE the last journal → no journal drift (already journaled)', () => {
    plantTask(
      '1714826789010-done.md',
      'done',
      'shipped',
      STALE_JOURNAL_MS + 2 * 60 * 60_000
    );
    plantJournal(
      '1714826789020-recent.md',
      STALE_JOURNAL_MS - 60_000 // fresher than threshold
    );
    const r = evaluateDrift(ID, coordRoot);
    expect(r.journal).toBe(false);
  });

  it('no journal AND no done tasks → no journal drift', () => {
    // Boundary: bare identity with no work yet shouldn't fire.
    const r = evaluateDrift(ID, coordRoot);
    expect(r.journal).toBe(false);
  });

  it('no journal AND a done task → fires (latest-journal-mtime=0 baseline)', () => {
    plantTask(
      '1714826789010-done.md',
      'done',
      'shipped',
      10 * 60_000
    );
    const r = evaluateDrift(ID, coordRoot);
    expect(r.journal).toBe(true);
  });
});

// ─── Combinations + body shape ─────────────────────────────────────────

describe('evaluateDrift — combinations', () => {
  it('all three conditions fire together → body lists all three', () => {
    plantInbox('1714826789010-aaaaaa.md', STALE_INBOX_MS + 60_000);
    plantTask(
      '1714826789020-stale-doing.md',
      'doing',
      'long-running thing',
      STALE_DOING_TASK_MS + 60_000
    );
    plantJournal(
      '1714826789030-old-journal.md',
      STALE_JOURNAL_MS + 60_000
    );
    plantTask(
      '1714826789040-done.md',
      'done',
      'shipped',
      10 * 60_000
    );
    const r = evaluateDrift(ID, coordRoot);
    expect(r.inbox).toBe(true);
    expect(r.doingTask).toBe(true);
    expect(r.journal).toBe(true);
    expect(r.body).toContain('inbox:');
    expect(r.body).toContain('doing-task:');
    expect(r.body).toContain('No journal entry since last task→done');
    expect(r.body.startsWith('Tidy check (drift detected):')).toBe(true);
  });

  it('body is empty when no condition fires', () => {
    const r = evaluateDrift(ID, coordRoot);
    expect(r.body).toBe('');
  });

  it('opts.now overrides Date.now for determinism', () => {
    const path = plantInbox('1714826789010-aaaaaa.md', 0);
    // Set the file's mtime to exactly "STALE_INBOX_MS+1 in the past"
    const baseline = 2_000_000_000_000;
    const pastT = new Date(baseline - STALE_INBOX_MS - 1);
    utimesSync(path, pastT, pastT);
    const r = evaluateDrift(ID, coordRoot, { now: () => baseline });
    expect(r.inbox).toBe(true);
  });
});

// ─── Resilience ────────────────────────────────────────────────────────

describe('evaluateDrift — resilience', () => {
  it('missing identity folder → no drift, no throw', () => {
    rmSync(scratch, { recursive: true, force: true });
    // Re-mkdir scratch so afterEach's rmSync doesn't error.
    mkdirSync(scratch);
    const r = evaluateDrift(ID, coordRoot);
    expect(r.inbox).toBe(false);
    expect(r.doingTask).toBe(false);
    expect(r.journal).toBe(false);
  });
});
