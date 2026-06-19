// commands/archive.ts — `coord archive [<id>] <filename>` and `coord archive trim ...`

import { existsSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  archiveDir,
  ensureIdentityDirs,
  filenameTimestamp,
  inboxDir,
  msNow,
  pluralize,
  resolveIdentity,
  validFilename,
} from '../common.ts';
import {
  ArchiveConflictError,
  InvalidDurationError,
  InvalidFilenameError,
  MessageNotFoundError,
} from '../errors.ts';

// ─── archive (move inbox → archive) ─────────────────────────────────────

export interface ArchiveInput {
  recipient?: string | undefined;
  filename: string;
  env: NodeJS.ProcessEnv;
  coordRoot: string;
}

export type ArchiveOutcome =
  | { kind: 'moved'; message: 'archived' }
  | {
      kind: 'idempotent';
      message: 'archived (idempotent: archive copy already present)';
    };

export interface ArchiveResult {
  outcome: ArchiveOutcome;
  recipient: string;
}

export function cmdArchive(input: ArchiveInput): ArchiveResult {
  if (!input.filename) throw new Error('<filename> required');

  const recipient = resolveIdentity({
    explicit: input.recipient,
    env: input.env,
    coordRoot: input.coordRoot,
  });
  if (!validFilename(input.filename)) {
    throw new InvalidFilenameError(input.filename);
  }

  const ipath = join(inboxDir(recipient, input.coordRoot), input.filename);
  const apath = join(archiveDir(recipient, input.coordRoot), input.filename);

  // Case 0 (post-sweep idempotent): inbox empty, archive present.
  if (!existsSync(ipath) && existsSync(apath)) {
    return idempotentResult(recipient);
  }

  // Case 1: not in either folder.
  if (!existsSync(ipath)) {
    throw new MessageNotFoundError(recipient, input.filename);
  }

  ensureIdentityDirs(recipient, input.coordRoot);

  if (existsSync(apath)) {
    // Case 2 or 3: archive copy exists. Compare byte-by-byte.
    const ibuf = readFileSync(ipath);
    const abuf = readFileSync(apath);
    if (ibuf.equals(abuf)) {
      // Case 2: byte-identical — remove inbox dup as a no-op.
      rmSync(ipath);
      return idempotentResult(recipient);
    }
    // Case 3: differs. Refuse.
    throw new ArchiveConflictError(recipient, input.filename);
  }

  // Case 4: clean rename.
  renameSync(ipath, apath);
  return {
    outcome: { kind: 'moved', message: 'archived' },
    recipient,
  };
}

function idempotentResult(recipient: string): ArchiveResult {
  return {
    outcome: {
      kind: 'idempotent',
      message: 'archived (idempotent: archive copy already present)',
    },
    recipient,
  };
}

/**
 * Resolve a positional shape that may be `[]`, `[<filename>]`, or
 * `[<identity>, <filename>]`.
 *
 * Single-positional disambiguation: the `.md` suffix wins (identity
 * names can't contain `.` per LAYOUT-004). Pre-brief-017a this used
 * the strict `validFilename` grammar, which mis-parsed
 * `coord message archive nope.md` as an identity and bailed with
 * the misleading "<filename> required" message.
 */
export function splitArchivePositionals(
  positional: readonly string[]
): { recipient?: string | undefined; filename?: string | undefined } {
  switch (positional.length) {
    case 0:
      return {};
    case 1: {
      const v = positional[0]!;
      if (v.endsWith('.md')) return { filename: v };
      return { recipient: v };
    }
    case 2:
      return { recipient: positional[0], filename: positional[1] };
    default:
      throw new Error('too many arguments');
  }
}

// ─── archive trim ───────────────────────────────────────────────────────

export interface ArchiveTrimInput {
  recipient?: string | undefined;
  /** A duration spec like `30d`, `12h`, `2w`. */
  olderThan?: string | undefined;
  /** Keep this many most-recent archive files; trim the rest. */
  keepLast?: number | undefined;
  /** When true, list victims but delete nothing. */
  dryRun?: boolean;

  env: NodeJS.ProcessEnv;
  coordRoot: string;
  /** Override now() for testability. Defaults to {@link msNow}. */
  now?: () => number;
}

export interface ArchiveTrimResult {
  /** Filenames deleted (or that *would* be deleted under --dry-run). */
  victims: string[];
  /** Trailing summary line printed to stderr. */
  summary: string;
  /** Whether this was a dry run. */
  dryRun: boolean;
}

export function cmdArchiveTrim(input: ArchiveTrimInput): ArchiveTrimResult {
  const recipient = resolveIdentity({
    explicit: input.recipient,
    env: input.env,
    coordRoot: input.coordRoot,
  });

  if (input.olderThan === undefined && input.keepLast === undefined) {
    throw new Error('trim requires --older-than DURATION or --keep-last N');
  }

  if (input.keepLast !== undefined) {
    if (
      !Number.isInteger(input.keepLast) ||
      (input.keepLast as number) < 0
    ) {
      throw new Error('--keep-last must be a non-negative integer');
    }
  }

  const adir = archiveDir(recipient, input.coordRoot);
  const dryRun = input.dryRun === true;

  let entries: string[];
  try {
    entries = readdirSync(adir);
  } catch {
    return {
      victims: [],
      summary: dryRun
        ? '# would trim 0 files (dry run; nothing deleted)'
        : '# trimmed 0 files',
      dryRun,
    };
  }
  // Filter to grammar-valid filenames and sort chronologically.
  const files = entries.filter(validFilename).sort();

  const victims = new Set<string>();

  if (input.olderThan !== undefined) {
    const secs = parseDuration(input.olderThan);
    const now = input.now ? input.now() : msNow();
    const cutoffMs = now - secs * 1000;
    for (const f of files) {
      if (filenameTimestamp(f) < cutoffMs) victims.add(f);
    }
  }

  if (input.keepLast !== undefined) {
    const keep = input.keepLast;
    if (files.length > keep) {
      const drop = files.length - keep;
      for (let i = 0; i < drop; i++) {
        victims.add(files[i]!);
      }
    }
  }

  // Stable order: chronological (= filename ascending).
  const uniq = files.filter((f) => victims.has(f));

  if (!dryRun) {
    for (const f of uniq) {
      try {
        rmSync(join(adir, f));
      } catch {
        // ignore: best-effort
      }
    }
  }

  const word = pluralize(uniq.length, 'file', 'files');
  const summary = dryRun
    ? `# would trim ${uniq.length} ${word} (dry run; nothing deleted)`
    : `# trimmed ${uniq.length} ${word}`;

  return { victims: uniq, summary, dryRun };
}

const DURATION_RE = /^([0-9]+)([smhdw])$/;
const DURATION_UNITS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
  w: 86400 * 7,
};

export { cmdArchive as cmdArchiveCore, cmdArchiveTrim as cmdArchiveTrimCore };

// ─── CLI wrapper ────────────────────────────────────────────────────────

import type { CliContext } from '../cli-context.ts';

export function cmdArchiveCli(
  args: readonly string[],
  ctx: CliContext
): number {
  if (args[0] === 'trim') {
    return cmdArchiveTrimCli(args.slice(1), ctx);
  }
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case '-h':
      case '--help':
        ctx.stderr(
          'usage: coord message archive [<identity>] <filename>\n' +
            '       coord message archive trim [<identity>] [--older-than DURATION] [--keep-last N] [--dry-run]\n'
        );
        return 0;
      default:
        if (a.startsWith('-')) throw new Error(`unknown flag: ${a}`);
        positional.push(a);
    }
  }
  const { recipient, filename } = splitArchivePositionals(positional);
  if (filename === undefined) throw new Error('<filename> required');
  const r = cmdArchive({
    ...(recipient !== undefined && { recipient }),
    filename,
    env: ctx.env,
    coordRoot: ctx.coordRoot,
  });
  ctx.stderr(`${r.outcome.message}\n`);
  return 0;
}

function cmdArchiveTrimCli(args: readonly string[], ctx: CliContext): number {
  let recipient: string | undefined;
  let olderThan: string | undefined;
  let keepLast: number | undefined;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case '--older-than':
        olderThan = args[++i];
        break;
      case '--keep-last': {
        const v = args[++i];
        if (v === undefined || !/^[0-9]+$/.test(v)) {
          throw new Error('--keep-last must be a non-negative integer');
        }
        keepLast = Number(v);
        break;
      }
      case '--dry-run':
        dryRun = true;
        break;
      case '-h':
      case '--help':
        ctx.stderr(
          'usage: coord message archive trim [<identity>] [--older-than DURATION] [--keep-last N] [--dry-run]\n'
        );
        return 0;
      default:
        if (a.startsWith('-')) throw new Error(`unknown flag: ${a}`);
        if (recipient === undefined) recipient = a;
        else throw new Error(`unexpected arg: ${a}`);
    }
  }
  const r = cmdArchiveTrim({
    ...(recipient !== undefined && { recipient }),
    ...(olderThan !== undefined && { olderThan }),
    ...(keepLast !== undefined && { keepLast }),
    dryRun,
    env: ctx.env,
    coordRoot: ctx.coordRoot,
  });
  for (const f of r.victims) ctx.stdout(`${f}\n`);
  ctx.stderr(`${r.summary}\n`);
  return 0;
}

/** Parse a duration like `30d` / `12h` / `2w` to seconds. */
export function parseDuration(spec: string): number {
  const m = DURATION_RE.exec(spec);
  if (!m) {
    throw new InvalidDurationError(spec);
  }
  const n = Number(m[1]);
  const unit = m[2]!;
  return n * DURATION_UNITS[unit]!;
}
