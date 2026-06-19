// tests/unit/task.test.ts — `coord task` (singular) verbs.
//
// Covers cmdTaskNew, cmdTaskLs, cmdTaskStatus, cmdTaskEdit against
// fixture coord roots. The editor spawn is mocked via the
// editorSpawn injection seam so no real $EDITOR fires.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  cmdTaskEdit,
  cmdTaskLs,
  cmdTaskNew,
  cmdTaskStatus,
} from '../../src/commands/task.ts';
import {
  InvalidTaskStateError,
  InvalidTaskTitleError,
  TaskNotFoundError,
  TasksSingleWriterError,
} from '../../src/errors.ts';

let scratch: string;
let coordRoot: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'coord-task-test-'));
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

// ─── cmdTaskNew ─────────────────────────────────────────────────────────

describe('cmdTaskNew — happy paths', () => {
  it('creates a file in <id>/tasks/ with correct frontmatter + body', () => {
    setupIdentity('alice');
    const r = cmdTaskNew({
      title: 'ship the auth fix',
      env: envFor('alice'),
      coordRoot,
      noEdit: true,
    });
    expect(r.filename).toMatch(/^[0-9]{13}-ship-the-auth-fix\.md$/);
    expect(r.identity).toBe('alice');
    const text = readFileSync(r.path, 'utf8');
    expect(text).toContain('status: todo');
    expect(text).toContain('# ship the auth fix');
  });

  it('emits priority, tags, due in frontmatter when provided', () => {
    setupIdentity('alice');
    const r = cmdTaskNew({
      title: 'fix login',
      priority: 'high',
      tags: ['auth', 'p1'],
      due: '2026-06-01',
      env: envFor('alice'),
      coordRoot,
      noEdit: true,
    });
    const text = readFileSync(r.path, 'utf8');
    expect(text).toContain('status: todo');
    expect(text).toContain('priority: high');
    expect(text).toContain('tags:');
    expect(text).toContain('auth');
    expect(text).toContain('p1');
    expect(text).toContain('due: 2026-06-01');
  });

  it('tags accepts a comma-separated string', () => {
    setupIdentity('alice');
    const r = cmdTaskNew({
      title: 't',
      tags: 'a,b,c',
      env: envFor('alice'),
      coordRoot,
      noEdit: true,
    });
    const text = readFileSync(r.path, 'utf8');
    expect(text).toContain('a');
    expect(text).toContain('b');
    expect(text).toContain('c');
  });

  // brief-017a bug 4: every input form must split-on-comma + trim +
  // drop empties, and the on-disk YAML must be a real flow sequence
  // (not a JSON-stringified scalar embedded in YAML).
  it('--tag a,b,c (string-array form, single element with commas) round-trips as three tags', () => {
    setupIdentity('alice');
    const r = cmdTaskNew({
      title: 't',
      // The CLI parser pushes `['a,b,c']` for `--tag a,b,c`. The
      // normalizer should split each element.
      tags: ['a,b,c'],
      env: envFor('alice'),
      coordRoot,
      noEdit: true,
    });
    const text = readFileSync(r.path, 'utf8');
    expect(text).toContain('tags: [a, b, c]');
    expect(text).not.toContain('a,b,c"');
    // Read-back through cmdTaskLs returns the three split tags.
    const items = cmdTaskLs({ env: envFor('alice'), coordRoot }).items;
    expect(items[0]!.tags).toEqual(['a', 'b', 'c']);
  });

  it('repeated --tag flags combine additively', () => {
    setupIdentity('alice');
    const r = cmdTaskNew({
      title: 't',
      tags: ['a', 'b'],
      env: envFor('alice'),
      coordRoot,
      noEdit: true,
    });
    const text = readFileSync(r.path, 'utf8');
    expect(text).toContain('tags: [a, b]');
    const items = cmdTaskLs({ env: envFor('alice'), coordRoot }).items;
    expect(items[0]!.tags).toEqual(['a', 'b']);
  });

  it('mixed --tag "a,b" --tag c form combines + splits', () => {
    setupIdentity('alice');
    cmdTaskNew({
      title: 't',
      tags: ['a,b', 'c'],
      env: envFor('alice'),
      coordRoot,
      noEdit: true,
    });
    const items = cmdTaskLs({ env: envFor('alice'), coordRoot }).items;
    expect(items[0]!.tags).toEqual(['a', 'b', 'c']);
  });

  it('whitespace around commas is trimmed', () => {
    setupIdentity('alice');
    cmdTaskNew({
      title: 't',
      tags: 'a, b ,c',
      env: envFor('alice'),
      coordRoot,
      noEdit: true,
    });
    const items = cmdTaskLs({ env: envFor('alice'), coordRoot }).items;
    expect(items[0]!.tags).toEqual(['a', 'b', 'c']);
  });

  it('--tag "" (empty) → no tags key written, items.tags is empty', () => {
    setupIdentity('alice');
    const r = cmdTaskNew({
      title: 't',
      tags: '',
      env: envFor('alice'),
      coordRoot,
      noEdit: true,
    });
    const text = readFileSync(r.path, 'utf8');
    expect(text).not.toContain('tags:');
    const items = cmdTaskLs({ env: envFor('alice'), coordRoot }).items;
    expect(items[0]!.tags).toEqual([]);
  });

  it('creates tasks/ folder lazily on first write', () => {
    setupIdentity('alice');
    expect(existsSync(join(coordRoot, 'alice', 'tasks'))).toBe(false);
    cmdTaskNew({
      title: 'first task',
      env: envFor('alice'),
      coordRoot,
      noEdit: true,
    });
    expect(existsSync(join(coordRoot, 'alice', 'tasks'))).toBe(true);
  });

  it('creates tasks/README.md stub on first write only', () => {
    setupIdentity('alice');
    cmdTaskNew({
      title: 'first',
      env: envFor('alice'),
      coordRoot,
      noEdit: true,
    });
    const readme = join(coordRoot, 'alice', 'tasks', 'README.md');
    expect(existsSync(readme)).toBe(true);
    const original = readFileSync(readme, 'utf8');
    expect(original).toContain("alice's tasks");
    // README is not regenerated on subsequent writes.
    writeFileSync(readme, '# overwritten by user\n');
    cmdTaskNew({
      title: 'second',
      env: envFor('alice'),
      coordRoot,
      noEdit: true,
    });
    expect(readFileSync(readme, 'utf8')).toBe('# overwritten by user\n');
  });

  it('--from-message seeds the body from <id>/inbox/<filename>', () => {
    setupIdentity('alice');
    writeFileSync(
      join(coordRoot, 'alice', 'inbox', '1714826789010-aaaaaa.md'),
      '---\nfrom: bob\n---\nplease investigate the login bug\n'
    );
    const r = cmdTaskNew({
      title: 'investigate login bug',
      fromMessage: '1714826789010-aaaaaa.md',
      env: envFor('alice'),
      coordRoot,
      noEdit: true,
    });
    const text = readFileSync(r.path, 'utf8');
    expect(text).toContain('# investigate login bug');
    expect(text).toContain('please investigate the login bug');
  });

  it('--from-message falls back to archive/ when not in inbox/', () => {
    setupIdentity('alice');
    writeFileSync(
      join(coordRoot, 'alice', 'archive', '1714826789010-aaaaaa.md'),
      '---\nfrom: bob\n---\nold archived msg\n'
    );
    const r = cmdTaskNew({
      title: 'follow up',
      fromMessage: '1714826789010-aaaaaa.md',
      env: envFor('alice'),
      coordRoot,
      noEdit: true,
    });
    const text = readFileSync(r.path, 'utf8');
    expect(text).toContain('old archived msg');
  });

  it('--from-message with non-existent filename → empty body (permissive)', () => {
    setupIdentity('alice');
    const r = cmdTaskNew({
      title: 'orphan',
      fromMessage: '1714826789999-zzzzzz.md',
      env: envFor('alice'),
      coordRoot,
      noEdit: true,
    });
    const text = readFileSync(r.path, 'utf8');
    expect(text).toContain('# orphan');
  });

  it('opens $EDITOR by default (via injected spawn)', () => {
    setupIdentity('alice');
    const spawned: Array<{ editor: string; path: string }> = [];
    const r = cmdTaskNew({
      title: 'edit me',
      env: { COORD_IDENTITY: 'alice', EDITOR: 'vi' } as NodeJS.ProcessEnv,
      coordRoot,
      editorSpawn: (editor, path) => {
        spawned.push({ editor, path });
      },
    });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.editor).toBe('vi');
    expect(spawned[0]!.path).toBe(r.path);
  });

  it('--no-edit suppresses the editor spawn', () => {
    setupIdentity('alice');
    const spy = vi.fn();
    cmdTaskNew({
      title: 'no edit',
      env: { COORD_IDENTITY: 'alice', EDITOR: 'vi' } as NodeJS.ProcessEnv,
      coordRoot,
      noEdit: true,
      editorSpawn: spy,
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('no $EDITOR or $VISUAL → no spawn, no error', () => {
    setupIdentity('alice');
    const spy = vi.fn();
    cmdTaskNew({
      title: 'silent',
      env: envFor('alice'),
      coordRoot,
      editorSpawn: spy,
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('falls back to $VISUAL when $EDITOR is unset', () => {
    setupIdentity('alice');
    const spawned: Array<{ editor: string }> = [];
    cmdTaskNew({
      title: 'visual',
      env: { COORD_IDENTITY: 'alice', VISUAL: 'emacs' } as NodeJS.ProcessEnv,
      coordRoot,
      editorSpawn: (editor) => {
        spawned.push({ editor });
      },
    });
    expect(spawned[0]!.editor).toBe('emacs');
  });
});

describe('cmdTaskNew — slug derivation', () => {
  it('lowercases and hyphenates', () => {
    setupIdentity('alice');
    const r = cmdTaskNew({
      title: 'Ship The Auth Fix',
      env: envFor('alice'),
      coordRoot,
      noEdit: true,
    });
    expect(r.filename).toMatch(/-ship-the-auth-fix\.md$/);
  });

  it('truncates to 32 characters', () => {
    setupIdentity('alice');
    const r = cmdTaskNew({
      title: 'this title is significantly longer than thirty two chars',
      env: envFor('alice'),
      coordRoot,
      noEdit: true,
    });
    const slug = r.filename.slice(14).replace(/\.md$/, '');
    expect(slug.length).toBeLessThanOrEqual(32);
  });

  it('collapses runs of non-alphanumerics into a single hyphen', () => {
    setupIdentity('alice');
    const r = cmdTaskNew({
      title: 'foo!!!  bar  ???baz',
      env: envFor('alice'),
      coordRoot,
      noEdit: true,
    });
    expect(r.filename).toMatch(/-foo-bar-baz\.md$/);
  });

  it('strips leading/trailing hyphens', () => {
    setupIdentity('alice');
    const r = cmdTaskNew({
      title: '!!!leading and trailing!!!',
      env: envFor('alice'),
      coordRoot,
      noEdit: true,
    });
    const slug = r.filename.slice(14).replace(/\.md$/, '');
    expect(slug).not.toMatch(/^-/);
    expect(slug).not.toMatch(/-$/);
  });

  it('empty title → InvalidTaskTitleError', () => {
    setupIdentity('alice');
    expect(() =>
      cmdTaskNew({
        title: '',
        env: envFor('alice'),
        coordRoot,
        noEdit: true,
      })
    ).toThrowError(InvalidTaskTitleError);
  });

  it('title that slugifies to empty (all punctuation) → InvalidTaskTitleError', () => {
    setupIdentity('alice');
    expect(() =>
      cmdTaskNew({
        title: '!!! !!! !!!',
        env: envFor('alice'),
        coordRoot,
        noEdit: true,
      })
    ).toThrowError(InvalidTaskTitleError);
  });
});

// ─── cmdTaskLs ─────────────────────────────────────────────────────────

describe('cmdTaskLs — list + filter', () => {
  beforeEach(() => {
    setupIdentity('alice');
    cmdTaskNew({
      title: 'a',
      priority: 'high',
      tags: ['x', 'y'],
      env: envFor('alice'),
      coordRoot,
      noEdit: true,
    });
    cmdTaskNew({
      title: 'b',
      priority: 'low',
      tags: ['y'],
      env: envFor('alice'),
      coordRoot,
      noEdit: true,
    });
    cmdTaskNew({
      title: 'c',
      env: envFor('alice'),
      coordRoot,
      noEdit: true,
    });
  });

  it('lists every task by default', () => {
    const r = cmdTaskLs({ env: envFor('alice'), coordRoot });
    expect(r.items).toHaveLength(3);
    expect(r.items.map((t) => t.title).sort()).toEqual(['a', 'b', 'c']);
  });

  it('filters by status', () => {
    // All three are status=todo; switch one to doing.
    const all = cmdTaskLs({ env: envFor('alice'), coordRoot }).items;
    cmdTaskStatus({
      filename: all[0]!.filename,
      state: 'doing',
      env: envFor('alice'),
      coordRoot,
    });
    const doing = cmdTaskLs({
      status: 'doing',
      env: envFor('alice'),
      coordRoot,
    });
    expect(doing.items).toHaveLength(1);
    const todo = cmdTaskLs({
      status: 'todo',
      env: envFor('alice'),
      coordRoot,
    });
    expect(todo.items).toHaveLength(2);
  });

  it('filters by priority', () => {
    const high = cmdTaskLs({
      priority: 'high',
      env: envFor('alice'),
      coordRoot,
    });
    expect(high.items.map((t) => t.title)).toEqual(['a']);
  });

  it('filters by tag', () => {
    const xs = cmdTaskLs({ tag: 'x', env: envFor('alice'), coordRoot });
    expect(xs.items.map((t) => t.title)).toEqual(['a']);
    const ys = cmdTaskLs({ tag: 'y', env: envFor('alice'), coordRoot });
    expect(ys.items.map((t) => t.title).sort()).toEqual(['a', 'b']);
  });

  it('composes filters (priority + tag)', () => {
    const r = cmdTaskLs({
      priority: 'low',
      tag: 'y',
      env: envFor('alice'),
      coordRoot,
    });
    expect(r.items.map((t) => t.title)).toEqual(['b']);
  });

  it('missing tasks/ folder → empty list, no throw', () => {
    setupIdentity('bob');
    const r = cmdTaskLs({ env: envFor('bob'), coordRoot });
    expect(r.items).toEqual([]);
  });

  it('skips README.md and non-.md files', () => {
    // README is created lazily; add a noise file too.
    writeFileSync(join(coordRoot, 'alice', 'tasks', 'noise.txt'), 'x');
    const r = cmdTaskLs({ env: envFor('alice'), coordRoot });
    expect(r.items.every((t) => t.filename.endsWith('.md'))).toBe(true);
    expect(r.items.every((t) => t.filename !== 'README.md')).toBe(true);
  });
});

// ─── cmdTaskStatus / done ──────────────────────────────────────────────

describe('cmdTaskStatus', () => {
  it('updates status: in-place; preserves other frontmatter', () => {
    setupIdentity('alice');
    const created = cmdTaskNew({
      title: 'work',
      priority: 'high',
      tags: ['x'],
      due: '2026-06-01',
      env: envFor('alice'),
      coordRoot,
      noEdit: true,
    });
    const r = cmdTaskStatus({
      filename: created.filename,
      state: 'doing',
      env: envFor('alice'),
      coordRoot,
    });
    expect(r.previousStatus).toBe('todo');
    expect(r.newStatus).toBe('doing');
    const text = readFileSync(created.path, 'utf8');
    expect(text).toContain('status: doing');
    expect(text).toContain('priority: high');
    expect(text).toContain('due: 2026-06-01');
  });

  it('rejects invalid states', () => {
    setupIdentity('alice');
    const created = cmdTaskNew({
      title: 't',
      env: envFor('alice'),
      coordRoot,
      noEdit: true,
    });
    expect(() =>
      cmdTaskStatus({
        filename: created.filename,
        state: 'WAT',
        env: envFor('alice'),
        coordRoot,
      })
    ).toThrowError(InvalidTaskStateError);
  });

  it('accepts all four LAYOUT states', () => {
    setupIdentity('alice');
    const created = cmdTaskNew({
      title: 't',
      env: envFor('alice'),
      coordRoot,
      noEdit: true,
    });
    for (const state of ['todo', 'doing', 'done', 'blocked'] as const) {
      expect(() =>
        cmdTaskStatus({
          filename: created.filename,
          state,
          env: envFor('alice'),
          coordRoot,
        })
      ).not.toThrow();
    }
  });

  it('non-existent filename → TaskNotFoundError', () => {
    setupIdentity('alice');
    // Need a tasks/ folder to exist (the resolver checks
    // inbox/archive but not tasks; the file-existence is what fails).
    mkdirSync(join(coordRoot, 'alice', 'tasks'), { recursive: true });
    expect(() =>
      cmdTaskStatus({
        filename: 'ghost.md',
        state: 'done',
        env: envFor('alice'),
        coordRoot,
      })
    ).toThrowError(TaskNotFoundError);
  });

  it('filename that belongs to another identity → TasksSingleWriterError', () => {
    setupIdentity('alice');
    setupIdentity('bob');
    const aliceTask = cmdTaskNew({
      title: 'mine',
      env: envFor('alice'),
      coordRoot,
      noEdit: true,
    });
    // bob attempts to mutate alice's task — implicitly via his own
    // COORD_IDENTITY. Look-up scans cross-tree and reports owner.
    let caught: TasksSingleWriterError | undefined;
    try {
      cmdTaskStatus({
        filename: aliceTask.filename,
        state: 'doing',
        env: envFor('bob'),
        coordRoot,
      });
    } catch (e) {
      caught = e as TasksSingleWriterError;
    }
    expect(caught).toBeInstanceOf(TasksSingleWriterError);
    expect(caught?.ownerIdentity).toBe('alice');
    expect(caught?.identity).toBe('bob');
  });
});

// ─── cmdTaskEdit ───────────────────────────────────────────────────────

describe('cmdTaskEdit', () => {
  it('invokes $EDITOR on the named task file', () => {
    setupIdentity('alice');
    const created = cmdTaskNew({
      title: 'edit-me',
      env: envFor('alice'),
      coordRoot,
      noEdit: true,
    });
    const spawned: Array<{ editor: string; path: string }> = [];
    cmdTaskEdit({
      filename: created.filename,
      env: { COORD_IDENTITY: 'alice', EDITOR: 'vi' } as NodeJS.ProcessEnv,
      coordRoot,
      editorSpawn: (editor, path) => {
        spawned.push({ editor, path });
      },
    });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.path).toBe(created.path);
  });

  it('non-existent filename → TaskNotFoundError', () => {
    setupIdentity('alice');
    mkdirSync(join(coordRoot, 'alice', 'tasks'), { recursive: true });
    expect(() =>
      cmdTaskEdit({
        filename: 'ghost.md',
        env: envFor('alice'),
        coordRoot,
      })
    ).toThrowError(TaskNotFoundError);
  });

  it('filename that belongs to another identity → TasksSingleWriterError', () => {
    setupIdentity('alice');
    setupIdentity('bob');
    const aliceTask = cmdTaskNew({
      title: 'mine',
      env: envFor('alice'),
      coordRoot,
      noEdit: true,
    });
    expect(() =>
      cmdTaskEdit({
        filename: aliceTask.filename,
        env: envFor('bob'),
        coordRoot,
      })
    ).toThrowError(TasksSingleWriterError);
  });
});

// ─── Concurrent status writes don't corrupt ────────────────────────────

describe('cmdTaskStatus — concurrency', () => {
  it('two rapid status flips both succeed; final file is well-formed', () => {
    setupIdentity('alice');
    const created = cmdTaskNew({
      title: 'flip',
      env: envFor('alice'),
      coordRoot,
      noEdit: true,
    });
    // Sync, sequential — but atomic temp+rename guarantees the file
    // is never partially written.
    cmdTaskStatus({
      filename: created.filename,
      state: 'doing',
      env: envFor('alice'),
      coordRoot,
    });
    cmdTaskStatus({
      filename: created.filename,
      state: 'done',
      env: envFor('alice'),
      coordRoot,
    });
    const text = readFileSync(created.path, 'utf8');
    expect(text).toMatch(/^---\n/);
    expect(text).toContain('status: done');
    // No leftover temp files in the tasks dir.
    const remaining = readdirSync(
      join(coordRoot, 'alice', 'tasks')
    ).filter((f) => f.includes('.tmp-'));
    expect(remaining).toEqual([]);
  });
});

// ─── Mark vi.fn import as used for the strict-types check ─────────────
void vi;
