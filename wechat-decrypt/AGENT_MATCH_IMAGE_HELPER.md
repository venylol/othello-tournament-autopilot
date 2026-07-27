# Agent Match Image Helper

Preferred unified entrypoint:

```powershell
.\agent_tournament_helper.cmd status
.\agent_tournament_helper.cmd refresh-map
.\agent_tournament_helper.cmd history --start "2026-06-06 20:00:00" --end "2026-06-06 20:30:00" --output agent_cache\match_history.json
.\agent_tournament_helper.cmd images --start "2026-06-06 20:00:00" --end "2026-06-06 20:30:00"
.\agent_tournament_helper.cmd watch-images --start "2026-06-06 20:00:00"
.\agent_tournament_helper.cmd score-scan --round 1 --start "2026-06-06 20:23:00" --end "2026-06-06 20:25:00"
.\agent_tournament_helper.cmd build-ftd-map-draft --ftd-players "$env:USERPROFILE\Downloads\ftd-players-576.json"
.\agent_tournament_helper.cmd patch-ftd-map --no-changes-reviewed
.\agent_tournament_helper.cmd validate-and-publish-ftd-map
```

The helper reads local decrypted WeChat databases and cached local image files
only. It does not automate WeChat and it does not use OCR.

## Current FTD Mapping Flow

Use one entrypoint only: `agent_tournament_helper.cmd`.

1. `build-ftd-map-draft --ftd-players "<ftd-players JSON>"`
   refreshes WeChat group nicknames, builds the first local FTD/OQ table, writes
   it through `/api/state`, and prints an `agentReviewPacket`.
2. The agent must review that packet once. Shared mapping rows are only
   `ftdName`, `account`, and `groupNick` plus required validation metadata;
   do not write `reason`, long source explanations, or candidate blocks into
   the shared local/online table.
3. During agent review, WeChat group nicknames usually put the player's name on
   the left and the OQ account on the right, separated by a space, hyphen,
   underscore, slash, or similar punctuation. Split name/account by this rule
   when it is clear; do not guess when multiple readings remain possible.
4. If the agent can deterministically add anything, run
   `patch-ftd-map --patch-file "<json>"`. If there is nothing deterministic to
   add, run `patch-ftd-map --no-changes-reviewed`. This step is mandatory and
   prevents skipping agent review.
5. Run `validate-and-publish-ftd-map`. It performs the single required OQ
   validation pass, writes the validated local table, publishes online, and
   verifies remote statistics. Do not manually publish the draft.

## FTD Player Account Map

Build the initial FTD Player/OQ account map after the waiting check-in roster
has been imported/reviewed in the local frontend and before formal 19:30
check-in starts. The user exports the FTD player JSON through the local
frontend's `导出player表` flow; then the agent uses the three-stage mapping flow
documented above:

1. `build-ftd-map-draft --ftd-players "<ftd-players JSON>"`;
2. agent review, followed by `patch-ftd-map --patch-file "<json>"` or
   `patch-ftd-map --no-changes-reviewed`;
3. `validate-and-publish-ftd-map`.

The historical one-command `build-and-publish-ftd-map` alias is disabled and is
not the normal competition-day path. Importing an FTD player JSON into the
frontend only creates an empty player table; it is not an initial mapping table
and must not be published as a completed mapping.

## Score Scan

Before score-assisted registration, the agent completes tournament setup and
check-in work itself. During score-assisted registration, do not spawn or use a
subagent. The current agent owns the round's score-scan windows, manual image
review, pending/ready judgment, and score-write preparation directly in the
visible conversation.

Only when the user signals a round handoff point such as "this round is over",
"prepare the next round", "下一轮准备", "这一轮结束了", or equivalent wording,
output a concise context-handoff prompt for the user to copy into a new
conversation. The prompt must tell the next AI which round is next, which local
state/files to inspect, that it must follow this document, and that it must
handle only the next round's score-assisted registration. If the user asks to
start or continue polling/registering scores for a round in the current
conversation, keep working directly instead of outputting a handoff prompt.

`score-scan` is the normal score-review path. For each polling window it:

- reads the latest local frontend state through `http://127.0.0.1:4174/api/state`;
- requires the current round FTD pairings to already be imported in the frontend;
- refreshes the target group's member nickname map before reading match images;
- maps current-round FTD players to OQ accounts before reading chat images,
  using the latest shared `ftdPlayerAccountMapping` first and then local
  roster/member-map hints when the mapping table has no row for that FTD name;
- extracts image messages from the requested WeChat time window;
- tries same-image candidates and keeps the highest-resolution successfully decoded image;
- writes a PNG/preview file path for player screenshot inspection;
- excludes bot/referee summary-table images from `pngPaths`, `imageItems`, and
  manual image review; they are counted as `refereeSummaryImageCount` only;
- matches the sender against the current round FTD pairing table;
- outputs `pngPaths` as the full PNG path list for this window, plus
  `imageItems` in the terminal and full image metadata in the optional JSON
  report.
- omits any player screenshot whose table has already been written to `ready`
  by the OQ auto-update step; those images must not appear in `pngPaths` or
  `imageItems`, and the agent does not need to reopen or recheck the script
  result.

It does not run OCR, does not start any worker, does not maintain keyword rules,
and does not auto-write scores. Codex must open every listed image and manually
judge the result before reporting or writing a score.

If the referee/user has already set the current round time in the frontend,
`score-scan` uses `scoreHelper.rounds[N-1].roundStartAt` automatically and the
agent does not need to run `score-anchor` or manually search for the start time.
The command output includes `scoreScanTiming.startSource:
"frontend-roundStartAt"` and an instruction reminding the agent to use the
frontend time.

Use `score-anchor` only when the frontend has no round time yet and the agent
must determine a new round's first score-scan start time from chat history:

```powershell
.\agent_tournament_helper.cmd score-anchor --round 2 --date 2026-06-06
```

The command reads the current round FTD table, searches that whole day for
`第2轮` / `第二轮` and zero-padded password keywords such as `0201`, `0202`,
and `0203`, then prints every matching message with time and content only.
Senders are omitted to save agent context. By default the total keyword list is
capped at 20: round keywords are kept first, then password keywords from low
table numbers upward. Use `--keyword-limit 0` only when intentionally searching
all tables. Codex should read those matches and choose the `score-scan --start`
timestamp itself; `score-anchor` does not write state or decide the timestamp
automatically.

When the agent does provide a start time because the frontend was empty,
`score-scan --start ...` or `--round-start ...` writes that time back to
`scoreHelper.rounds[N-1].roundStartAt` through the local sync API with
`roundStartSource: "agent-score-scan"`, so the frontend shows the agent-selected
time immediately. If the frontend already had a time, `score-scan` preserves it
and does not overwrite it with later polling-window starts.

If the current round has no FTD pairing table, `score-scan` stops. If some FTD
players cannot be mapped or still lack OQ accounts after checking the group
nickname map, `score-scan` prints those unresolved mappings in the terminal and
continues. The agent reviews that list once; anything still unclear is ignored
for score polling instead of blocking the round.

Clearing the mapping table in the frontend deletes the entire FTD Player/OQ
table, including FTD names and OQ accounts. The next `ftd-player-table` import
creates a fresh initial table; after that, the user and agent jointly maintain
`ftdPlayerAccountMapping`.

Example two-minute polling window:

```powershell
.\agent_tournament_helper.cmd score-scan --round 1 --round-count <frontend-round-count> --start "2026-06-06 20:23:00" --end "2026-06-06 20:25:00" --output agent_cache\score_scan_r1_20260606_2023_2025.json
```

If the frontend already has the round time, the first scan can omit `--start`;
the helper will use the frontend value:

```powershell
.\agent_tournament_helper.cmd score-scan --round 1 --round-count <frontend-round-count> --end "2026-06-06 20:25:00" --output agent_cache\score_scan_r1_20260606_2023_2025.json
```

For every window, call `score-scan` once. Do not split the normal flow into
manual `history`, `images`, and `push-score` calls.

Realtime score polling must leave a local-cache delay. Every `score-scan` and
`watch-images` polling pass reads only chat history whose end time is at least
60 seconds earlier than the current Beijing/local time. If an agent or wrapper
passes an end time inside the newest 60 seconds, the helper automatically
clamps the end time to `now - 60s` and shifts the whole requested window
backward while preserving its duration. Check the output `range` and
`cacheDelay` fields for the actual scanned window. This avoids missing images
whose WeChat cache has not arrived on disk yet.

Within a score round, the current agent makes each `score-scan` call and
reviews that window's output before moving on. Keep image-by-image score
registration in the current visible conversation until the user asks for a
round handoff prompt.

Every `score-scan` terminal output is a compact summary. If `--output` is used,
the full JSON report is written to that file, but the terminal still prints only
the compact summary. Do not paste or restate the full report unless the user asks
for it.

Every `score-scan` output includes a `pngPaths` array for player screenshots
only. Bot/referee summary-table images must not appear in `pngPaths` or
`imageItems`, and the agent does not need to open them. For one polling window,
first let `score-scan` download and list all player screenshot PNG candidates,
then use `pngPaths` to open all listed images for this window together before
manual comparison. Do not open images one by one as they are discovered. If OQ
auto-update already wrote a table to yellow `ready`, its related screenshot is
not an agent review item and must not be added back into `pngPaths`.
Pairing charts, ranking tables, and any other image that contains no board or
result score information are ignored; they must not be written as pending.
Keep the judged items for that polling window together, and write the window's
ready and pending results in one state update with `push-batch-scores` whenever
there is more than one item. Use `push-pending-score` or `push-ready-score` only
for a single correction or emergency update. Do not wait for multiple polling
windows and then merge the updates, because the referee needs to see pending
items immediately.
Pending is jointly handled by the agent and the user/referee. During every
polling window, if manual image review finds an abnormal screenshot, unreadable
image, loser-side upload, account/table mismatch, ambiguous sender/table, or any
other referee-action item, update the frontend pending queue in that same
window. Do not leave abnormal items only in terminal notes or wait for a later
poll before writing/updating pending. Images that are only pairing charts,
ranking tables, or other non-score/non-board information are not referee-action
items and should be ignored.

If `score-scan` sees both the next round label and the next round password
format inside the current polling window, for example `第3轮` plus `0301`, it
sets `stopPolling: true`, `stopPollingCode: "next-round-password-visible"`, and
fills `nextRoundPasswordStopHint`. Treat this as a strong advisory stop marker:
ask/decide whether to stop current-round polling, but do not confuse it with the
post-write all-tables-complete stop rule. The older broad next-round pairing
text hint remains advisory as `next-round-transition-visible`.

## Output Fields

Each image message includes:

- `sender`: group nickname from the cached member map, rewritten through the
  current round pairing match when deterministic.
- `wechatSender`: original group nickname before pairing rewrite.
- `sourceRole`: `player-screenshot` or `referee-summary`.
- `allowedReadySource`: `false` means the item is for flow/cross-check only and
  must not be used as a ready score source.
- `image.path`: saved decrypted original file for player screenshots.
- `image.previewPath`: first player screenshot path the agent should inspect.
- `image.previewPngPath` / `pngPath`: PNG path for player screenshot viewing.
- `pngPaths`: top-level list of player screenshot PNG paths found in this
  score-scan window; open this list together before judging images.
- `alreadySeenInPreviousWindow` / `alreadyWritten`: duplicate markers for
  cross-window boundary images and already-registered sources.
- `refereeSummaryImageCount`: number of bot/referee summary-table images
  suppressed from image review and path output.
- `image.resolution`: decoded image width and height.
- `image.sourceKind`: whether the image came from the high-resolution candidate,
  primary image, Bubble cache, thumbnail, or another fallback.
- `pairingContext.table`: current FTD table.
- `pairingContext.reporterName` / `reporterAccount`: expected sender player and
  OQ account.
- `pairingContext.opponentName` / `opponentAccount`: expected opponent player
  and OQ account.
- `playerHint.status`: `matched`, `ambiguous`, `unmatched`, or `no-roster`.
- `playerHint.matchedDisplayName`: filled only when exactly one current-round
  pairing player is matched.
- `agentText`: compact agent-facing text with sender, match hint, image source,
  resolution, PNG path, and preview path.

## Manual Scoring Rules

Open all images from the top-level `pngPaths` list together before continuing,
then judge each opened image manually.

- Screenshot account verification is the required first gate before writing any
  score. For every candidate image, inspect the visible upper and lower OQ IDs
  and compare them against `pairingAccountIndex`, which lists both OQ accounts
  for every table in the current FTD round. The two visible OQ IDs must
  uniquely match the two accounts of one current-round table before the agent
  writes `ready`.
- Message sender mapping is auxiliary only. It can help locate a likely table,
  but it cannot replace the screenshot OQ ID gate. If the sender mapping
  conflicts with the table uniquely identified by the screenshot's two OQ IDs,
  keep the screenshot OQ match as the required gate and record/update a compact
  pending item for the sender conflict when referee attention is needed.
- Tolerate minor visual-recognition mistakes, case differences, spaces,
  underscores, or very similar IDs. Stop and report an account/table mismatch
  when a visible account is clearly different, far from the expected ID, or
  outside the two players at that table. Do not write a timeout, disconnect,
  resignation, no-show, forfeit, or normal score until this account gate passes.
- For account-mismatch pending, include `accountMismatchText` as the first
  compact summary: visible OQ ID in the image, registered/group-nickname OQ ID,
  and player name for the mismatching side. If both sides mismatch, keep both
  sides in the same short text.
- If an image is only a pairing chart, ranking table, or other picture with no
  board/result score information, ignore it instead of writing pending.
- If an image is sideways, upside down, or otherwise not readable in the opened
  orientation, do not ignore it. Generate a rotated local PNG with a
  script/tool, open the rotated image, and only then decide whether the result
  is usable.
  Example:
  `.\agent_tournament_helper.cmd rotate-image --image-path "C:\path\sideways.png" --degrees 90`
- Timeout, disconnect, no-show, forfeit, or resignation means loser stones `0`
  and winner score `64`, when the screenshot or referee context clearly shows
  that result.
- Draw means `32-32`.
- For normal completed games, do not calculate the final score from the margin
  alone. In OQ result screenshots, the upper player row is the opponent and the
  lower row is the sender/self side. Read the upper opponent displayed count as
  the opponent score, then compute the sender/self score as
  `64 - opponentScore`. Do not use the lower sender/self-side displayed stone
  count as the scoring source for normal completed games.
- FTD black/white is only a table-pairing placeholder. Match the screenshot's
  displayed accounts/names to the two players at that table; do not use FTD
  color to infer score direction.
- Later referee/bot result tables must not be used as the score source or
  fallback.
- If the player's own screenshot does not yield a usable opponent count after
  manual PNG inspection, write/update pending in the current window and keep
  polling unless the referee interrupts.
- If a manually inspected image shows a true loser-side screenshot, write/update
  pending in the current window and keep polling unless the referee interrupts.

## Blocking Score Checks

Before writing any score, explicitly check these five conditions. If any one
applies, do not write `ready`; write or update a compact pending item in the
current polling window and continue polling unless the referee interrupts or
local sync/write fails. Pairing charts, ranking tables, and other images with no
board/result score information are outside these blocking checks and should be
ignored:

- The two visible screenshot OQ IDs cannot both be matched to exactly one
  current-round table in `pairingAccountIndex`.
- A visible screenshot OQ ID is clearly outside the uniquely matched table's two
  expected OQ accounts.
- Sender mapping conflicts with the screenshot-account-matched table and the
  conflict cannot be explained as nickname/account trace noise.
- The manually inspected image is a true loser-side upload.
- A candidate OQ board/result image still has no usable result after manual
  inspection, including required rotation attempts for sideways or upside-down
  images.

Agent-reviewed score writes must set the FTD row to `status: "ready"` so it
appears yellow/pending confirmation in the frontend. The row becomes
`status: "completed"` only after the referee confirms it in the frontend.
Ready rows are ordered by result time from earliest to latest. OQ auto-update
uses the OQ game creation time. Agent/user ready writes do not need to provide
time manually: `push-ready-score` and `push-batch-scores` fill `resultTime`
automatically from the image/message time, `sourceMessageKey`, or finally the
write time. Keep writing one polling window efficiently with
`push-batch-scores`.
If the agent finds an abnormal item while polling, do not stop the whole polling
loop only to report it. Record or update it in the frontend pending queue during
that polling window, and continue polling unless the referee explicitly
interrupts.
Every pending item must include the score-image sender's group nickname in
`wechatSender`; if a `score-scan` output item does not include that group
nickname, add it from the corresponding image-message sender before writing the
pending item. For account-mismatch pending, also include `accountMismatchText`
with the shortest useful text, for example `图上id: xxx / 注册id: yyy / 姓名:
Zhang San`:

```powershell
.\agent_tournament_helper.cmd push-pending-score --round 1 --round-count <frontend-round-count> --table 3 --wechat-sender "Peng Xianlu ppp" --verdict "account-mismatch" --account-mismatch-text "图上id: pppp / 注册id: ppp / 姓名: Peng Xianlu" --source-message-key "message-key-from-score-scan"
```

The pending item is visible in the frontend pending column. The shared JSON is
kept compact; agent writes do not store `reason`, `imagePath`, or `sourceTime`.
If a later image fixes that table/result, use `push-ready-score`; it clears
matching agent pending items for the same table/message and writes the FTD row
as yellow `ready`.

If the referee resolves a pending item in the frontend, the shared JSON keeps
that pending item with `resolvedByReferee: true`, `resolvedAt`, and
`resolvedNote`. Agent write commands report these items in `resolvedPending`;
do not recreate or clear them unless the referee gives explicit direction.
Because pending is jointly handled by agent and referee, each new score-scan
window must review existing pending items and update them when a new screenshot
clarifies or supersedes the abnormality.

For batch writes after reviewing one polling window, prepare a JSON file with
`pending` and `ready` arrays. This is the preferred score-write path. Keep
ready items minimal: use `table`, `blackScore`, `whiteScore`, and
`sourceMessageKey`. `sender` is optional trace context. Do not add `verdict` to
normal ready items when the agent has manually inspected the image and already
has the exact scores. Pending items must include `wechatSender` and should keep
`verdict` for frontend classification.

```json
{
  "pending": [
    {
      "table": "3",
      "pendingTable": "3",
      "sender": "Peng Xianlu",
      "wechatSender": "Peng Xianlu ppp",
      "verdict": "account-mismatch",
      "accountMismatchText": "图上id: pppp / 注册id: ppp / 姓名: Peng Xianlu",
      "sourceMessageKey": "message-key-from-score-scan"
    }
  ],
  "ready": [
    {
      "table": "4",
      "blackScore": 40,
      "whiteScore": 24,
      "sourceMessageKey": "message-key-from-score-scan"
    }
  ]
}
```

Then write the whole polling window at once:

```powershell
.\agent_tournament_helper.cmd push-batch-scores --round 1 --round-count <frontend-round-count> --batch-file agent_cache\score_batch_r1_20260606_2023_2025.json
```

After every `push-ready-score` or `push-batch-scores` write, read
`roundCompletion`, `stopPolling`, `stopPollingCode`, and `stopPollingReason`.
Stop automatically only when all of these are true:
`stopPolling` is `true`, `stopPollingCode` is `all-ready-or-completed`,
`roundCompletion.missing_count` is `0`, and `resultEditorAudit.ok` is `true`.
That means every active table is `ready` or `completed`, and every such row has
a clear `lastEditedBy` source showing whether it was marked by `agent` or
`user`. If the code is `referee-resolved-pending` or
`has-pending-but-round-can-stop`, first inspect `roundCompletion.missing`; any
table still `imported` or `dirty` is not registered yet, even if an older
pending item was resolved. If the code is
`all-ready-or-completed-editor-unknown`, keep polling/checking because at least
one result row lacks a clear agent/user editor source. Continue polling unless
the referee explicitly tells the agent to stop. The agent and referee jointly
maintain `pending`; the agent also maintains yellow `ready` rows. The agent does
not need to manage or wait for `ready` becoming `completed`, because the
referee/frontend may confirm those rows independently.

If the referee/frontend marks a result as dirty, keep it as a white
`status: "dirty"` FTD row and a `dirty: true` pending item in the shared JSON.
Dirty items are reminders for later review, not immediate blockers; continue
polling unless another blocking rule applies.

After manual image review, write clear results to the current round FTD row as
yellow `ready` with `push-ready-score`:

```powershell
.\agent_tournament_helper.cmd push-ready-score --round 1 --round-count <frontend-round-count> --table 3 --black-score 64 --white-score 0 --source-message-key "message-key-from-score-scan"
```

If a yellow `ready` row needs correction, `push-ready-score` may overwrite the
same table when the `sourceMessageKey` is the same. For a different reviewed
source, pass `--force-update`.

Legacy manual fallback: use `push-score` only when the agent has manually
reviewed the result and the FTD-pairing ready path cannot be used. It appends to
the old `pending` queue instead of updating `ftdPairings[].status`:

```powershell
.\agent_tournament_helper.cmd push-score --round 1 --round-count <frontend-round-count> --sender "Peng Xianlu" --loser-stone-count 0 --verdict "you win timeout/resign"
```

## Image Candidate Policy

The helper decodes the highest-resolution available candidate first. If that
candidate cannot be decoded, it continues through lower-resolution candidates
and thumbnails. Common candidate locations include:

1. High-resolution `msg\attach\...\Img\<md5>_h.dat` or another large original.
2. Main `msg\attach\...\Img\<md5>.dat` or another primary image candidate.
3. Same-MD5 `cache\...\Message\...\Bubble\<md5>_b.dat`.
4. Same-MD5 `msg\attach\...\Img\<md5>_t.dat` thumbnail.

Report `image.sourceKind`, `image.source`, `image.originalDecodeError`, and
`image.resolution` so the agent knows whether it is inspecting a high-resolution
candidate, primary original, Bubble cache, or low-resolution thumbnail. If only
a thumbnail is available and the score is not readable, stop and ask for manual
confirmation instead of guessing.

## Dependencies

The project virtualenv needs `av` and `pillow` for HEVC/wxgf preview conversion:

```powershell
.\.venv\Scripts\python.exe -m pip install av pillow
```
