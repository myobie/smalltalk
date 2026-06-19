---
date: 2026-05-12
audience: future-us
purpose: collect "agreed this is interesting, parked for later" ideas so they don't get lost
---

# Future ideas — parked

Things we've discussed but decided not to build yet. Listed so the next round of work has a menu to pull from instead of re-discovering each one.

## Structural role enforcement (manager / worker)

Already documented in `agent-roles.md`. Today we use prompts + memory + `agents.md`. Future options if drift becomes a real problem:

- PreToolUse soft-warning hook when the manager is about to Edit/Write in implementation paths.
- External task tracker (could be coord's `tasks/` folder once that ships — manager polls `coord tasks worker-claude --status doing` instead of `pty peek`).
- Per-role env vars surfaced as session tags.

## `coord_task_*` / `coord_journal_*` / `coord_overview` MCP tools

Once the relevant CLI surfaces (`tasks/` from brief-015, overview from brief-016, `journal/` from brief-024) settle in real use, expose them through the MCP server too:
- `coord_task_new`
- `coord_task_status`
- `coord_task_ls` (covers the `--status doing` filter — the load-bearing observability call)
- `coord_journal_new`
- `coord_journal_ls`
- `coord_journal_tail` (the peer-narrative-following call)
- `coord_overview` (drop-in for an agent-facing "what's the state of my world?" tool — useful in Claude Code channel sessions for periodic check-ins)

`coord_members` already shipped (brief-019) for peer discovery; the remaining task/journal/overview surface stays parked. Phase 8 of harness-integrations if it lands. The MCP layer today covers the brief-009 / brief-010 message tools (`coord_msg_send`, `coord_msg_ls`, `coord_msg_read`, `coord_msg_archive`, `coord_msg_thread`, plus `coord_msg_reply` in channel mode) and `coord_members`.

## Pi end-to-end agent-to-agent demo (the 5-identity scene running for real)

The walkthrough's "A bigger demo" section describes a 5-identity setup (manager-claude, worker-claude, pi-agent, codex-agent, myobie) sharing one `$COORD_ROOT`. The folder layout exists in `/tmp/coord-demo/`; what's missing is actually configuring each agent's harness and running all five sessions for real. Could be done as a demo-script (`examples/full-demo/setup.sh` + a tmux/pty layout that boots all five). Useful as both onboarding material and a stress test of the integration.

## Trim convergence across machines (the deferred bug)

LAYOUT.md mentions this. `archive trim` is local-only; a peer that hasn't trimmed yet will resurrect trimmed files on the next sync. Workaround: schedule trim on a similar cadence everywhere. Real fix: tombstone protocol or scoped `--delete` for archive. Worth doing if cross-machine deployment actually happens.

## `coord peer add` verb

`peers.yaml` is hand-edited today. A CLI verb for adding/removing peers would be nice once peer counts grow. Currently fine for the local-mode and single-machine demos.

## Full leniency for `coord message ls <missing-identity>`

Today: `ls dave` where `dave/inbox` exists but is empty returns `# 0 messages in inbox` exit 0, while `ls eve` where no `eve/` folder exists at all errors `identity folder missing for eve` exit 1. Soft asymmetry observed during the brief-017a DX walkthrough.

**Why parked, not fixed:** the error path is the typo-catching signal. `coord message ls dvae` (typo) currently errors loudly. Full leniency would silently return "0 messages" and hide the typo. That's the right tradeoff for the cross-identity read surface — we *want* the error when an identity doesn't exist, even though we want the empty-inbox case to succeed quietly.

If it ever becomes a real friction (e.g. agents need to probe-without-erroring whether a peer is hosted), we can revisit. The escape hatch today is `coord members` — that just doesn't list a non-existent identity.
