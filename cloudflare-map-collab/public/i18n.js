(function () {
  "use strict";

  const STORAGE_KEY = "mapCollabLanguage";
  const DEFAULT_LANG = "zh-Hant";
  const LANGS = {
    "zh-Hant": { htmlLang: "zh-Hant", label: "繁中" },
    "zh-Hans": { htmlLang: "zh-CN", label: "简中" },
    en: { htmlLang: "en", label: "EN" },
    ja: { htmlLang: "ja", label: "日本語" }
  };

  const TEXT = {
    "FTD/OQ 映射表协作": {
      "zh-Hant": "FTD/OQ 映射表協作",
      "zh-Hans": "FTD/OQ 映射表协作",
      en: "FTD/OQ Mapping Collaboration",
      ja: "FTD/OQ マッピング共同編集"
    },
    "FTD/OQ 映射表": {
      "zh-Hant": "FTD/OQ 映射表",
      "zh-Hans": "FTD/OQ 映射表",
      en: "FTD/OQ Mapping",
      ja: "FTD/OQ マッピング"
    },
    "FTD Player/OQ 映射表": {
      "zh-Hant": "FTD Player/OQ 映射表",
      "zh-Hans": "FTD Player/OQ 映射表",
      en: "FTD Player/OQ Mapping",
      ja: "FTD Player/OQ マッピング"
    },
    "加载中": { "zh-Hant": "載入中", "zh-Hans": "加载中", en: "Loading", ja: "読み込み中" },
    "语言": { "zh-Hant": "語言", "zh-Hans": "语言", en: "Language", ja: "言語" },
    "查看报名接龙": { "zh-Hant": "查看報名接龍", "zh-Hans": "查看报名接龙", en: "Show Relay", ja: "申込リレー" },
    "隐藏报名接龙": { "zh-Hant": "隱藏報名接龍", "zh-Hans": "隐藏报名接龙", en: "Hide Relay", ja: "リレーを隠す" },
    "导出 PNG": { "zh-Hant": "匯出 PNG", "zh-Hans": "导出 PNG", en: "Export PNG", ja: "PNG 出力" },
    "下载 JSON": { "zh-Hant": "下載 JSON", "zh-Hans": "下载 JSON", en: "Download JSON", ja: "JSON ダウンロード" },
    "校验OQ账号": { "zh-Hant": "校驗 OQ 帳號", "zh-Hans": "校验 OQ 账号", en: "Validate OQ", ja: "OQ 検証" },
    "保存并校验OQ账号": { "zh-Hant": "儲存並校驗 OQ 帳號", "zh-Hans": "保存并校验 OQ 账号", en: "Save and Validate OQ", ja: "保存して OQ 検証" },
    "保存并校验 OQ 账号": { "zh-Hant": "儲存並校驗 OQ 帳號", "zh-Hans": "保存并校验 OQ 账号", en: "Save and Validate OQ", ja: "保存して OQ 検証" },
    "已保存": { "zh-Hant": "已儲存", "zh-Hans": "已保存", en: "Saved", ja: "保存済み" },
    "未保存": { "zh-Hant": "未儲存", "zh-Hans": "未保存", en: "Unsaved", ja: "未保存" },
    "保存中": { "zh-Hant": "儲存中", "zh-Hans": "保存中", en: "Saving", ja: "保存中" },
    "保存失败": { "zh-Hant": "儲存失敗", "zh-Hans": "保存失败", en: "Save Failed", ja: "保存失敗" },
    "检验中": { "zh-Hant": "校驗中", "zh-Hans": "校验中", en: "Validating", ja: "検証中" },
    "只读": { "zh-Hant": "唯讀", "zh-Hans": "只读", en: "Read-only", ja: "読み取り専用" },
    "编辑链接": { "zh-Hant": "編輯連結", "zh-Hans": "编辑链接", en: "Edit Link", ja: "編集リンク" },
    "查看模式": { "zh-Hant": "查看模式", "zh-Hans": "查看模式", en: "View Mode", ja: "表示モード" },
    "清除": { "zh-Hant": "清除", "zh-Hans": "清除", en: "Clear", ja: "クリア" },
    "搜索姓名、账号、群昵称、状态": {
      "zh-Hant": "搜尋姓名、帳號、群暱稱、狀態",
      "zh-Hans": "搜索姓名、账号、群昵称、状态",
      en: "Search name, account, group nickname, status",
      ja: "名前、アカウント、グループ表示名、状態を検索"
    },
    "报名接龙": { "zh-Hant": "報名接龍", "zh-Hans": "报名接龙", en: "Registration Relay", ja: "申込リレー" },
    "关闭": { "zh-Hant": "關閉", "zh-Hans": "关闭", en: "Close", ja: "閉じる" },
    "姓名": { "zh-Hant": "姓名", "zh-Hans": "姓名", en: "Name", ja: "名前" },
    "OQ账号": { "zh-Hant": "OQ 帳號", "zh-Hans": "OQ 账号", en: "OQ Account", ja: "OQ アカウント" },
    "OQ 账号": { "zh-Hant": "OQ 帳號", "zh-Hans": "OQ 账号", en: "OQ Account", ja: "OQ アカウント" },
    "原行": { "zh-Hant": "原始行", "zh-Hans": "原行", en: "Source Line", ja: "元の行" },
    "未自动解析行": { "zh-Hant": "未自動解析行", "zh-Hans": "未自动解析行", en: "Unparsed Lines", ja: "未解析行" },
    "原始接龙文本": { "zh-Hant": "原始接龍文字", "zh-Hans": "原始接龙文本", en: "Raw Relay Text", ja: "リレー原文" },
    "没有可显示的接龙账号记录。": {
      "zh-Hant": "沒有可顯示的接龍帳號記錄。",
      "zh-Hans": "没有可显示的接龙账号记录。",
      en: "No relay account records to display.",
      ja: "表示できるリレーアカウント記録はありません。"
    },
    "未识别": { "zh-Hant": "未識別", "zh-Hans": "未识别", en: "Not detected", ja: "未検出" },
    "是": { "zh-Hant": "是", "zh-Hans": "是", en: "Yes", ja: "はい" },
    "否": { "zh-Hant": "否", "zh-Hans": "否", en: "No", ja: "いいえ" },
    "未命名": { "zh-Hant": "未命名", "zh-Hans": "未命名", en: "Unnamed", ja: "名称未設定" },
    "未选择": { "zh-Hant": "未選擇", "zh-Hans": "未选择", en: "Not selected", ja: "未選択" },
    "群昵称": { "zh-Hant": "群暱稱", "zh-Hans": "群昵称", en: "Group Nickname", ja: "グループ表示名" },
    "搜索群昵称...": {
      "zh-Hant": "搜尋群暱稱...",
      "zh-Hans": "搜索群昵称...",
      en: "Search group nicknames...",
      ja: "グループ表示名を検索..."
    },
    "输入只用于筛选，选择下方候选后才会写入。": {
      "zh-Hant": "輸入只用於篩選，選擇下方候選後才會寫入。",
      "zh-Hans": "输入只用于筛选，选择下方候选后才会写入。",
      en: "Typing only filters candidates; select a candidate below to save it.",
      ja: "入力は候補の絞り込みのみです。保存するには下の候補を選択してください。"
    },
    "没有匹配的群昵称。": {
      "zh-Hant": "沒有匹配的群暱稱。",
      "zh-Hans": "没有匹配的群昵称。",
      en: "No matching group nicknames.",
      ja: "一致するグループ表示名はありません。"
    },
    "当前没有群昵称候选。": {
      "zh-Hant": "目前沒有群暱稱候選。",
      "zh-Hans": "当前没有群昵称候选。",
      en: "No group nickname candidates are available.",
      ja: "利用できるグループ表示名候補はありません。"
    },
    "清除选择": { "zh-Hant": "清除選擇", "zh-Hans": "清除选择", en: "Clear Selection", ja: "選択を解除" },
    "恢复": { "zh-Hant": "恢復", "zh-Hans": "恢复", en: "Restore", ja: "復元" },
    "强制通过校验": { "zh-Hant": "強制通過校驗", "zh-Hans": "强制通过校验", en: "Force Pass", ja: "強制承認" },
    "未填账号": { "zh-Hant": "未填帳號", "zh-Hans": "未填账号", en: "No Account", ja: "アカウント未入力" },
    "未检验": { "zh-Hant": "未校驗", "zh-Hans": "未校验", en: "Unchecked", ja: "未検証" },
    "已检验": { "zh-Hant": "已校驗", "zh-Hans": "已校验", en: "Checked", ja: "検証済み" },
    "强制通过": { "zh-Hant": "強制通過", "zh-Hans": "强制通过", en: "Forced OK", ja: "強制承認" },
    "检验失败": { "zh-Hant": "校驗失敗", "zh-Hans": "校验失败", en: "Invalid", ja: "検証失敗" },
    "群昵称变动": { "zh-Hant": "群暱稱變動", "zh-Hans": "群昵称变动", en: "Nickname Changed", ja: "表示名変更" },
    "用户修改": { "zh-Hant": "使用者修改", "zh-Hans": "用户修改", en: "User Edit", ja: "ユーザー編集" },
    "agent修改": { "zh-Hant": "agent 修改", "zh-Hans": "agent修改", en: "Agent Edit", ja: "Agent 編集" },
    "已删除": { "zh-Hant": "已刪除", "zh-Hans": "已删除", en: "Deleted", ja: "削除済み" },
    "未填写账号": { "zh-Hant": "未填寫帳號", "zh-Hans": "未填写账号", en: "No account", ja: "アカウント未入力" },
    "标签": { "zh-Hant": "標籤", "zh-Hans": "标签", en: "Tag", ja: "タグ" },
    "白色未完成；黄色为OQ账号校验不通过；绿色需姓名、OQ账号、群昵称齐全且OQ有效。": {
      "zh-Hant": "白色未完成；黃色為 OQ 帳號校驗不通過；綠色需姓名、OQ 帳號、群暱稱齊全且 OQ 有效。",
      "zh-Hans": "白色未完成；黄色为 OQ 账号校验不通过；绿色需姓名、OQ 账号、群昵称齐全且 OQ 有效。",
      en: "White is incomplete; yellow means OQ validation failed; green requires name, OQ account, group nickname, and a valid OQ check.",
      ja: "白は未完了、黄は OQ アカウント検証失敗、緑は名前、OQ アカウント、グループ表示名、有効な OQ 検証が揃った状態です。"
    },
    "链接缺少表 ID 或 token。": {
      "zh-Hant": "連結缺少表 ID 或 token。",
      "zh-Hans": "链接缺少表 ID 或 token。",
      en: "The link is missing a table ID or token.",
      ja: "リンクに表 ID または token がありません。"
    },
    "正在强制通过校验，请勿操作。": {
      "zh-Hant": "正在強制通過校驗，請勿操作。",
      "zh-Hans": "正在强制通过校验，请勿操作。",
      en: "Forcing validation pass. Do not edit.",
      ja: "強制承認中です。操作しないでください。"
    },
    "已强制通过 OQ 校验。": {
      "zh-Hant": "已強制通過 OQ 校驗。",
      "zh-Hans": "已强制通过 OQ 校验。",
      en: "OQ validation was forced through.",
      ja: "OQ 検証を強制承認しました。"
    },
    "正在保存中，请勿操作。": {
      "zh-Hant": "正在儲存中，請勿操作。",
      "zh-Hans": "正在保存中，请勿操作。",
      en: "Saving. Do not edit.",
      ja: "保存中です。操作しないでください。"
    },
    "映射表已保存，正在校验 OQ 账号，请勿操作。": {
      "zh-Hant": "映射表已儲存，正在校驗 OQ 帳號，請勿操作。",
      "zh-Hans": "映射表已保存，正在校验 OQ 账号，请勿操作。",
      en: "Mapping saved. Validating OQ accounts. Do not edit.",
      ja: "マッピングを保存しました。OQ アカウントを検証中です。操作しないでください。"
    },
    "远端版本已更新。为避免覆盖他人改动，请刷新页面后再操作。": {
      "zh-Hant": "遠端版本已更新。為避免覆蓋他人改動，請重新整理頁面後再操作。",
      "zh-Hans": "远端版本已更新。为避免覆盖他人改动，请刷新页面后再操作。",
      en: "The remote version changed. Refresh before editing to avoid overwriting others.",
      ja: "リモート版が更新されました。他の人の変更を上書きしないよう、ページを再読み込みしてから操作してください。"
    },
    "远端版本已更新。为避免覆盖他人改动，请刷新页面后再校验。": {
      "zh-Hant": "遠端版本已更新。為避免覆蓋他人改動，請重新整理頁面後再校驗。",
      "zh-Hans": "远端版本已更新。为避免覆盖他人改动，请刷新页面后再校验。",
      en: "The remote version changed. Refresh before validating to avoid overwriting others.",
      ja: "リモート版が更新されました。他の人の変更を上書きしないよう、ページを再読み込みしてから検証してください。"
    },
    "远端映射行已更新。为避免覆盖他人改动，请刷新页面后再校验。": {
      "zh-Hant": "遠端映射行已更新。為避免覆蓋他人改動，請重新整理頁面後再校驗。",
      "zh-Hans": "远端映射行已更新。为避免覆盖他人改动，请刷新页面后再校验。",
      en: "Remote mapping rows changed. Refresh before validating to avoid overwriting others.",
      ja: "リモートのマッピング行が更新されました。他の人の変更を上書きしないよう、ページを再読み込みしてから検証してください。"
    },
    "当前没有可导出的选手。": {
      "zh-Hant": "目前沒有可匯出的選手。",
      "zh-Hans": "当前没有可导出的选手。",
      en: "There are no players to export.",
      ja: "出力できる選手がいません。"
    },
    "打开中...": { "zh-Hant": "開啟中...", "zh-Hans": "打开中...", en: "Opening...", ja: "開いています..." },
    "生成中...": { "zh-Hant": "產生中...", "zh-Hans": "生成中...", en: "Generating...", ja: "生成中..." },
    "PNG 已打开，请长按/右键保存。": {
      "zh-Hant": "PNG 已開啟，請長按或右鍵儲存。",
      "zh-Hans": "PNG 已打开，请长按/右键保存。",
      en: "PNG opened. Long-press or right-click to save.",
      ja: "PNG を開きました。長押しまたは右クリックで保存してください。"
    },
    "已开始下载 PNG。": {
      "zh-Hant": "已開始下載 PNG。",
      "zh-Hans": "已开始下载 PNG。",
      en: "PNG download started.",
      ja: "PNG のダウンロードを開始しました。"
    },
    "映射表 PNG": { "zh-Hant": "映射表 PNG", "zh-Hans": "映射表 PNG", en: "Mapping PNG", ja: "マッピング PNG" },
    "返回": { "zh-Hant": "返回", "zh-Hans": "返回", en: "Back", ja: "戻る" },
    "下载 PNG": { "zh-Hant": "下載 PNG", "zh-Hans": "下载 PNG", en: "Download PNG", ja: "PNG ダウンロード" },
    "正在生成图片...": {
      "zh-Hant": "正在產生圖片...",
      "zh-Hans": "正在生成图片...",
      en: "Generating image...",
      ja: "画像を生成中..."
    },
    "映射表图片": { "zh-Hant": "映射表圖片", "zh-Hans": "映射表图片", en: "Mapping image", ja: "マッピング画像" },
    "图片已生成。可点击下载，或长按/右键保存。": {
      "zh-Hant": "圖片已產生。可點擊下載，或長按/右鍵儲存。",
      "zh-Hans": "图片已生成。可点击下载，或长按/右键保存。",
      en: "Image generated. Click download, or long-press/right-click to save.",
      ja: "画像を生成しました。ダウンロードをクリックするか、長押し/右クリックで保存してください。"
    },
    "无法获取 Canvas 2D 上下文": {
      "zh-Hant": "無法取得 Canvas 2D 上下文",
      "zh-Hans": "无法获取 Canvas 2D 上下文",
      en: "Could not get the Canvas 2D context",
      ja: "Canvas 2D コンテキストを取得できません"
    },
    "已复制编辑链接。": {
      "zh-Hant": "已複製編輯連結。",
      "zh-Hans": "已复制编辑链接。",
      en: "Edit link copied.",
      ja: "編集リンクをコピーしました。"
    },
    "已删除映射行。": {
      "zh-Hant": "已刪除映射行。",
      "zh-Hans": "已删除映射行。",
      en: "Mapping row deleted.",
      ja: "マッピング行を削除しました。"
    },
    "为防止误操作，名单区域禁用双指缩放。请在上方标题、统计或搜索区域进行页面缩放。": {
      "zh-Hant": "為防止誤操作，名單區域禁用雙指縮放。請在上方標題、統計或搜尋區域進行頁面縮放。",
      "zh-Hans": "为防止误操作，名单区域禁用双指缩放。请在上方标题、统计或搜索区域进行页面缩放。",
      en: "Pinch zoom is disabled in the list area to prevent accidental edits. Zoom from the title, stats, or search area above.",
      ja: "誤操作防止のため、一覧エリアではピンチズームを無効にしています。上部のタイトル、統計、検索エリアでズームしてください。"
    }
  };

  const PREFIX_PATTERNS = [
    {
      id: "force-fail",
      re: /^强制通过失败：(.+)$/,
      render: (lang, m) => ({
        "zh-Hant": `強制通過失敗：${m[1]}`,
        "zh-Hans": `强制通过失败：${m[1]}`,
        en: `Force pass failed: ${m[1]}`,
        ja: `強制承認に失敗しました: ${m[1]}`
      })[lang]
    },
    {
      id: "save-validate-fail",
      re: /^保存或 OQ 校验失败：(.+)$/,
      render: (lang, m) => ({
        "zh-Hant": `儲存或 OQ 校驗失敗：${m[1]}`,
        "zh-Hans": `保存或 OQ 校验失败：${m[1]}`,
        en: `Save or OQ validation failed: ${m[1]}`,
        ja: `保存または OQ 検証に失敗しました: ${m[1]}`
      })[lang]
    },
    {
      id: "export-png-fail",
      re: /^导出 PNG 失败：(.+)$/,
      render: (lang, m) => ({
        "zh-Hant": `匯出 PNG 失敗：${m[1]}`,
        "zh-Hans": `导出 PNG 失败：${m[1]}`,
        en: `Export PNG failed: ${m[1]}`,
        ja: `PNG 出力に失敗しました: ${m[1]}`
      })[lang]
    }
  ];

  const PATTERNS = [
    {
      id: "revision",
      detect: (s) => {
        const m = /^(?:revision|修訂|修订|Revision|リビジョン)\s+(\d+)\s+·\s*(.*)$/.exec(s);
        return m ? [m[1], m[2]] : null;
      },
      render: (lang, m) => ({
        "zh-Hant": `修訂 ${m[0]} · ${m[1]}`,
        "zh-Hans": `修订 ${m[0]} · ${m[1]}`,
        en: `Revision ${m[0]} · ${m[1]}`,
        ja: `リビジョン ${m[0]} · ${m[1]}`
      })[lang]
    },
    {
      id: "stats-relay",
      detect: (s) => {
        const m = /^(\d+\/\d+)\s+·\s+(?:接龙|接龍|Relay|リレー)\s+(\d+)$/.exec(s);
        return m ? [m[1], m[2]] : null;
      },
      render: (lang, m) => ({
        "zh-Hant": `${m[0]} · 接龍 ${m[1]}`,
        "zh-Hans": `${m[0]} · 接龙 ${m[1]}`,
        en: `${m[0]} · Relay ${m[1]}`,
        ja: `${m[0]} · リレー ${m[1]}`
      })[lang]
    },
    {
      id: "relay-competition",
      detect: (s) => {
        const m = /^(?:比赛|比賽|Competition|大会)：?\s*(.*)$/.exec(s);
        return m ? [m[1]] : null;
      },
      render: (lang, m) => ({
        "zh-Hant": `比賽：${m[0]}`,
        "zh-Hans": `比赛：${m[0]}`,
        en: `Competition: ${m[0]}`,
        ja: `大会: ${m[0]}`
      })[lang]
    },
    {
      id: "relay-current-month",
      detect: (s) => {
        const m = /^(?:当前月|目前月份|Current month|現在月)：?\s*(.*)$/.exec(s);
        return m ? [m[1]] : null;
      },
      render: (lang, m) => ({
        "zh-Hant": `目前月份：${m[0]}`,
        "zh-Hans": `当前月：${m[0]}`,
        en: `Current month: ${m[0]}`,
        ja: `現在月: ${m[0]}`
      })[lang]
    },
    {
      id: "relay-detected-months",
      detect: (s) => {
        const m = /^(?:接龙月|接龍月份|Relay month|リレー月)：?\s*(.*)$/.exec(s);
        return m ? [m[1]] : null;
      },
      render: (lang, m) => ({
        "zh-Hant": `接龍月份：${m[0]}`,
        "zh-Hans": `接龙月：${m[0]}`,
        en: `Relay month: ${m[0]}`,
        ja: `リレー月: ${m[0]}`
      })[lang]
    },
    {
      id: "relay-month-match",
      detect: (s) => {
        const m = /^(?:月份匹配|月份符合|Month match|月一致)：?\s*(.*)$/.exec(s);
        return m ? [m[1]] : null;
      },
      render: (lang, m) => ({
        "zh-Hant": `月份符合：${translateInlineValue(m[0], lang)}`,
        "zh-Hans": `月份匹配：${translateInlineValue(m[0], lang)}`,
        en: `Month match: ${translateInlineValue(m[0], lang)}`,
        ja: `月一致: ${translateInlineValue(m[0], lang)}`
      })[lang]
    },
    {
      id: "relay-parsed",
      detect: (s) => {
        const m = /^(?:解析|Parsed|解析済み)：?\s*(\d+)$/.exec(s);
        return m ? [m[1]] : null;
      },
      render: (lang, m) => ({
        "zh-Hant": `解析：${m[0]}`,
        "zh-Hans": `解析：${m[0]}`,
        en: `Parsed: ${m[0]}`,
        ja: `解析済み: ${m[0]}`
      })[lang]
    },
    {
      id: "relay-unparsed",
      detect: (s) => {
        const m = /^(?:未解析|Unparsed)：?\s*(\d+)$/.exec(s);
        return m ? [m[1]] : null;
      },
      render: (lang, m) => ({
        "zh-Hant": `未解析：${m[0]}`,
        "zh-Hans": `未解析：${m[0]}`,
        en: `Unparsed: ${m[0]}`,
        ja: `未解析: ${m[0]}`
      })[lang]
    },
    {
      id: "unparsed-lines",
      detect: (s) => {
        const m = /^(?:未自动解析行|未自動解析行|Unparsed Lines|未解析行)\s+(\d+)$/.exec(s);
        return m ? [m[1]] : null;
      },
      render: (lang, m) => ({
        "zh-Hant": `未自動解析行 ${m[0]}`,
        "zh-Hans": `未自动解析行 ${m[0]}`,
        en: `Unparsed Lines ${m[0]}`,
        ja: `未解析行 ${m[0]}`
      })[lang]
    },
    {
      id: "showing",
      detect: (s) => {
        const m = /^(?:显示|顯示|Showing|表示)\s+(\d+\/\d+)$/.exec(s);
        return m ? [m[1]] : null;
      },
      render: (lang, m) => ({
        "zh-Hant": `顯示 ${m[0]}`,
        "zh-Hans": `显示 ${m[0]}`,
        en: `Showing ${m[0]}`,
        ja: `表示 ${m[0]}`
      })[lang]
    },
    {
      id: "oq-games",
      detect: (s) => {
        const m = /^(?:(.*?)\s*)?(\d+)(?:局| games|ゲーム)$/.exec(s);
        return m ? [m[1] || "", m[2]] : null;
      },
      render: (lang, m) => ({
        "zh-Hant": `${m[0] ? `${m[0]} ` : ""}${m[1]}局`,
        "zh-Hans": `${m[0] ? `${m[0]} ` : ""}${m[1]}局`,
        en: `${m[0] ? `${m[0]} ` : ""}${m[1]} games`,
        ja: `${m[0] ? `${m[0]} ` : ""}${m[1]}ゲーム`
      })[lang]
    },
    {
      id: "invalid-chars",
      detect: (s) => {
        const m = /^OQ账号填写不规范，出现字符“(.+)”。$/.exec(s) || /^OQ 帳號填寫不規範，出現字元「(.+)」。$/.exec(s);
        return m ? [m[1]] : null;
      },
      render: (lang, m) => ({
        "zh-Hant": `OQ 帳號填寫不規範，出現字元「${m[0]}」。`,
        "zh-Hans": `OQ账号填写不规范，出现字符“${m[0]}”。`,
        en: `OQ account contains invalid characters: ${m[0]}.`,
        ja: `OQ アカウントに無効な文字が含まれています: ${m[0]}。`
      })[lang]
    },
    {
      id: "validation-result",
      detect: (s) => {
        const m = /^(.*?)(?:已保存并完成 OQ 校验|已儲存並完成 OQ 校驗|Saved and completed OQ validation|保存して OQ 検証が完了)：?(?:本次| this run | 今回 )?\s*(\d+)[，,]\s*(?:有效|valid|有効)\s*(\d+)[，,]\s*(?:异常|abnormal|異常)\s*(\d+)[，,]\s*(?:跳过|skipped|スキップ)\s*(\d+)[；;]\s*(?:当前异常|current abnormal|現在の異常)\s*(\d+)$/.exec(s);
        return m ? [m[1], m[2], m[3], m[4], m[5], m[6]] : null;
      },
      render: (lang, m) => ({
        "zh-Hant": `${m[0]}已儲存並完成 OQ 校驗：本次 ${m[1]}，有效 ${m[2]}，異常 ${m[3]}，跳過 ${m[4]}；目前異常 ${m[5]}`,
        "zh-Hans": `${m[0]}已保存并完成 OQ 校验：本次 ${m[1]}，有效 ${m[2]}，异常 ${m[3]}，跳过 ${m[4]}；当前异常 ${m[5]}`,
        en: `${m[0]}Saved and completed OQ validation: this run ${m[1]}, valid ${m[2]}, abnormal ${m[3]}, skipped ${m[4]}; current abnormal ${m[5]}`,
        ja: `${m[0]}保存して OQ 検証が完了：今回 ${m[1]}、有効 ${m[2]}、異常 ${m[3]}、スキップ ${m[4]}；現在の異常 ${m[5]}`
      })[lang]
    },
    {
      id: "validating-with-prefix",
      detect: (s) => {
        const m = /^(.*?)(?:正在校验 OQ 账号，请勿操作。|正在校驗 OQ 帳號，請勿操作。|Validating OQ accounts\. Do not edit\.|OQ アカウントを検証中です。操作しないでください。)$/.exec(s);
        return m && m[1] ? [m[1]] : null;
      },
      render: (lang, m) => ({
        "zh-Hant": `${m[0]}正在校驗 OQ 帳號，請勿操作。`,
        "zh-Hans": `${m[0]}正在校验 OQ 账号，请勿操作。`,
        en: `${m[0]}Validating OQ accounts. Do not edit.`,
        ja: `${m[0]}OQ アカウントを検証中です。操作しないでください。`
      })[lang]
    },
    {
      id: "nick-changed-list",
      detect: (s) => {
        const m = /^(.*?)(?:，群昵称有变动，需要重新登记。|，群暱稱有變動，需要重新登記。|: group nickname changed; registration is required again\.|：グループ表示名が変更されました。再登録が必要です。)$/.exec(s);
        return m ? [m[1]] : null;
      },
      render: (lang, m) => ({
        "zh-Hant": `${m[0]}，群暱稱有變動，需要重新登記。`,
        "zh-Hans": `${m[0]}，群昵称有变动，需要重新登记。`,
        en: `${m[0]}: group nickname changed; registration is required again.`,
        ja: `${m[0]}：グループ表示名が変更されました。再登録が必要です。`
      })[lang]
    },
    {
      id: "export-complete",
      detect: (s) => {
        const m = /^(?:已完成|已完成|Completed|完了)：?\s*(\d+\/\d+)$/.exec(s);
        return m ? [m[1]] : null;
      },
      render: (lang, m) => ({
        "zh-Hant": `已完成：${m[0]}`,
        "zh-Hans": `已完成：${m[0]}`,
        en: `Completed: ${m[0]}`,
        ja: `完了: ${m[0]}`
      })[lang]
    },
    {
      id: "png-truncated-ios",
      detect: (s) => {
        const m = /^iOS (?:兼容模式|相容模式|compatibility mode|互換モード)：(?:PNG )?(?:仅导出前|僅匯出前|exports only the first|先頭のみ出力)\s*(\d+)\s*(?:人|players|名).*?$/.exec(s);
        return m ? [m[1]] : null;
      },
      render: (lang, m) => ({
        "zh-Hant": `iOS 相容模式：PNG 僅匯出前 ${m[0]} 人。`,
        "zh-Hans": `iOS 兼容模式：PNG 仅导出前 ${m[0]} 人。`,
        en: `iOS compatibility mode: PNG exports only the first ${m[0]} players.`,
        ja: `iOS 互換モード：PNG は先頭 ${m[0]} 名のみ出力します。`
      })[lang]
    },
    {
      id: "png-truncated",
      detect: (s) => {
        const m = /^(?:名单较长，PNG 仅导出前|名單較長，PNG 僅匯出前|Long list: PNG exports only the first|名簿が長いため、PNG は先頭)\s*(\d+)\s*(?:人|players|名).*?$/.exec(s);
        return m ? [m[1]] : null;
      },
      render: (lang, m) => ({
        "zh-Hant": `名單較長，PNG 僅匯出前 ${m[0]} 人。`,
        "zh-Hans": `名单较长，PNG 仅导出前 ${m[0]} 人。`,
        en: `Long list: PNG exports only the first ${m[0]} players.`,
        ja: `名簿が長いため、PNG は先頭 ${m[0]} 名のみ出力します。`
      })[lang]
    }
  ];

  const exactReverse = new Map();
  Object.keys(TEXT).forEach((key) => {
    exactReverse.set(key, key);
    Object.values(TEXT[key]).forEach((value) => exactReverse.set(value, key));
  });

  let currentLang = normalizeLang(readStoredLanguage()) || DEFAULT_LANG;
  const textMemo = new WeakMap();
  const attrMemo = new WeakMap();
  const externalDocuments = new Set();
  let observer = null;
  let observerScheduled = false;

  function normalizeLang(value) {
    return Object.prototype.hasOwnProperty.call(LANGS, value) ? value : "";
  }

  function readStoredLanguage() {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch (_) {
      return "";
    }
  }

  function writeStoredLanguage(lang) {
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch (_) {
      // Storage can be unavailable in restricted browser contexts.
    }
  }

  function translateExact(key, lang) {
    return (TEXT[key] && TEXT[key][lang]) || key;
  }

  function translateInlineValue(value, lang) {
    const key = exactReverse.get(value);
    return key ? translateExact(key, lang) : value;
  }

  function detectSource(trimmed) {
    const exactKey = exactReverse.get(trimmed);
    if (exactKey) return { type: "exact", key: exactKey };

    for (const pattern of PREFIX_PATTERNS) {
      const match = pattern.re.exec(trimmed);
      if (match) return { type: "prefix", id: pattern.id, args: match };
    }

    for (const pattern of PATTERNS) {
      const args = pattern.detect(trimmed);
      if (args) return { type: "pattern", id: pattern.id, args };
    }
    return null;
  }

  function renderDetected(source, lang) {
    if (!source) return "";
    if (source.type === "exact") return translateExact(source.key, lang);
    if (source.type === "prefix") {
      const pattern = PREFIX_PATTERNS.find((item) => item.id === source.id);
      return pattern ? pattern.render(lang, source.args) : "";
    }
    const pattern = PATTERNS.find((item) => item.id === source.id);
    return pattern ? pattern.render(lang, source.args) : "";
  }

  function translateText(text, lang) {
    const source = detectSource(text);
    return source ? renderDetected(source, lang) : text;
  }

  function shouldSkipTextNode(node) {
    const parent = node.parentElement;
    if (!parent) return true;
    return Boolean(parent.closest("script, style, textarea, pre, code, [data-i18n-ignore], [data-group-nick]"));
  }

  function translateTextNode(node, lang) {
    if (shouldSkipTextNode(node)) return;
    const raw = node.nodeValue || "";
    const trimmed = raw.trim();
    if (!trimmed) return;

    const leading = raw.match(/^\s*/)[0];
    const trailing = raw.match(/\s*$/)[0];
    let source = null;
    const memo = textMemo.get(node);
    if (memo && trimmed === memo.lastOutput) {
      source = memo.source;
    } else {
      source = detectSource(trimmed);
    }
    if (!source) return;

    const translated = renderDetected(source, lang);
    if (!translated) return;
    const next = `${leading}${translated}${trailing}`;
    textMemo.set(node, { source, lastOutput: translated });
    if (raw !== next) node.nodeValue = next;
  }

  function translateAttributes(el, lang) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return;
    ["placeholder", "title", "alt", "aria-label"].forEach((attr) => {
      if (!el.hasAttribute(attr)) return;
      const value = el.getAttribute(attr);
      const key = `${attr}:${value}`;
      let store = attrMemo.get(el);
      if (!store) {
        store = {};
        attrMemo.set(el, store);
      }
      let source = null;
      if (store[attr] && value === store[attr].lastOutput) {
        source = store[attr].source;
      } else {
        source = detectSource(value);
      }
      if (!source) return;
      const translated = renderDetected(source, lang);
      if (!translated) return;
      store[attr] = { source, lastOutput: translated, key };
      if (value !== translated) el.setAttribute(attr, translated);
    });
  }

  function walk(root, lang) {
    if (!root) return;
    if (root.nodeType === Node.TEXT_NODE) {
      translateTextNode(root, lang);
      return;
    }
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;

    if (root.nodeType === Node.ELEMENT_NODE) translateAttributes(root, lang);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.matches("script, style, textarea, pre, code, [data-i18n-ignore]")) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
        return shouldSkipTextNode(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      }
    });
    let node = walker.nextNode();
    while (node) {
      if (node.nodeType === Node.TEXT_NODE) translateTextNode(node, lang);
      else translateAttributes(node, lang);
      node = walker.nextNode();
    }
  }

  function syncSelector() {
    const selector = document.getElementById("language-selector");
    if (!selector) return;
    selector.value = currentLang;
    selector.setAttribute("aria-label", translateExact("语言", currentLang));
  }

  function applyLanguage(lang, persist) {
    currentLang = normalizeLang(lang) || DEFAULT_LANG;
    if (persist) writeStoredLanguage(currentLang);
    document.documentElement.lang = LANGS[currentLang].htmlLang;
    syncSelector();
    walk(document, currentLang);
    for (const doc of externalDocuments) {
      try {
        walkExternal(doc, currentLang);
      } catch (_) {
        externalDocuments.delete(doc);
      }
    }
  }

  function setupSelector() {
    const selector = document.getElementById("language-selector");
    if (!selector) return;
    Array.from(selector.options).forEach((option) => {
      if (LANGS[option.value]) option.textContent = LANGS[option.value].label;
    });
    selector.value = currentLang;
    selector.addEventListener("change", () => applyLanguage(selector.value, true));
  }

  function scheduleWalk(root) {
    if (observerScheduled) return;
    observerScheduled = true;
    requestAnimationFrame(() => {
      observerScheduled = false;
      walk(root || document, currentLang);
    });
  }

  function startObserver() {
    if (observer) observer.disconnect();
    observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "characterData") {
          translateTextNode(record.target, currentLang);
        } else if (record.type === "attributes") {
          translateAttributes(record.target, currentLang);
        } else {
          record.addedNodes.forEach((node) => scheduleWalk(node));
        }
      }
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["placeholder", "title", "alt", "aria-label"]
    });
  }

  function walkExternal(doc, lang) {
    if (!doc || !doc.documentElement) return;
    doc.documentElement.lang = LANGS[lang].htmlLang;
    const walker = doc.createTreeWalker(doc, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        if (node.nodeType === Node.ELEMENT_NODE && node.matches("script, style, textarea, pre, code")) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let node = walker.nextNode();
    while (node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const raw = node.nodeValue || "";
        const translated = translateText(raw.trim(), lang);
        if (translated !== raw.trim()) {
          node.nodeValue = raw.replace(raw.trim(), translated);
        }
      } else {
        ["placeholder", "title", "alt", "aria-label"].forEach((attr) => {
          if (!node.hasAttribute || !node.hasAttribute(attr)) return;
          node.setAttribute(attr, translateText(node.getAttribute(attr), lang));
        });
      }
      node = walker.nextNode();
    }
  }

  function patchPopupWindows() {
    const originalOpen = window.open;
    if (typeof originalOpen !== "function") return;
    window.open = function patchedOpen() {
      const win = originalOpen.apply(window, arguments);
      if (!win || !win.document) return win;
      try {
        const doc = win.document;
        const originalWrite = doc.write.bind(doc);
        doc.write = function patchedWrite(html) {
          return originalWrite(typeof html === "string" ? translateHtmlString(html) : html);
        };
        const originalClose = doc.close.bind(doc);
        doc.close = function patchedClose() {
          const result = originalClose();
          externalDocuments.add(doc);
          setTimeout(() => {
            walkExternal(doc, currentLang);
            const extObserver = new MutationObserver(() => walkExternal(doc, currentLang));
            extObserver.observe(doc.documentElement, {
              subtree: true,
              childList: true,
              characterData: true,
              attributes: true,
              attributeFilter: ["placeholder", "title", "alt", "aria-label"]
            });
          }, 0);
          return result;
        };
      } catch (_) {
        return win;
      }
      return win;
    };
  }

  function translateHtmlString(html) {
    let output = html;
    Object.keys(TEXT).forEach((key) => {
      output = output.split(key).join(translateExact(key, currentLang));
    });
    return output;
  }

  function patchCanvasText() {
    if (!window.CanvasRenderingContext2D || !CanvasRenderingContext2D.prototype.fillText) return;
    const originalFillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function patchedFillText(text) {
      if (typeof text === "string") {
        arguments[0] = translateText(text, currentLang);
      }
      return originalFillText.apply(this, arguments);
    };
  }

  document.documentElement.lang = LANGS[currentLang].htmlLang;
  patchPopupWindows();
  patchCanvasText();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      setupSelector();
      applyLanguage(currentLang, false);
      startObserver();
    });
  } else {
    setupSelector();
    applyLanguage(currentLang, false);
    startObserver();
  }
})();
