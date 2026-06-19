// tests/integration/tasks.test.ts — end-to-end `coord task` / `coord tasks`
// via the real bin/coord child-process surface.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cleanupRoot,
  mkIdentity,
  mkRoot,
  runCoord,
} from './helpers.ts';

let root: string;

beforeEach(() => {
  root = mkRoot();
});
afterEach(() => {
  cleanupRoot(root);
});

function tasksFile(identity: string, filename: string): string {
  return readFileSync(join(root, identity, 'tasks', filename), 'utf8');
}

function tasksList(identity: string): string[] {
  const dir = join(root, identity, 'tasks');
  if (!existsSync(dir)) return [];
  return readdirSync(dir);
}

// ─── coord task new ─────────────────────────────────────────────────────

describe('coord task new (CLI)', () => {
  it('creates a file in <id>/tasks/ with the right frontmatter + body', () => {
    mkIdentity(root, 'alice');
    const r = runCoord(
      ['task', 'new', 'ship the auth fix', '--priority', 'high', '--no-edit'],
      { coordRoot: root, coordIdentity: 'alice' }
    );
    expect(r.exitCode).toBe(0);
    const filename = r.stdout.trim();
    expect(filename).toMatch(/^[0-9]{13}-ship-the-auth-fix\.md$/);
    const text = tasksFile('alice', filename);
    expect(text).toContain('status: todo');
    expect(text).toContain('priority: high');
    expect(text).toContain('# ship the auth fix');
    // README.md is created lazily on first task write.
    expect(existsSync(join(root, 'alice', 'tasks', 'README.md'))).toBe(true);
  });

  it('emits the filename to stdout for piping', () => {
    mkIdentity(root, 'alice');
    const r = runCoord(
      ['task', 'new', 'pipe target', '--no-edit'],
      { coordRoot: root, coordIdentity: 'alice' }
    );
    expect(r.stdout.trim()).toMatch(/^[0-9]{13}-pipe-target\.md$/);
  });

  it('--from-message seeds the body from <id>/inbox/<filename>', () => {
    mkIdentity(root, 'alice');
    writeFileSync(
      join(root, 'alice', 'inbox', '1714826789010-aaaaaa.md'),
      '---\nfrom: bob\n---\nhi alice, please look at the login bug.\n'
    );
    const r = runCoord(
      [
        'task',
        'new',
        'investigate login bug',
        '--from-message',
        '1714826789010-aaaaaa.md',
        '--no-edit',
      ],
      { coordRoot: root, coordIdentity: 'alice' }
    );
    expect(r.exitCode).toBe(0);
    const filename = r.stdout.trim();
    const text = tasksFile('alice', filename);
    expect(text).toContain('# investigate login bug');
    expect(text).toContain('hi alice, please look at the login bug.');
  });
});

// ─── coord task status / done ──────────────────────────────────────────

describe('coord task status (CLI)', () => {
  it('flips status to "doing"; coord tasks --status doing surfaces it', () => {
    mkIdentity(root, 'alice');
    const newR = runCoord(
      ['task', 'new', 'a doing task', '--no-edit'],
      { coordRoot: root, coordIdentity: 'alice' }
    );
    const filename = newR.stdout.trim();
    const statusR = runCoord(
      ['task', 'status', filename, 'doing'],
      { coordRoot: root, coordIdentity: 'alice' }
    );
    expect(statusR.exitCode).toBe(0);
    expect(statusR.stdout).toMatch(/todo → doing/);

    const lsR = runCoord(
      ['tasks', 'alice', '--status', 'doing'],
      { coordRoot: root }
    );
    expect(lsR.exitCode).toBe(0);
    expect(lsR.stdout).toContain(filename);
    expect(lsR.stdout).toContain('a doing task');
  });

  it('coord task done is the same as status <f> done', () => {
    mkIdentity(root, 'alice');
    const filename = runCoord(
      ['task', 'new', 'wrap it up', '--no-edit'],
      { coordRoot: root, coordIdentity: 'alice' }
    ).stdout.trim();
    const r = runCoord(['task', 'done', filename], {
      coordRoot: root,
      coordIdentity: 'alice',
    });
    expect(r.exitCode).toBe(0);
    expect(tasksFile('alice', filename)).toContain('status: done');
  });
});

// ─── Cross-identity read + write protection ────────────────────────────

describe('coord tasks (CLI) cross-identity', () => {
  it('bob can read alice\'s tasks via coord tasks alice', () => {
    mkIdentity(root, 'alice');
    mkIdentity(root, 'bob');
    const aliceFile = runCoord(
      ['task', 'new', 'alice has work', '--no-edit'],
      { coordRoot: root, coordIdentity: 'alice' }
    ).stdout.trim();

    const r = runCoord(['tasks', 'alice'], {
      coordRoot: root,
      coordIdentity: 'bob',
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(aliceFile);
    expect(r.stdout).toContain('alice has work');
  });

  it("bob attempting to mutate alice's task → exit !=0 with single-writer message", () => {
    mkIdentity(root, 'alice');
    mkIdentity(root, 'bob');
    const aliceFile = runCoord(
      ['task', 'new', 'alice keeps this', '--no-edit'],
      { coordRoot: root, coordIdentity: 'alice' }
    ).stdout.trim();

    const r = runCoord(
      ['task', 'status', aliceFile, 'doing'],
      { coordRoot: root, coordIdentity: 'bob' }
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/single-writer/);
    expect(r.stderr).toContain('alice');
    // Alice's file is unmodified.
    expect(tasksFile('alice', aliceFile)).toContain('status: todo');
  });

  it('coord tasks (no arg) walks every identity', () => {
    mkIdentity(root, 'alice');
    mkIdentity(root, 'bob');
    runCoord(['task', 'new', 'a1', '--no-edit'], {
      coordRoot: root,
      coordIdentity: 'alice',
    });
    runCoord(['task', 'new', 'b1', '--no-edit'], {
      coordRoot: root,
      coordIdentity: 'bob',
    });
    const r = runCoord(['tasks'], { coordRoot: root });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('alice\t');
    expect(r.stdout).toContain('bob\t');
    expect(r.stdout).toContain('a1');
    expect(r.stdout).toContain('b1');
  });

  it('coord tasks --json is parseable and carries the shape the brief specifies', () => {
    mkIdentity(root, 'alice');
    runCoord(
      ['task', 'new', 'json target', '--priority', 'high', '--no-edit'],
      { coordRoot: root, coordIdentity: 'alice' }
    );
    const r = runCoord(['tasks', '--json'], { coordRoot: root });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(1);
    const item = parsed[0]!;
    expect(item.identity).toBe('alice');
    expect(item.title).toBe('json target');
    expect(item.status).toBe('todo');
    expect(item.priority).toBe('high');
    // --include-body NOT passed → no body field.
    expect(item).not.toHaveProperty('body');
  });

  it('coord tasks --json --include-body returns the body', () => {
    mkIdentity(root, 'alice');
    runCoord(
      ['task', 'new', 'with body', '--no-edit'],
      { coordRoot: root, coordIdentity: 'alice' }
    );
    const r = runCoord(['tasks', '--json', '--include-body'], {
      coordRoot: root,
    });
    const parsed = JSON.parse(r.stdout) as Array<Record<string, unknown>>;
    expect(parsed[0]!.body).toEqual(expect.any(String));
    expect(String(parsed[0]!.body)).toContain('# with body');
  });
});

// Mark tasksList as used so unused-vars stays quiet (referenced in
// the assertion above via readdirSync directly).
void tasksList;
