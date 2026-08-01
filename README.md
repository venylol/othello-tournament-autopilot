# 比赛编排本地入口

本仓库现在只用于本地比赛签到、配对导入和比分登记辅助，不部署到
Cloudflare Pages。默认入口是根目录：

```powershell
.\打开比赛签到程序.cmd
```

这个 cmd 是本地流程总启动器：

- 启动或复用 `tournament_arrangement\recovered\local-server.js`
- 打开本地页面 `http://127.0.0.1:4174/`
- 启用本地状态 API：`http://127.0.0.1:4174/api/state`
- 启用 FTD 控制台导出代码所需的本地静态文件服务
- 预检 `wechat-decrypt\agent_tournament_helper.cmd`
- 预检 `wechat-decrypt\.venv` Python

注意：cmd 只启动常驻本地依赖和做预检，不会自动读取微信消息，不会自动
`refresh-map`，不会自动 `score-scan`，也不会部署网页。这些比赛阶段动作必须等裁判
明确开始对应流程后再由 agent 执行。

比分轮询阶段不使用 OCR。脚本只负责读取微信图片、从同一组候选图里选择
成功解码的最高分辨率图片、生成可查看的 PNG/预览路径，并输出发图人和本轮
FTD 配对匹配信息；Codex 后续逐张打开图片人工识别比分。
比分辅助登记之前的所有阶段由当前 agent 自己完成，包括本地启动检查、名单审查、
新人标记、FTD player/OQ 映射、签到轮询和本轮 FTD JSON 导入确认。比分辅助登记阶段
不使用 subagent；当前 agent 直接处理本轮 `score-scan`、图片人工判读、pending/ready
判断和比分写入准备，方便用户在当前对话里看到进度。只有当用户说“这一轮结束了”、
“准备下一轮”、“下一轮准备”或同类换轮交接话术时，agent 才输出一段可复制到新对话的
上下文交接 prompt，让新对话里的 AI 只接手下一轮比分辅助登记；如果用户只是要求在当前
对话里开始或继续某一轮比分轮询，就继续直接处理，不输出交接 prompt。
每次 `score-scan` 前会先确认本轮 FTD JSON 已导入，刷新群成员昵称映射，
并把本轮每个 FTD 选手映射到本地名单里的 OQ 账号。输出会列出发图者
姓名/OQ 号和对手姓名/OQ 号，方便 Codex 看图核对。登记前必须先核对截图
上下两行可见 OQ ID 是否属于本桌这两个人；只靠发图人匹配到桌号不能登记。
截图里的 ID 如果只是大小写、空格、下划线或轻微识别误差导致很相似，不作为
异常；但如果可见对手 ID 明显不是本桌对手，或任一可见账号明显不是本桌两人，
必须停止并报告账号/桌号不匹配。横向、倒置或不便阅读的图片不能直接忽略；
先用脚本/工具生成旋转后的本地 PNG，再人工看旋转图。

```powershell
cd .\wechat-decrypt
.\agent_tournament_helper.cmd --help
.\agent_tournament_helper.cmd build-ftd-map-draft --ftd-players "%USERPROFILE%\Downloads\ftd-players-576.json"
.\agent_tournament_helper.cmd patch-ftd-map --no-changes-reviewed
.\agent_tournament_helper.cmd validate-and-publish-ftd-map
.\agent_tournament_helper.cmd history --start "YYYY-MM-DD HH:MM:SS" --end "YYYY-MM-DD HH:MM:SS" --output agent_cache\history.json
.\agent_tournament_helper.cmd score-anchor --round N --date YYYY-MM-DD
.\agent_tournament_helper.cmd score-scan --round N --end "YYYY-MM-DD HH:MM:SS"
.\agent_tournament_helper.cmd rotate-image --image-path "C:\path\sideways.png" --degrees 90
```

FTD Player/OQ 映射表的正常比赛日流程是三阶段：
`build-ftd-map-draft --ftd-players ...`、agent 审阅后执行
`patch-ftd-map --patch-file ...` 或 `patch-ftd-map --no-changes-reviewed`、
最后 `validate-and-publish-ftd-map`。中间审阅是 agent 审阅，不是人工审阅；
只写确定性的 FTD 名称/OQ 账号/群昵称补充。历史的一步式
`build-and-publish-ftd-map` 已禁用，不要作为正常入口。

如果用户已在前端设置本轮开始时间并点击应用，`score-scan` 会直接使用
`scoreHelper.rounds[N-1].roundStartAt`，agent 不需要再运行 `score-anchor`
或手动找开始时间。只有当前端本轮时间为空时，才用 `score-anchor` 生成关键词，
搜索当天聊天里的 `第N轮`、简体中文轮次和 `0N01`、`0N02` 这类密码消息，
只输出时间和消息内容，方便 agent 判断本轮起点。agent 首次传入 `--start`
或 `--round-start` 时，脚本会把该时间写回前端本轮 `roundStartAt`；如果前端
已有时间，后续轮询窗口不会覆盖它。默认总关键词上限是 20 个：轮次关键词优先，
剩余名额从低桌号密码开始；需要全量搜全部桌号时再加 `--keyword-limit 0`。

每个窗口仍然只运行一次 `score-scan`。输出中的 `imageItems`/报告路径供
当前 agent 打开图片人工判读；顶层 `pngPaths` 是本窗口需要打开的玩家截图 PNG
清单，必须先一次性全部打开，再逐张人工判读；不维护自动关键词表，也不自动写绿色完成状态。
实时轮询窗口必须给微信图片缓存留出时间：脚本只读取结束时间至少早于当前本地时间
60 秒的聊天记录。如果传入的 `--end` 太新，`score-scan` 会保持窗口长度并整体后移，
在输出 `range` 和 `cacheDelay` 里显示实际扫描窗口。
如果当前窗口聊天里同时出现下一轮轮次和下一轮密码，例如 `第3轮` 与 `0301`，
`score-scan` 会输出 `stopPollingCode: "next-round-password-visible"`，作为
是否停止当前轮询的强提示，由 agent/裁判结合缺失桌和前端状态决定。
同一个轮询窗口里如果判出多个结果或 pending，优先写一个批量 JSON，然后用
`push-batch-scores` 一次写入本窗口的 `ready` 和 `pending`。只有单条修正或
紧急补写才使用 `push-ready-score` / `push-pending-score`；旧的 `push-score`
只是 FTD ready 路径不可用时的 fallback。

批量写入模板：

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
      "sender": "Black Player",
      "blackScore": 40,
      "whiteScore": 24,
      "sourceMessageKey": "message-key-from-score-scan"
    }
  ]
}
```

```powershell
.\agent_tournament_helper.cmd push-batch-scores --round N --round-count <前端显示的总轮次> --batch-file agent_cache\score_batch_rN_YYYYMMDD_HHMM_HHMM.json
```

pending 由 agent 和用户（裁判）共同处理。每轮轮询中只要发现异常截图、
账号/桌号不匹配、败方上传、不可读图片或其他需要裁判介入的情况，agent
应当在当前轮询窗口及时写入或更新精简 pending，不要攒到后续窗口再合并。
前端标记的脏数据应保留为白色 `dirty` 行，并在共享 JSON 的 pending 队列里
带 `dirty: true`，供后续 agent 留意；它不是当前轮询的立即阻塞项。

## 常用路径

- 本地页面源码：`tournament_arrangement\recovered`
- 选手分析工具门户：`player_analysis_toolkit`
- 共享状态文件：`tournament_arrangement\recovered\data\checkin-state.json`
- Agent 比赛辅助入口：`wechat-decrypt\agent_tournament_helper.cmd`
- 无差别组流程 PDF：`无差别\2026栢龙杯棋王赛无差别组比赛流程指南.pdf`
- Agent 守则：`AGENTS.md`
## Score-scan output budget

`score-scan` should keep terminal output compact. Use `--output` for the full
JSON report; the terminal summary should be enough for the agent to decide which
player screenshots to open. Bot/referee summary-table images are counted only as
`refereeSummaryImageCount`; they must not output PNG paths, must not appear in
`pngPaths`/`imageItems`, and do not require agent image inspection.

## Current FTD Player/OQ mapping flow

Use one entrypoint only: `wechat-decrypt\agent_tournament_helper.cmd`.

```powershell
.\agent_tournament_helper.cmd build-ftd-map-draft --ftd-players "%USERPROFILE%\Downloads\ftd-players-576.json"
.\agent_tournament_helper.cmd patch-ftd-map --no-changes-reviewed
.\agent_tournament_helper.cmd validate-and-publish-ftd-map
```

The middle step is agent review, not human review. The agent must inspect the
`agentReviewPacket`, incomplete rows, group nickname list, and local roster/OQ
list, then either write deterministic additions with `patch-ftd-map --patch-file`
or explicitly run `patch-ftd-map --no-changes-reviewed`. WeChat group nicknames
usually put name on the left and OQ account on the right, separated by a space,
hyphen, underscore, slash, or similar punctuation; split by that convention only
when clear. Shared mapping rows should stay minimal: FTD name, OQ account, group
nickname, and required validation metadata. Do not store `reason` or long source
explanations in the local/online mapping table.

轮次数以本地前端/API 的显式设置和已导入当前轮配对为准。人数估算只用于赛前
提醒，不能让前端、导入脚本或 helper 把用户设置的 4 轮改成 5 轮。Egaroucid
统计只使用真实 OQ 棋谱 game id；BYE 可以显示为 BYE，但不能伪造成真实棋谱或
进入真实均损统计。
