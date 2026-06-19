// tests/integration/two-machine-convergence.test.ts — the core LAYOUT
// acceptance: real rsync between two filesystems, archive-as-tombstone
// invariant holds, sweep restores it after every sync round.
//
// "Machine A" and "Machine B" are two distinct $COORD_ROOT directories on
// the same disk; rsync sees them via the `local:<path>` peer spec.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  cleanupRoot,
  listArchive,
  listInbox,
  mkIdentity,
  mkRoot,
  rsyncAvailable,
  runCoord,
} from './helpers.ts';

const skip = !rsyncAvailable();
const d = skip ? describe.skip : describe;

d('two-machine convergence (real rsync)', () => {
  let rootA: string;
  let rootB: string;

  beforeAll(() => {
    rootA = mkRoot();
    rootB = mkRoot();
    mkIdentity(rootA, 'alice');
    mkIdentity(rootB, 'bob');
  });

  afterAll(() => {
    cleanupRoot(rootA);
    cleanupRoot(rootB);
  });

  // Each test gets a fresh send so we can assert specific filenames; reset
  // both inboxes/archives between cases by removing their contents (kept
  // simple: just recreate the identities).
  function resetAll(): void {
    cleanupRoot(rootA);
    cleanupRoot(rootB);
    rootA = mkRoot();
    rootB = mkRoot();
    mkIdentity(rootA, 'alice');
    mkIdentity(rootB, 'bob');
  }

  it('send + sync push delivers the file to the receiver', () => {
    resetAll();
    const send = runCoord(['message', 'send', 'bob', '--from', 'alice'], {
      coordRoot: rootA,
      coordIdentity: 'alice',
      stdin: 'hello bob',
    });
    expect(send.exitCode).toBe(0);
    const filename = send.stdout.trim();
    // Lives on A in alice's view of bob/inbox/.
    expect(existsSync(join(rootA, 'bob', 'inbox', filename))).toBe(true);

    const push = runCoord(['sync', 'push', `local:${rootB}`], {
      coordRoot: rootA,
      coordIdentity: 'alice',
    });
    expect(push.exitCode).toBe(0);
    // Now exists on B too (rsync -a copies, doesn't move).
    expect(existsSync(join(rootB, 'bob', 'inbox', filename))).toBe(true);
    expect(existsSync(join(rootA, 'bob', 'inbox', filename))).toBe(true);
  });

  it('round trip: receiver archives, bidirectional sync converges', () => {
    resetAll();
    const send = runCoord(['message', 'send', 'bob', '--from', 'alice'], {
      coordRoot: rootA,
      coordIdentity: 'alice',
      stdin: 'core acceptance',
    });
    const filename = send.stdout.trim();
    runCoord(['sync', 'push', `local:${rootB}`], {
      coordRoot: rootA,
      coordIdentity: 'alice',
    });

    // Bob archives locally.
    const arch = runCoord(['message', 'archive', 'bob', filename], {
      coordRoot: rootB,
      coordIdentity: 'bob',
    });
    expect(arch.exitCode).toBe(0);
    expect(existsSync(join(rootB, 'bob', 'archive', filename))).toBe(true);
    expect(existsSync(join(rootB, 'bob', 'inbox', filename))).toBe(false);

    // One full bidirectional round.
    runCoord(['sync', 'push', `local:${rootB}`], {
      coordRoot: rootA,
      coordIdentity: 'alice',
    });
    runCoord(['sync', 'pull', `local:${rootB}`], {
      coordRoot: rootA,
      coordIdentity: 'alice',
    });
    runCoord(['sync', 'push', `local:${rootA}`], {
      coordRoot: rootB,
      coordIdentity: 'bob',
    });
    runCoord(['sync', 'pull', `local:${rootA}`], {
      coordRoot: rootB,
      coordIdentity: 'bob',
    });

    // Both sides: archive only, inbox empty.
    expect(listInbox(rootA, 'bob')).toEqual([]);
    expect(listArchive(rootA, 'bob')).toEqual([filename]);
    expect(listInbox(rootB, 'bob')).toEqual([]);
    expect(listArchive(rootB, 'bob')).toEqual([filename]);
  });

  it('asymmetric sync: A pushes twice, B never syncs — B inbox is clean after archive', () => {
    // The Z1 regression from dx-review-2: a receiver that doesn't run sync
    // itself should not see phantom inbox entries when the sender re-pushes.
    resetAll();
    const send = runCoord(['message', 'send', 'bob', '--from', 'alice'], {
      coordRoot: rootA,
      coordIdentity: 'alice',
      stdin: 'z1 repro',
    });
    const filename = send.stdout.trim();
    runCoord(['sync', 'push', `local:${rootB}`], {
      coordRoot: rootA,
      coordIdentity: 'alice',
    });
    runCoord(['message', 'archive', 'bob', filename], {
      coordRoot: rootB,
      coordIdentity: 'bob',
    });
    // A pushes again — A still has bob/inbox/X locally because A's sync
    // hasn't pulled bob/archive/X back yet.
    runCoord(['sync', 'push', `local:${rootB}`], {
      coordRoot: rootA,
      coordIdentity: 'alice',
    });
    // A's push re-deposited the inbox copy on B.
    // Now B reads its inbox WITHOUT first running its own sync. The
    // universal pre-command sweep on `coord ls` cleans the zombie.
    const ls = runCoord(['message', 'ls', 'bob', '--count'], {
      coordRoot: rootB,
      coordIdentity: 'bob',
    });
    expect(ls.exitCode).toBe(0);
    expect(ls.stdout.trim()).toBe('0');
    expect(listInbox(rootB, 'bob')).toEqual([]);
    expect(listArchive(rootB, 'bob')).toEqual([filename]);
  });

  it('5 messages, 3 archived, full sync → 2 inbox + 3 archive on both sides', () => {
    resetAll();
    const filenames: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = runCoord(['message', 'send', 'bob', '--from', 'alice'], {
        coordRoot: rootA,
        coordIdentity: 'alice',
        stdin: `msg ${i}`,
      });
      expect(r.exitCode).toBe(0);
      filenames.push(r.stdout.trim());
    }
    runCoord(['sync', 'push', `local:${rootB}`], {
      coordRoot: rootA,
      coordIdentity: 'alice',
    });
    // Archive the first three on B (chronological order).
    const sortedNames = [...filenames].sort();
    for (let i = 0; i < 3; i++) {
      const r = runCoord(['message', 'archive', 'bob', sortedNames[i]!], {
        coordRoot: rootB,
        coordIdentity: 'bob',
      });
      expect(r.exitCode).toBe(0);
    }

    // Bidirectional convergence (two rounds to drain peer-side zombies).
    const sync = (root: string, peer: string, identity: string): void => {
      runCoord(['sync', 'push', `local:${peer}`], {
        coordRoot: root,
        coordIdentity: identity,
      });
      runCoord(['sync', 'pull', `local:${peer}`], {
        coordRoot: root,
        coordIdentity: identity,
      });
    };
    sync(rootA, rootB, 'alice');
    sync(rootB, rootA, 'bob');
    sync(rootA, rootB, 'alice');

    const archived = sortedNames.slice(0, 3).sort();
    const remaining = sortedNames.slice(3).sort();
    expect(listArchive(rootA, 'bob')).toEqual(archived);
    expect(listArchive(rootB, 'bob')).toEqual(archived);
    expect(listInbox(rootA, 'bob')).toEqual(remaining);
    expect(listInbox(rootB, 'bob')).toEqual(remaining);
  });

  it('idempotent: a second sync push is a no-op (no new files)', () => {
    resetAll();
    runCoord(['message', 'send', 'bob', '--from', 'alice'], {
      coordRoot: rootA,
      coordIdentity: 'alice',
      stdin: 'once',
    });
    runCoord(['sync', 'push', `local:${rootB}`], {
      coordRoot: rootA,
      coordIdentity: 'alice',
    });
    const before = listInbox(rootB, 'bob');

    const second = runCoord(['sync', 'push', `local:${rootB}`], {
      coordRoot: rootA,
      coordIdentity: 'alice',
    });
    expect(second.exitCode).toBe(0);
    expect(listInbox(rootB, 'bob')).toEqual(before);
  });

  it('empty trees both sides: sync push is a no-op, exit 0, no stderr', () => {
    resetAll();
    const r = runCoord(['sync', 'push', `local:${rootB}`], {
      coordRoot: rootA,
      coordIdentity: 'alice',
    });
    expect(r.exitCode).toBe(0);
    expect(listInbox(rootA, 'alice')).toEqual([]);
    expect(listArchive(rootA, 'alice')).toEqual([]);
    expect(listInbox(rootB, 'bob')).toEqual([]);
    expect(listArchive(rootB, 'bob')).toEqual([]);
  });

  it('content survives the round trip byte-for-byte', () => {
    resetAll();
    const body =
      'line one\nline two\n\nline four with: a colon and "quotes"\n';
    const send = runCoord(
      ['message', 'send', 'bob', '--from', 'alice', '--subject', 're: hello'],
      { coordRoot: rootA, coordIdentity: 'alice', stdin: body }
    );
    const filename = send.stdout.trim();
    runCoord(['sync', 'push', `local:${rootB}`], {
      coordRoot: rootA,
      coordIdentity: 'alice',
    });

    const aText = readFileSync(join(rootA, 'bob', 'inbox', filename), 'utf8');
    const bText = readFileSync(join(rootB, 'bob', 'inbox', filename), 'utf8');
    expect(aText).toBe(bText);
    // Frontmatter quotes the colon-bearing subject; body is preserved.
    expect(aText).toContain('subject: "re: hello"');
    expect(aText).toMatch(/line one\nline two\n\nline four/);
  });
});
