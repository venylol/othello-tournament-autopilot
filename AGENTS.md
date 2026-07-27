# Agent Notes

## Current FTD Player/OQ Mapping Flow

Use one script entrypoint only: `wechat-decrypt\agent_tournament_helper.cmd`.
When the user asks the agent to build the FTD Player/OQ mapping table, the
mandatory flow is:

1. `build-ftd-map-draft --ftd-players "<downloaded ftd-players JSON>"`
   refreshes WeChat group nicknames, builds the draft local mapping table, and
   prints `agentReviewPacket`.
2. Agent review is mandatory and is not human review. The agent reads the
   packet, incomplete rows, current group nickname list, and local roster/OQ
   list. The agent writes only deterministic additions with
   `patch-ftd-map --patch-file "<agent reviewed patch JSON>"`. If there is no
   deterministic addition, it must still run `patch-ftd-map
   --no-changes-reviewed`.
3. `validate-and-publish-ftd-map` performs the single required OQ validation
   pass, writes the validated table through `/api/state`, publishes the whole
   table plus group-nickname candidates online, and verifies remote statistics.

During agent review, WeChat group nicknames usually put the player's name on
the left and the OQ account on the right, separated by a space, hyphen,
underscore, slash, or similar punctuation. Split name/account by this convention
when it is clear; do not guess when multiple readings remain possible.

Shared local/online mapping rows should stay minimal: FTD name, OQ account, and
group nickname plus required validation metadata. Do not write `reason`, long
source explanations, or candidate blocks into the shared mapping table. Older
mentions of the former one-command `build-and-publish-ftd-map` are historical;
the three-stage agent-review flow above is authoritative.

- Project root: `recovered/`
- Cloudflare Pages project name: `onlicheck` (historical only)
- Production URL: `https://onlicheck.pages.dev` (historical only)

## Deploy

Do not deploy this project to Cloudflare Pages. The current working target is
the local page and local sync server only.

## Edit flow

1. Modify files in `recovered/`
2. Start/verify the local workflow with root `打开比赛签到程序.cmd`
3. Verify `http://127.0.0.1:4174/`

## Local Launcher

Use root `打开比赛签到程序.cmd` as the default local startup entrypoint. It is
the local workflow launcher for the repository home page: it starts or verifies
`node local-server.js`, opens `http://127.0.0.1:4174/`, enables the local state
API and FTD static-file service, checks the tournament helper wrapper, checks
the check-in and score helper wrappers, and checks `wechat-decrypt\.venv` Python.

The launcher must not automatically read WeChat messages, run `refresh-map`,
run `score-scan`, or deploy Pages. Those actions require the user's explicit
competition-stage instruction.

## Opt-in Chrome FTD Round Autopilot

The local score-helper also has an explicit `本轮自律` mode documented in
`tournament_arrangement/recovered/FTD_AUTOPILOT.md`. It is not the default
competition-day workflow. The referee must select and start it for one exact
local round/stage. If a valid `roundStartAt` is already applied, preserve and
use it. If it is absent or invalid at startup, set it once to the `本轮自律`
start instant. That click authorizes only that locked round's score and
transcript writes.

- It uses the fixed-ID Chrome MV3 bridge and the persistent local coordinator.
  It imports the selected FTD round directly through the authenticated page
  bridge and must not search or watch Downloads for round JSON.
- A real read-only probe must first prove login, TD access, and coexistence of
  the FTD page socket with the dedicated bridge socket. Until that succeeds,
  FTD score/transcript writes remain disabled.
- It uses direct OQ game-list/detail data only. It must never invoke WeChat,
  `score-scan`, `history`, images, OCR, PaddleOCR, or screenshot recognition.
  The screenshot/manual-image instructions below continue to govern the
  separate existing `score-scan` workflow.
- Existing manual FTD Console buttons and manual JSON import remain available.
  Pause or stop the active automation before using them.
- The usual manual/agent rule that only the frontend user turns yellow ready
  rows green remains unchanged. The sole automation exception is a locked
  autopilot row with an exact verified FTD score readback: it may set green
  `completed` with `lastEditedBy: automation`, preserving the OQ audit and a
  separate FTD receipt.
- Pause prevents new commands; resume revalidates the locked scope. Emergency
  stop prevents new external writes, waits for an in-flight command to settle,
  and never rolls back verified writes. Completion additionally requires every
  applicable transcript readback, final FTD readback, exactly one verified
  round/stage PNG, and Chrome confirmation that its download completed.

## Prompt Notes

1. Monthly no-handicap referee workflow:
   - The user is the referee for the online no-handicap group (`网赛无差别组`).
     When the user asks for this month's tournament name before or during the
     event, use the tournament naming rule below and answer directly.
   - Before check-in, the user imports/edits the initial roster in the local
     frontend. After the user says the import is ready for review, the agent
     reads the shared state and checks for parse errors, duplicate/suspect
     players, missing accounts, stale state, wrong group assignment, or likely
     name/account splits. If anything may affect correctness, report the issue
     directly and wait for the user's correction plan before editing state.
   - During roster review, also estimate the preliminary round count from the
     player count: fewer than 32 players = 5 rounds, 32 to 63 players = 6
     rounds, 64 or more players = 7 rounds. State the likely round count in the
     review summary. If the count is at or near a boundary, especially 31/32
     or 63/64, explicitly remind the user that one extra checked-in player can
     change the required round count.
   - In parallel with local roster setup, the user/referee also enters players
     into Flip the Disc. When the user gives only a new player's Chinese name,
     pinyin name, or minimal name information during registration, reply with
     pinyin-only in the format `Surname Givenname`, exactly one ASCII space,
     and no labels, punctuation, Chinese characters, account guesses, or extra
     explanation.
   - Before check-in starts, keep track of all new-player names the user has
     provided in this conversation. When the user says "开始签到了" or equivalent,
     first mark those known new players as `isNew` in the local shared state
     where they can be deterministically matched; if any new-player name cannot
     be matched safely, stop and ask/report before proceeding.
   - After new-player marking is resolved, run the normal assisted check-in
     flow: use the cached WeChat member map, keep the history start fixed at
     match day 19:27, poll/review through 19:57 in two-minute windows, and only
     mark deterministic sign-ins. Preserve the blocking ambiguity rules below.
   - Before the score-assisted registration stage, the agent must complete all
     tournament workflow stages itself. This includes local startup checks,
     roster review, new-player tracking/marking, FTD player/account mapping,
     check-in polling, state review, and verifying that the current round's FTD
     JSON has been imported.
   - During score-assisted registration, do not use a subagent. The current
     agent handles that round's `score-scan` windows, image opening/manual
     review, pending/ready judgment, and score-write preparation directly under
     `AGENT_MATCH_IMAGE_HELPER.md`, so the user can see progress in the current
     conversation.
   - When the user signals a round handoff point such as "这一轮结束了",
     "准备下一轮", "下一轮准备", or equivalent wording, output a concise
     context-handoff prompt for the user to copy into a new conversation. The
     prompt must tell the next AI which round is next, what local state and
     files to inspect, that it must follow `AGENT_MATCH_IMAGE_HELPER.md`, and
     that it must handle only the next round's score-assisted registration.
     If the user simply asks to start or continue score polling for a round in
     the current conversation, keep working directly instead of outputting a
     handoff prompt.
   - During each match round, if the user asks the agent to poll/register
     scores, use the score helper flow in `AGENT_MATCH_IMAGE_HELPER.md`.
     Do not use OCR or PaddleOCR. `score-scan` only downloads/PNG-converts
     image messages, selects the highest-resolution successfully decoded
     candidate from same-image candidates, and outputs image paths plus sender
     matching against the current round's FTD pairing table. Codex must open
     and manually inspect every score image before reporting or writing a
     result.
     When score polling starts, do not pull chat images immediately: first
     verify that the requested round's FTD JSON has been imported, refresh the
     target group's member nickname map, and map every current-round FTD player
     to the local roster/OQ account where possible. If some players still cannot
     be mapped after the member-map review, list those unresolved mappings in
     the terminal/report and continue; do not block score polling merely because
     a few players lack OQ account mapping.
     If the user/referee has already set the current round start time in the
     frontend and clicked apply, use that shared `roundStartAt`; do not run
     `score-anchor` or manually search chat history just to re-decide the start
     time. `score-scan` can omit `--start` in that case and reports
     `scoreScanTiming.startSource: "frontend-roundStartAt"`. If the frontend
     time is empty and the agent supplies `--start` or `--round-start`,
     `score-scan` writes that time back to frontend `roundStartAt`; later
     polling-window starts must not overwrite a frontend-set time. Realtime
     score polling must also leave the newest 60 seconds of chat history
     unread so WeChat image cache can arrive locally; the helper reports the
     actual adjusted window in `range` and `cacheDelay`.
     Current round FTD pairing data must be loaded before `score-scan`; score
     sender matching uses the current round pairing table, not the check-in
     roster. Once the user has manually imported the current round FTD JSON,
     treat that FTD pairing table as authoritative for score work, including
     table count and table membership. Do not use the check-in roster, checked-in
     player count, or expected table count to decide whether a score table or
     pairing is correct; players may withdraw or be edited by the referee during
     the event. Each `score-scan` terminal output should stay compact. If a full
     report is needed, write it to `--output` and do not paste or restate the
     whole JSON unless the user asks. `pngPaths` must contain only player
     screenshot PNG paths that still require agent manual review. If the OQ
     auto-update step already wrote that table to yellow `ready`, do not output
     that screenshot path, do not include it in the path aggregation block, and
     do not ask the agent to recheck the script result. Bot/referee
     summary-table images must not output PNG paths,
     must not appear in `pngPaths` or `imageItems`, and do not require agent
     image inspection. Pairing charts, ranking tables, and any other image that
     contains no board/result score information must be ignored; do not add them
     to pending. Open all paths from `pngPaths` together before manual
     inspection instead of opening images one by one as they are discovered.
     Review every listed player screenshot before continuing. Do not maintain a growing automatic keyword list as the source
     of truth for score entry. Account verification is a required gate before
     any score write, including timeout, disconnect, resignation, no-show, or
     forfeit writes. For every candidate result image, first compare the visible
     upper and lower OQ IDs against that table's expected two OQ accounts from
     `pairingContext.reporterAccount` and `pairingContext.opponentAccount`.
     The sender-to-table match alone is not enough to register a result. If the
     visible opponent ID is clearly not the expected opponent for that table,
     or if either visible account is clearly outside the two expected players,
     do not write a ready score; write or update a compact pending item for
     agent/referee review in the current polling window. For account-mismatch
     pending, first record the shortest useful summary: the mismatching visible
     OQ ID in the image, that side's registered/group-nickname OQ ID, and that
     player's name.
     Tolerate minor visual-recognition mistakes, case differences, spaces,
     underscores, and very similar IDs. If an image is sideways, upside down,
     or otherwise not readable in the opened orientation, generate a rotated
     local copy with a script/tool and inspect the rotated PNG before deciding
     it is unusable. When
     judging an OQ result screenshot, first check whether the bottom/self-side
     result is timeout, disconnect, resignation, no-show, forfeit, or another
     clear non-board-finish result; if so, record the loser as `0` and winner
     as `64`. Otherwise, for normal result text such as "win by N",
     "赢对手 N 子", "差 N 子", or "胜利(+N)", do not calculate the final score
     from the margin alone. In Othello, when the board finishes before all
     squares are filled, remaining empty squares are awarded to the winner, so
     the same margin can correspond to more than one final score pair. The
     agent must find the opponent's displayed stone count in the image. In OQ
     result screenshots, the upper player row is the opponent and the lower row
     is the sender/self side. Use the upper opponent displayed count as the
     opponent's final score, then compute the sender/self score as
     `64 - opponentScore`. Do not use the lower sender/self-side displayed
     stone count as the scoring source for normal completed games. In the real registration flow, later
     referee/bot results tables must not be used as the score source or
     fallback, must not output PNG paths, and must not be included in agent
     required image review, because the user may be the bot/referee and those
     tables may already depend on agent-entered data. If the player's own screenshot does
     not yield a usable opponent count after manual PNG inspection, stop and
     ask the user.
     If the agent opens an image for manual inspection and personally reads a
     loss-side result line such as "输对手 N 子", "lose by N", or "you lost",
     do not immediately report a loser-side screenshot from that phrase alone;
     wording alone is not the trigger. First inspect the screenshot player rows:
     in an OQ result screenshot, the upper player row is the opponent and the
     lower player row is the sender/self side. If the upper opponent displayed
     stone count is above `32` and the result line says the sender/self side
     lost, then treat it as a true loser-side upload and stop for user
     direction. If the upper opponent count is below `32`, the agent probably
     misread the loss/win wording; keep reviewing instead of blocking solely on
     the loss wording.
     Displayed player numbers may be used to identify accounts/sides or flag a
     contradiction, but not as the primary scoring source, because Othello Quest
     board displays can omit empty squares that are awarded to the winner when
     neither side has a legal move. When
     the agent writes a judged result into an FTD row, write `status: "ready"`
     so the row stays yellow/pending confirmation. Only the user's frontend
     confirmation action, such as pressing Enter or clicking complete, should
     change the row to `status: "completed"` green.
     Ready rows are displayed by result time from earliest to latest. OQ
     auto-update uses the OQ game creation time. Agent/user writes do not need
     to provide this time manually; `push-ready-score` and `push-batch-scores`
     fill it from the image/message time, `sourceMessageKey`, or finally the
     write time. Keep using `push-batch-scores` for one polling window's
     reviewed ready and pending items instead of writing rows one by one.
     Normal ready batch items should stay minimal: `table`, `blackScore`,
     `whiteScore`, and `sourceMessageKey`; `sender` is optional trace context,
     and `verdict` is unnecessary for manually judged exact-score ready items.
     Pending items should keep `wechatSender` and `verdict` for classification.
     If the user marks an FTD row as dirty/pending because the score may be
     wrong, the frontend should keep the row white with `status: "dirty"` and
     add a `dirty: true` pending item in the shared JSON. Dirty items are not a
     blocking ambiguity by themselves, because players may be rematching and a
     later correct screenshot may not exist yet. The agent should keep polling
     and remember to review dirty items later, but must not treat them as green
     completed results or auto-complete them.
     The pending queue is jointly handled by the agent and the user/referee.
     During every score-scan polling window, if the agent finds an abnormal
     screenshot, unreadable image, loser-side upload, account/table mismatch,
     ambiguous sender/table, or any item needing referee attention, update the
     frontend pending queue in that same polling window. Do not leave such
     abnormalities only in terminal notes, and do not wait for a later polling
     window to batch them. Images that are only pairing charts, ranking tables,
     or other non-score/non-board information are not referee-action pending
     items; ignore them. Later rounds/windows must review existing pending
     items and update or clear them when a new valid screenshot resolves the
     issue.
     For score-write follow-up, stop automatically only when all four are true:
     `stopPolling: true`, `stopPollingCode: "all-ready-or-completed"`,
     `roundCompletion.missing_count: 0`, and `resultEditorAudit.ok: true`.
     This means every active table is `ready` or `completed`, and every result
     row has a clear `lastEditedBy` source showing whether it was marked by
     `agent` or `user`. `has-pending-but-round-can-stop` and
     `referee-resolved-pending` are advisory codes only: before stopping,
     inspect `roundCompletion.missing`. Any table still `imported` or `dirty`
     is not registered yet, even if an older pending item was resolved. If
     `stopPollingCode` is `all-ready-or-completed-editor-unknown`, keep
     polling/checking because at least one ready/completed row lacks a clear
     agent/user editor source. Continue polling unless the referee explicitly
     tells the agent to stop.
     Before writing any score, explicitly check these five blocking conditions.
     If any one applies, do not write a ready score. Instead, write/update a
     compact pending item immediately and continue polling unless the user
     explicitly stops the flow or local sync/write fails:
     1. A board/result image shows a visible OQ ID that clearly does not match
        either of the current table's two expected OQ accounts.
     2. The sender/self-side visible OQ ID does not match the sender's expected
        OQ account from the current-round FTD pairing table.
     3. The message sender cannot be uniquely matched to any player in the
        current-round FTD pairing table.
     4. The manually inspected image is a true loser-side upload.
     5. A candidate OQ board/result image still has no usable result after
        manual inspection, including required rotation attempts for sideways or
        upside-down images. Do not use this rule for pairing charts, ranking
        tables, or other images with no board/result score information; ignore
        those images instead of writing pending.
     Blocking score-flow abnormalities include: a clear board/result image whose
     sender cannot be uniquely matched to any player in the current-round FTD
     pairing table; a visible screenshot account that is clearly outside the
     expected two OQ accounts for that table; a loser-side screenshot; or an
     actual OQ board/result image that still has no usable result after the
     agent's own manual image inspection, including required rotation attempts
     for sideways images. Pairing charts, ranking tables, and other non-score
     images are ignored and not recorded in pending.
     These abnormalities block ready-score writes, but they should be recorded
     or updated in pending during the current polling window so the referee can
     jointly handle them in the frontend while agent polling continues.

2. If the user forgets the tournament name, read the current local date first
   and provide the name in this format:
   `Broadway Online Cup YYYY-S<season>-<round>`.
   - `YYYY` is the current year.
   - Season is calendar quarter based: Jan-Mar = `S1`, Apr-Jun = `S2`,
     Jul-Sep = `S3`, Oct-Dec = `S4`.
   - Round is the month number inside that season: first month = `1`, second
     month = `2`, third month = `3`.
   - Known examples: Apr = `S2-1`, May = `S2-2`, Sep = `S3-3`.
   The user's responsible event lane is the online no-handicap group
   (`网赛无差别组`).

3. Referee / host assistance notes for the user's no-handicap online cup lane:
   Source material:
   - Announcement screenshot supplied by user on 2026-06-06.
   - PDF guide:
     `C:\Users\MeroAF\Desktop\比赛编排\无差别\2026栢龙杯棋王赛无差别组比赛流程指南.pdf`.
   - Extracted text-layer copy:
     `source_extracts/open_group_pdf_text_2026.txt`.
   - PDF handling workflow: first check whether the PDF has a usable text
     layer and extract it with `pdfminer`/`pypdf`; only use OCR if the text
     layer is absent or unreadable.
   - Platform: Othello Quest.
   - Check-in window: match day 19:30-19:57. Late check-in is treated as
     forfeiting participation.
   - Roll-call note from the PDF: at 19:30, initial participants or players
     unfamiliar with the process are marked/handled as "扣 2"; other players
     as "扣 1". Preserve this wording unless the user clarifies the operational
     meaning.
   - Registration deadline: match day 19:00.
   - Match start time: match day 20:00.
   - Swiss/preliminary rounds by player count:
     - Fewer than 32 players: 5 rounds.
     - 32 to 63 players: 6 rounds.
     - 64 or more players: 7 rounds.
   - Preliminary time control: 5 minutes per player per game.
   - Preliminary matching: the referee sends a pairing chart each round.
     Players derive the OQ password from the round and table number.
   - Players must verify the opponent name after matching. If the opponent is
     wrong, resign immediately even if the password was entered correctly. If
     they do not resign or do not match within 5 minutes, score the game as a
     64:0 loss.
   - OQ matching note from the PDF: use matching by the shared password; do
     not click the blue option shown in the guide, or matching may fail.
   - Top 4 after preliminaries enter semifinals and finals.
   - Semifinal pairing: preliminary rank 1 vs rank 4, rank 2 vs rank 3.
   - Local score-helper knockout layout: preliminary numeric rounds are followed
     by one `semifinal` stage and one combined `finals` stage. Import the FTD
     `SF` JSON into the semifinal stage (2 tables). Import FTD `F` and `3/4`
     JSON files separately into the combined finals stage; locally `F` is table
     1 and `3/4` is table 2. Preserve each row's original `ftdStage`,
     `ftdRound`, and `ftdTable` for FTD score/transcript writes.
   - Semifinal/final time control: 10 minutes per player per game.
   - Semifinal/final matching: use OQ advanced/detailed settings, enter the
     referee-provided password, choose 10min, set move increment/byoyomi to 0,
     and use normal mode. Password, time, increment, and mode must all match.
   - Semifinal/final tiebreak: winner advances; if drawn, higher preliminary
     rank advances.
   - After semifinals, run the final and the 3rd/4th-place match using the same
     process.
   - Pairing passwords are announced in the group each round. Format is
     round number + table number, both two digits: round 1 table 1 = `0101`,
     round 5 table 6 = `0506`, round 6 table 11 = `0611`.
   - After each round, ask winners to send final score screenshots to the
     group; for draws, either player may send the screenshot. Screenshots
     should include the board/final result view.
   - Score screenshot interpretation rule: FTD black/white assignment is only
     a table-pairing placeholder. In Othello Quest, the two players at a table
     are the reliable pairing; their actual in-game colors are not fixed by
     FTD. When reading a score screenshot, do not use the FTD black/white side
     to infer who scored which color. Match the screenshot accounts/names to
     the two players at that table and use the screenshot's displayed numeric
     scores/result text to assign each player's score. Example: if the sender
     is listed as black in FTD but the screenshot shows that same sender played
     white and won by 12, record the sender's player score from the screenshot
     (38) and the opponent's score (26), regardless of FTD color.
   - During score registration, the user-imported current-round FTD table is
     authoritative even if it differs from the check-in roster or from a table
     count inferred from checked-in players. Do not flag a table-count mismatch
     or table membership mismatch merely because the check-in roster suggests a
     different number of active players; the referee may edit the list for
     withdrawals, absences, or other event-stage changes.
   - During matches, remind players not to chat or send stickers.
   - If the user provides the number of checked-in players, calculate the
     required preliminary round count using the rule above. This is only for
     preliminary format planning before pairings are imported; it must not be
     used to override or question an imported current-round FTD pairing table
     during score registration.

4. New-player registration assistance:
   - During the competition registration stage, if the user sends only a
     player's name, name pinyin, or other minimal player-name information in
     this repository context, treat the player as a new player by default.
   - When replying with a player's name, output pinyin only: surname pinyin
     and given-name pinyin, with exactly one ASCII space between them.
   - Do not output Chinese characters in that reply, even if the user's input
     contains Chinese characters.
   - Do not add explanations, labels, punctuation, account guesses, Chinese
     characters, or extra fields in that reply.
   - Examples:
     - Chinese-character input for Wang Xiaoming -> `Wang Xiaoming`
     - `Wang Xiaoming` -> `Wang Xiaoming`

5. WeChat check-in helper script:
   - Final retained candidate for pulling WeChat nicknames and chat information:
     `https://github.com/ylytdeng/wechat-decrypt`
   - Local checkout:
     `C:\Users\MeroAF\Desktop\比赛编排\wechat-decrypt`
   - Do not connect automation directly to WeChat without explicit user
     confirmation. Preferred check-in mode remains user-operated WeChat plus
     local parsing/sign-in assistance.

6. Local check-in sync workflow:
   - Local web app root:
     `C:\Users\MeroAF\Desktop\比赛编排\tournament_arrangement\recovered`
   - Start the local two-way sync server from that directory:
     `node local-server.js`
   - Open:
     `http://127.0.0.1:4174/`
   - Shared state file:
     `C:\Users\MeroAF\Desktop\比赛编排\tournament_arrangement\recovered\data\checkin-state.json`
   - The browser and the agent both use this shared JSON as the local sync
     bridge. Default roster workflow: the user first opens the local frontend
     and performs the initial roster import/editing there. After the user
     clearly says the initial import is ready for review (for example "ok",
     "好了", "导完了", "检查一下", or equivalent wording), the agent reads the
     shared JSON and reviews the roster for ambiguity, parse mistakes,
     duplicate/suspect entries, missing accounts, or other correctness risks.
     If there are questions, the agent reports them directly and waits for the
     user's correction plan before editing the shared JSON. The agent should
     only create or directly rewrite the roster JSON when the user explicitly
     asks for agent-side import/editing.
   - Strong constraint for assisted check-in: if any ambiguity, parse failure,
     suspected mismatch, conflicting nickname/account mapping, stale state,
     write failure, or other issue could affect sign-in correctness, stop that
     sub-action and report it to the user immediately. Do not silently guess,
     auto-correct, or resolve data conflicts without surfacing them.
   - When the local sync server is available, agent-side roster/check-in
     changes must be written through `http://127.0.0.1:4174/api/state` instead
     of direct file writes. This lets the server broadcast the revision to the
     frontend and avoids browser cached state overwriting agent edits. If the
     API is unavailable, stop and report the local sync problem before writing
     the shared JSON directly.
   - If a direct shared JSON write is explicitly required, write UTF-8 without
     BOM. PowerShell `Set-Content -Encoding UTF8` may produce a BOM in older
     shells and can break strict JSON parsing; prefer the local sync API or a
     no-BOM writer.
   - Preferred tournament-day agent entrypoint:
     `C:\Users\MeroAF\Desktop\比赛编排\wechat-decrypt\agent_tournament_helper.cmd`.
     Use it for common operations so the agent does not switch between separate
     check-in and score/image scripts:
     `refresh-map`, `history`, `images`, `watch-images`, `members`,
     `score-scan`, `push-score`.
     The `history` command exports text plus image messages; when image messages
     are present, it downloads them locally, creates/uses a PNG path, and
     includes `pngPath`, preview path, resolution, sender match hint, and
     `agentText` in the JSON for agent review. If the main WeChat `Img`
     original cannot be decoded, the helper should try same-MD5
     `cache\Message\...\Bubble\*_b.dat` and then `Img\*_t.dat` thumbnail
     fallback before treating the image as unavailable.
     For score registration, prefer `score-scan` to gather/match images. Do not
     use OCR or PaddleOCR. Do not treat keyword-based recognition as
     authoritative. `score-scan` first refreshes the target group's member map,
     verifies the current round FTD table is present, and maps each FTD player
     to the local roster/OQ account where possible before reading images. Any
     unresolved mappings are printed for one agent review pass and then ignored
     if still unclear. The output must include a top-level `pngPaths` array for
     all PNG files in the current polling window, and the agent must open that
     whole list together before judging. The agent must manually judge
     the result against the current-round pairing table. Write only clear
     results through the local sync API as yellow `ready` FTD rows, not green
     `completed` rows. Pending is jointly handled by the agent and the
     user/referee; abnormal, ambiguous, unreadable, loser-side, or
     account-mismatch screenshots must be written or updated as compact pending
     items during the same polling window. Use `push-score` only as a manual
     fallback after agent review.
     If a clear board/result image's sender cannot be uniquely matched to the
     current-round FTD pairing table, if the image is a loser-side screenshot,
     or if manual image inspection still does not show a usable result, do not
     write ready; update pending promptly and continue polling unless the
     referee explicitly interrupts or local sync/write fails.
   - FTD pairing import for score registration:
     On the local score-helper page, the user can click `复制 FTD 导出代码`,
     paste that code into the Flip the Disc console, and download the current
     round JSON plus a black-background pairing PNG. For each round, the user
     manually imports that round's JSON in the local frontend with `导入本轮
     JSON`. The frontend writes the FTD round through the local sync API and
     merges it into the shared JSON state. The agent must not automatically
     search the Downloads folder or run `import-ftd-round.js` as the normal
     flow. Current round FTD pairings must be visible in the frontend and
     synced before `score-scan`.
   - The lower-level WeChat check-in message preparation script remains:
     `C:\Users\MeroAF\Desktop\比赛编排\wechat-decrypt\agent_checkin_bridge.cmd`.
     Do not run `python agent_checkin_bridge.py` directly from the system
     Python; it may miss required packages such as `Crypto`.
     The bridge has two separate stages:
     `refresh-map` explicitly refreshes the target group's member nickname map;
     `history` only reads the cached map and rewrites message senders to group
     nicknames before outputting JSON. Do not refresh the map implicitly during
     every history pull. Refresh is allowed at agent startup, when the agent
     explicitly chooses to refresh, or when the user asks for it.
   - Competition-day assisted check-in flow:
     1. Before 19:30, the user performs the initial roster import/editing in
        the local frontend. The agent may help open/verify the local sync
        server, but should not take over roster import unless explicitly asked.
     2. After the user clearly says the initial import is ready for review,
        the agent reads the shared state JSON:
        `C:\Users\MeroAF\Desktop\比赛编排\tournament_arrangement\recovered\data\checkin-state.json`.
        The agent reviews the roster for ambiguity, parse mistakes,
        duplicate/suspect entries, missing accounts, stale state, or other
        correctness risks. If there are questions, report them directly and
        wait for the user's correction plan before modifying the JSON.
    3. After the waiting check-in roster has been imported/reviewed and before
        formal 19:30 check-in starts, establish the initial FTD Player/OQ
        mapping table. The user exports the FTD player JSON from the local
        frontend's `导出player表` flow, then the agent runs the three-stage
        mapping flow from the top of this file: `build-ftd-map-draft`, mandatory
        agent review plus `patch-ftd-map`, and `validate-and-publish-ftd-map`.
        Importing an FTD player JSON into the frontend only creates an empty
        FTD player table; it is not an initial mapping table and must not be
        published as a completed mapping. The initial table is only a starting
        point; the user/referee, assistant referees, and agent may jointly edit
        or complete it afterward.
        The online mapping table is the assistant-referee collaboration
        surface. Assistant referees may fill or correct FTD/OQ mapping rows
        there, while the agent continues to serve the chief referee/user in
        the local workflow. Mapping-table cloud sync is mostly automated after
        this hard-gated build/publish command; tournament `history` /
        `chat-history` pulls the
        online mapping table before reading messages and pushes the latest
        local WeChat group-nickname pool afterward; the frontend
        `更新线上映射表` button runs the same safe sync manually by pushing
        nicknames first and then pulling the online mapping table. The agent
        should not manually run extra mapping sync commands unless a sync
        result reports an error or the user explicitly asks. Local writeback
        still goes through `/api/state` protective merging, so newer local
        mapping edits are not overwritten by older online data.
     4. Once the roster review is resolved, the agent starts or verifies the local sync server:
        `node local-server.js` from
        `C:\Users\MeroAF\Desktop\比赛编排\tournament_arrangement\recovered`,
        then tells the user to open/monitor `http://127.0.0.1:4174/`.
     5. The agent runs `agent_checkin_bridge.cmd refresh-map` once during
        startup/pre-check unless a fresh suitable cache already exists. The
        agent may refresh again only by explicit agent decision or user request;
        do not bind refresh to every chat-history pull.
     6. Wait until the user says "开始签到了" or gives an equivalent explicit
        start command. Do not poll WeChat check-in messages before that command.
     7. After the start command, poll by repeatedly running
        `agent_checkin_bridge.cmd history --start "<match date> 19:27" --end
        "<current time or 19:57>" --limit 1000`. Use the cached nickname map.
        The 19:27 start is required to avoid missing players who send clear
        `1`/`2` check-in codes a few minutes before the referee/bot check-in
        prompt. Continue polling/reviewing in two-minute windows from 19:30
        through 19:57, but keep the exported history start fixed at 19:27.
        The bridge output already has message senders rewritten to group
        nicknames; never use raw WeChat display names for sign-in matching.
     8. For each poll result, mark only deterministic roster matches as
        checked-in in the shared JSON, preserving manual edits from the browser.
        Record/check-in source as WeChat-derived where the state schema allows.
        Do not rely only on scripts: after every polling round, the agent must
        manually review the round result for missed or mistaken sign-ins before
        reporting progress or moving to the next round.
        When script output includes `reviewItems`, use it as the main review
        table. Each valid-code message should have one row with sender,
        content, status, matchedDisplayName, matchReasons, and
        candidateDisplayNames. `matchedDisplayName` is the roster display-name
        field and must be shown for successful matches. Keep `appliedPreview`,
        `unmatched`, and `disputes` as supporting detail, but do not force
        review across separate tables when `reviewItems` is available.
        Required per-round review:
        - Review newly checked players and make sure the group nickname's main
          name matches the roster player. The normal group nickname convention
          is player name first, OQ account second. If the main name matches the
          roster player's Chinese name/pinyin, the agent may silently accept
          account differences.
        - Review all unmatched or ignored messages that look like sign-in
          attempts. Valid sign-in codes are `1` and `2`, including obvious
          repeated-key forms like `11`, `111`, `22`, or `222`. `2` means the
          player is a new/first-time or process-unfamiliar player and must be
          marked as such where the state schema allows.
        - If a player sends or is discussed with "请个假", "请假", "不参赛",
          "退赛", "弃权", "不比", or similar non-participation context near a
          check-in code, treat it as a blocking dispute. Do not mark that
          player checked-in or remove them from the roster until the user
          confirms the handling.
        - Messages from 19:27-19:29 that clearly contain a valid `1`/`2`
          check-in code may be accepted after manual review, even if they were
          sent before the referee/bot issued the formal check-in prompt. Do
          not reject them solely because they are early.
        - Do not count vague text such as "我到了", "收到", chat, stickers, or
          unrelated discussion as check-in unless it also contains a clear
          `1`/`2` style sign-in code.
        - Review the current not-checked-in list against the chat messages for
          likely Chinese-name, pinyin, or nickname appearances. This review is
          mandatory at every round. Starting around 19:55, strengthen this
          review: manually recheck all remaining not-checked-in players against
          the full check-in window and also inspect newly checked players for
          possible false positives before finalizing.
        - If the agent still cannot decide after applying these rules, stop
          that sub-action and ask the user. Do not silently resolve genuinely
          unclear cases.
     9. If any message sender is unmapped, any roster match is ambiguous, a
        leave/non-participation dispute appears near a sign-in code, the shared
        JSON has a stale/conflicting revision, the local sync server is
        unavailable, or parsing produces an unexpected shape, stop that
        sub-action and report the issue to the user immediately.
     10. Stop polling at 19:57, when the user says to stop, or when a blocking
        ambiguity is encountered. Late check-in handling follows the referee
        notes above.
