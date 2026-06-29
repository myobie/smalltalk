#!/bin/bash
# coord session-start nudge — wakes Claude with a system reminder to
# run the coord boot ritual on every cold start, --resume, --continue,
# /resume, /clear, and /compact.
#
# Install per coord/examples/claude-code/README.md.
#
# This script is intentionally minimal: it doesn't shell out to `coord`
# or fetch anything — the boot ritual itself (status set, inbox drain)
# is documented in the MCP server's CHANNEL_INSTRUCTIONS string + the
# coord SKILL.md, both of which the agent has already loaded by the
# time it sees this reminder. All we need to do here is force a model
# turn so those instructions get acted on; exit code 2 + stderr is the
# mechanism Claude Code uses to inject a system reminder under
# `asyncRewake: true`.
echo "Run the coord boot ritual: set status to available and drain inbox (read → reply → archive)." >&2
exit 2
