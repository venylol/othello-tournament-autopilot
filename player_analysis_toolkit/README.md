# Player Analysis Toolkit

本目录提供可复用的 Othello Quest 选手调查工具。它不会启动或修改 EG
引擎，只读取已有的 OQ bundle 和 EG `game_*.json` 分析结果。

所有文本输入输出均使用 UTF-8。脚本不会删除输入或既有结果文件；输出路径
如果需要覆盖，应由使用者先明确处理。

## 文件

- `player_analysis.py`：数据汇总、子损、用时、个人开局库、留一法开局比较、
  外部参照组比较及统一运行入口。
- `analysis_core.py`：棋盘回放、8种对称归一化和全部统计函数。
- `standard_openings.json`：可手工维护的标准定式名称、别名和着手序列表。
- `agent_offbook_review.py`：生成逐 ply 人工审查包、校验 Agent 手工脱谱标记，
  并计算包含脱谱手在内的脱谱后统计。
- `render_github_pdf.py`：把 Markdown 渲染成 GitHub Issue 风格 HTML/PDF。
- `METHOD.md`：当前分析方法及各项结果的含义。

## 环境

- Python 3.11 或更高版本
- `numpy`
- `scikit-learn`
- Microsoft Edge（仅 PDF 生成需要）

## 1. 汇总 OQ 数据

```powershell
python player_analysis.py summary `
  --bundle "C:\path\account-bundle.json" `
  --account "player_id" `
  --output-dir "C:\path\output\summary"
```

输出：

- `summary.json`
- `events.json/csv`
- `games.json/csv`

## 2. 建立特定选手 Human Frequency Book

```powershell
python player_analysis.py build-book `
  --bundle "C:\path\account-bundle.json" `
  --account "player_id" `
  --color white `
  --exclude-game-id "reported_game_1" `
  --exclude-game-id "reported_game_2" `
  --max-ply 20 `
  --output "C:\path\output\player-white-book.json"
```

个人库的每个节点为：

```text
[board_string, occurrence_count, ply]
```

`board_string` 是当前行动方视角的完整棋盘，经过8种旋转、镜像归一化。
对手着手不会被算作被调查选手的选择，但会改变下一次选择前的完整棋盘。

## 3. 分析被报告局与留一法对照局的开局

```powershell
python player_analysis.py opening `
  --bundle "C:\path\account-bundle.json" `
  --account "player_id" `
  --reported-game-id "reported_game_1" `
  --reported-game-id "reported_game_2" `
  --max-ply 20 `
  --output "C:\path\output\opening-analysis.json"
```

被报告局不会进入个人库。检查每一盘对照局时，该局自身也会从个人库排除。

## 4. 查询或筛选标准开局定式

查询目标选手的指定对局；省略 `--game-id` 时查询该 bundle 中该选手的全部
对局：

```powershell
python player_analysis.py standard-opening `
  --bundle "C:\path\account-bundle.json" `
  --account "player_id" `
  --game-id "game_id" `
  --output "C:\path\output\standard-opening.json"
```

筛选所有包含指定定式的对局：

```powershell
python player_analysis.py standard-opening `
  --bundle "C:\path\account-bundle.json" `
  --account "player_id" `
  --opening "tanida" `
  --output "C:\path\output\tanida-games.json" `
  --csv-output "C:\path\output\tanida-games.csv"
```

`--opening` 可使用定式 `id`、名称、别名或坐标序列。坐标序列经过8种旋转、
镜像归一化后比较；只要定式序列是对局序列的前缀就算匹配。因此 Tanida 对局
也会被 `diagonal` 查询选中。每局的 `opening` 是最长、最具体的已登记定式，
`openingMatches` 保留全部上级定式。

维护新定式时，在 `standard_openings.json` 的 `openings` 数组增加：

```json
{
  "id": "unique-id",
  "name": "Opening Name",
  "sequence": "f5f6e6d6",
  "aliases": ["optional alias"]
}
```

脚本会拒绝非法着手序列、重复名称/别名，以及经过对称变换后重复的序列。若
输入的是目录中尚未登记的合法坐标序列，仍可临时筛选，但不会获得定式名称。

## 5. Agent 手工脱谱位置审查

该流程严格分成三个阶段。脚本不会自动判断、推荐或填写脱谱位置。

审查重心是目标选手逐 ply 的 OQ 原始思考时间及其局内连续性。Agent 要人工识别
从连续快速、像是熟悉路线的落子转为明显现场思考的首次可信转折，并结合前后
多手排除偶发长考、强制着手、网络抖动和终局收官。不得使用固定秒数阈值批量
生成结论。

Human Frequency Book 只作弱参考：父节点或子节点未见、次数低、比例低，都不
能单独确定脱谱位置。样本内首次未见节点不得机械地写成锚点。EG 子损和选择
前后连续性可用于理解背景；若思考时间没有给出可信的首次转折，应明确登记
`no_offbook`，而不是从 Frequency Book 强行挑选一手。

每局 `agentNote` 必须填写，并简洁说明锚点前后的原始用时连续性；若引用
Frequency Book，须明确其弱参考地位。登记脚本会拒绝空备注，但不会自动判断
备注内容或替 Agent 选择锚点。

### 5.1 生成逐 ply 审查包

目标选手模式会列出每局每个实际落子 ply 的原始 `thinkingTimeMs`，并给出同色
留一法 Frequency Book 的父节点、结果节点、出现次数和比例。前者是人工审查的
主要证据，后者只是弱历史参考：

```powershell
python agent_offbook_review.py offbook-packet `
  --bundle "C:\path\account-bundle.json" `
  --account "Z779" `
  --mode target `
  --exclude-from-book-game-id "reported_game_1" `
  --exclude-from-book-game-id "reported_game_2" `
  --output "C:\path\z779-offbook-packet.json"
```

排行榜高分选手使用 `--mode reference`。参照组包只给出每个 ply 的原始用时，
不生成 Frequency Book 情况：

```powershell
python agent_offbook_review.py offbook-packet `
  --bundle "C:\path\leader-bundle.json" `
  --account "leader_id" `
  --mode reference `
  --output "C:\path\leader-offbook-packet.json"
```

### 5.2 Agent 手工标记并登记

Agent 阅读审查包后手写标记文件；每局必须明确记录 `offbook` 或
`no_offbook`。示例：

```json
{
  "schema": "player-offbook-agent-marks-input-v1",
  "account": "Z779",
  "mode": "target",
  "reviewedBy": "agent",
  "sourcePacketSha256": "可选，但建议填写审查包 SHA-256",
  "marks": [
    {
      "gameId": "game_1",
      "judgment": "offbook",
      "offBookPly": 12,
      "agentNote": "Agent 人工判断依据"
    },
    {
      "gameId": "game_2",
      "judgment": "no_offbook",
      "offBookPly": null,
      "agentNote": "Agent 人工审查后未标记脱谱点"
    }
  ]
}
```

登记命令：

```powershell
python agent_offbook_review.py offbook-record `
  --packet "C:\path\z779-offbook-packet.json" `
  --marks "C:\path\z779-agent-marks.json" `
  --output "C:\path\z779-offbook-records.json"
```

登记阶段强制检查标记属于目标选手本人：执白只能标白方着手，执黑只能标黑方
着手。每局只允许一个首次脱谱点；输出已存在时脚本拒绝覆盖。

### 5.3 脱谱后指标及排行榜参照比较

统计配置示例：

```json
{
  "target": {
    "name": "Z779",
    "account": "Z779",
    "marks": "C:\\path\\z779-offbook-records.json",
    "engineDirectory": "C:\\path\\z779-existing-eg-json"
  },
  "references": [
    {
      "name": "leaderboard-page-5",
      "members": [
        {
          "name": "leader-1",
          "account": "leader_1",
          "marks": "C:\\path\\leader-1-offbook-records.json",
          "engineDirectory": "C:\\path\\leader-existing-eg-json"
        }
      ]
    }
  ]
}
```

```powershell
python agent_offbook_review.py offbook-stats `
  --config "C:\path\offbook-stats-config.json" `
  --output "C:\path\offbook-stats.json"
```

结果同时保留整局和 `postOffBookInclusive` 单元。脱谱后单元从 Agent 标记的
目标选手着手开始，包含该手，计算局等权/着手等权子损和原始毫秒 mean 用时，
并输出目标选手减排行榜参照组的差值。标为 `no_offbook` 的对局保留在整局统计，
但不进入脱谱后单元。

## 6. 子损分析

```powershell
python player_analysis.py loss `
  --engine-dir "C:\path\ega-analysis" `
  --account "player_id" `
  --reported-game-id "reported_game_1" `
  --reported-game-id "reported_game_2" `
  --bootstrap 10000 `
  --model-bootstrap 1000 `
  --output "C:\path\output\loss-analysis.json"
```

脚本读取既有 EG `game_*.json`，不会重跑引擎。结果包含按局、按着手、整局
聚类 bootstrap、精确组合位置和单步两部分模型。

## 7. 用时趋势

```powershell
python player_analysis.py time `
  --engine-dir "C:\path\ega-analysis" `
  --account "player_id" `
  --reported-game-id "reported_game_1" `
  --reported-game-id "reported_game_2" `
  --output "C:\path\output\time-analysis.json"
```

基线使用同色对照局的原始毫秒用时，以算术平均为中心拟合 ply 曲线。长考阈值
为相同 ply 对照用时的第90百分位。

## 8. 外部参照组

参照组通过 JSON 配置。排行榜 bundle 的示例：

```json
{
  "target": {
    "engineDirectory": "C:\\path\\target-ega",
    "account": "player_id",
    "gameIds": ["reported_game_1", "reported_game_2"]
  },
  "groups": [
    {
      "name": "page5",
      "engineDirectory": "C:\\path\\reference-ega",
      "bundle": "C:\\path\\reference-bundle.json",
      "where": {"page": 5},
      "accountField": "leaderboardAccount"
    }
  ]
}
```

运行：

```powershell
python player_analysis.py reference --config reference-config.json --output reference-analysis.json
```

## 9. 一次运行主要分析

配置：

```json
{
  "bundle": "C:\\path\\account-bundle.json",
  "engineDirectory": "C:\\path\\ega-analysis",
  "account": "player_id",
  "reportedGameIds": ["reported_game_1", "reported_game_2"],
  "outputDirectory": "C:\\path\\analysis-output",
  "maxPly": 20,
  "bootstrap": 10000,
  "modelBootstrap": 1000,
  "seed": 20260801,
  "referenceConfig": "C:\\path\\reference-config.json"
}
```

```powershell
python player_analysis.py run-all --config run-config.json
```

`referenceConfig` 可以省略。

## 10. 生成 GitHub 风格 PDF

```powershell
python render_github_pdf.py `
  --markdown "C:\path\report.md" `
  --pdf "C:\path\report-github.pdf" `
  --title "对局调查报告" `
  --subtitle "Othello Quest 对局分析" `
  --reporter "裁判（使用 AI 协助）" `
  --role "无差别网赛裁判" `
  --report-date "2026年8月2日"
```

附录图片使用 JSON manifest：

```json
{
  "heading": "附录：截图依据",
  "intro": "以下截图作为报告的图像依据。",
  "images": [
    {"path": "C:\\path\\image1.jpg", "caption": "图 A-1 说明"},
    {"path": "C:\\path\\image2.jpg", "caption": "图 A-2 说明"}
  ]
}
```

将 manifest 路径传给 `--appendix-manifest`。脚本同时保存 HTML，默认与 PDF
同名；可以用 `--html-output` 指定位置。
