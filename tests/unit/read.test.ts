// tests/unit/read.test.ts — comprehensive coverage of cmd_read.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cmdRead,
  splitReadPositionals,
  type ReadInput,
} from '../../src/commands/read.ts';

let scratch: string;
let coordRoot: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'coord-read-test-'));
  coordRoot = join(scratch, 'coord');
  mkdirSync(coordRoot, { recursive: true });
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function setupIdentity(id: string): void {
  mkdirSync(join(coordRoot, id, 'inbox'), { recursive: true });
  mkdirSync(join(coordRoot, id, 'archive'), { recursive: true });
}

function writeFile(
  id: string,
  filename: string,
  content: string,
  folder: 'inbox' | 'archive' = 'inbox'
): void {
  writeFileSync(join(coordRoot, id, folder, filename), content);
}

function baseInput(overrides: Partial<ReadInput> = {}): ReadInput {
  return {
    recipient: 'bob',
    filename: '1714826789010-aaaaaa.md',
    env: {} as NodeJS.ProcessEnv,
    coordRoot,
    ...overrides,
  };
}

// ─── Happy paths ────────────────────────────────────────────────────────

describe('cmdRead — formatted mode', () => {
  it('inbox file: header derives to/ts; body separated', () => {
    setupIdentity('bob');
    writeFile(
      'bob',
      '1714826789010-aaaaaa.md',
      '---\nfrom: alice\nsubject: hi\n---\nthe body\n'
    );
    const r = cmdRead(baseInput());
    expect(r.label).toBe('inbox');
    expect(r.untyped).toBe(false);
    expect(r.header).toContain('# inbox/1714826789010-aaaaaa.md');
    expect(r.header).toContain('to:          bob  (derived from path)');
    expect(r.header).toContain(
      'ts:          1714826789010  (derived from filename)'
    );
    // Header padding: label padded to 12 + 1 space = 13-char prefix
    // before the value, matching the bash printf format.
    expect(r.header).toContain('from:        alice'); // 8 spaces
    expect(r.header).toContain('subject:     hi'); // 5 spaces
    expect(r.body).toBe('the body\n');
  });

  it('archive file (with --archive) returns archive header label', () => {
    setupIdentity('bob');
    writeFile(
      'bob',
      '1714826789010-aaaaaa.md',
      '---\nfrom: alice\n---\narchived body\n',
      'archive'
    );
    const r = cmdRead(baseInput({ fromArchive: true }));
    expect(r.label).toBe('archive');
    expect(r.header).toContain('# archive/1714826789010-aaaaaa.md');
    expect(r.body).toBe('archived body\n');
  });

  it('auto-fallback: not in inbox, IS in archive → reads archive', () => {
    setupIdentity('bob');
    writeFile(
      'bob',
      '1714826789010-aaaaaa.md',
      '---\nfrom: alice\n---\narchived\n',
      'archive'
    );
    const r = cmdRead(baseInput());
    expect(r.label).toBe('archive');
  });

  it('inbox preferred when --archive not set and file in both', () => {
    setupIdentity('bob');
    writeFile(
      'bob',
      '1714826789010-aaaaaa.md',
      '---\nfrom: alice\n---\ninbox-version\n'
    );
    writeFile(
      'bob',
      '1714826789010-aaaaaa.md',
      '---\nfrom: alice\n---\narchive-version\n',
      'archive'
    );
    const r = cmdRead(baseInput());
    expect(r.label).toBe('inbox');
    expect(r.body).toBe('inbox-version\n');
  });

  it('--archive prefers archive even when inbox copy exists', () => {
    setupIdentity('bob');
    writeFile(
      'bob',
      '1714826789010-aaaaaa.md',
      '---\nfrom: alice\n---\ninbox-version\n'
    );
    writeFile(
      'bob',
      '1714826789010-aaaaaa.md',
      '---\nfrom: alice\n---\narchive-version\n',
      'archive'
    );
    const r = cmdRead(baseInput({ fromArchive: true }));
    expect(r.label).toBe('archive');
    expect(r.body).toBe('archive-version\n');
  });

  it('omits empty frontmatter rows from the header', () => {
    setupIdentity('bob');
    writeFile('bob', '1714826789010-aaaaaa.md', '---\nfrom: alice\n---\nbody\n');
    const r = cmdRead(baseInput());
    expect(r.header).not.toContain('subject:');
    expect(r.header).not.toContain('in-reply-to:');
    expect(r.header).not.toContain('tags:');
    expect(r.header).not.toContain('priority:');
  });

  it('shows in-reply-to when present', () => {
    setupIdentity('bob');
    writeFile(
      'bob',
      '1714826789010-aaaaaa.md',
      '---\nfrom: alice\nin-reply-to: 1714826789000-zzzzzz.md\n---\nbody\n'
    );
    const r = cmdRead(baseInput());
    expect(r.header).toContain('in-reply-to: 1714826789000-zzzzzz.md');
  });

  it('shows tags when present', () => {
    setupIdentity('bob');
    writeFile(
      'bob',
      '1714826789010-aaaaaa.md',
      '---\nfrom: alice\ntags: [a, b]\n---\nbody\n'
    );
    const r = cmdRead(baseInput());
    expect(r.header).toContain('tags:        [a, b]'); // 8 spaces
  });
});

// ─── --raw ──────────────────────────────────────────────────────────────

describe('cmdRead — --raw', () => {
  it('returns the file verbatim and empty header', () => {
    setupIdentity('bob');
    const text = '---\nfrom: alice\nsubject: hi\n---\nthe body\n';
    writeFile('bob', '1714826789010-aaaaaa.md', text);
    const r = cmdRead(baseInput({ raw: true }));
    expect(r.body).toBe(text);
    expect(r.header).toBe('');
    expect(r.untyped).toBe(false);
  });

  it('--raw on a no-frontmatter file dumps body verbatim', () => {
    setupIdentity('bob');
    const text = 'just body, no frontmatter\n';
    writeFile('bob', '1714826789010-aaaaaa.md', text);
    const r = cmdRead(baseInput({ raw: true }));
    expect(r.body).toBe(text);
  });
});

// ─── Untyped (no frontmatter) ───────────────────────────────────────────

describe('cmdRead — files without frontmatter', () => {
  it('formatted mode marks "(untyped: no frontmatter)" and prints body verbatim', () => {
    setupIdentity('bob');
    writeFile('bob', '1714826789010-aaaaaa.md', 'just text\n');
    const r = cmdRead(baseInput());
    expect(r.untyped).toBe(true);
    expect(r.header).toContain('(untyped: no frontmatter)');
    expect(r.body).toBe('just text\n');
  });

  it('unterminated fence is treated as untyped (permissive read)', () => {
    setupIdentity('bob');
    writeFile(
      'bob',
      '1714826789010-aaaaaa.md',
      '---\nfrom: alice\nno close fence\nbody\n'
    );
    const r = cmdRead(baseInput());
    expect(r.untyped).toBe(true);
  });

  it('empty file: untyped, body is empty', () => {
    setupIdentity('bob');
    writeFile('bob', '1714826789010-aaaaaa.md', '');
    const r = cmdRead(baseInput());
    expect(r.untyped).toBe(true);
    expect(r.body).toBe('');
  });
});

// ─── Errors ─────────────────────────────────────────────────────────────

describe('cmdRead — errors', () => {
  it('not found anywhere → error mentions both folders', () => {
    setupIdentity('bob');
    expect(() => cmdRead(baseInput())).toThrowError(
      /not found in inbox or archive/
    );
  });

  it('invalid filename grammar → error before filesystem hit', () => {
    setupIdentity('bob');
    expect(() =>
      cmdRead(baseInput({ filename: 'garbage' }))
    ).toThrowError(/invalid filename/);
  });

  it('empty filename → error', () => {
    setupIdentity('bob');
    expect(() =>
      cmdRead(baseInput({ filename: '' }))
    ).toThrowError(/required/);
  });

  it('unknown identity → mkdir hint', () => {
    expect(() =>
      cmdRead(baseInput({ recipient: 'ghost' }))
    ).toThrowError(/identity folder missing/);
  });

  it('no recipient + no COORD_IDENTITY → identity-required error', () => {
    expect(() =>
      cmdRead(baseInput({ recipient: undefined }))
    ).toThrowError(/COORD_IDENTITY/);
  });
});

// ─── Identity resolution ────────────────────────────────────────────────

describe('cmdRead — identity resolution', () => {
  it('uses positional recipient over env', () => {
    setupIdentity('bob');
    setupIdentity('alice');
    writeFile('bob', '1714826789010-aaaaaa.md', '---\nfrom: a\n---\nb\n');
    const r = cmdRead(
      baseInput({
        recipient: 'bob',
        env: { COORD_IDENTITY: 'alice' } as NodeJS.ProcessEnv,
      })
    );
    expect(r.label).toBe('inbox');
  });

  it('falls back to COORD_IDENTITY when no positional', () => {
    setupIdentity('bob');
    writeFile('bob', '1714826789010-aaaaaa.md', '---\nfrom: a\n---\nb\n');
    const r = cmdRead(
      baseInput({
        recipient: undefined,
        env: { COORD_IDENTITY: 'bob' } as NodeJS.ProcessEnv,
      })
    );
    expect(r.label).toBe('inbox');
  });
});

// ─── Positional disambiguation ──────────────────────────────────────────

describe('splitReadPositionals', () => {
  it('zero args → both undefined', () => {
    expect(splitReadPositionals([])).toEqual({});
  });

  it('one arg matching filename grammar → filename, recipient undefined', () => {
    expect(splitReadPositionals(['1714826789010-aaaaaa.md'])).toEqual({
      filename: '1714826789010-aaaaaa.md',
    });
  });

  it('one arg NOT matching grammar → recipient, filename undefined', () => {
    expect(splitReadPositionals(['bob'])).toEqual({ recipient: 'bob' });
  });

  // brief-017a bug 2: a non-grammar filename with .md suffix should
  // still parse as a filename so the core's InvalidFilenameError
  // fires instead of the misleading "<filename> required" path.
  it('one arg ending in .md (but not strict grammar) → filename, not recipient', () => {
    expect(splitReadPositionals(['nope.md'])).toEqual({
      filename: 'nope.md',
    });
    expect(splitReadPositionals(['does-not-exist.md'])).toEqual({
      filename: 'does-not-exist.md',
    });
  });

  it('two args → recipient, filename', () => {
    expect(
      splitReadPositionals(['bob', '1714826789010-aaaaaa.md'])
    ).toEqual({ recipient: 'bob', filename: '1714826789010-aaaaaa.md' });
  });

  it('three args → throws', () => {
    expect(() => splitReadPositionals(['a', 'b', 'c'])).toThrowError(
      /too many arguments/
    );
  });
});
