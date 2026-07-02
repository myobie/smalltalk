// tests/unit/context.test.ts — brief-024 context/ v1 core.
//
// Absent-able is the load-bearing property: every verb must handle a
// missing folder / missing files without crashing. That's what lets
// evals-claude's restart-continuity eval A/B a control arm (no
// context/) against a treatment arm that resumes.

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
  cmdContextAppend,
  cmdContextCli,
  cmdContextRead,
  cmdContextWrite,
} from '../../src/commands/context.ts';

let scratch: string;
let coordRoot: string;
let stdoutBuf: string;
let stderrBuf: string;
let ctx: CliContext;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'coord-context-test-'));
  coordRoot = join(scratch, 'coord');
  mkdirSync(coordRoot, { recursive: true });
  // Create alice's identity dirs so resolveIdentity is happy. The
  // context/ folder is intentionally absent — that's the point of the
  // absent-able tests.
  mkdirSync(join(coordRoot, 'alice', 'inbox'), { recursive: true });
  mkdirSync(join(coordRoot, 'alice', 'archive'), { recursive: true });
  stdoutBuf = '';
  stderrBuf = '';
  ctx = {
    env: { COORD_IDENTITY: 'alice' },
    coordRoot,
    coordConfig: '/unused',
    stdout: (s) => {
      stdoutBuf += s;
    },
    stderr: (s) => {
      stderrBuf += s;
    },
    readStdin: async () => Buffer.alloc(0),
  };
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// ─── absent-able: cold agent, no context/ folder ─────────────────────────

describe('cmdContextRead — absent-able', () => {
  it('missing context/ folder → text is empty, absent is true', () => {
    const r = cmdContextRead({
      env: ctx.env,
      coordRoot,
    });
    expect(r.identity).toBe('alice');
    expect(r.file).toBe('now');
    expect(r.text).toBe('');
    expect(r.absent).toBe(true);
    // Sanity: the read must NOT have created the folder — the eval's
    // control arm relies on "no context/" staying that way through a
    // read.
    expect(existsSync(join(coordRoot, 'alice', 'context'))).toBe(false);
  });

  it('--decisions on a missing folder returns empty', () => {
    const r = cmdContextRead({
      file: 'decisions',
      env: ctx.env,
      coordRoot,
    });
    expect(r.text).toBe('');
    expect(r.absent).toBe(true);
  });

  it('--full on a missing folder returns empty', () => {
    const r = cmdContextRead({
      file: 'full',
      env: ctx.env,
      coordRoot,
    });
    expect(r.text).toBe('');
    expect(r.absent).toBe(true);
  });

  it('--full with one file present is not absent', () => {
    mkdirSync(join(coordRoot, 'alice', 'context'));
    writeFileSync(
      join(coordRoot, 'alice', 'context', 'now.md'),
      'mid-task\n'
    );
    const r = cmdContextRead({
      file: 'full',
      env: ctx.env,
      coordRoot,
    });
    expect(r.absent).toBe(false);
    expect(r.text).toContain('# now.md');
    expect(r.text).toContain('mid-task');
    expect(r.text).not.toContain('# decisions.md');
  });
});

// ─── write: whole-file rewrite ───────────────────────────────────────────

describe('cmdContextWrite', () => {
  it('creates the context/ folder + writes now.md with a trailing newline', () => {
    const r = cmdContextWrite({
      body: 'brief-024 v1 in-flight',
      env: ctx.env,
      coordRoot,
    });
    expect(r.path).toBe(join(coordRoot, 'alice', 'context', 'now.md'));
    // Trailing newline enforced.
    const raw = readFileSync(r.path, 'utf8');
    expect(raw).toBe('brief-024 v1 in-flight\n');
    expect(r.bytes).toBe(raw.length);
  });

  it('preserves an existing trailing newline (no double-newline)', () => {
    const r = cmdContextWrite({
      body: 'already ends in newline\n',
      env: ctx.env,
      coordRoot,
    });
    expect(readFileSync(r.path, 'utf8')).toBe('already ends in newline\n');
  });

  it('overwrites now.md on a subsequent call (whole-file rewrite discipline)', () => {
    cmdContextWrite({
      body: 'first',
      env: ctx.env,
      coordRoot,
    });
    cmdContextWrite({
      body: 'second',
      env: ctx.env,
      coordRoot,
    });
    expect(
      readFileSync(join(coordRoot, 'alice', 'context', 'now.md'), 'utf8')
    ).toBe('second\n');
  });

  it('write does not touch decisions.md', () => {
    cmdContextWrite({
      body: 'now-only',
      env: ctx.env,
      coordRoot,
    });
    expect(
      existsSync(join(coordRoot, 'alice', 'context', 'decisions.md'))
    ).toBe(false);
  });

  it('does not leak the tmp file when the write succeeds', () => {
    cmdContextWrite({
      body: 'x',
      env: ctx.env,
      coordRoot,
    });
    const entries = require('node:fs').readdirSync(
      join(coordRoot, 'alice', 'context')
    ) as string[];
    // Only now.md; no `.context.tmp-*` sibling should remain.
    expect(entries.filter((n) => n.startsWith('.context.tmp'))).toEqual([]);
  });
});

// ─── append: bulleted decision log ───────────────────────────────────────

describe('cmdContextAppend', () => {
  const ts = '2026-07-02T22:00:00.000Z';

  it('creates decisions.md when absent and adds a bulleted line', () => {
    const r = cmdContextAppend({
      decision: 'pick auto as default',
      why: 'preserves pre-brief-023 behavior',
      timestamp: ts,
      env: ctx.env,
      coordRoot,
    });
    expect(r.path).toBe(
      join(coordRoot, 'alice', 'context', 'decisions.md')
    );
    expect(r.line).toBe(
      `- ${ts} pick auto as default. why: preserves pre-brief-023 behavior.`
    );
    expect(readFileSync(r.path, 'utf8')).toBe(r.line + '\n');
  });

  it('appends a second line without clobbering the first', () => {
    cmdContextAppend({
      decision: 'first',
      why: 'a',
      timestamp: ts,
      env: ctx.env,
      coordRoot,
    });
    cmdContextAppend({
      decision: 'second',
      why: 'b',
      timestamp: ts,
      env: ctx.env,
      coordRoot,
    });
    const raw = readFileSync(
      join(coordRoot, 'alice', 'context', 'decisions.md'),
      'utf8'
    );
    expect(raw).toBe(
      `- ${ts} first. why: a.\n- ${ts} second. why: b.\n`
    );
  });

  it('strips duplicate trailing period from decision + why', () => {
    const r = cmdContextAppend({
      decision: 'has a period.',
      why: 'also has a period.',
      timestamp: ts,
      env: ctx.env,
      coordRoot,
    });
    expect(r.line).toBe(
      `- ${ts} has a period. why: also has a period.`
    );
  });

  it('rejects empty decision or why', () => {
    expect(() =>
      cmdContextAppend({
        decision: '',
        why: 'reason',
        timestamp: ts,
        env: ctx.env,
        coordRoot,
      })
    ).toThrow(/--decision is required/);
    expect(() =>
      cmdContextAppend({
        decision: 'thing',
        why: '   ',
        timestamp: ts,
        env: ctx.env,
        coordRoot,
      })
    ).toThrow(/--why is required/);
  });

  it('rejects multi-line decision or why', () => {
    expect(() =>
      cmdContextAppend({
        decision: 'line one\nline two',
        why: 'reason',
        timestamp: ts,
        env: ctx.env,
        coordRoot,
      })
    ).toThrow(/single lines/);
  });

  it('append does not touch now.md', () => {
    cmdContextAppend({
      decision: 'thing',
      why: 'reason',
      timestamp: ts,
      env: ctx.env,
      coordRoot,
    });
    expect(
      existsSync(join(coordRoot, 'alice', 'context', 'now.md'))
    ).toBe(false);
  });

  it('appended lines survive after a now.md write (independent files)', () => {
    cmdContextAppend({
      decision: 'thing',
      why: 'reason',
      timestamp: ts,
      env: ctx.env,
      coordRoot,
    });
    cmdContextWrite({
      body: 'now',
      env: ctx.env,
      coordRoot,
    });
    const raw = readFileSync(
      join(coordRoot, 'alice', 'context', 'decisions.md'),
      'utf8'
    );
    expect(raw).toContain('thing. why: reason.');
  });
});

// ─── read after write / append ───────────────────────────────────────────

describe('cmdContextRead — after write / append', () => {
  it('reads back exactly what write wrote', () => {
    cmdContextWrite({
      body: '# now\nstate\n',
      env: ctx.env,
      coordRoot,
    });
    const r = cmdContextRead({
      env: ctx.env,
      coordRoot,
    });
    expect(r.text).toBe('# now\nstate\n');
    expect(r.absent).toBe(false);
  });

  it('reads decisions with --decisions', () => {
    cmdContextAppend({
      decision: 'x',
      why: 'y',
      timestamp: '2026-07-02T00:00:00.000Z',
      env: ctx.env,
      coordRoot,
    });
    const r = cmdContextRead({
      file: 'decisions',
      env: ctx.env,
      coordRoot,
    });
    expect(r.text).toContain('x. why: y.');
    expect(r.absent).toBe(false);
  });

  it('reads both with --full', () => {
    cmdContextWrite({
      body: 'now-state',
      env: ctx.env,
      coordRoot,
    });
    cmdContextAppend({
      decision: 'x',
      why: 'y',
      timestamp: '2026-07-02T00:00:00.000Z',
      env: ctx.env,
      coordRoot,
    });
    const r = cmdContextRead({
      file: 'full',
      env: ctx.env,
      coordRoot,
    });
    expect(r.text).toContain('# now.md');
    expect(r.text).toContain('now-state');
    expect(r.text).toContain('# decisions.md');
    expect(r.text).toContain('x. why: y.');
    expect(r.absent).toBe(false);
  });
});

// ─── CLI wrapper ─────────────────────────────────────────────────────────

describe('cmdContextCli', () => {
  it('read on empty prints nothing and exits 0 (absent-able)', async () => {
    // Load-bearing for the SessionStart hook: `coord context read` on a
    // fresh agent must be exit-0 + no output so hooks can `cat` it
    // unconditionally.
    const rc = await cmdContextCli(['read'], ctx);
    expect(rc).toBe(0);
    expect(stdoutBuf).toBe('');
  });

  it('write reads from ctx.readStdin and reports bytes', async () => {
    ctx.readStdin = async () => Buffer.from('body from stdin');
    const rc = await cmdContextCli(['write'], ctx);
    expect(rc).toBe(0);
    expect(stdoutBuf).toMatch(/wrote 16 bytes to .*context\/now\.md/);
    // The read-round-trip proves write actually persisted.
    stdoutBuf = '';
    await cmdContextCli(['read'], ctx);
    expect(stdoutBuf).toBe('body from stdin\n');
  });

  it('append requires --decision and --why', async () => {
    await expect(
      cmdContextCli(['append', '--decision', 'x'], ctx)
    ).rejects.toThrow(/--why/);
    await expect(
      cmdContextCli(['append', '--why', 'y'], ctx)
    ).rejects.toThrow(/--decision/);
  });

  it('append prints the exact line written', async () => {
    const rc = await cmdContextCli(
      ['append', '--decision', 'thing', '--why', 'reason'],
      ctx
    );
    expect(rc).toBe(0);
    expect(stdoutBuf).toMatch(
      /^- \d{4}-\d{2}-\d{2}T[\d:.]+Z thing\. why: reason\.\n$/
    );
  });

  it('unknown verb → exit 2 + help on stderr', async () => {
    const rc = await cmdContextCli(['banana'], ctx);
    expect(rc).toBe(2);
    expect(stderrBuf).toMatch(/unknown subcommand/);
    expect(stderrBuf).toMatch(/usage: coord context/);
  });

  it('no verb → exit 2 + help', async () => {
    const rc = await cmdContextCli([], ctx);
    expect(rc).toBe(2);
    expect(stderrBuf).toMatch(/usage: coord context/);
  });

  it('--help → exit 0 + help on stderr', async () => {
    const rc = await cmdContextCli(['--help'], ctx);
    expect(rc).toBe(0);
    expect(stderrBuf).toMatch(/usage: coord context/);
  });

  it('read with positional identity reads that peer\'s context', async () => {
    // Set up a peer with a context/now.md.
    mkdirSync(join(coordRoot, 'bob', 'inbox'), { recursive: true });
    mkdirSync(join(coordRoot, 'bob', 'archive'), { recursive: true });
    mkdirSync(join(coordRoot, 'bob', 'context'), { recursive: true });
    writeFileSync(
      join(coordRoot, 'bob', 'context', 'now.md'),
      "bob's state\n"
    );
    const rc = await cmdContextCli(['read', 'bob'], ctx);
    expect(rc).toBe(0);
    expect(stdoutBuf).toBe("bob's state\n");
  });
});
