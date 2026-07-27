# Agent Check-In Bridge

This bridge prepares WeChat group messages for the check-in agent without
letting the agent infer sender identity.

## Target Group

Default group name is based on the current month:

```text
【n月无差别组】栢龙杯棋王赛
```

For 2026-06 this resolves to:

```text
【6月无差别组】栢龙杯棋王赛
35025014579@chatroom
```

If the group naming pattern changes, pass `--group "..."`.

## Commands

Run from this directory through the project virtualenv wrapper:

```powershell
.\agent_checkin_bridge.cmd status
.\agent_checkin_bridge.cmd refresh-map
.\agent_checkin_bridge.cmd history --start "2026-06-06 19:27" --end "2026-06-06 19:57" --limit 1000 --output agent_cache\checkin_history.json
```

Do not run `python agent_checkin_bridge.py` directly from the system Python.
The bridge depends on packages installed in `.venv`, including `Crypto`.

## Refresh Rule

`refresh-map` is an explicit stage. It may be run by the agent during startup,
by the agent when it decides the cached map is stale, or by direct user request.

`history` never refreshes the map implicitly. It reads the cached map, rewrites
each message sender to the cached group nickname, then outputs JSON. If a
message sender is not present in the cached map, the command exits with an
error instead of outputting ambiguous data.

## Assisted Check-In Flow

Expected event-day flow:

Pre-score stages stay in the current agent context. The agent runs this
check-in bridge itself for roster review, new-player marking, and check-in
polling. Score-assisted registration also stays in the current visible
conversation. When the user signals that a round is over and the next round
should be prepared, output a concise handoff prompt for a new conversation
instead of spawning a hidden subagent.

1. Before 19:30, the user imports and edits the current roster in the local
   browser frontend. The agent may help open/verify the local sync server, but
   should not take over the first import unless explicitly asked.
2. After the user says the import is ready for review, the agent reads the
   local shared state, checks for parse errors, duplicates, suspect entries,
   missing accounts, stale state, or wrong group assignment, and reports any
   correctness risk directly before editing state.
3. During this review, calculate the likely preliminary round count from the
   current player count: fewer than 32 = 5 rounds, 32 to 63 = 6 rounds, 64 or
   more = 7 rounds. If the player count is near 31/32 or 63/64, explicitly
   remind the user that the round count may change at the boundary.
4. The agent starts or verifies the local sync page at:

   ```text
   http://127.0.0.1:4174/
   ```

5. The agent explicitly runs `refresh-map` during startup/pre-check unless a
   fresh suitable cache already exists.
6. Before check-in starts, remember any new-player names the user has provided
   during registration.
7. Wait until the user says "开始签到了" or gives an equivalent explicit start
   command. Do not poll check-in messages before this command.
8. After that command, first mark the known new players as `isNew` in the local
   shared state where they can be deterministically matched. If a name cannot
   be matched safely, stop and ask/report before continuing.
9. After new-player marking is resolved, the agent polls
   with `history`, using a fixed start time
   of 19:27 on match day and an end time of current time or 19:57. Keep the
   history start fixed at 19:27 to catch players who send clear `1`/`2`
   check-in codes before the referee/bot prompt, then review in two-minute
   windows from 19:30 through 19:57.
   Example:

   ```powershell
   .\agent_checkin_bridge.cmd history --start "2026-06-06 19:27" --end "2026-06-06 19:57" --limit 1000 --output agent_cache\checkin_history.json
   ```

10. The agent consumes only this rewritten JSON. It must not use raw WeChat
   display names for sign-in matching. Early 19:27-19:29 messages with clear
   valid codes (`1`, `2`, `11`, `111`, `22`, `222`) may be accepted after
   manual review; do not reject them solely because they came before the formal
   check-in prompt.
11. Agent-side shared-state writes should go through the local sync API
   `http://127.0.0.1:4174/api/state` when the local server is available. This
   avoids direct file encoding problems and lets the browser receive the same
   revision instead of pushing stale cached state back into the shared JSON.
12. If a valid-looking code appears near "请个假", "请假", "不参赛", "退赛",
   "弃权", "不比", or similar leave/non-participation context, treat it as a
   blocking dispute and ask the user before marking check-in or changing the
   roster.
13. When `agent_apply_checkin_window.js` output includes `reviewItems`, use it
   as the main one-row-per-code review table. Successful matches must show the
   roster name in `matchedDisplayName`; unmatched, ambiguous, already checked,
   and dispute rows should be visible in the same table.
14. If `history` fails because a sender is unmapped, or if roster matching is
   ambiguous, the agent must stop that sub-action and report the issue to the
   user immediately.
15. Polling stops at 19:57, when the user asks to stop, or when a blocking
   ambiguity appears.

## Current Mapping Snapshot

At implementation time the target group had:

- `member_count`: 184
- `mapped_count`: 163
- `missing_from_ext_count`: 21

The 2026-06-06 19:30-19:57 check-in window exported successfully with 138 text
messages after sender rewrite. Future runs must still treat any unmapped sender
as a blocking ambiguity and report it to the user.
