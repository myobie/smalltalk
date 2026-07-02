// commands/context.ts — `coord context <verb>` for per-agent durable
// working-state (brief-024, context/ v1).
//
// Purpose. Solve the in-context-state loss leg of lossless-restart: a
// restart-from-summary / auto-compaction / crash used to wipe the
// model's memory of what it was mid-doing. `context/` persists that
// state on disk, outside the session jsonl, in the agent's smalltalk
// network folder (~/.local/state/coord/<agent>/context/).
//
// Two files, two shapes:
//   - now.md         — whole-file rewrite; `read now` prints it,
//                      `write` replaces it from stdin. Meant for
//                      "what I'm mid-doing" snapshots the model
//                      flushes at each meaningful state change.
//   - decisions.md   — append-only log. `append` adds one bulleted
//                      line "- <ISO ts> <decision>. why: <why>.".
//                      Never rewritten in v1 — decisions accumulate
//                      so a restarted-you doesn't re-litigate.
//
// Absent-able (load-bearing for evals-claude's restart-continuity
// eval): every verb tolerates a missing `context/` folder. `read`
// returns empty text when the file is absent. `append` and `write`
// lazy-create the folder. There is no `coord context init` — you
// can go from zero to a first write without any ceremony, and the
// eval's control arm can just delete the folder to A/B against the
// treatment.
//
// Explicitly out of scope for v1 (v2 candidates surfaced by cos):
//   - No `now edit` verb — full-rewrite discipline prevents the
//     staleness that edit-in-place invites.
//   - No hook wiring here (PreCompact flush + SessionStart rehydrate
//     ship as a follow-up PR so we can iterate on the schema without
//     the hook plumbing in the way).
//   - No "standing jobs to re-establish on boot" schema — cos flagged
//     this as the way to close the dead-session-only-crons leg; v2.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

import type { CliContext } from '../cli-context.ts';
import {
  contextDecisionsPath,
  contextDir,
  contextNowPath,
  resolveIdentity,
} from '../common.ts';

// ─── Types ───────────────────────────────────────────────────────────────

export type ContextVerb = 'read' | 'write' | 'append';

export interface ContextReadInput {
  recipient?: string | undefined;
  /** Which file to read. Default 'now'. */
  file?: 'now' | 'decisions' | 'full' | undefined;
  env: NodeJS.ProcessEnv;
  coordRoot: string;
}

export interface ContextReadResult {
  identity: string;
  /** The requested file. `full` returns both concatenated. */
  file: 'now' | 'decisions' | 'full';
  /** File contents; empty string when the file (or folder) is absent. */
  text: string;
  /**
   * True when the requested file was absent. For `full`, true only
   * when BOTH files were absent. Lets callers distinguish "empty
   * file" from "no file yet" without a second stat.
   */
  absent: boolean;
}

export interface ContextWriteInput {
  recipient?: string | undefined;
  /** Whole-file rewrite content for now.md. */
  body: string;
  env: NodeJS.ProcessEnv;
  coordRoot: string;
}

export interface ContextWriteResult {
  identity: string;
  path: string;
  /** Byte length of what was written. */
  bytes: number;
}

export interface ContextAppendInput {
  recipient?: string | undefined;
  /** The decision text — one line, no leading `- `; we add the bullet. */
  decision: string;
  /** The "why" — kept separate so callers must think about the reason. */
  why: string;
  /**
   * ISO timestamp to stamp the entry with. Callers supply this so
   * the core stays deterministic under test (no clock reach). CLI
   * wrapper defaults to `new Date().toISOString()`.
   */
  timestamp: string;
  env: NodeJS.ProcessEnv;
  coordRoot: string;
}

export interface ContextAppendResult {
  identity: string;
  path: string;
  /** The exact bulleted line that was appended (without trailing \n). */
  line: string;
}

// ─── Core ─────────────────────────────────────────────────────────────────

/**
 * Read one of the context files. Absent-able: a missing folder or file
 * returns `text: ''` + `absent: true` so callers can distinguish
 * "restart with no prior context" from "restart with empty context".
 */
export function cmdContextRead(input: ContextReadInput): ContextReadResult {
  const identity = resolveIdentity({
    explicit: input.recipient,
    env: input.env,
    coordRoot: input.coordRoot,
  });
  const which = input.file ?? 'now';

  if (which === 'now') {
    const { text, absent } = readIfPresent(
      contextNowPath(identity, input.coordRoot)
    );
    return { identity, file: 'now', text, absent };
  }
  if (which === 'decisions') {
    const { text, absent } = readIfPresent(
      contextDecisionsPath(identity, input.coordRoot)
    );
    return { identity, file: 'decisions', text, absent };
  }
  // `full`: now.md then decisions.md, separated by a heading so the
  // reader can tell what came from where. Absent-flag is true iff
  // BOTH files were missing — a partial rehydrate is still "present".
  const now = readIfPresent(contextNowPath(identity, input.coordRoot));
  const dec = readIfPresent(
    contextDecisionsPath(identity, input.coordRoot)
  );
  const parts: string[] = [];
  if (!now.absent) {
    parts.push('# now.md', now.text);
  }
  if (!dec.absent) {
    if (parts.length > 0) parts.push('');
    parts.push('# decisions.md', dec.text);
  }
  return {
    identity,
    file: 'full',
    text: parts.join('\n'),
    absent: now.absent && dec.absent,
  };
}

/**
 * Whole-file rewrite of `now.md`. Atomic via tmp + rename so a
 * concurrent reader can't see a partial file — matters because the
 * SessionStart hook will read this on every boot and we don't want a
 * mid-write moment to inject a truncated `<context>` block.
 */
export function cmdContextWrite(
  input: ContextWriteInput
): ContextWriteResult {
  const identity = resolveIdentity({
    explicit: input.recipient,
    env: input.env,
    coordRoot: input.coordRoot,
  });
  const path = contextNowPath(identity, input.coordRoot);
  ensureContextDir(identity, input.coordRoot);
  // Normalize trailing newline so the file always ends with \n. Keeps
  // downstream tools happy (git diff, `cat`), matches the shape the
  // model writes when the body already ends with a newline.
  const body = input.body.endsWith('\n') ? input.body : input.body + '\n';
  writeAtomic(path, body);
  return { identity, path, bytes: body.length };
}

/**
 * Append one decision + why line to `decisions.md`. Format:
 *   - <ISO ts> <decision>. why: <why>.
 * We add the leading `- ` and enforce trailing periods so a hand-rolled
 * append via `>>` and a helper-driven append look identical to the
 * reader. Rejects a `\n` in either field — a decision that spans lines
 * belongs in a note or a doc, not in this log.
 */
export function cmdContextAppend(
  input: ContextAppendInput
): ContextAppendResult {
  const identity = resolveIdentity({
    explicit: input.recipient,
    env: input.env,
    coordRoot: input.coordRoot,
  });
  const decision = input.decision.trim();
  const why = input.why.trim();
  if (decision.length === 0) {
    throw new Error('--decision is required and cannot be empty');
  }
  if (why.length === 0) {
    throw new Error('--why is required and cannot be empty');
  }
  if (decision.includes('\n') || why.includes('\n')) {
    throw new Error(
      "context append: --decision and --why must be single lines. Multi-line reasoning belongs in a doc; the log is a scannable list."
    );
  }
  const line = `- ${input.timestamp} ${trimTrailingPeriod(decision)}. why: ${trimTrailingPeriod(why)}.`;
  const path = contextDecisionsPath(identity, input.coordRoot);
  ensureContextDir(identity, input.coordRoot);
  // Append semantics: read + concat + atomic-rename. Not fs.appendFile
  // because a partial-write from a crash mid-append would corrupt the
  // log; a rename is either all-or-nothing.
  const prior = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const sep = prior.length === 0 || prior.endsWith('\n') ? '' : '\n';
  writeAtomic(path, prior + sep + line + '\n');
  return { identity, path, line };
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function readIfPresent(path: string): { text: string; absent: boolean } {
  if (!existsSync(path)) return { text: '', absent: true };
  try {
    return { text: readFileSync(path, 'utf8'), absent: false };
  } catch {
    // Present-but-unreadable is different from absent — treat as absent
    // so callers don't rehydrate garbage, but also don't surface a
    // hard error. The eval's control arm gets the same shape either way.
    return { text: '', absent: true };
  }
}

function ensureContextDir(identity: string, root: string): void {
  mkdirSync(contextDir(identity, root), { recursive: true });
}

function writeAtomic(path: string, body: string): void {
  const dir = dirname(path);
  const tmp = join(
    dir,
    `.context.tmp-${process.pid}-${randomBytes(3).toString('hex')}`
  );
  try {
    writeFileSync(tmp, body);
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw err;
  }
}

function trimTrailingPeriod(s: string): string {
  return s.endsWith('.') ? s.slice(0, -1) : s;
}

// ─── CLI wrapper ─────────────────────────────────────────────────────────

const CONTEXT_USAGE =
  'usage: coord context <verb> [args...]\n\n' +
  '  read [<identity>] [--decisions | --full]\n' +
  '                           print now.md (default), decisions.md, or both.\n' +
  '                           Absent files print nothing (exit 0) so the\n' +
  '                           SessionStart hook can `cat` unconditionally.\n' +
  '  write [<identity>]       whole-file rewrite of now.md from stdin.\n' +
  '                           Creates the context/ folder if absent.\n' +
  '  append [<identity>] --decision "<text>" --why "<text>"\n' +
  '                           append one bulleted line to decisions.md.\n' +
  '                           ISO timestamp stamped at the moment of append.\n\n' +
  '  Files: ~/.local/state/coord/<identity>/context/{now.md, decisions.md}\n' +
  '  brief-024 (context/ v1): the in-context-state leg of lossless-restart.\n';

export async function cmdContextCli(
  args: readonly string[],
  ctx: CliContext
): Promise<number> {
  const sub = args[0];
  if (sub === undefined || sub === '-h' || sub === '--help') {
    ctx.stderr(CONTEXT_USAGE);
    return sub === undefined ? 2 : 0;
  }
  const rest = args.slice(1);
  switch (sub) {
    case 'read':
      return cliRead(rest, ctx);
    case 'write':
      return await cliWrite(rest, ctx);
    case 'append':
      return cliAppend(rest, ctx);
    default:
      ctx.stderr(`coord context: unknown subcommand: ${sub}\n\n`);
      ctx.stderr(CONTEXT_USAGE);
      return 2;
  }
}

function cliRead(args: readonly string[], ctx: CliContext): number {
  let recipient: string | undefined;
  let file: 'now' | 'decisions' | 'full' = 'now';
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case '--decisions':
        file = 'decisions';
        break;
      case '--full':
        file = 'full';
        break;
      default:
        if (a.startsWith('-')) {
          throw new Error(`unknown flag: ${a}`);
        }
        if (recipient === undefined) recipient = a;
        else throw new Error(`unexpected arg: ${a}`);
    }
  }
  const r = cmdContextRead({
    ...(recipient !== undefined && { recipient }),
    file,
    env: ctx.env,
    coordRoot: ctx.coordRoot,
  });
  // Print the text as-is (including empty). Absent files exit 0 with
  // empty output — the SessionStart hook can `cat $(coord context
  // read)` unconditionally without a special-case for first-boot
  // agents.
  ctx.stdout(r.text);
  return 0;
}

async function cliWrite(
  args: readonly string[],
  ctx: CliContext
): Promise<number> {
  let recipient: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('-')) throw new Error(`unknown flag: ${a}`);
    if (recipient === undefined) recipient = a;
    else throw new Error(`unexpected arg: ${a}`);
  }
  const buf = await ctx.readStdin();
  const body = buf.toString('utf8');
  const r = cmdContextWrite({
    ...(recipient !== undefined && { recipient }),
    body,
    env: ctx.env,
    coordRoot: ctx.coordRoot,
  });
  ctx.stdout(`wrote ${r.bytes} bytes to ${r.path}\n`);
  return 0;
}

function cliAppend(args: readonly string[], ctx: CliContext): number {
  let recipient: string | undefined;
  let decision: string | undefined;
  let why: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case '--decision':
        if (i + 1 >= args.length) {
          throw new Error('--decision requires a value');
        }
        decision = args[++i];
        break;
      case '--why':
        if (i + 1 >= args.length) {
          throw new Error('--why requires a value');
        }
        why = args[++i];
        break;
      default:
        if (a.startsWith('-')) throw new Error(`unknown flag: ${a}`);
        if (recipient === undefined) recipient = a;
        else throw new Error(`unexpected arg: ${a}`);
    }
  }
  if (decision === undefined) {
    throw new Error('--decision <text> is required');
  }
  if (why === undefined) {
    throw new Error('--why <text> is required');
  }
  const r = cmdContextAppend({
    ...(recipient !== undefined && { recipient }),
    decision,
    why,
    timestamp: new Date().toISOString(),
    env: ctx.env,
    coordRoot: ctx.coordRoot,
  });
  ctx.stdout(`${r.line}\n`);
  return 0;
}
