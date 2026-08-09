# 选手调查流水线 Agent 运行手册

本文面向后续负责运行 `scripts/analysis/run_player_investigation.py` 的主 Agent，记录实际操作中最容易影响结果或造成不必要中断的经验。本文只讨论运行方法，不记录历史代码缺陷。

## 1. 开始前固定调查口径

开始运行前，先在会话中明确并复述以下信息：

- 账号，包括大小写、下划线等完整字符。
- 举报时间使用哪个时区。
- 起止时间是否为闭区间。
- 用户给到分钟时，结束时间是精确到 `HH:MM:00`，还是包含整个 `HH:MM` 分钟。
- 是否使用区间外全部当前可查询对局作为对照组。

时间必须写成带偏移的 ISO 8601。中国标准时间示例：

```text
2026-08-08T21:00:00+08:00
```

如果用户说“到 22:51 分”且确认包含整个 22:51 分钟，闭区间结束值应明确写为：

```text
2026-08-08T22:51:59.999999+08:00
```

不要默认为整分钟或整点。边界附近可能恰好存在对局，差几十秒就会改变举报组与对照组。

## 2. 每次调查使用独立目录

为每个账号和调查日期创建唯一输出目录，例如：

```powershell
python scripts/analysis/run_player_investigation.py start `
  --account "example_player" `
  --output-dir "investigations\example_player_investigation"
```

不要复用其他选手的目录，也不要在已冻结分组的目录中改换时间区间。已完成阶段同时校验命令摘要和输出 SHA-256；手工修改阶段产物会使续跑校验失败。

所有 PowerShell 会话建议先设置 UTF-8：

```powershell
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"
```

## 3. 启动后先核对棋谱目录

`start` 完成后，顶层状态应为 `awaiting_group_selection`。先读取：

- `game_catalog.json`
- `account_bundle.json`
- `progress.json`

核对账号、总局数、`created` 时间和时区换算，再选择分组。不要仅凭列表顺序推断“最后几局”。

时间区间选择示例：

```powershell
python scripts/analysis/run_player_investigation.py select-groups `
  --run-dir "investigations\example_player_investigation" `
  --reported-from "2026-08-08T21:00:00+08:00" `
  --reported-to "2026-08-08T22:51:00+08:00"
```

分组完成后，必须从 `progress.json` 再确认：

- `reportedGameIds`
- `controlGameIds`
- `excludedGameIds`
- 转换为 UTC 后的 `reportedFrom` 和 `reportedTo`

最好同时检查区间上下界前后的相邻对局，避免分钟边界理解错误。

## 4. `select-groups` 是长命令

`select-groups` 不只生成分组和审查包。它还会继续执行 Player 画像、Level22、hint1、hint6 和安全装配，最后才进入 `awaiting_agent_review`。

个人调查使用固定并行契约：

- Level22：12 个独立 Console worker，每个 16 线程，hash25，逐局原子提交，完成后全量 audit。
- hint6：12 个独立 Console worker，每个 16 线程，Level18、book、hash25、batch 128、timeout 900、最多 2 次，完成后全量 audit。
- Tournament 直接调用 Level22 runner 时默认只有 2 个 worker，避免比赛期间资源抢占；调查编排器会显式传入 12。

因此：

- 不要给外层命令设置两分钟之类的短超时。
- 允许底层命令长时间运行，在另一终端或工具调用中轮询 JSON。
- 每次轮询间隔建议 30–60 秒；不要用长时间阻塞的 `sleep`。
- 命令暂时没有标准输出不等于卡死，应以进程和嵌套进度为准。

主要嵌套进度文件：

```text
progress.json
engine_level22/progress.json
hints/hint1/progress.json
hints/hint6/progress.json
model/adapters/personal_ensemble_progress.json
```

hint 阶段的总实着位置数来自：

```text
hint_source/source_manifest.json -> shape.placements
```

将它与 hint `progress.json` 中的提交计数比较，可以得到真实完成比例。

## 5. 在计算期间完成人工脱谱审查

`offbook_packet.json` 通常会早于 Level22 和 hint 计算完成。主 Agent 可以利用这段时间人工审查，不必等待预审计算全部结束。

审查要求：

- 必须覆盖审查包中的全部对局，不只是举报局。
- 思考时间连续性是主要证据。
- 不得使用固定秒数阈值批量标记。
- Frequency Book 只作弱参考；首次未见节点不能单独确定脱谱。
- 孤立长考后立即恢复短考，通常不足以构成持续转折。
- 没有可信首次转折时明确写 `no_offbook`，不要制造锚点。
- `offBookPly` 必须是目标选手本人的实际落子 ply。
- 每局 `agentNote` 都要说明锚点前后的原始用时连续性。

以 `agent_marks.template.json` 为结构基础生成 `agent_marks.json`，并保持：

```json
"reviewedBy": "agent"
```

建议填写 `sourcePacketSha256`，确保标记对应当前审查包。

## 6. 提交标记与模型口径

预审完成且标记文件准备好后运行：

```powershell
python scripts/analysis/run_player_investigation.py submit-marks `
  --run-dir "investigations\example_player_investigation" `
  --marks "investigations\example_player_investigation\agent_marks.json"
```

模型评估口径为：

- 有人工锚点的举报局：从锚点手开始，包含锚点手。
- 无人工锚点的举报局：使用目标选手整局全部着手。
- 无锚点局会出现在 `fullGameFallbackNoOffbookGameIds`，不会获得合成锚点。

提交后会继续执行模型物化、Profile 物化、12 成员个人适配、举报局推理、Bootstrap、常规子损/WLD/时间统计和最终报告。

## 7. 状态驱动的断点恢复

先读取顶层 `progress.json`，再决定动作：

| 顶层状态或条件 | 操作 |
| --- | --- |
| `awaiting_group_selection` | 执行 `select-groups` |
| 预审阶段 `running` | 继续轮询，不重复启动 |
| 任一阶段 `failed` | 确认没有残留计算进程，再执行 `resume` |
| `awaiting_agent_review` 且没有 `offbook_records.json` | 完成人工标记并执行 `submit-marks` |
| 已有 `offbook_records.json`，后续阶段未完成 | 执行 `resume` |
| `completed` | 校验并读取 `report.json` |

续跑命令：

```powershell
python scripts/analysis/run_player_investigation.py resume `
  --run-dir "investigations\example_player_investigation"
```

查看状态：

```powershell
python scripts/analysis/run_player_investigation.py status `
  --run-dir "investigations\example_player_investigation"
```

外层工具超时后，不要立即再启动一个相同任务。先检查 Python 和 Egaroucid 进程以及嵌套进度，确认旧进程确实已经结束，避免两个进程同时写同一运行目录。

顶层 `lastError` 可能保留已恢复的历史错误。最终判断应同时查看顶层 `status`、各阶段状态、`completedStages/totalStages` 和最终产物哈希。

## 8. 完成标准

只有满足以下条件才算完成：

- 顶层 `status` 为 `completed`。
- `completedStages == totalStages`，通常为 `16/16`。
- `final_report.status` 为 `completed`。
- `report.json` 存在，且实际 SHA-256 与 `progress.json` 一致。
- `report.json.status` 为 `completed`。
- 最终 JSON 中的举报局、对照局和时间选择仍与用户口径一致。

流水线不生成 Markdown。完成后直接从 `report.json` 向当前会话汇报：

- 举报组和对照组局数。
- Level22 子损点估计、Bootstrap 区间和精确组合位置。
- WLD 差值及区间。
- 12 模型实际减预期残差及区间。
- 思考时间经验位置和显著异常项。
- 人工锚点及无锚点整局回退情况。
- 样本量、时间控制归一化和“统计结果不是作弊概率”等限制。

不要只看点估计下结论。区间跨零时应明确说明证据不确定；思考时间单项异常也不能脱离其他指标直接解释为作弊。

## 9. 推荐的最短操作清单

```text
1. 复述账号、时区、精确秒级闭区间。
2. start，核对 game_catalog.json。
3. select-groups，核对边界相邻对局和冻结后的两组 ID。
4. 长时间运行预审阶段，同时人工阅读 offbook_packet.json。
5. 写完整 agent_marks.json。
6. 等待预审阶段完成，submit-marks。
7. 每 30–60 秒轮询顶层和当前 nestedProgress。
8. 失败时先查残留进程，再 resume。
9. 校验 16/16、report.json 状态和 SHA-256。
10. 不生成 Markdown，直接在会话总结结果与限制。
```
