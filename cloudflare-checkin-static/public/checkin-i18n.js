(() => {
  const STORAGE_KEY = "onlicheck:language";
  const DEFAULT_LANG = "zh-Hant";
  const LANGS = [
    ["zh-Hant", "繁"],
    ["zh-Hans", "简"],
    ["en", "EN"],
    ["ja", "日"],
  ];

  const dictionaries = {
    "zh-Hans": {},
    "zh-Hant": {
      "比赛签到助手": "比賽簽到助手",
      "签到助手": "簽到助手",
      "比赛签到助手（本地保存版）": "比賽簽到助手（本地保存版）",
      "本地运行 · 自动保存 · 不上传数据": "本機執行 · 自動儲存 · 不上傳資料",
      "安装/添加到主屏幕": "安裝/加入主畫面",
      "帮助与说明": "說明",
      "清除本地进度": "清除本機進度",
      "当前步骤": "目前步驟",
      "导入数据": "匯入資料",
      "现场签到": "現場簽到",
      "导入选手名单": "匯入選手名單",
      "把名单粘贴进来即可开始。数据只保存在你的设备上（LocalStorage），Cloudflare\n                仅负责托管静态页面；若在微信/QQ等内置浏览器中使用，导出时建议优先“复制文本”。": "貼上名單即可開始。資料只保存在你的裝置上（LocalStorage），Cloudflare 僅負責託管靜態頁面；若在微信/QQ 等內建瀏覽器中使用，匯出時建議優先使用「複製文字」。",
      "粘贴名单后开始识别": "貼上名單後開始辨識",
      "左侧可放长期名单，右侧可放报名接龙；两边任选其一即可导入。": "左側可放長期名單，右側可放報名接龍；兩邊任選其一即可匯入。",
      "长期俱乐部成员（每行一人）": "長期俱樂部成員（每行一人）",
      "支持中英文、数字、括号内账号等；会自动去重并排序。": "支援中英文、數字、括號內帳號等；會自動去重並排序。",
      "比赛报名接龙信息": "比賽報名接龍資訊",
      "请在此粘贴完整的接龙信息…": "請在此貼上完整的接龍資訊…",
      "会自动过滤“接龙说明/规则/链接”等非选手行，支持 #接龙 / #接龍。": "會自動過濾「接龍說明/規則/連結」等非選手行，支援 #接龍。",
      "组别识别设置（可选）": "組別辨識設定（可選）",
      "支持新增组别关键词": "支援新增組別關鍵字",
      "新增组别": "新增組別",
      "恢复默认": "恢復預設",
      "每个组别可配置多个关键词（逗号/换行分隔）。导入时当某一行像标题且包含关键词（例如“【1月无差别组】…”），\n                程序会把其后的选手自动标记到该组别。": "每個組別可設定多個關鍵字（逗號/換行分隔）。匯入時若某一行像標題且包含關鍵字（例如「【1月無差別組】…」），程式會把其後的選手自動標記到該組別。",
      "继续上次进度": "繼續上次進度",
      "导入进度": "匯入進度",
      "确认导入并开始签到": "確認匯入並開始簽到",
      "选手签到": "選手簽到",
      "步骤 1/2": "步驟 1/2",
      "步骤 2/2": "步驟 2/2",
      "步骤 3/3": "步驟 3/3",
      "比赛名称（可改）": "比賽名稱（可修改）",
      "例如：XX杯黑白棋比赛": "例如：XX盃黑白棋比賽",
      "设置 PNG 输出格式": "設定 PNG 輸出格式",
      "统计": "統計",
      "总人数": "總人數",
      "已签到": "已簽到",
      "等待中": "等待中",
      "当前显示": "目前顯示",
      "组别筛选": "組別篩選",
      "点名模式：只显示未签到，并放大按钮": "點名模式：只顯示未簽到，並放大按鈕",
      "点名模式": "點名模式",
      "显示/隐藏签到时间": "顯示/隱藏簽到時間",
      "显示时间": "顯示時間",
      "检查疑似重复/异常（仅供参考）": "檢查疑似重複/異常（僅供參考）",
      "检查重复": "檢查重複",
      "搜索选手": "搜尋選手",
      "搜索选手名称…": "搜尋選手名稱…",
      "清除搜索": "清除搜尋",
      "重新导入": "重新匯入",
      "批量操作": "批次操作",
      "完成签到，进入比分登记辅助": "完成簽到，進入比分登記輔助",
      "添加漏登/临时报名选手…": "新增漏登/臨時報名選手…",
      "添加": "新增",
      "自动保存：已启用": "自動儲存：已啟用",
      "本地服务同步状态": "本機服務同步狀態",
      "本地同步：未连接": "本機同步：未連線",
      "导出进度": "匯出進度",
      "粘贴导入": "貼上匯入",
      "选手列表": "選手列表",
      "比分登记辅助": "比分登記輔助",
      "等待截图识别结果": "等待截圖辨識結果",
      "总轮次": "總輪次",
      "应用": "套用",
      "返回签到": "返回簽到",
      "比分登记轮次": "比分登記輪次",
      "手动 pending": "手動 pending",
      "已登记": "已登記",
      "提示": "提示",
      "签到总表预览": "簽到總表預覽",
      "导出设置": "匯出設定",
      "筛选范围": "篩選範圍",
      "组别": "組別",
      "签到状态": "簽到狀態",
      "全部": "全部",
      "仅已签到": "僅已簽到",
      "仅未签到": "僅未簽到",
      "排序方式": "排序方式",
      "排序": "排序",
      "按当前名单顺序": "依目前名單順序",
      "已签到优先": "已簽到優先",
      "未签到优先": "未簽到優先",
      "显示列": "顯示欄位",
      "导出列设置": "匯出欄位設定",
      "组别列": "組別欄",
      "平台列": "平台欄",
      "账号列": "帳號欄",
      "俱乐部列": "俱樂部欄",
      "签到时间列": "簽到時間欄",
      "内置浏览器提示": "內建瀏覽器提示",
      "若在微信/QQ/微博等内置浏览器中“下载\n                  CSV/PNG”失败，建议使用“复制文本”，或右上角菜单选择“在浏览器打开”。": "若在微信/QQ/微博等內建瀏覽器中「下載 CSV/PNG」失敗，建議使用「複製文字」，或從右上角選單選擇「在瀏覽器開啟」。",
      "返回修改": "返回修改",
      "复制文本": "複製文字",
      "下载 CSV": "下載 CSV",
      "下载 PNG": "下載 PNG",
      "确认": "確認",
      "取消": "取消",
      "关闭": "關閉",
      "删除": "刪除",
      "编辑": "編輯",
      "签到": "簽到",
      "取消签到": "取消簽到",
      "未分组": "未分組",
      "无差别组": "無差別組",
      "青少年组": "青少年組",
      "新人赛": "新人賽",
      "特殊赛": "特殊賽",
      "长期名单": "長期名單",
    },
    en: {
      "比赛签到助手": "Tournament Check-in",
      "签到助手": "Check-in",
      "比赛签到助手（本地保存版）": "Tournament Check-in (local save)",
      "本地运行 · 自动保存 · 不上传数据": "Runs locally · autosaves · no data upload",
      "安装/添加到主屏幕": "Install / Add to Home Screen",
      "帮助与说明": "Help",
      "清除本地进度": "Clear local progress",
      "当前步骤": "Current step",
      "导入数据": "Import",
      "现场签到": "Check-in",
      "导入选手名单": "Import player list",
      "把名单粘贴进来即可开始。数据只保存在你的设备上（LocalStorage），Cloudflare\n                仅负责托管静态页面；若在微信/QQ等内置浏览器中使用，导出时建议优先“复制文本”。": "Paste the list to start. Data is stored only on this device (LocalStorage). Cloudflare only hosts the static page. In WeChat/QQ in-app browsers, use Copy Text first when exporting.",
      "粘贴名单后开始识别": "Paste a list to begin",
      "左侧可放长期名单，右侧可放报名接龙；两边任选其一即可导入。": "Paste the long-term roster on the left or registration relay on the right. Either side can be imported.",
      "长期俱乐部成员（每行一人）": "Long-term club members (one per line)",
      "支持中英文、数字、括号内账号等；会自动去重并排序。": "Supports Chinese, English, numbers, and account names in brackets. Duplicates are removed and sorted automatically.",
      "比赛报名接龙信息": "Registration relay",
      "请在此粘贴完整的接龙信息…": "Paste the full registration relay here...",
      "会自动过滤“接龙说明/规则/链接”等非选手行，支持 #接龙 / #接龍。": "Non-player lines such as relay instructions, rules, and links are filtered automatically.",
      "组别识别设置（可选）": "Group detection settings (optional)",
      "支持新增组别关键词": "Add group keywords",
      "新增组别": "Add group",
      "恢复默认": "Restore defaults",
      "每个组别可配置多个关键词（逗号/换行分隔）。导入时当某一行像标题且包含关键词（例如“【1月无差别组】…”），\n                程序会把其后的选手自动标记到该组别。": "Each group can have multiple keywords, separated by commas or new lines. When an imported title-like line contains a keyword, following players are assigned to that group.",
      "继续上次进度": "Resume",
      "导入进度": "Import progress",
      "确认导入并开始签到": "Import and start check-in",
      "选手签到": "Player check-in",
      "步骤 1/2": "Step 1/2",
      "步骤 2/2": "Step 2/2",
      "步骤 3/3": "Step 3/3",
      "比赛名称（可改）": "Tournament name (editable)",
      "例如：XX杯黑白棋比赛": "Example: Othello Cup",
      "设置 PNG 输出格式": "PNG format",
      "统计": "Stats",
      "总人数": "Total",
      "已签到": "Checked in",
      "等待中": "Waiting",
      "当前显示": "Showing",
      "组别筛选": "Group filter",
      "点名模式：只显示未签到，并放大按钮": "Roll-call mode: show only unchecked players with larger buttons",
      "点名模式": "Roll call",
      "显示/隐藏签到时间": "Show/hide check-in time",
      "显示时间": "Show time",
      "检查疑似重复/异常（仅供参考）": "Check possible duplicates/issues (reference only)",
      "检查重复": "Check duplicates",
      "搜索选手": "Search players",
      "搜索选手名称…": "Search player name...",
      "清除搜索": "Clear search",
      "重新导入": "Re-import",
      "批量操作": "Batch",
      "完成签到，进入比分登记辅助": "Finish check-in and enter score helper",
      "添加漏登/临时报名选手…": "Add missing or late player...",
      "添加": "Add",
      "自动保存：已启用": "Autosave: on",
      "本地服务同步状态": "Local sync status",
      "本地同步：未连接": "Local sync: disconnected",
      "导出进度": "Export progress",
      "粘贴导入": "Paste import",
      "选手列表": "Player list",
      "比分登记辅助": "Score helper",
      "等待截图识别结果": "Waiting for screenshot results",
      "总轮次": "Rounds",
      "应用": "Apply",
      "返回签到": "Back to check-in",
      "比分登记轮次": "Score rounds",
      "手动 pending": "Manual pending",
      "已登记": "Registered",
      "提示": "Notice",
      "签到总表预览": "Check-in summary preview",
      "导出设置": "Export settings",
      "筛选范围": "Filter",
      "组别": "Group",
      "签到状态": "Check-in status",
      "全部": "All",
      "仅已签到": "Checked only",
      "仅未签到": "Unchecked only",
      "排序方式": "Sort",
      "排序": "Sort",
      "按当前名单顺序": "Current list order",
      "已签到优先": "Checked first",
      "未签到优先": "Unchecked first",
      "显示列": "Columns",
      "导出列设置": "Export columns",
      "组别列": "Group",
      "平台列": "Platform",
      "账号列": "Account",
      "俱乐部列": "Club",
      "签到时间列": "Check-in time",
      "内置浏览器提示": "In-app browser note",
      "若在微信/QQ/微博等内置浏览器中“下载\n                  CSV/PNG”失败，建议使用“复制文本”，或右上角菜单选择“在浏览器打开”。": "If CSV/PNG download fails in WeChat/QQ/Weibo in-app browsers, use Copy Text or open this page in a browser from the top-right menu.",
      "返回修改": "Back",
      "复制文本": "Copy text",
      "下载 CSV": "Download CSV",
      "下载 PNG": "Download PNG",
      "确认": "Confirm",
      "取消": "Cancel",
      "关闭": "Close",
      "删除": "Delete",
      "编辑": "Edit",
      "签到": "Check in",
      "取消签到": "Undo check-in",
      "未分组": "Ungrouped",
      "无差别组": "Open",
      "青少年组": "Youth",
      "新人赛": "Newcomer",
      "特殊赛": "Special",
      "长期名单": "Long-term roster",
    },
    ja: {
      "比赛签到助手": "大会チェックイン",
      "签到助手": "チェックイン",
      "比赛签到助手（本地保存版）": "大会チェックイン（ローカル保存）",
      "本地运行 · 自动保存 · 不上传数据": "ローカル実行 · 自動保存 · データ送信なし",
      "安装/添加到主屏幕": "インストール / ホーム画面に追加",
      "帮助与说明": "ヘルプ",
      "清除本地进度": "ローカル進捗を削除",
      "当前步骤": "現在のステップ",
      "导入数据": "インポート",
      "现场签到": "チェックイン",
      "导入选手名单": "選手リストをインポート",
      "把名单粘贴进来即可开始。数据只保存在你的设备上（LocalStorage），Cloudflare\n                仅负责托管静态页面；若在微信/QQ等内置浏览器中使用，导出时建议优先“复制文本”。": "リストを貼り付けると開始できます。データはこの端末の LocalStorage のみに保存されます。Cloudflare は静的ページのホスティングのみを行います。WeChat/QQ などの内蔵ブラウザでは、エクスポート時にまず「テキストをコピー」を使ってください。",
      "粘贴名单后开始识别": "リストを貼り付けて開始",
      "左侧可放长期名单，右侧可放报名接龙；两边任选其一即可导入。": "左に長期名簿、右に参加登録リレーを貼り付けます。どちらか一方だけでもインポートできます。",
      "长期俱乐部成员（每行一人）": "長期クラブメンバー（1行1名）",
      "支持中英文、数字、括号内账号等；会自动去重并排序。": "中国語・英語・数字・括弧内のアカウントに対応し、自動で重複削除と並べ替えを行います。",
      "比赛报名接龙信息": "参加登録リレー",
      "请在此粘贴完整的接龙信息…": "参加登録リレー全文をここに貼り付け...",
      "会自动过滤“接龙说明/规则/链接”等非选手行，支持 #接龙 / #接龍。": "説明・ルール・リンクなど選手でない行は自動で除外します。",
      "组别识别设置（可选）": "グループ判定設定（任意）",
      "支持新增组别关键词": "グループキーワードを追加できます",
      "新增组别": "グループ追加",
      "恢复默认": "既定に戻す",
      "每个组别可配置多个关键词（逗号/换行分隔）。导入时当某一行像标题且包含关键词（例如“【1月无差别组】…”），\n                程序会把其后的选手自动标记到该组别。": "各グループに複数のキーワードを設定できます（カンマまたは改行区切り）。タイトルらしい行にキーワードが含まれる場合、その後の選手をそのグループに自動設定します。",
      "继续上次进度": "前回の続き",
      "导入进度": "進捗をインポート",
      "确认导入并开始签到": "インポートしてチェックイン開始",
      "选手签到": "選手チェックイン",
      "步骤 1/2": "ステップ 1/2",
      "步骤 2/2": "ステップ 2/2",
      "步骤 3/3": "ステップ 3/3",
      "比赛名称（可改）": "大会名（編集可）",
      "例如：XX杯黑白棋比赛": "例：オセロ大会",
      "设置 PNG 输出格式": "PNG 形式設定",
      "统计": "集計",
      "总人数": "合計",
      "已签到": "チェックイン済み",
      "等待中": "待機中",
      "当前显示": "表示中",
      "组别筛选": "グループ絞り込み",
      "点名模式：只显示未签到，并放大按钮": "点呼モード：未チェックインのみ表示し、ボタンを大きくします",
      "点名模式": "点呼モード",
      "显示/隐藏签到时间": "チェックイン時刻を表示/非表示",
      "显示时间": "時刻表示",
      "检查疑似重复/异常（仅供参考）": "重複/異常候補を確認（参考用）",
      "检查重复": "重複確認",
      "搜索选手": "選手検索",
      "搜索选手名称…": "選手名を検索...",
      "清除搜索": "検索クリア",
      "重新导入": "再インポート",
      "批量操作": "一括操作",
      "完成签到，进入比分登记辅助": "チェックイン完了、スコア補助へ",
      "添加漏登/临时报名选手…": "未登録/臨時参加選手を追加...",
      "添加": "追加",
      "自动保存：已启用": "自動保存：有効",
      "本地服务同步状态": "ローカル同期状態",
      "本地同步：未连接": "ローカル同期：未接続",
      "导出进度": "進捗をエクスポート",
      "粘贴导入": "貼り付けインポート",
      "选手列表": "選手リスト",
      "比分登记辅助": "スコア登録補助",
      "等待截图识别结果": "スクリーンショット結果待ち",
      "总轮次": "総ラウンド数",
      "应用": "適用",
      "返回签到": "チェックインへ戻る",
      "比分登记轮次": "スコア登録ラウンド",
      "手动 pending": "手動 pending",
      "已登记": "登録済み",
      "提示": "通知",
      "签到总表预览": "チェックイン一覧プレビュー",
      "导出设置": "エクスポート設定",
      "筛选范围": "絞り込み",
      "组别": "グループ",
      "签到状态": "チェックイン状態",
      "全部": "すべて",
      "仅已签到": "チェックイン済みのみ",
      "仅未签到": "未チェックインのみ",
      "排序方式": "並び順",
      "排序": "並び順",
      "按当前名单顺序": "現在のリスト順",
      "已签到优先": "チェックイン済み優先",
      "未签到优先": "未チェックイン優先",
      "显示列": "表示列",
      "导出列设置": "エクスポート列設定",
      "组别列": "グループ列",
      "平台列": "プラットフォーム列",
      "账号列": "アカウント列",
      "俱乐部列": "クラブ列",
      "签到时间列": "チェックイン時刻列",
      "内置浏览器提示": "内蔵ブラウザの注意",
      "若在微信/QQ/微博等内置浏览器中“下载\n                  CSV/PNG”失败，建议使用“复制文本”，或右上角菜单选择“在浏览器打开”。": "WeChat/QQ/Weibo などの内蔵ブラウザで CSV/PNG のダウンロードに失敗する場合は、「テキストをコピー」を使うか、右上メニューからブラウザで開いてください。",
      "返回修改": "戻る",
      "复制文本": "テキストをコピー",
      "下载 CSV": "CSV ダウンロード",
      "下载 PNG": "PNG ダウンロード",
      "确认": "確認",
      "取消": "キャンセル",
      "关闭": "閉じる",
      "删除": "削除",
      "编辑": "編集",
      "签到": "チェックイン",
      "取消签到": "チェックイン取消",
      "未分组": "未分類",
      "无差别组": "オープン",
      "青少年组": "ジュニア",
      "新人赛": "新人戦",
      "特殊赛": "特殊戦",
      "长期名单": "長期名簿",
    },
  };

  const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const attrNames = ["placeholder", "title", "aria-label", "value"];
  let currentLang = DEFAULT_LANG;
  let applying = false;
  let observer = null;

  function dictionary() {
    return dictionaries[currentLang] || {};
  }

  function translateText(value) {
    const raw = String(value ?? "");
    if (!raw.trim() || currentLang === "zh-Hans") return raw;
    const dict = dictionary();
    if (dict[raw]) return dict[raw];
    const compact = normalize(raw);
    if (dict[compact]) {
      const leading = raw.match(/^\s*/)?.[0] || "";
      const trailing = raw.match(/\s*$/)?.[0] || "";
      return `${leading}${dict[compact]}${trailing}`;
    }
    let translated = raw;
    const entries = Object.entries(dict).sort((a, b) => b[0].length - a[0].length);
    for (const [source, target] of entries) {
      if (!source || source.length < 2) continue;
      translated = translated.split(source).join(target);
    }
    return translated;
  }

  function rememberOriginalText(node) {
    if (!node.parentElement) return;
    if (node.parentElement.closest("script, style, textarea")) return;
    if (!node.parentElement.dataset.i18nOriginalText && node.nodeValue.trim()) {
      node.parentElement.dataset.i18nOriginalText = node.nodeValue;
    }
  }

  function applyToTextNode(node) {
    if (!node || node.nodeType !== Node.TEXT_NODE || !node.nodeValue.trim()) return;
    if (!node.parentElement || node.parentElement.closest("script, style, textarea")) return;
    if (!node.__i18nOriginal || node.nodeValue !== node.__i18nLastOutput) {
      node.__i18nOriginal = node.nodeValue;
    }
    const next = translateText(node.__i18nOriginal);
    node.__i18nLastOutput = next;
    if (node.nodeValue !== next) node.nodeValue = next;
  }

  function applyToElement(el) {
    if (!(el instanceof Element) || el.closest("script, style")) return;
    for (const attr of attrNames) {
      if (!el.hasAttribute(attr)) continue;
      const key = `i18nOriginal${attr.replace(/-([a-z])/g, (_, c) => c.toUpperCase())}`;
      const lastKey = `${key}LastOutput`;
      const current = el.getAttribute(attr) || "";
      if (!el.dataset[key] || current !== el.dataset[lastKey]) {
        el.dataset[key] = current;
      }
      const next = translateText(el.dataset[key]);
      el.dataset[lastKey] = next;
      if (el.getAttribute(attr) !== next) el.setAttribute(attr, next);
    }
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        rememberOriginalText(child);
        applyToTextNode(child);
      }
    }
  }

  function applyI18n(root = document.body) {
    if (applying || !root) return;
    applying = true;
    try {
      document.documentElement.lang = currentLang;
      document.title = translateText("比赛签到助手（本地保存版）");
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      let node = root.nodeType === Node.TEXT_NODE || root.nodeType === Node.ELEMENT_NODE ? root : walker.nextNode();
      while (node) {
        if (node.nodeType === Node.TEXT_NODE) applyToTextNode(node);
        else applyToElement(node);
        node = walker.nextNode();
      }
      updateSelector();
    } finally {
      applying = false;
    }
  }

  function setLang(lang) {
    currentLang = dictionaries[lang] ? lang : DEFAULT_LANG;
    localStorage.setItem(STORAGE_KEY, currentLang);
    applyI18n(document.body);
  }

  function updateSelector() {
    const select = document.getElementById("language-select");
    if (select && select.value !== currentLang) select.value = currentLang;
  }

  function addSelector() {
    if (document.getElementById("language-select")) return;
    const actions = document.querySelector(".top-bar__actions");
    if (!actions) return;
    const wrap = document.createElement("label");
    wrap.className = "language-select-wrap";
    wrap.setAttribute("aria-label", "Language");
    const select = document.createElement("select");
    select.id = "language-select";
    select.className = "language-select";
    for (const [value, label] of LANGS) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      select.appendChild(option);
    }
    select.value = currentLang;
    select.addEventListener("change", () => setLang(select.value));
    wrap.appendChild(select);
    actions.prepend(wrap);
  }

  function init() {
    currentLang = localStorage.getItem(STORAGE_KEY) || DEFAULT_LANG;
    if (!dictionaries[currentLang]) currentLang = DEFAULT_LANG;
    addSelector();
    applyI18n(document.body);
    observer = new MutationObserver((mutations) => {
      if (applying) return;
      window.clearTimeout(observer._timer);
      observer._timer = window.setTimeout(() => {
        for (const mutation of mutations) {
          if (mutation.type === "childList") {
            mutation.addedNodes.forEach((node) => applyI18n(node));
          } else if (mutation.type === "characterData") {
            applyToTextNode(mutation.target);
          } else if (mutation.type === "attributes") {
            applyToElement(mutation.target);
          }
        }
      }, 20);
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: attrNames,
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
