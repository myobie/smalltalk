// tests/integration/claude-code-hooks.test.ts — Claude Code hook
// scripts at examples/claude-code/hooks/{session-start,stop-failure}.sh.
//
// Both are bash scripts. The stop-failure script branches by
// `error_type` and shells out to `coord` for status changes and
// message sends; we shim `coord` so the tests assert which
// invocations the script would have made without touching real coord
// state. Skipped on hosts without `jq` on PATH (stop-failure.sh uses
// jq to parse the envelope).

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const SESSION_START_SH = join(
  REPO_ROOT,
  'examples',
  'claude-code',
  'hooks',
  'session-start.sh'
);
const STOP_FAILURE_SH = join(
  REPO_ROOT,
  'examples',
  'claude-code',
  'hooks',
  'stop-failure.sh'
);

function jqAvailable(): boolean {
  return spawnSync('jq', ['--version'], { stdio: 'ignore' }).status === 0;
}
const HAS_JQ = jqAvailable();

let scratch: string;
let shimDir: string;
let shimLog: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'coord-it-claude-'));
  shimDir = join(scratch, 'bin');
  shimLog = join(scratch, 'coord-shim.log');
  mkdirSync(shimDir, { recursive: true });

  // Plant a tiny `coord` shim that records every invocation's argv
  // (one line per call, NUL-separated args within a line so bodies
  // with spaces survive). The hook script will resolve `coord` to
  // this file because we prepend shimDir to PATH below.
  const shimPath = join(shimDir, 'coord');
  writeFileSync(
    shimPath,
    [
      '#!/bin/bash',
      '# Test shim — records argv to $COORD_SHIM_LOG, exit 0.',
      // Use printf with \0 between args so we can split unambiguously
      // even when a body argument contains spaces, quotes, or newlines.
      'for arg in "$@"; do printf "%s\\0" "$arg" >> "$COORD_SHIM_LOG"; done',
      'printf "\\n" >> "$COORD_SHIM_LOG"',
      'exit 0',
      '',
    ].join('\n')
  );
  chmodSync(shimPath, 0o755);
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  calls: string[][]; // each invocation = list of argv strings
}

function readShimCalls(): string[][] {
  if (!existsSync(shimLog)) return [];
  const raw = readFileSync(shimLog, 'utf8');
  // Each line is one invocation; within a line, args are NUL-separated
  // with a trailing NUL before the newline.
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => line.split('\0').filter((arg) => arg.length > 0));
}

function runStopFailure(
  envelope: Record<string, unknown> | string,
  env: NodeJS.ProcessEnv = {}
): RunResult {
  const path = `${shimDir}:${process.env.PATH ?? ''}`;
  const fullEnv: NodeJS.ProcessEnv = {
    PATH: path,
    HOME: process.env.HOME,
    COORD_SHIM_LOG: shimLog,
    ...env,
  };
  const input =
    typeof envelope === 'string' ? envelope : JSON.stringify(envelope);
  const r = spawnSync('bash', [STOP_FAILURE_SH], {
    env: fullEnv,
    input,
    encoding: 'utf8',
    timeout: 15_000,
  });
  return {
    stdout: typeof r.stdout === 'string' ? r.stdout : '',
    stderr: typeof r.stderr === 'string' ? r.stderr : '',
    exitCode: r.status ?? -1,
    calls: readShimCalls(),
  };
}

// ─── session-start.sh ──────────────────────────────────────────────────
//
// Tiny script; covered for completeness so a regression on the wake
// mechanism (echo to stderr + exit 2) is caught early.

describe('claude-code hooks — session-start.sh', () => {
  it('exits 2 and emits the boot-ritual reminder to stderr', () => {
    const r = spawnSync('bash', [SESSION_START_SH], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('boot ritual');
    expect(r.stderr).toContain('set status to available');
    expect(r.stderr).toContain('drain inbox');
    expect(r.stdout).toBe('');
  });
});

// ─── stop-failure.sh ───────────────────────────────────────────────────

describe.skipIf(!HAS_JQ)('claude-code hooks — stop-failure.sh', () => {
  // ── rate_limit: status=away only, no ding ────────────────────────────
  it('rate_limit → coord status away, no message send', () => {
    const r = runStopFailure(
      { error_type: 'rate_limit', session_id: 'abc' },
      { COORD_IDENTITY: 'bob' }
    );
    expect(r.exitCode).toBe(0);
    expect(r.calls).toEqual([['status', 'bob', '--set', 'away']]);
  });

  // ── server_error: status=away + ding ─────────────────────────────────
  it('server_error → status away + message to myobie (no priority high)', () => {
    const r = runStopFailure(
      { error_type: 'server_error' },
      { COORD_IDENTITY: 'bob' }
    );
    expect(r.exitCode).toBe(0);
    expect(r.calls.length).toBe(2);
    expect(r.calls[0]).toEqual(['status', 'bob', '--set', 'away']);
    const send = r.calls[1]!;
    expect(send[0]).toBe('message');
    expect(send[1]).toBe('send');
    expect(send[2]).toBe('myobie');
    expect(send).not.toContain('--priority');
    expect(send).toContain('--subject');
    const subject = send[send.indexOf('--subject') + 1]!;
    expect(subject).toContain('server_error');
    expect(subject).toContain('bob');
    expect(send).toContain('-m');
  });

  // ── authentication_failed: offline + priority high ───────────────────
  it('authentication_failed → status offline + priority-high ding', () => {
    const r = runStopFailure(
      { error_type: 'authentication_failed' },
      { COORD_IDENTITY: 'bob' }
    );
    expect(r.exitCode).toBe(0);
    expect(r.calls.length).toBe(2);
    expect(r.calls[0]).toEqual(['status', 'bob', '--set', 'offline']);
    const send = r.calls[1]!;
    expect(send.slice(0, 3)).toEqual(['message', 'send', 'myobie']);
    expect(send).toContain('--priority');
    expect(send[send.indexOf('--priority') + 1]).toBe('high');
    const subject = send[send.indexOf('--subject') + 1]!;
    expect(subject).toContain('auth failed');
    expect(subject).toContain('authentication_failed');
  });

  // ── oauth_org_not_allowed: same shape as authentication_failed ───────
  it('oauth_org_not_allowed → status offline + priority-high ding (auth-shape)', () => {
    const r = runStopFailure(
      { error_type: 'oauth_org_not_allowed' },
      { COORD_IDENTITY: 'bob' }
    );
    expect(r.exitCode).toBe(0);
    expect(r.calls.length).toBe(2);
    expect(r.calls[0]).toEqual(['status', 'bob', '--set', 'offline']);
    const send = r.calls[1]!;
    expect(send[send.indexOf('--priority') + 1]).toBe('high');
    const subject = send[send.indexOf('--subject') + 1]!;
    expect(subject).toContain('oauth_org_not_allowed');
  });

  // ── billing_error: offline + priority high + "billing" subject ───────
  it('billing_error → status offline + priority-high billing ding', () => {
    const r = runStopFailure(
      { error_type: 'billing_error' },
      { COORD_IDENTITY: 'bob' }
    );
    expect(r.exitCode).toBe(0);
    expect(r.calls.length).toBe(2);
    expect(r.calls[0]).toEqual(['status', 'bob', '--set', 'offline']);
    const send = r.calls[1]!;
    expect(send[send.indexOf('--priority') + 1]).toBe('high');
    const subject = send[send.indexOf('--subject') + 1]!;
    expect(subject).toContain('billing');
  });

  // ── programmer-error types: no coord calls at all ────────────────────
  for (const errType of [
    'max_output_tokens',
    'invalid_request',
    'model_not_found',
  ]) {
    it(`${errType} → no coord calls (programmer error, not infra)`, () => {
      const r = runStopFailure(
        { error_type: errType },
        { COORD_IDENTITY: 'bob' }
      );
      expect(r.exitCode).toBe(0);
      expect(r.calls).toEqual([]);
    });
  }

  // ── unknown: away + ding with error_type verbatim in subject + body ──
  it('unknown → status away + ding with error_type verbatim', () => {
    const r = runStopFailure(
      { error_type: 'unknown' },
      { COORD_IDENTITY: 'bob' }
    );
    expect(r.exitCode).toBe(0);
    expect(r.calls.length).toBe(2);
    expect(r.calls[0]).toEqual(['status', 'bob', '--set', 'away']);
    const send = r.calls[1]!;
    const subject = send[send.indexOf('--subject') + 1]!;
    const body = send[send.indexOf('-m') + 1]!;
    expect(subject).toContain('unknown');
    expect(body).toContain('error_type=unknown');
  });

  // ── novel error_type: catch-all path, verbatim in subject + body ─────
  it('novel error_type (not in the table) → catch-all: away + ding verbatim', () => {
    const r = runStopFailure(
      { error_type: 'overloaded_error' },
      { COORD_IDENTITY: 'bob' }
    );
    expect(r.exitCode).toBe(0);
    expect(r.calls.length).toBe(2);
    expect(r.calls[0]).toEqual(['status', 'bob', '--set', 'away']);
    const send = r.calls[1]!;
    const subject = send[send.indexOf('--subject') + 1]!;
    const body = send[send.indexOf('-m') + 1]!;
    expect(subject).toContain('overloaded_error');
    expect(body).toContain('error_type=overloaded_error');
  });

  // ── identity propagation: a different COORD_IDENTITY → in subject ────
  it('uses $COORD_IDENTITY in status target and subject', () => {
    const r = runStopFailure(
      { error_type: 'server_error' },
      { COORD_IDENTITY: 'coord-claude' }
    );
    expect(r.exitCode).toBe(0);
    expect(r.calls[0]).toEqual(['status', 'coord-claude', '--set', 'away']);
    const send = r.calls[1]!;
    const subject = send[send.indexOf('--subject') + 1]!;
    expect(subject).toContain('coord-claude');
  });

  // ── missing COORD_IDENTITY: silent exit 0, no coord calls ────────────
  it('missing COORD_IDENTITY → exit 0, no coord calls (silent)', () => {
    const r = runStopFailure({ error_type: 'rate_limit' }, {});
    expect(r.exitCode).toBe(0);
    expect(r.calls).toEqual([]);
  });

  // ── missing error_type field: treated as unknown ─────────────────────
  it('envelope without error_type → catch-all (away + ding)', () => {
    const r = runStopFailure(
      { session_id: 'abc' },
      { COORD_IDENTITY: 'bob' }
    );
    expect(r.exitCode).toBe(0);
    expect(r.calls.length).toBe(2);
    expect(r.calls[0]).toEqual(['status', 'bob', '--set', 'away']);
  });

  // ── malformed JSON stdin: treated as unknown, never throws ───────────
  it('non-JSON stdin → catch-all (defensive: never crash the hook)', () => {
    const r = runStopFailure('not json at all', { COORD_IDENTITY: 'bob' });
    expect(r.exitCode).toBe(0);
    expect(r.calls.length).toBe(2);
    expect(r.calls[0]).toEqual(['status', 'bob', '--set', 'away']);
  });
});
