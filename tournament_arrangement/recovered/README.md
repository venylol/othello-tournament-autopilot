## 恢复说明

这个目录是从线上站点 `https://onlicheck.pages.dev/?source=pwa[201~` 抓取下来的静态前端文件。

已恢复的主要文件：

- `index.html`
- `styles.css`
- `app.js`
- `sw.js`
- `manifest.webmanifest`
- `icons/`
- `vendor/html2canvas.min.js`

说明：

1. `app.js`、`styles.css`、`index.html` 已格式化，可直接修改。
2. 这是部署后的前端代码，不一定等同于你最初项目里的原始工程结构。
3. `vendor/html2canvas.min.js` 是第三方库，当前保留为站点里的部署版本。
4. 这是纯静态站点，建议通过本地 HTTP 服务访问，不要直接双击 `index.html`。

推荐本地运行：

从仓库根目录双击或执行：

```powershell
.\打开比赛签到程序.cmd
```

该入口会启动或复用 `node local-server.js`，打开
`http://127.0.0.1:4174/`，并预检签到、FTD 导入和比分图片登记流程中
需要用到的本地 helper。

本地双向同步运行：

```powershell
node local-server.js
```

然后打开：

`http://127.0.0.1:4174/`

该模式会启用浏览器和本地文件之间的双向同步：

- 共享状态文件：`data/checkin-state.json`
- 前端修改签到状态后，会写入共享状态文件。
- Agent 或脚本修改共享状态文件后，前端会自动监听并载入。
- 如果同步失败、状态冲突、JSON 格式错误，页面会明确提示；不要把这类问题静默处理。

默认协作方式：

1. 用户先在本地前端完成名单的初步导入和人工整理。
2. 用户明确表示初步导入已完成并需要审查后，Agent 再读取
   `data/checkin-state.json` 检查疑点，例如解析错误、重复/疑似重复、
   账号缺失、姓名和账号错位、旧状态残留等。
3. 如果存在疑点，Agent 直接列出问题并等待用户给出修改方案。
4. 用户确认修改方案后，Agent 可以按方案修改共享 JSON；前端会通过本地同步自动载入。
5. 到签到时间并收到明确开始指令后，再进入后续签到/轮询流程。
6. 签到历史导出固定从比赛日 19:27 开始，以免漏掉裁判或 bot 正式提示
   前已经扣 `1`/`2` 的选手；之后按 19:30、19:30-19:32、
   19:30-19:34 ... 到 19:57 的两分钟节奏预演、人工审查、再写回。
   19:27-19:29 的明确有效签到码可以经人工审查后计入，不因提前发送
   而直接否决。

当用户明确要求 Agent 直接导入或重写当前名单时，Agent 可以创建/更新
`data/checkin-state.json`。文件根对象使用前端 state schema：`version: 2`、
`step`、`competitionName`、`players` 等字段；每个选手至少需要
`id`、`displayName`、`group`、`checkedIn`、`checkedInAt`。

比分辅助的淘汰赛结构：

- “预赛轮次”只表示瑞士制预赛的 5/6/7 轮。
- 前端固定在预赛后追加“半决赛”和“决赛阶段”两个标签。
- 半决赛从 FTD 的 `SF` JSON 导入，必须为 2 台、4 人。
- 决赛阶段同时进行决赛与 3/4 决赛。FTD 的 `F` 与 `3/4` JSON 分开导入，
  前端合并显示为本地第 1 台（决赛）和第 2 台（3/4 决赛）。
- 每条配对保留 `ftdStage`、`ftdRound`、`ftdTable`，FTD 登分和棋谱写回必须
  使用这些原始标识，不能把两场比赛写到同一个 FTD 阶段。

部署说明：

当前版本仅作为本地页面使用，不要部署到 Cloudflare Pages。
请使用 `node local-server.js` 和 `http://127.0.0.1:4174/` 进行本地验证。

## Chrome FTD 本轮自律（opt-in）

本地页面新增“FTD 只读探测 / 本轮自律 / 暂停 / 继续 / 紧急停止”。该模式通过固定 ID 的 Chrome Manifest V3 扩展直接读取已登录 FTD 标签页，并由 `local-server.js` 的持久协调器处理单个锁定轮次。它不搜索 Downloads、不调用微信或 `score-scan`，也不会结束、发布或推进 FTD 轮次。

现有“复制 FTD 导出代码”“复制 FTD 登分代码”“复制本轮棋谱导入代码”和手动 JSON 导入仍是默认兼容流程。自动化只有在比分与棋谱均经过 FTD 精确回读后，才允许把本地行自动标成绿色 `completed`。

安装、只读探测、安全权限、操作和恢复说明见 [FTD_AUTOPILOT.md](./FTD_AUTOPILOT.md)。真实写入前必须先在 Chrome 中完成只读双 Socket 共存探测；当前代码和 mock 测试不能替代该现场验证。
