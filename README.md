# coord

A small Node CLI **and** TypeScript library for the **coord** file-folder
convention. The folder is the API: `<identity>/inbox/`, `<identity>/archive/`,
plus the optional `<identity>/tasks/` queue, plain markdown files with YAML
frontmatter, plain `rsync` between machines.

- **Convention:** [LAYOUT.md](LAYOUT.md) — the binding spec.
- **Philosophy:** [IDEA.md](IDEA.md).
- **Walkthrough:** [notes/walkthrough.md](notes/walkthrough.md) — three
  participants, three machines, an end-to-end play.
- **Loss argument:** [notes/PROOF.md](notes/PROOF.md).

> **Pre-1.0.** Conventions and CLI may break between commits.

## Install

```sh
git clone https://github.com/myobie/coord
cd coord
npm install
export PATH="$PWD/bin:$PATH"
```

Requires Node 22.6+ (for `node --experimental-strip-types`) and `rsync`
on `$PATH`. `bin/coord` is a small bash shim that execs Node against
`src/cli.ts`.

## First time on a machine

```sh
mkdir -p $HOME/.local/state/coord/alice/{inbox,archive}
export COORD_IDENTITY=alice
```

`COORD_IDENTITY` (or an explicit `--from <id>` per command) tells coord
which identity is acting; commands die loudly when neither is set.

To wire up an MCP host (Claude Code, etc.) inside a repo, run `coord init`
in that repo's root. It writes (or merges into) a `.mcp.json` with the
coord channel-mode entry — see [MCP server](#mcp-server) below.

```sh
cd ~/work/some-repo
coord init                  # write or merge .mcp.json in cwd
coord init --print          # preview the entry without touching disk
```

`coord init` is idempotent: re-running it on a repo that already has
the matching entry is a no-op. Other `mcpServers.*` entries (if any)
are preserved untouched. The resolved `command` path is portable — it
comes from this package's install location, not your developer
machine.

## CLI: a few example commands

```sh
echo "hi bob" | coord message send bob --subject hello      # send via stdin (alias: `coord msg send`)
coord message ls                                            # list my inbox
coord message read bob 1714826789012-x9k4mz.md              # parsed view of one file
coord message archive 1714826789012-x9k4mz.md               # mv inbox -> archive
coord message thread bob 1714826789012-x9k4mz.md            # walk the in-reply-to chain
coord status --set busy                                     # update my status (available | busy | away | dnd | offline)
coord task new "fix login" --priority high                  # add a task to my queue
coord tasks worker-claude --status doing                    # what's worker-claude doing right now?
coord journal new "shipped brief-024" --tag layout          # terse work-log entry
coord journal tail worker-claude -n 5                       # follow a peer's narrative
coord members --status available                            # who's around?
coord overview                                              # at-a-glance dashboard
coord init                                                  # wire .mcp.json into the current repo
coord sync pull --all                                       # conservative cron
coord watch                                                 # cross-tree activity
```

`coord help` lists every subcommand; `coord <subcommand> --help` shows
that command's usage.

## Programmatic API

Embed coord into a Node TUI, an Electron main process, or any host that
wants to drive coord without shelling out to `bin/coord`:

```ts
import { createCoord, asIdentity } from '@myobie/coord';

const coord = createCoord({
  root: '/Users/me/.local/state/coord',
  identity: asIdentity('me'),
});

await coord.send(asIdentity('teammate'), 'hello');

const ac = new AbortController();
for await (const ev of coord.watch(undefined, { signal: ac.signal })) {
  console.log(`new: ${ev.identity}/${ev.filename}`);
}
```

Branded `Identity` / `Filename`, async-iterable `watch` with
`AbortSignal`, typed `CoordError` subclasses (each with a stable
`code`), zero stdio writes. Full surface: [src/index.ts](src/index.ts).
Runnable example: [examples/tui-watch.ts](examples/tui-watch.ts) (`npm
run example:tui-watch`). Canonical reference for each method:
[tests/unit/lib.test.ts](tests/unit/lib.test.ts) and
[tests/integration/library-embedding.test.ts](tests/integration/library-embedding.test.ts).

## MCP server

`coord mcp` runs the same surface as a [Model Context
Protocol](https://modelcontextprotocol.io) stdio server. Tools:
`coord_msg_send`, `coord_msg_ls`, `coord_msg_read`, `coord_msg_archive`,
`coord_msg_thread`, `coord_members`.

The fast path to wire it into a repo is `coord init` (described under
[First time on a machine](#first-time-on-a-machine)) — that writes a
`.mcp.json` with the entry below, resolving the `command` path
portably. For hosts that need a hand-written config, the shape is:

```json
{
  "mcpServers": {
    "coord": {
      "command": "coord",
      "args": ["mcp"],
      "env": { "COORD_ROOT": "/Users/me/.local/state/coord", "COORD_IDENTITY": "me" }
    }
  }
}
```

Errors surface as `isError: true` with a `<CODE>:` prefixed text block
and a structured payload under `result._meta['coord/error']` (namespaced
passthrough — schema-free).

### Push mode (Claude Code channels)

`coord mcp --channel` adds the push half: the server watches the
configured inbox, emits `notifications/claude/channel` for every new
message, and registers a `coord_msg_reply` tool. Aimed at Claude Code; other
MCP hosts ignore the experimental capability and keep getting the same
non-channel tool set.

`coord init` writes the channel-mode entry by default — use
`coord init --no-channel` to omit the `--channel` arg for pull-only
hosts. The hand-written shape:

```json
{
  "mcpServers": {
    "coord": {
      "command": "coord",
      "args": ["mcp", "--channel"],
      "env": { "COORD_ROOT": "/Users/me/.local/state/coord", "COORD_IDENTITY": "me" }
    }
  }
}
```

Default `coord mcp` (no flag) is unchanged — non-Claude hosts pay no
chokidar startup cost.

The MCP server ships an `instructions` string covering the **boot
ritual**: on connect, the agent writes `available` to its status
file, drains any inbox backlog (ls → read → reply → archive), and
runs `coord_members` for peer state. As work happens, it records
tasks via `coord task new/status/done`. On shutdown (`SIGTERM`,
`SIGINT`, or transport close), the server writes `offline` to the
status file so peers see the right state immediately. The full text
lives in `src/mcp/capabilities.ts` (`CHANNEL_INSTRUCTIONS`).

## Harness integrations

Coord plugs into three agent harnesses with reference scripts under
[`examples/`](examples/):

- **Claude Code** — `coord mcp --channel` advertises
  `experimental.claude/channel` and emits `notifications/claude/channel`
  for every new arrival, plus a `coord_msg_reply` tool. See above.
  A `SessionStart` hook at
  [`examples/claude-code/`](examples/claude-code/) fires the boot
  ritual on cold start AND on every `--resume` / `/clear` / `/compact`
  so resumed sessions don't sit silent — install per
  [`examples/claude-code/README.md`](examples/claude-code/README.md).
- **Codex CLI** — [`examples/codex/`](examples/codex/) ships
  `SessionStart` + `Stop` bash hooks that inject the inbox snapshot
  via `coord message ls --json`, plus a `coord ding` recipe for true push
  into a pty-wrapped Codex session.
- **Pi** — [`examples/pi/coord.ts`](examples/pi/) is a single
  TypeScript extension that auto-discovers from
  `~/.pi/agent/extensions/`, watches the inbox via the embeddable
  library, and registers the five coord verbs via
  `pi.registerTool()` (pi has no native MCP). Its `session_start`
  handler also fires a one-time `pi.sendUserMessage` so the boot
  ritual runs on every fresh session and `/reload` / `/resume`.

For harnesses without channels or extension points, `coord ding
<pty-session>` is a busy-aware push daemon: it watches the inbox,
respects `coord status` (suppress on `busy`/`dnd`, flush on
`available`/`offline`), and pty-sends a one-line notice into the
target session on each new arrival.

The full integration map — design rationale, links to the briefs that
shipped each phase — lives at
[`notes/harness-integrations.md`](notes/harness-integrations.md).

## Tests

```sh
npm test                # full vitest run: unit + integration
```

Unit tests exercise every module in `src/` against in-memory fixtures.
Integration tests spawn the actual `bin/coord` binary against real
`$COORD_ROOT` directories, real `rsync`, and real PTYs (via
`@myobie/pty/testing`) — gated by rsync's presence on `$PATH`.

## Layout reference

See [LAYOUT.md](LAYOUT.md). Anything not in LAYOUT.md is implementation
choice and may change.
