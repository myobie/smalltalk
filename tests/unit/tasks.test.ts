// tests/unit/tasks.test.ts — `coord tasks` (plural) read-out verb.
//
// Covers cmdTasks (snapshot) and tasksWatch (follow). Watch uses
// real timers with a short interval; aborts via AbortController.

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

import { cmdTaskNew, cmdTaskStatus } from '../../src/commands/task.ts';
import {
  cmdTasks,
  tasksWatch,
  type TasksWatchEvent,
} from '../../src/commands/tasks.ts';

let scratch: string;
let coordRoot: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'coord-tasks-test-'));
  coordRoot = join(scratch, 'coord');
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function setupIdentity(id: string): void {
  mkdirSync(join(coordRoot, id, 'inbox'), { recursive: true });
  mkdirSync(join(coordRoot, id, 'archive'), { recursive: true });
}

function envFor(id: string): NodeJS.ProcessEnv {
  return { COORD_IDENTITY: id } as NodeJS.ProcessEnv;
}

// ─── cmdTasks — snapshot ─────────────────────────────────────────────

describe('cmdTasks — snapshot', () => {
  beforeEach(() => {
    setupIdentity('alice');
    setupIdentity('bob');
    setupIdentity('carol'); // no tasks/ — should be absent from output
    cmdTaskNew({
      title: 'alice-1',
      priority: 'high',
      env: envFor('alice'),
      coordRoot,
      noEdit: true,
    });
    cmdTaskNew({
      title: 'alice-2',
      tags: ['x'],
      env: envFor('alice'),
      coordRoot,
      noEdit: true,
    });
    cmdTaskNew({
      title: 'bob-1',
      env: envFor('bob'),
      coordRoot,
      noEdit: true,
    });
  });

  it('no args → every identity\'s tasks across $COORD_ROOT', () => {
    const r = cmdTasks({ env: {} as NodeJS.ProcessEnv, coordRoot });
    expect(r.items).toHaveLength(3);
    const titles = r.items.map((t) => t.title).sort();
    expect(titles).toEqual(['alice-1', 'alice-2', 'bob-1']);
  });

  it('sorted by (identity, filename)', () => {
    const r = cmdTasks({ env: {} as NodeJS.ProcessEnv, coordRoot });
    const grouped = r.items.map((t) => t.identity);
    expect(grouped).toEqual(['alice', 'alice', 'bob']);
  });

  it('positional identity scopes to that identity', () => {
    const r = cmdTasks({
      identity: 'alice',
      env: {} as NodeJS.ProcessEnv,
      coordRoot,
    });
    expect(r.items.map((t) => t.title).sort()).toEqual(['alice-1', 'alice-2']);
  });

  it('identity with no tasks/ folder is absent (no throw)', () => {
    const r = cmdTasks({
      identity: 'carol',
      env: {} as NodeJS.ProcessEnv,
      coordRoot,
    });
    expect(r.items).toEqual([]);
  });

  it('filters compose: status + priority', () => {
    // Switch alice-1 to doing.
    const all = cmdTasks({ env: {} as NodeJS.ProcessEnv, coordRoot }).items;
    const alice1 = all.find((t) => t.title === 'alice-1')!;
    cmdTaskStatus({
      filename: alice1.filename,
      state: 'doing',
      env: envFor('alice'),
      coordRoot,
    });
    const doing = cmdTasks({
      status: 'doing',
      priority: 'high',
      env: {} as NodeJS.ProcessEnv,
      coordRoot,
    });
    expect(doing.items.map((t) => t.title)).toEqual(['alice-1']);
  });

  it('--tag filter', () => {
    const r = cmdTasks({
      tag: 'x',
      env: {} as NodeJS.ProcessEnv,
      coordRoot,
    });
    expect(r.items.map((t) => t.title)).toEqual(['alice-2']);
  });

  it('--include-body=false (default in --json path) strips body', () => {
    const r = cmdTasks({
      includeBody: false,
      env: {} as NodeJS.ProcessEnv,
      coordRoot,
    });
    for (const t of r.items) expect(t.body).toBe('');
  });

  it('--include-body=true preserves body', () => {
    const r = cmdTasks({
      includeBody: true,
      env: {} as NodeJS.ProcessEnv,
      coordRoot,
    });
    for (const t of r.items) expect(t.body.length).toBeGreaterThan(0);
  });

  it('invalid identity → InvalidIdentityError', () => {
    expect(() =>
      cmdTasks({
        identity: 'NOT-AN-IDENTITY',
        env: {} as NodeJS.ProcessEnv,
        coordRoot,
      })
    ).toThrowError(/invalid identity/i);
  });

  it('items carry the expected fields', () => {
    const r = cmdTasks({
      identity: 'alice',
      includeBody: true,
      env: {} as NodeJS.ProcessEnv,
      coordRoot,
    });
    const t = r.items[0]!;
    expect(t.identity).toBe('alice');
    expect(typeof t.filename).toBe('string');
    expect(typeof t.title).toBe('string');
    expect(typeof t.status).toBe('string');
    expect(Array.isArray(t.tags)).toBe(true);
    expect(typeof t.body).toBe('string');
    // priority and due are nullable; check the key exists at least.
    expect('priority' in t).toBe(true);
    expect('due' in t).toBe(true);
  });

  it('missing tasks/ for an identity does not interfere with siblings', () => {
    // Carol has no tasks/. The cross-tree call still returns alice + bob.
    const r = cmdTasks({ env: {} as NodeJS.ProcessEnv, coordRoot });
    expect(r.items.map((t) => t.identity).sort()).toEqual([
      'alice',
      'alice',
      'bob',
    ]);
  });

  it('skips identities whose folder name fails validIdentity', () => {
    // Drop a junk folder name into the root — should be skipped.
    mkdirSync(join(coordRoot, 'NOT-VALID', 'tasks'), { recursive: true });
    writeFileSync(
      join(coordRoot, 'NOT-VALID', 'tasks', 'whatever.md'),
      '---\nstatus: todo\n---\n# x\n'
    );
    const r = cmdTasks({ env: {} as NodeJS.ProcessEnv, coordRoot });
    expect(r.items.every((t) => t.identity !== 'NOT-VALID')).toBe(true);
  });
});

// ─── tasksWatch — follow ───────────────────────────────────────────────

describe('tasksWatch — follow', () => {
  it('first tick seeds baseline silently; subsequent tick emits "added" on new files', async () => {
    setupIdentity('alice');
    const ac = new AbortController();
    const received: TasksWatchEvent[] = [];

    // Pre-existing task — should NOT be emitted (baseline).
    cmdTaskNew({
      title: 'baseline',
      env: envFor('alice'),
      coordRoot,
      noEdit: true,
    });

    const iter = tasksWatch({
      intervalMs: 20,
      signal: ac.signal,
      env: {} as NodeJS.ProcessEnv,
      coordRoot,
    });

    const consumer = (async () => {
      for await (const ev of iter) received.push(ev);
    })();

    // Give the iterator time to seed its baseline (first tick).
    await sleep(80);
    expect(received).toHaveLength(0);

    // Drop a new task — should emit "added" on the next tick.
    cmdTaskNew({
      title: 'new arrival',
      env: envFor('alice'),
      coordRoot,
      noEdit: true,
    });
    await sleep(200);
    ac.abort();
    await consumer;

    const added = received.filter((e) => e.kind === 'added');
    expect(added.length).toBeGreaterThanOrEqual(1);
    expect(added.some((e) => e.task.title === 'new arrival')).toBe(true);
  });

  it('emits "changed" when an existing file\'s mtime advances', async () => {
    setupIdentity('alice');
    const created = cmdTaskNew({
      title: 'will-change',
      env: envFor('alice'),
      coordRoot,
      noEdit: true,
    });

    const ac = new AbortController();
    const received: TasksWatchEvent[] = [];
    const iter = tasksWatch({
      intervalMs: 20,
      signal: ac.signal,
      env: {} as NodeJS.ProcessEnv,
      coordRoot,
    });
    const consumer = (async () => {
      for await (const ev of iter) received.push(ev);
    })();

    await sleep(80);
    // Bump mtime explicitly so the change shows up even if the
    // status mutation happens in the same ms as the baseline read.
    const newMtime = (Date.now() + 5000) / 1000;
    utimesSync(created.path, newMtime, newMtime);

    await sleep(200);
    ac.abort();
    await consumer;

    const changed = received.filter((e) => e.kind === 'changed');
    expect(changed.length).toBeGreaterThanOrEqual(1);
    expect(changed.some((e) => e.task.filename === created.filename)).toBe(
      true
    );
  });

  it('respects --status filter: tasks outside the filter aren\'t emitted', async () => {
    setupIdentity('alice');
    cmdTaskNew({
      title: 'baseline',
      env: envFor('alice'),
      coordRoot,
      noEdit: true,
    });

    const ac = new AbortController();
    const received: TasksWatchEvent[] = [];
    const iter = tasksWatch({
      status: 'doing',
      intervalMs: 20,
      signal: ac.signal,
      env: {} as NodeJS.ProcessEnv,
      coordRoot,
    });
    const consumer = (async () => {
      for await (const ev of iter) received.push(ev);
    })();

    await sleep(80);
    // Adds a todo task — should be filtered out.
    cmdTaskNew({
      title: 'a todo',
      env: envFor('alice'),
      coordRoot,
      noEdit: true,
    });
    await sleep(120);
    expect(received).toHaveLength(0);
    ac.abort();
    await consumer;
  });

  it('aborts cleanly via the AbortSignal', async () => {
    setupIdentity('alice');
    const ac = new AbortController();
    const iter = tasksWatch({
      intervalMs: 50,
      signal: ac.signal,
      env: {} as NodeJS.ProcessEnv,
      coordRoot,
    });
    const consumer = (async () => {
      // Drain the iterator. If abort doesn't actually stop it, the
      // promise will hang and the test will time out.
      for await (const _ of iter) {
        void _;
      }
    })();
    ac.abort();
    await consumer;
    // Reaches here = clean shutdown.
    expect(true).toBe(true);
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
