// tests/unit/archive.test.ts — coverage for cmd_archive + archive trim.

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

import {
  cmdArchive,
  cmdArchiveTrim,
  parseDuration,
  splitArchivePositionals,
  type ArchiveInput,
  type ArchiveTrimInput,
} from '../../src/commands/archive.ts';

let scratch: string;
let coordRoot: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'coord-archive-test-'));
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

function writeMsg(
  id: string,
  filename: string,
  body = 'body',
  folder: 'inbox' | 'archive' = 'inbox'
): void {
  writeFileSync(
    join(coordRoot, id, folder, filename),
    `---\nfrom: alice\n---\n${body}\n`
  );
}

function archiveInput(overrides: Partial<ArchiveInput> = {}): ArchiveInput {
  return {
    recipient: 'bob',
    filename: '1714826789010-aaaaaa.md',
    env: {} as NodeJS.ProcessEnv,
    coordRoot,
    ...overrides,
  };
}

// ─── archive (move) ─────────────────────────────────────────────────────

describe('cmdArchive — case 4 (clean rename)', () => {
  it('moves inbox file → archive when no twin', () => {
    setupIdentity('bob');
    writeMsg('bob', '1714826789010-aaaaaa.md');
    const r = cmdArchive(archiveInput());
    expect(r.outcome.kind).toBe('moved');
    expect(r.outcome.message).toBe('archived');
    expect(existsSync(join(coordRoot, 'bob', 'inbox', '1714826789010-aaaaaa.md'))).toBe(false);
    expect(existsSync(join(coordRoot, 'bob', 'archive', '1714826789010-aaaaaa.md'))).toBe(true);
  });
});

describe('cmdArchive — case 2 (idempotent: byte-identical twin)', () => {
  it('removes inbox dup when archive copy is byte-identical', () => {
    setupIdentity('bob');
    writeMsg('bob', '1714826789010-aaaaaa.md', 'same', 'inbox');
    writeMsg('bob', '1714826789010-aaaaaa.md', 'same', 'archive');
    const r = cmdArchive(archiveInput());
    expect(r.outcome.kind).toBe('idempotent');
    expect(existsSync(join(coordRoot, 'bob', 'inbox', '1714826789010-aaaaaa.md'))).toBe(false);
    expect(readFileSync(join(coordRoot, 'bob', 'archive', '1714826789010-aaaaaa.md'), 'utf8')).toContain('same');
  });
});

describe('cmdArchive — case 3 (refuse: divergent twin)', () => {
  it('refuses with a clear error and leaves both copies in place', () => {
    setupIdentity('bob');
    writeFileSync(
      join(coordRoot, 'bob', 'inbox', '1714826789010-aaaaaa.md'),
      'inbox-version'
    );
    writeFileSync(
      join(coordRoot, 'bob', 'archive', '1714826789010-aaaaaa.md'),
      'archive-version'
    );
    expect(() => cmdArchive(archiveInput())).toThrowError(/refuse to archive/);
    expect(existsSync(join(coordRoot, 'bob', 'inbox', '1714826789010-aaaaaa.md'))).toBe(true);
    expect(existsSync(join(coordRoot, 'bob', 'archive', '1714826789010-aaaaaa.md'))).toBe(true);
  });
});

describe('cmdArchive — case 0 (post-sweep idempotent)', () => {
  it('inbox empty + archive present → success without re-throwing', () => {
    setupIdentity('bob');
    writeMsg('bob', '1714826789010-aaaaaa.md', 'archived', 'archive');
    const r = cmdArchive(archiveInput());
    expect(r.outcome.kind).toBe('idempotent');
  });
});

describe('cmdArchive — case 1 (not in inbox, not in archive)', () => {
  it('errors with "not found in inbox or archive"', () => {
    setupIdentity('bob');
    expect(() => cmdArchive(archiveInput())).toThrowError(
      /not found in inbox or archive/
    );
  });
});

describe('cmdArchive — input validation', () => {
  it('rejects invalid filename grammar before filesystem hit', () => {
    setupIdentity('bob');
    expect(() =>
      cmdArchive(archiveInput({ filename: 'garbage' }))
    ).toThrowError(/invalid filename/);
  });

  it('rejects empty filename', () => {
    setupIdentity('bob');
    expect(() => cmdArchive(archiveInput({ filename: '' }))).toThrowError(
      /required/
    );
  });

  it('errors with mkdir hint when identity folder is missing', () => {
    expect(() =>
      cmdArchive(archiveInput({ recipient: 'ghost' }))
    ).toThrowError(/identity folder missing/);
  });

  it('falls back to COORD_IDENTITY when recipient omitted', () => {
    setupIdentity('bob');
    writeMsg('bob', '1714826789010-aaaaaa.md');
    cmdArchive(
      archiveInput({
        recipient: undefined,
        env: { COORD_IDENTITY: 'bob' } as NodeJS.ProcessEnv,
      })
    );
    expect(existsSync(join(coordRoot, 'bob', 'archive', '1714826789010-aaaaaa.md'))).toBe(true);
  });
});

// ─── splitArchivePositionals ────────────────────────────────────────────

describe('splitArchivePositionals', () => {
  it('one arg matching grammar → filename slot', () => {
    expect(splitArchivePositionals(['1714826789010-aaaaaa.md'])).toEqual({
      filename: '1714826789010-aaaaaa.md',
    });
  });

  it('one arg NOT matching grammar → recipient slot', () => {
    expect(splitArchivePositionals(['bob'])).toEqual({ recipient: 'bob' });
  });

  // brief-017a bug 2: .md suffix wins over the strict grammar.
  it('one arg ending in .md (but not strict grammar) → filename slot', () => {
    expect(splitArchivePositionals(['nope.md'])).toEqual({
      filename: 'nope.md',
    });
  });

  it('two args → recipient + filename', () => {
    expect(
      splitArchivePositionals(['bob', '1714826789010-aaaaaa.md'])
    ).toEqual({ recipient: 'bob', filename: '1714826789010-aaaaaa.md' });
  });

  it('three args → throws', () => {
    expect(() =>
      splitArchivePositionals(['a', 'b', 'c'])
    ).toThrowError(/too many arguments/);
  });
});

// ─── parseDuration ──────────────────────────────────────────────────────

describe('parseDuration', () => {
  it.each([
    ['30s', 30],
    ['5m', 300],
    ['2h', 7200],
    ['30d', 30 * 86400],
    ['2w', 2 * 86400 * 7],
    ['0d', 0],
    ['1s', 1],
  ])('%s → %d seconds', (spec, expected) => {
    expect(parseDuration(spec)).toBe(expected);
  });

  it.each(['30days', '30', 'xy', '', '-1d', '5.0d', 'hd', '30D'])(
    'rejects %s',
    (spec) => {
      expect(() => parseDuration(spec)).toThrowError(/invalid duration/);
    }
  );
});

// ─── archive trim ───────────────────────────────────────────────────────

function trimInput(overrides: Partial<ArchiveTrimInput> = {}): ArchiveTrimInput {
  return {
    recipient: 'bob',
    env: {} as NodeJS.ProcessEnv,
    coordRoot,
    ...overrides,
  };
}

describe('cmdArchiveTrim — flag validation', () => {
  it('errors when neither --older-than nor --keep-last is given', () => {
    setupIdentity('bob');
    expect(() => cmdArchiveTrim(trimInput())).toThrowError(
      /trim requires --older-than DURATION or --keep-last N/
    );
  });

  it('rejects negative --keep-last', () => {
    setupIdentity('bob');
    expect(() =>
      cmdArchiveTrim(trimInput({ keepLast: -1 }))
    ).toThrowError(/non-negative integer/);
  });

  it('rejects non-integer --keep-last', () => {
    setupIdentity('bob');
    expect(() =>
      cmdArchiveTrim(trimInput({ keepLast: 1.5 }))
    ).toThrowError(/non-negative integer/);
  });

  it('rejects bad --older-than syntax', () => {
    setupIdentity('bob');
    expect(() =>
      cmdArchiveTrim(trimInput({ olderThan: 'xy' }))
    ).toThrowError(/invalid duration/);
  });
});

describe('cmdArchiveTrim — empty / non-existent archive', () => {
  it('empty archive: no-op, returns 0 victims', () => {
    setupIdentity('bob');
    const r = cmdArchiveTrim(trimInput({ keepLast: 100 }));
    expect(r.victims).toEqual([]);
    expect(r.summary).toBe('# trimmed 0 files');
  });

  it('missing archive directory: no-op (no throw)', () => {
    mkdirSync(join(coordRoot, 'bob', 'inbox'), { recursive: true });
    // Note: identity-folder check requires archive/ too; create then remove
    // it AFTER resolveIdentity runs… here we just simulate by setting up
    // both dirs and removing archive after.
    mkdirSync(join(coordRoot, 'bob', 'archive'), { recursive: true });
    rmSync(join(coordRoot, 'bob', 'archive'), { recursive: true });
    expect(() =>
      cmdArchiveTrim(trimInput({ keepLast: 100 }))
    ).toThrowError(/identity folder missing/);
  });
});

describe('cmdArchiveTrim — --keep-last', () => {
  it('keeps the N most-recent files, deletes the rest', () => {
    setupIdentity('bob');
    for (const ts of [
      '1714826789010',
      '1714826789020',
      '1714826789030',
      '1714826789040',
      '1714826789050',
    ]) {
      writeFileSync(
        join(coordRoot, 'bob', 'archive', `${ts}-aaaaaa.md`),
        'msg'
      );
    }
    const r = cmdArchiveTrim(trimInput({ keepLast: 2 }));
    expect(r.victims).toEqual([
      '1714826789010-aaaaaa.md',
      '1714826789020-aaaaaa.md',
      '1714826789030-aaaaaa.md',
    ]);
    expect(r.summary).toBe('# trimmed 3 files');
    expect(
      existsSync(join(coordRoot, 'bob', 'archive', '1714826789040-aaaaaa.md'))
    ).toBe(true);
    expect(
      existsSync(join(coordRoot, 'bob', 'archive', '1714826789050-aaaaaa.md'))
    ).toBe(true);
  });

  it('--keep-last 0 trims everything', () => {
    setupIdentity('bob');
    writeFileSync(
      join(coordRoot, 'bob', 'archive', '1714826789010-aaaaaa.md'),
      'x'
    );
    const r = cmdArchiveTrim(trimInput({ keepLast: 0 }));
    expect(r.victims).toEqual(['1714826789010-aaaaaa.md']);
  });

  it('--keep-last larger than count trims nothing', () => {
    setupIdentity('bob');
    writeFileSync(
      join(coordRoot, 'bob', 'archive', '1714826789010-aaaaaa.md'),
      'x'
    );
    const r = cmdArchiveTrim(trimInput({ keepLast: 100 }));
    expect(r.victims).toEqual([]);
  });

  it('singular pluralization: "trimmed 1 file"', () => {
    setupIdentity('bob');
    writeFileSync(
      join(coordRoot, 'bob', 'archive', '1714826789010-aaaaaa.md'),
      'x'
    );
    writeFileSync(
      join(coordRoot, 'bob', 'archive', '1714826789020-bbbbbb.md'),
      'x'
    );
    const r = cmdArchiveTrim(trimInput({ keepLast: 1 }));
    expect(r.summary).toBe('# trimmed 1 file');
  });
});

describe('cmdArchiveTrim — --older-than', () => {
  it('removes files older than the cutoff (now − duration)', () => {
    setupIdentity('bob');
    const now = 1_800_000_000_000;
    const oldTs = now - 100 * 86400 * 1000; // 100 days ago
    const recentTs = now - 1; // 1ms ago
    writeFileSync(
      join(coordRoot, 'bob', 'archive', `${oldTs}-aaaaaa.md`),
      'x'
    );
    writeFileSync(
      join(coordRoot, 'bob', 'archive', `${recentTs}-bbbbbb.md`),
      'x'
    );
    const r = cmdArchiveTrim(
      trimInput({ olderThan: '30d', now: () => now })
    );
    expect(r.victims).toEqual([`${oldTs}-aaaaaa.md`]);
  });
});

describe('cmdArchiveTrim — both flags (union, deduped)', () => {
  it('victims = union of older-than ∪ keep-last, sorted, no dups', () => {
    setupIdentity('bob');
    const now = 1_800_000_000_000;
    const tsList = [
      now - 100 * 86400 * 1000, // very old
      now - 50 * 86400 * 1000,  // old
      now - 10 * 86400 * 1000,  // recent
      now - 1,                  // newest
    ];
    for (let i = 0; i < tsList.length; i++) {
      writeFileSync(
        join(
          coordRoot,
          'bob',
          'archive',
          `${tsList[i]}-${'abcdef'[i]!.repeat(6)}.md`
        ),
        'x'
      );
    }
    // older-than 30d → drops [0], [1].
    // keep-last 2     → drops [0], [1] (keep newest 2).
    // Union: [0], [1]. Deduped: 2 files.
    const r = cmdArchiveTrim(
      trimInput({
        olderThan: '30d',
        keepLast: 2,
        now: () => now,
      })
    );
    expect(r.victims).toHaveLength(2);
    expect(r.summary).toBe('# trimmed 2 files');
  });
});

describe('cmdArchiveTrim — --dry-run', () => {
  it('lists victims but deletes nothing; summary uses "would trim"', () => {
    setupIdentity('bob');
    for (const ts of [
      '1714826789010',
      '1714826789020',
      '1714826789030',
      '1714826789040',
      '1714826789050',
    ]) {
      writeFileSync(
        join(coordRoot, 'bob', 'archive', `${ts}-aaaaaa.md`),
        'x'
      );
    }
    const r = cmdArchiveTrim(trimInput({ keepLast: 2, dryRun: true }));
    expect(r.dryRun).toBe(true);
    expect(r.victims).toHaveLength(3);
    expect(r.summary).toBe(
      '# would trim 3 files (dry run; nothing deleted)'
    );
    // All 5 still on disk.
    for (const ts of [
      '1714826789010',
      '1714826789020',
      '1714826789030',
      '1714826789040',
      '1714826789050',
    ]) {
      expect(
        existsSync(join(coordRoot, 'bob', 'archive', `${ts}-aaaaaa.md`))
      ).toBe(true);
    }
  });
});

describe('cmdArchiveTrim — non-grammar files in archive/', () => {
  it('skips non-.md and grammar-violating files (preserves them)', () => {
    setupIdentity('bob');
    writeFileSync(join(coordRoot, 'bob', 'archive', 'README'), 'x');
    writeFileSync(join(coordRoot, 'bob', 'archive', 'notes.md'), 'x');
    writeFileSync(
      join(coordRoot, 'bob', 'archive', '1714826789010-myobie-aaaaaa.md'),
      'legacy'
    );
    writeFileSync(
      join(coordRoot, 'bob', 'archive', '1714826789020-aaaaaa.md'),
      'real'
    );
    const r = cmdArchiveTrim(trimInput({ keepLast: 0 }));
    expect(r.victims).toEqual(['1714826789020-aaaaaa.md']);
    expect(existsSync(join(coordRoot, 'bob', 'archive', 'README'))).toBe(true);
    expect(existsSync(join(coordRoot, 'bob', 'archive', 'notes.md'))).toBe(true);
    expect(
      existsSync(
        join(coordRoot, 'bob', 'archive', '1714826789010-myobie-aaaaaa.md')
      )
    ).toBe(true);
  });
});
