// tests/unit/journal.test.ts — brief-024 journal/ folder verbs.
//
// Covers the four cmdJournal* functions and their CLI wrappers. The
// reserved-name check (validIdentity('journal') → false) lives in
// tests/unit/common.test.ts since it's a property of the central
// validator, not journal-specific.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CliContext } from '../../src/cli-context.ts';
import {
  cmdJournalCat,
  cmdJournalCli,
  cmdJournalLs,
  cmdJournalNew,
  cmdJournalTail,
} from '../../src/commands/journal.ts';

const JOURNAL_FILENAME_RE = /^[0-9]{13}-[A-Za-z0-9._-]+\.md$/;

let scratch: string;
let coordRoot: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'coord-journal-'));
  coordRoot = join(scratch, 'coord');
  for (const id of ['alice', 'bob']) {
    mkdirSync(join(coordRoot, id, 'inbox'), { recursive: true });
    mkdirSync(join(coordRoot, id, 'archive'), { recursive: true });
  }
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function envCtx(identity: string): NodeJS.ProcessEnv {
  return { COORD_IDENTITY: identity } as NodeJS.ProcessEnv;
}

interface RecordedCtx extends CliContext {
  stdoutBuf: string;
  stderrBuf: string;
}

function makeCliCtx(identity: string, stdin = ''): RecordedCtx {
  const stdoutBuf = { v: '' };
  const stderrBuf = { v: '' };
  const ctx: RecordedCtx = {
    env: envCtx(identity),
    coordRoot,
    coordConfig: join(scratch, 'config'),
    stdout: (s) => {
      stdoutBuf.v += s;
    },
    stderr: (s) => {
      stderrBuf.v += s;
    },
    readStdin: async () => Buffer.from(stdin, 'utf8'),
    // expose the buffers via getters so tests can read after the call
    get stdoutBuf() {
      return stdoutBuf.v;
    },
    get stderrBuf() {
      return stderrBuf.v;
    },
  } as RecordedCtx;
  return ctx;
}

// ─── cmdJournalNew ──────────────────────────────────────────────────────

describe('cmdJournalNew — happy path', () => {
  it('writes <unix-ms>-<slug>.md under <self>/journal/', () => {
    const r = cmdJournalNew({
      body: 'started brief-023; designed the 5min refresh loop',
      env: envCtx('alice'),
      coordRoot,
    });
    expect(r.identity).toBe('alice');
    expect(r.filename).toMatch(JOURNAL_FILENAME_RE);
    expect(existsSync(r.path)).toBe(true);
    expect(r.path).toContain(join(coordRoot, 'alice', 'journal'));
  });

  it('derives the slug from the body when --slug is not given (brief example)', () => {
    const r = cmdJournalNew({
      body: 'fixed the auth bug at last',
      env: envCtx('alice'),
      coordRoot,
    });
    expect(r.filename).toMatch(/^\d{13}-fixed-the-auth-bug-at-last\.md$/);
  });

  it('honors an explicit --slug override', () => {
    const r = cmdJournalNew({
      body: 'long detailed body text that would otherwise slugify',
      slug: 'brief-022-status-refresh',
      env: envCtx('alice'),
      coordRoot,
    });
    expect(r.filename).toMatch(/^\d{13}-brief-022-status-refresh\.md$/);
  });

  it('writes body without frontmatter when no topic/tags supplied', () => {
    const r = cmdJournalNew({
      body: 'minimal entry',
      env: envCtx('alice'),
      coordRoot,
    });
    const text = readFileSync(r.path, 'utf8');
    expect(text.startsWith('---')).toBe(false);
    expect(text.trim()).toBe('minimal entry');
  });

  it('topic + tags round-trip through frontmatter when supplied', () => {
    const r = cmdJournalNew({
      body: 'wired up the refresh tick',
      topic: 'mcp-refresh',
      tags: ['mcp', 'status'],
      env: envCtx('alice'),
      coordRoot,
    });
    const text = readFileSync(r.path, 'utf8');
    expect(text).toContain('---');
    expect(text).toContain('topic: mcp-refresh');
    expect(text).toContain('tags: [mcp, status]');
    expect(text).toContain('wired up the refresh tick');
  });

  it('rejects an empty body', () => {
    expect(() =>
      cmdJournalNew({ body: '   \n\t', env: envCtx('alice'), coordRoot })
    ).toThrow(/non-empty/);
  });
});

// ─── cmdJournalLs ───────────────────────────────────────────────────────

describe('cmdJournalLs — listing', () => {
  it('returns entries newest-first', () => {
    // Plant three entries with distinct timestamps in non-chronological
    // call order so we exercise the sort path.
    const dir = join(coordRoot, 'alice', 'journal');
    mkdirSync(dir);
    writeFileSync(join(dir, '1714826789020-second.md'), 'second\n');
    writeFileSync(join(dir, '1714826789030-third.md'), 'third\n');
    writeFileSync(join(dir, '1714826789010-first.md'), 'first\n');

    const r = cmdJournalLs({ env: envCtx('alice'), coordRoot });
    expect(r.filenames).toEqual([
      '1714826789030-third.md',
      '1714826789020-second.md',
      '1714826789010-first.md',
    ]);
  });

  it('cross-identity read on missing journal/ → empty list, no throw', () => {
    // bob has no journal/ folder at all. Reading from alice's
    // perspective should be a quiet empty result, not an error —
    // mirrors `coord task ls` shape so probing peers is safe.
    const r = cmdJournalLs({
      identity: 'bob',
      env: envCtx('alice'),
      coordRoot,
    });
    expect(r.identity).toBe('bob');
    expect(r.filenames).toEqual([]);
  });

  it('--since filters by filename ts (inclusive lower bound)', () => {
    const dir = join(coordRoot, 'alice', 'journal');
    mkdirSync(dir);
    writeFileSync(join(dir, '1714826789010-a.md'), 'a\n');
    writeFileSync(join(dir, '1714826789020-b.md'), 'b\n');
    writeFileSync(join(dir, '1714826789030-c.md'), 'c\n');
    const r = cmdJournalLs({
      since: 1714826789020,
      env: envCtx('alice'),
      coordRoot,
    });
    expect(r.filenames).toEqual([
      '1714826789030-c.md',
      '1714826789020-b.md',
    ]);
  });

  it('non-grammar files in journal/ are silently skipped', () => {
    const dir = join(coordRoot, 'alice', 'journal');
    mkdirSync(dir);
    writeFileSync(join(dir, '1714826789010-good.md'), 'ok\n');
    writeFileSync(join(dir, 'README.md'), 'docs\n');
    writeFileSync(join(dir, 'no-prefix.md'), 'nope\n');
    const r = cmdJournalLs({ env: envCtx('alice'), coordRoot });
    expect(r.filenames).toEqual(['1714826789010-good.md']);
  });
});

// ─── cmdJournalCat / cmdJournalTail ────────────────────────────────────

describe('cmdJournalCat / cmdJournalTail', () => {
  it('cat reads one entry; tail -n returns N newest with bodies', () => {
    const a = cmdJournalNew({
      body: 'first',
      env: envCtx('alice'),
      coordRoot,
    });
    // ensure distinct timestamps in case Date.now() ties on fast hardware
    const sleep = (n: number) => {
      const until = Date.now() + n;
      while (Date.now() < until) {
        /* spin */
      }
    };
    sleep(2);
    const b = cmdJournalNew({
      body: 'second',
      env: envCtx('alice'),
      coordRoot,
    });
    sleep(2);
    const c = cmdJournalNew({
      body: 'third',
      env: envCtx('alice'),
      coordRoot,
    });

    const cat = cmdJournalCat({
      filename: b.filename,
      env: envCtx('alice'),
      coordRoot,
    });
    expect(cat.body.trim()).toBe('second');

    const tail = cmdJournalTail({
      n: 2,
      env: envCtx('alice'),
      coordRoot,
    });
    expect(tail.entries.map((e) => e.filename)).toEqual([c.filename, b.filename]);
    expect(tail.entries[0]?.body.trim()).toBe('third');
    // Silence-unused: keep `a` referenced for clarity that it was written.
    expect(a.filename).toBeTruthy();
  });

  it('cat on a nonexistent filename errors loudly', () => {
    expect(() =>
      cmdJournalCat({
        filename: '1714826789010-nonexistent.md',
        env: envCtx('alice'),
        coordRoot,
      })
    ).toThrow(/not found/i);
  });

  it('cat rejects a malformed filename', () => {
    expect(() =>
      cmdJournalCat({
        filename: 'garbage',
        env: envCtx('alice'),
        coordRoot,
      })
    ).toThrow(/invalid journal filename/i);
  });
});

// ─── CLI dispatcher ─────────────────────────────────────────────────────

describe('coord journal CLI', () => {
  it('`new` accepts --stdin for body input', async () => {
    const ctx = makeCliCtx('alice', 'piped body via stdin');
    const rc = await cmdJournalCli(['new', '--stdin'], ctx);
    expect(rc).toBe(0);
    // Output is the filename
    expect(ctx.stdoutBuf.trim()).toMatch(JOURNAL_FILENAME_RE);
  });

  it('`new --from` is rejected as an unknown flag (single-writer guard)', async () => {
    // brief-024 boundary: the owner of journal/ is always
    // $COORD_IDENTITY. There's no cross-identity write path; adding
    // a --from override would let an agent forge entries on a
    // peer's behalf, which is the same anti-pattern the tasks
    // single-writer rule forbids.
    const ctx = makeCliCtx('alice', '');
    await expect(
      cmdJournalCli(['new', '--from', 'bob', 'forge'], ctx)
    ).rejects.toThrow(/unknown flag.*--from/);
  });

  it('`ls` with no args writes filenames to stdout, newest-first', async () => {
    cmdJournalNew({ body: 'a', env: envCtx('alice'), coordRoot });
    cmdJournalNew({ body: 'b', env: envCtx('alice'), coordRoot });
    const ctx = makeCliCtx('alice');
    const rc = await cmdJournalCli(['ls'], ctx);
    expect(rc).toBe(0);
    const lines = ctx.stdoutBuf.trim().split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line).toMatch(JOURNAL_FILENAME_RE);
  });

  it('`tail -n 1` prints body inline under a divider', async () => {
    cmdJournalNew({
      body: 'wrapped the refresh tick',
      env: envCtx('alice'),
      coordRoot,
    });
    const ctx = makeCliCtx('alice');
    const rc = await cmdJournalCli(['tail', '-n', '1'], ctx);
    expect(rc).toBe(0);
    expect(ctx.stdoutBuf).toMatch(/── \d{13}-/);
    expect(ctx.stdoutBuf).toContain('wrapped the refresh tick');
  });
});
