// commands/journal.ts — terse work-log entries per identity.
//
// Per brief-024: `<identity>/journal/` is a fourth optional writable
// folder, parallel to inbox/archive/tasks. Single-writer (only the
// owning identity writes; peers read via sync). Append-only at file
// granularity — each entry is its own file, never edited in place.
//
// Audience is everyone else: an agent or human skimming should pick
// up the *what* and *why* in seconds. Terse by convention, not by
// code enforcement.
//
// Subcommands:
//   coord journal new "<body>" [--slug ...] [--topic ...] [--tag T,T]
//   coord journal new --stdin
//   coord journal new --edit
//   coord journal ls [<identity>] [--since <ms>]
//   coord journal cat [<identity>] <filename>
//   coord journal tail [<identity>] [-n N]

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';

import type { CliContext } from '../cli-context.ts';
import {
  emitFrontmatter,
  journalDir,
  msNow,
  parseFrontmatter,
  resolveIdentity,
  validIdentity,
} from '../common.ts';
import { InvalidIdentityError } from '../errors.ts';

// Journal filenames are <unix-ms>-<slug>.md. Slug is user-derived, so
// the regex is permissive (any non-empty trailing token before `.md`).
// Distinct from FILENAME_RE in common.ts which is the strict message
// grammar (6-char crockford suffix).
const JOURNAL_FILENAME_RE = /^[0-9]{13}-[A-Za-z0-9._-]+\.md$/;

// ─── Shape ──────────────────────────────────────────────────────────────

export interface JournalRecord {
  filename: string;
  topic: string | null;
  tags: string[];
  body: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────

/** lowercase, hyphenate non-alphanumerics, trim, truncate to 48. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/** First ~8 words of body, slugified. Fallback to "entry" if empty. */
function deriveSlug(body: string): string {
  const cleaned = body.trim();
  if (cleaned.length === 0) return 'entry';
  const words = cleaned.split(/\s+/).slice(0, 8).join(' ');
  return slugify(words) || 'entry';
}

function ensureJournalDir(identity: string, root: string): string {
  const dir = journalDir(identity, root);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function readJournalFile(path: string, filename: string): JournalRecord {
  const text = readFileSync(path, 'utf8');
  const { fm, body } = parseFrontmatter(text);
  const topic =
    typeof fm.topic === 'string' && fm.topic.length > 0 ? fm.topic : null;
  let tags: string[] = [];
  if (Array.isArray(fm.tags)) {
    tags = fm.tags.map((t) => String(t));
  } else if (typeof fm.tags === 'string' && fm.tags.length > 0) {
    tags = fm.tags
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((s) => s.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1'))
      .filter((s) => s.length > 0);
  }
  return { filename, topic, tags, body };
}

// ─── coord journal new ──────────────────────────────────────────────────

export interface JournalNewInput {
  /** Body text. Required and non-empty after trim. */
  body: string;
  /** Optional override for the filename's slug portion. */
  slug?: string | undefined;
  /** Optional `topic:` frontmatter field. */
  topic?: string | undefined;
  /** Optional `tags:` frontmatter array. */
  tags?: string[] | undefined;
  env: NodeJS.ProcessEnv;
  coordRoot: string;
}

export interface JournalNewResult {
  filename: string;
  path: string;
  identity: string;
}

export function cmdJournalNew(input: JournalNewInput): JournalNewResult {
  const body = input.body.trim();
  if (body.length === 0) {
    throw new Error('journal body must be non-empty');
  }
  const identity = resolveIdentity({
    env: input.env,
    coordRoot: input.coordRoot,
  });
  const dir = ensureJournalDir(identity, input.coordRoot);
  const slug =
    input.slug !== undefined && input.slug.length > 0
      ? slugify(input.slug)
      : deriveSlug(body);
  const filename = `${msNow()}-${slug || 'entry'}.md`;
  const path = join(dir, filename);

  const fm: Record<string, unknown> = {};
  if (input.topic !== undefined && input.topic.length > 0) {
    fm.topic = input.topic;
  }
  if (input.tags !== undefined && input.tags.length > 0) {
    fm.tags = input.tags;
  }
  const bodyOut = body.endsWith('\n') ? body : `${body}\n`;
  const content =
    Object.keys(fm).length === 0
      ? bodyOut
      : emitFrontmatter(fm, bodyOut);
  writeFileSync(path, content);
  return { filename, path, identity };
}

// ─── coord journal ls ───────────────────────────────────────────────────

export interface JournalLsInput {
  /** Defaults to $COORD_IDENTITY. */
  identity?: string | undefined;
  /** Filter to filenames whose <unix-ms> prefix is >= this. */
  since?: number | undefined;
  env: NodeJS.ProcessEnv;
  coordRoot: string;
}

export interface JournalLsResult {
  identity: string;
  /** Newest-first by filename timestamp. */
  filenames: string[];
}

export function cmdJournalLs(input: JournalLsInput): JournalLsResult {
  const identity =
    input.identity !== undefined && input.identity.length > 0
      ? input.identity
      : resolveIdentity({ env: input.env, coordRoot: input.coordRoot });
  if (!validIdentity(identity)) throw new InvalidIdentityError(identity);

  const dir = journalDir(identity, input.coordRoot);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    // Lenient cross-identity read: missing journal/ → empty list,
    // not an error. Mirrors `coord task ls`'s behavior on a fresh
    // identity.
    return { identity, filenames: [] };
  }
  let valid = names.filter((n) => JOURNAL_FILENAME_RE.test(n));
  valid.sort();
  valid.reverse(); // newest first
  if (input.since !== undefined) {
    const cutoff = input.since;
    valid = valid.filter((n) => Number(n.slice(0, 13)) >= cutoff);
  }
  return { identity, filenames: valid };
}

// ─── coord journal cat ──────────────────────────────────────────────────

export interface JournalCatInput {
  identity?: string | undefined;
  filename: string;
  env: NodeJS.ProcessEnv;
  coordRoot: string;
}

export function cmdJournalCat(input: JournalCatInput): JournalRecord {
  const identity =
    input.identity !== undefined && input.identity.length > 0
      ? input.identity
      : resolveIdentity({ env: input.env, coordRoot: input.coordRoot });
  if (!validIdentity(identity)) throw new InvalidIdentityError(identity);
  if (!JOURNAL_FILENAME_RE.test(input.filename)) {
    throw new Error(`invalid journal filename: ${input.filename}`);
  }
  const path = join(journalDir(identity, input.coordRoot), input.filename);
  if (!existsSync(path)) {
    throw new Error(`journal entry not found: ${identity}/${input.filename}`);
  }
  return readJournalFile(path, input.filename);
}

// ─── coord journal tail ─────────────────────────────────────────────────

export interface JournalTailInput {
  identity?: string | undefined;
  /** How many entries to return. Defaults to 5. */
  n?: number | undefined;
  env: NodeJS.ProcessEnv;
  coordRoot: string;
}

export interface JournalTailResult {
  identity: string;
  /** Newest-first. */
  entries: JournalRecord[];
}

export function cmdJournalTail(input: JournalTailInput): JournalTailResult {
  const identity =
    input.identity !== undefined && input.identity.length > 0
      ? input.identity
      : resolveIdentity({ env: input.env, coordRoot: input.coordRoot });
  if (!validIdentity(identity)) throw new InvalidIdentityError(identity);
  const n = input.n ?? 5;
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`-n must be a positive integer; got ${n}`);
  }
  const lsResult = cmdJournalLs({
    identity,
    env: input.env,
    coordRoot: input.coordRoot,
  });
  const take = lsResult.filenames.slice(0, n);
  const dir = journalDir(identity, input.coordRoot);
  const entries = take.map((f) => readJournalFile(join(dir, f), f));
  return { identity, entries };
}

// ─── CLI dispatcher ─────────────────────────────────────────────────────

const JOURNAL_HELP =
  'usage: coord journal <verb> [args]\n\n' +
  '  new "<body>" [--slug ...] [--topic ...] [--tag T,T]\n' +
  '    Append a terse journal entry under $COORD_IDENTITY/journal/.\n' +
  '    Alternatives: --stdin to read body from stdin, --edit to open\n' +
  '    $EDITOR on a fresh template.\n' +
  '  ls [<identity>] [--since <ms>]\n' +
  '    List journal entries (newest first). Defaults to your own.\n' +
  '  cat [<identity>] <filename>\n' +
  '    Read one entry, frontmatter + body.\n' +
  '  tail [<identity>] [-n N]\n' +
  '    Last N entries with bodies inline. Default 5.\n';

export async function cmdJournalCli(
  args: readonly string[],
  ctx: CliContext
): Promise<number> {
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    ctx.stderr(JOURNAL_HELP);
    return args.length === 0 ? 2 : 0;
  }
  const verb = args[0]!;
  const rest = args.slice(1);
  switch (verb) {
    case 'new':
      return await cmdJournalNewCli(rest, ctx);
    case 'ls':
      return cmdJournalLsCli(rest, ctx);
    case 'cat':
      return cmdJournalCatCli(rest, ctx);
    case 'tail':
      return cmdJournalTailCli(rest, ctx);
    default:
      ctx.stderr(`coord journal: unknown subcommand: ${verb}\n\n`);
      ctx.stderr(JOURNAL_HELP);
      return 2;
  }
}

async function cmdJournalNewCli(
  args: readonly string[],
  ctx: CliContext
): Promise<number> {
  let body: string | undefined;
  let slug: string | undefined;
  let topic: string | undefined;
  let tags: string[] = [];
  let useStdin = false;
  let useEditor = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case '--slug':
        slug = args[++i];
        break;
      case '--topic':
        topic = args[++i];
        break;
      case '--tag': {
        const v = args[++i] ?? '';
        for (const part of v.split(',')) {
          const t = part.trim();
          if (t.length > 0) tags.push(t);
        }
        break;
      }
      case '--stdin':
        useStdin = true;
        break;
      case '--edit':
        useEditor = true;
        break;
      case '-h':
      case '--help':
        ctx.stderr(JOURNAL_HELP);
        return 0;
      default:
        if (a.startsWith('-')) throw new Error(`unknown flag: ${a}`);
        if (body === undefined) body = a;
        else throw new Error(`unexpected positional arg: ${a}`);
    }
  }

  if (useStdin) {
    if (body !== undefined) {
      throw new Error('--stdin and an inline body are mutually exclusive');
    }
    // readStdin returns Buffer; tests stub this on CliContext.
    const buf = await ctx.readStdin();
    body = buf.toString('utf8');
  }
  if (useEditor) {
    if (body !== undefined || useStdin) {
      throw new Error('--edit is mutually exclusive with --stdin/inline body');
    }
    body = openEditor(ctx.env);
  }
  if (body === undefined || body.trim().length === 0) {
    throw new Error(
      'journal new: body is required (positional, --stdin, or --edit)'
    );
  }

  const r = cmdJournalNew({
    body,
    ...(slug !== undefined && { slug }),
    ...(topic !== undefined && { topic }),
    ...(tags.length > 0 && { tags }),
    env: ctx.env,
    coordRoot: ctx.coordRoot,
  });
  ctx.stdout(`${r.filename}\n`);
  return 0;
}

function cmdJournalLsCli(args: readonly string[], ctx: CliContext): number {
  let identity: string | undefined;
  let since: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case '--since': {
        const v = args[++i];
        if (v === undefined) throw new Error('--since requires a value');
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) {
          throw new Error(`--since must be a non-negative integer; got ${v}`);
        }
        since = n;
        break;
      }
      case '-h':
      case '--help':
        ctx.stderr(JOURNAL_HELP);
        return 0;
      default:
        if (a.startsWith('-')) throw new Error(`unknown flag: ${a}`);
        if (identity === undefined) identity = a;
        else throw new Error(`unexpected positional arg: ${a}`);
    }
  }
  const r = cmdJournalLs({
    ...(identity !== undefined && { identity }),
    ...(since !== undefined && { since }),
    env: ctx.env,
    coordRoot: ctx.coordRoot,
  });
  for (const f of r.filenames) ctx.stdout(`${f}\n`);
  return 0;
}

function cmdJournalCatCli(args: readonly string[], ctx: CliContext): number {
  // <identity> <filename> | <filename>
  let identity: string | undefined;
  let filename: string | undefined;
  for (const a of args) {
    if (a === '-h' || a === '--help') {
      ctx.stderr(JOURNAL_HELP);
      return 0;
    }
    if (a.startsWith('-')) throw new Error(`unknown flag: ${a}`);
    if (filename === undefined && JOURNAL_FILENAME_RE.test(a)) {
      filename = a;
    } else if (identity === undefined) {
      identity = a;
    } else if (filename === undefined) {
      filename = a;
    } else {
      throw new Error(`unexpected positional arg: ${a}`);
    }
  }
  if (filename === undefined) {
    throw new Error('coord journal cat: <filename> is required');
  }
  const r = cmdJournalCat({
    ...(identity !== undefined && { identity }),
    filename,
    env: ctx.env,
    coordRoot: ctx.coordRoot,
  });
  // Emit YAML frontmatter (if any) + body — same shape as the file
  // on disk so peers see exactly what was written.
  const fm: Record<string, unknown> = {};
  if (r.topic !== null) fm.topic = r.topic;
  if (r.tags.length > 0) fm.tags = r.tags;
  const out =
    Object.keys(fm).length === 0
      ? r.body
      : emitFrontmatter(fm, r.body);
  ctx.stdout(out.endsWith('\n') ? out : `${out}\n`);
  return 0;
}

function cmdJournalTailCli(args: readonly string[], ctx: CliContext): number {
  let identity: string | undefined;
  let n: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case '-n': {
        const v = args[++i];
        if (v === undefined) throw new Error('-n requires a value');
        const parsed = Number(v);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error(`-n must be a positive integer; got ${v}`);
        }
        n = parsed;
        break;
      }
      case '-h':
      case '--help':
        ctx.stderr(JOURNAL_HELP);
        return 0;
      default:
        if (a.startsWith('-')) throw new Error(`unknown flag: ${a}`);
        if (identity === undefined) identity = a;
        else throw new Error(`unexpected positional arg: ${a}`);
    }
  }
  const r = cmdJournalTail({
    ...(identity !== undefined && { identity }),
    ...(n !== undefined && { n }),
    env: ctx.env,
    coordRoot: ctx.coordRoot,
  });
  for (let i = 0; i < r.entries.length; i++) {
    const e = r.entries[i]!;
    ctx.stdout(`── ${e.filename} ──\n`);
    if (e.topic !== null) ctx.stdout(`topic: ${e.topic}\n`);
    if (e.tags.length > 0) ctx.stdout(`tags: ${e.tags.join(', ')}\n`);
    if (e.topic !== null || e.tags.length > 0) ctx.stdout('\n');
    ctx.stdout(e.body.endsWith('\n') ? e.body : `${e.body}\n`);
    if (i < r.entries.length - 1) ctx.stdout('\n');
  }
  return 0;
}

function openEditor(env: NodeJS.ProcessEnv): string {
  const editor = env.EDITOR ?? env.VISUAL;
  if (editor === undefined || editor.length === 0) {
    throw new Error(
      'coord journal new --edit: $EDITOR or $VISUAL must be set'
    );
  }
  const tmp = join(
    tmpdir(),
    `coord-journal-${process.pid}-${randomBytes(3).toString('hex')}.md`
  );
  writeFileSync(tmp, '');
  try {
    spawnSync(editor, [tmp], { stdio: 'inherit' });
    return readFileSync(tmp, 'utf8');
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort
    }
  }
}
