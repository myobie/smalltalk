// commands/ls.ts — list inbox or archive entries.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  archiveDir,
  filenameTimestamp,
  inboxDir,
  parseFrontmatter,
  pluralize,
  resolveIdentity,
  validFilename,
} from '../common.ts';

export interface LsInput {
  recipient?: string | undefined;
  archive?: boolean;
  /** Filename ts >= since (`<unix-ms>` prefix). Undefined means no filter. */
  since?: number | undefined;
  /** Match files whose `from:` frontmatter equals this. */
  fromFilter?: string | undefined;
  /**
   * When true, populate {@link LsResult.items} with parsed frontmatter
   * for each match. Off by default to preserve the cheap filename-only
   * path that `coord ls` and `coord watch` rely on.
   */
  withMeta?: boolean;

  env: NodeJS.ProcessEnv;
  coordRoot: string;
}

export interface LsItem {
  filename: string;
  /** Derived from the filename's `<unix-ms>` prefix; always present. */
  ts: number;
  from: string | null;
  subject: string | null;
  inReplyTo: string | null;
  tags: string[];
  priority: 'low' | 'normal' | 'high' | null;
}

export interface LsResult {
  /** Matching filenames in chronological (filename) order. */
  matches: string[];
  /** Header text for the human-readable form (`# N message[s] in inbox`). */
  header: string;
  /** Whether the lookup was against archive/ (vs inbox/). */
  archive: boolean;
  /**
   * Per-match parsed frontmatter. Present iff {@link LsInput.withMeta}
   * was true. Same length and order as {@link matches}.
   */
  items?: LsItem[];
}

function buildItem(filename: string, dir: string): LsItem {
  const text = readFileSync(join(dir, filename), 'utf8');
  const fm = parseFrontmatter(text).fm;
  const from = typeof fm.from === 'string' && fm.from.length > 0 ? fm.from : null;
  const subject =
    typeof fm.subject === 'string' && fm.subject.length > 0
      ? fm.subject
      : null;
  const inReplyTo =
    typeof fm['in-reply-to'] === 'string' && fm['in-reply-to'].length > 0
      ? fm['in-reply-to']
      : null;
  let tags: string[] = [];
  if (Array.isArray(fm.tags)) {
    tags = fm.tags.map((t) => String(t));
  } else if (typeof fm.tags === 'string' && fm.tags.length > 0) {
    // Stored shape is the raw `[a, b]` list scalar — split conservatively.
    tags = fm.tags
      .replace(/^\[/, '')
      .replace(/\]$/, '')
      .split(',')
      .map((t) => t.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1'))
      .filter((t) => t.length > 0);
  }
  const priorityRaw = typeof fm.priority === 'string' ? fm.priority : '';
  const priority =
    priorityRaw === 'low' || priorityRaw === 'normal' || priorityRaw === 'high'
      ? priorityRaw
      : null;
  return {
    filename,
    ts: filenameTimestamp(filename),
    from,
    subject,
    inReplyTo,
    tags,
    priority,
  };
}

export function cmdLs(input: LsInput): LsResult {
  // Lenient on explicit <other>: a peer's tree on this machine
  // often has only inbox/ from a one-shot send, not archive/. The
  // existsSync gate below treats a missing folder as empty.
  const recipient = resolveIdentity({
    explicit: input.recipient,
    env: input.env,
    coordRoot: input.coordRoot,
    ...(input.recipient ? { policy: 'lenient' as const } : {}),
  });
  const archive = input.archive === true;
  const dir = archive
    ? archiveDir(recipient, input.coordRoot)
    : inboxDir(recipient, input.coordRoot);
  const label = archive ? 'archive' : 'inbox';

  if (!existsSync(dir)) {
    const empty: LsResult = {
      matches: [],
      header: `# 0 messages in ${label}`,
      archive,
    };
    if (input.withMeta === true) empty.items = [];
    return empty;
  }

  const since = input.since;
  const fromFilter = input.fromFilter;
  const withMeta = input.withMeta === true;

  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    // Permission-denied (chmod 000), I/O error, etc — degrade
    // gracefully per the brief-016 read-side resilience contract.
    const empty: LsResult = {
      matches: [],
      header: `# 0 messages in ${label}`,
      archive,
    };
    if (input.withMeta === true) empty.items = [];
    return empty;
  }
  const matches: string[] = [];
  const items: LsItem[] = [];
  for (const name of names.sort()) {
    if (!validFilename(name)) continue;
    if (since !== undefined) {
      if (filenameTimestamp(name) < since) continue;
    }
    if (fromFilter !== undefined && fromFilter !== '') {
      const text = readFileSync(join(dir, name), 'utf8');
      const fm = parseFrontmatter(text).fm;
      if (fm.from !== fromFilter) continue;
    }
    matches.push(name);
    if (withMeta) {
      items.push(buildItem(name, dir));
    }
  }

  const n = matches.length;
  const header = `# ${n} ${pluralize(n, 'message', 'messages')} in ${label}`;

  const result: LsResult = { matches, header, archive };
  if (withMeta) result.items = items;
  return result;
}

export { cmdLs as cmdLsCore };

// ─── CLI wrapper ────────────────────────────────────────────────────────

import type { CliContext } from '../cli-context.ts';

export function cmdLsCli(args: readonly string[], ctx: CliContext): number {
  let recipient: string | undefined;
  let archive = false;
  let count = false;
  let json = false;
  let since: number | undefined;
  let fromFilter: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case '--archive':
        archive = true;
        break;
      case '--count':
        count = true;
        break;
      case '--json':
        json = true;
        break;
      case '--since': {
        const v = args[++i];
        if (v === undefined || !/^[0-9]+$/.test(v)) {
          throw new Error('--since must be a unix-ms integer');
        }
        since = Number(v);
        break;
      }
      case '--from':
        fromFilter = args[++i];
        break;
      case '-h':
      case '--help':
        ctx.stderr(
          'usage: coord message ls [<recipient>] [--archive] [--count|--json] [--since UNIX_MS] [--from ID]\n'
        );
        return 0;
      default:
        if (a.startsWith('-')) throw new Error(`unknown flag: ${a}`);
        if (recipient === undefined) recipient = a;
        else throw new Error(`unexpected arg: ${a}`);
    }
  }
  if (count && json) {
    throw new Error('--count and --json are mutually exclusive');
  }
  const r = cmdLs({
    ...(recipient !== undefined && { recipient }),
    archive,
    ...(since !== undefined && { since }),
    ...(fromFilter !== undefined && { fromFilter }),
    withMeta: json,
    env: ctx.env,
    coordRoot: ctx.coordRoot,
  });
  if (count) {
    ctx.stdout(`${r.matches.length}\n`);
    return 0;
  }
  if (json) {
    ctx.stdout(`${JSON.stringify(r.items ?? [])}\n`);
    return 0;
  }
  ctx.stderr(`${r.header}\n`);
  for (const name of r.matches) ctx.stdout(`${name}\n`);
  return 0;
}
