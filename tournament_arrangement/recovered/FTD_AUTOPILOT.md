# FTD 本轮自律（Chrome，本地）

“本轮自律”是一个明确选择后才运行的单轮自动化模式。默认的手动 JSON、FTD Console 登分、棋谱导入和 `score-scan` 流程全部保留。自动化只处理启动时选中的本地轮次/阶段；完成并确认一个总分 PNG 下载后停止，不会创建、发布、结束、删除或推进 FTD 轮次。

## 首次安装扩展

1. 从项目根目录运行 `打开比赛签到程序.cmd`，确认本地页面是 `http://127.0.0.1:4174/`。
2. 在 Google Chrome 打开 `chrome://extensions/`。
3. 打开右上角“开发者模式”，点击“加载已解压的扩展程序”。
4. 选择：

   `C:\Users\MeroAF\Desktop\比赛编排\tournament_arrangement\recovered\chrome-ftd-bridge`

5. 确认扩展 ID 是 `kbojmgkjbgokbbhlpkapiobfjnpacnme`。若不一致，本地协调器会拒绝连接。
6. 保持已登录的 `https://flipthedisc.com/live/<tournamentId>`（或带 `www` 的同一官方域名）标签页打开。扩展不需要 DevTools 或 Console。

扩展仅请求以下权限：

- `https://flipthedisc.com/*` 与 `https://www.flipthedisc.com/*`：兼容 FTD 的两个官方主机形式，在已登录页面内建立受限的第二条 Socket.IO 连接；token 与 sid 始终留在该页面的 MAIN world。
- `http://127.0.0.1:4174/*`：与只绑定 loopback 的本地协调器交换固定 RPC。
- `downloads`：只启动并跟踪本会话生成的一个 PNG 下载 ID，使用 Chrome `uniquify` 避免覆盖同名文件。

扩展不请求历史记录、cookie、剪贴板、debugger 或全站访问权限，也没有 `eval`、任意事件名或通用 `socket.emit` 接口。

## 必须先做只读探测

当前实现还没有在真实 FTD 会话中证明第二条认证 Socket 与页面自带 Socket 可以共存。第一次使用时必须先点击“FTD 只读探测”。探测只做以下操作：

- 检查页面已登录；
- 检查赛事 TD 权限；
- 检查页面原 Socket 与专用第二 Socket 同时连接；
- 读取并清洗当前赛事轮次信息。

探测不会写比分或棋谱。MAIN-world bridge 和本地协调器都会保持写入禁用，直到当前赛事的探测通过。不要在未经明确授权的正式赛事上测试写入。

## 启动一轮

裁判完成这些准备后点击“本轮自律”：

1. 已在 FTD 建立并开始对应轮次；
2. Chrome 中打开并登录正确的 FTD `/live/<id>` 页面；
3. 本地页面选择正确的预赛轮次、半决赛或决赛阶段；
4. 如已知本轮开始时间，填写并“应用”；如果启动时仍为空或无效，协调器会把点击“本轮自律”的瞬间设为开始时间。已经设定的有效时间绝不会被启动动作覆盖；
5. 本地 FTD 链接与 Chrome 标签页属于同一 tournamentId。

点击后会立即锁定 tournamentId、本地轮次/阶段、实际 FTD 轮次和最终采用的 `roundStartAt`。该点击就是本轮自动写比分和棋谱的授权，不再要求第二次确认。前端自己的 OQ 定时轮询会停止，服务器协调器接管调度。

协调器直接从 Chrome FTD bridge 导入配对，不读取或搜索 Downloads。它复用现有 OQ 直连推理：精确账号对、唯一时间窗对局、棋局回放、空格归胜方及超时/认输/断线结果。它从不调用微信、`score-scan`、图片识别、OCR 或 PaddleOCR。

## 暂停、继续和紧急停止

- “暂停”：不再启动新的外部写入；正在进行的命令安全结束。可随后点“继续”。
- “继续”：重新检查锁定状态并恢复轮询。Chrome 页面重连时会重新执行只读共存探测。
- “紧急停止”：立刻禁止新的比分、棋谱和图片命令，等待正在进行的命令落定；不回滚已写且已回读验证的内容。

控制 token 只保存在当前标签页的 `sessionStorage`，不会写入共享状态或日志。自动化运行时，手动 FTD Console/JSON 按钮会先提示暂停；若要完全改用手动流程，可紧急停止后继续。

异常只暂停对应桌并写入现有 pending 队列。修正映射、本地 dirty/pending 或 FTD 冲突后，该桌会在后续轮询自动重试；系统不会在多局、缺映射或冲突时猜测。

## 完成条件与审计

每个非 BYE 桌必须同时满足：

- FTD 比分精确回读，local row 自动改为绿色 `completed`，`lastEditedBy: "automation"`；
- 原 OQ `oqAutoAudit` 和 game ID 保留；
- 独立 `ftdScoreReceipt` 已保存；
- 可用棋谱已写入并精确回读，保存 `ftdTranscriptReceipt`；
- 无棋局的裁判确认缺席有明确 `transcriptNotApplicable` 原因；
- 不存在 blocking pending、dirty、映射或 FTD 冲突。

最终再次回读 FTD。只有这次回读仍与所有比分和棋谱回执一致时，才从回读快照绘制一张黑底总分图。决赛阶段会把 `F` 和 `3/4` 合成一张图。Chrome 报告该唯一下载 ID 为 `complete` 且文件存在于下载记录后，会话才进入 `done`。

会话状态和不含凭据的 UTF-8 追加日志位于：

`data\automation-sessions\<sessionId>.json`  
`data\automation-sessions\<sessionId>.jsonl`

服务器重启后只信任已经保存的精确回执。中断中的比分/棋谱命令会先回读 FTD，再决定已完成、仍为空或冲突；不会盲目重复发送。下载失败或不确定会阻止 `done`，并且同一会话不会发出第二个下载请求。

## 开发验证

不连接真实 FTD 的本地测试：

```powershell
node tests\ftd-round-shared.test.js
node tests\ftd-autopilot.test.js
node tests\chrome-ftd-bridge.test.js
node tests\local-server-merge.test.js
node tests\score-helper-render.test.js
node tests\ftd-transcript.test.js
```

OQ 直连回归：

```powershell
cd ..\..\wechat-decrypt
.\.venv\Scripts\python.exe -m unittest tests.test_oq_auto_score_update
```

这些测试使用 mock FTD/OQ/Chrome 下载，不会进行真实 FTD 或微信写入。
