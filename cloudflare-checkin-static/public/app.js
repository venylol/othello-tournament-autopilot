/* ==============================
   比赛签到助手（纯前端，本地保存）
   - Cloudflare 只负责托管静态文件
   - 签到数据保存在浏览器 LocalStorage
   ============================== */

(() => {
  "use strict";

  // ------------------------------------------------------------
  // Environment guards
  // ------------------------------------------------------------
  // The app is designed for browsers, but we also run regression tests in
  // Node.js (no DOM). In Node we only export the pure parsing/suspects
  // logic and skip all UI initialization.
  const IS_NODE =
    typeof module !== "undefined" &&
    !!module.exports &&
    (typeof window === "undefined" || typeof document === "undefined");

  const APP_VERSION = (() => {
    try {
      if (
        typeof document === "undefined" ||
        !document ||
        typeof document.querySelector !== "function"
      ) {
        return "dev";
      }
      const el = document.querySelector('meta[name="app-version"]');
      const v =
        el && typeof el.getAttribute === "function"
          ? el.getAttribute("content")
          : "";
      return (v && String(v).trim()) || "dev";
    } catch (_) {
      return "dev";
    }
  })();

  // ------------------------------
  // Polyfills (compatibility)
  // ------------------------------
  // Element.matches / Element.closest for older WebViews
  try {
    if (typeof Element !== "undefined") {
      if (!Element.prototype.matches) {
        Element.prototype.matches =
          Element.prototype.msMatchesSelector ||
          Element.prototype.webkitMatchesSelector ||
          function (selector) {
            const el = this;
            const nodes = (el.document || el.ownerDocument).querySelectorAll(
              selector,
            );
            for (let i = 0; i < nodes.length; i++) {
              if (nodes[i] === el) return true;
            }
            return false;
          };
      }
      if (!Element.prototype.closest) {
        Element.prototype.closest = function (selector) {
          let el = this;
          while (el && el.nodeType === 1) {
            if (el.matches(selector)) return el;
            el = el.parentElement || el.parentNode;
          }
          return null;
        };
      }
    }
  } catch (_) {
    // ignore polyfill errors
  }

  // ------------------------------
  // DOM helpers
  // ------------------------------
  // In Node.js tests there is no DOM; keep this helper safe.
  const $ = (sel, root) => {
    const base = root || (typeof document !== "undefined" ? document : null);
    if (!base || typeof base.querySelector !== "function") return null;
    return base.querySelector(sel);
  };

  // Robust node checks (avoid ReferenceError in some embedded WebViews)
  const isNode = (x) =>
    !!x && typeof x === "object" && typeof x.nodeType === "number";
  const isElement = (x) => isNode(x) && x.nodeType === 1;
  const isHTMLElement = (x) => isElement(x) && typeof x.style === "object";

  function on(el, type, handler, options) {
    if (!el) {
      console.warn("事件绑定失败：未找到元素", type);
      return;
    }
    el.addEventListener(type, handler, options);
  }

  function debounce(fn, delay = 120) {
    let t = null;
    return (...args) => {
      if (t) window.clearTimeout(t);
      t = window.setTimeout(() => {
        t = null;
        fn(...args);
      }, delay);
    };
  }

  function now() {
    return Date.now();
  }

  function pad2(n) {
    const s = String(Math.trunc(Number(n) || 0));
    return s.length >= 2 ? s : "0" + s;
  }

  function formatTime(ts) {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return "";
    const d = new Date(n);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }

  function formatShortTime(ts) {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return "";
    const d = new Date(n);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  // ------------------------------
  // Storage
  // ------------------------------
  const STORAGE_KEY = "reversi_checkin_local_state_v2";
  const STORAGE_VERSION = 2;
  const UNDO_SNACKBAR_DURATION = 4200;
  const INAPP_EXPORT_TIP_KEY = "checkin_assistant_inapp_export_tip_v1";
  let lastAutoSuspectHash = "";

  const DEFAULT_GROUP_RULES = Object.freeze([
    {
      id: "rule-open",
      group: "无差别组",
      keywords: ["无差别组", "无差别赛事", "公开组", "open"],
      enabled: true,
    },
    {
      id: "rule-youth",
      group: "青少年组",
      keywords: ["青少年组", "少年组", "youth"],
      enabled: true,
    },
    {
      id: "rule-newbie",
      group: "新人赛",
      keywords: ["新人赛", "新人组", "新手组", "newbie"],
      enabled: true,
    },
    {
      id: "rule-special",
      group: "特殊赛",
      keywords: ["特殊赛", "特别赛", "xot", "vint"],
      enabled: true,
    },
    {
      id: "rule-longterm",
      group: "长期名单",
      keywords: ["长期选手", "长期成员", "长期名单"],
      enabled: true,
    },
  ]);

  function cloneDefaultGroupRules() {
    return DEFAULT_GROUP_RULES.map((r) => ({
      id: String(r.id),
      group: String(r.group),
      keywords: Array.isArray(r.keywords) ? r.keywords.slice() : [],
      enabled: Boolean(r.enabled),
    }));
  }

  function normalizeGroupRuleKeywords(raw) {
    if (Array.isArray(raw)) {
      return raw
        .map((x) => normalizeWhitespace(x))
        .filter(Boolean)
        .slice(0, 24);
    }

    const text = normalizeWhitespace(String(raw || ""));
    if (!text) return [];
    return text
      .split(/[\n,，;；]/)
      .map((x) => normalizeWhitespace(x))
      .filter(Boolean)
      .slice(0, 24);
  }

  function sanitizeGroupRules(rawRules) {
    const list = Array.isArray(rawRules) ? rawRules : [];
    const out = [];
    const used = new Set();

    for (const item of list) {
      if (!item || typeof item !== "object") continue;

      const group = normalizeWhitespace(item.group);
      if (!group) continue;

      let id = normalizeWhitespace(item.id);
      if (!id) id = `rule-${Math.random().toString(16).slice(2, 10)}`;
      if (used.has(id)) continue;

      const keywords = normalizeGroupRuleKeywords(item.keywords);
      if (keywords.length === 0) continue;

      used.add(id);
      out.push({
        id,
        group,
        keywords,
        enabled: item.enabled !== false,
      });
    }

    return out.length ? out : cloneDefaultGroupRules();
  }

  function getActiveGroupRules() {
    const rules = sanitizeGroupRules(state && state.groupRules);
    return rules.filter((r) => r.enabled !== false);
  }

  const initialState = () => ({
    version: STORAGE_VERSION,
    step: "import", // 'import' | 'checkin' | 'score-helper'
    competitionName: "比赛签到表",
    nextPlayerId: 1,
    players: [],
    clubText: "",
    relayText: "",
    groupRules: cloneDefaultGroupRules(),
    scoreHelper: createDefaultScoreHelper(),
    ui: {
      group: "all", // 'all' | groupName
      callMode: false, // 点名模式
      showTime: false, // 显示签到时间
    },
    savedAt: now(),
  });

  let state = initialState();
  // UI-only override so we can show "导入页 + 继续上次进度" without overwriting saved step.
  let viewStepOverride = null;
  let saveTimer = null;
  let lastSaveFailAt = 0;
  let lastLocalEditAt = 0;

  const LOCAL_SYNC_ENABLED =
    !IS_NODE &&
    (() => {
      try {
        const params = new URLSearchParams(window.location.search || "");
        if (params.get("localSync") === "1") return true;
        if (params.get("localSync") === "0") return false;
        const host = String(window.location.hostname || "").toLowerCase();
        return host === "127.0.0.1" || host === "localhost" || host === "::1";
      } catch (_) {
        return false;
      }
    })();

  const LOCAL_SYNC_STATE_URL = "/api/state";
  const LOCAL_SYNC_EVENTS_URL = "/api/events";
  const LOCAL_SYNC_CLIENT_ID =
    !IS_NODE && typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `client-${Math.random().toString(16).slice(2)}-${Date.now()}`;
  let localSyncApplyingRemote = false;
  let localSyncPushTimer = null;
  let localSyncPushInFlight = false;
  let localSyncPendingPush = false;
  let localSyncLastRevision = -1;
  let localSyncLastErrorAt = 0;
  let localSyncPollTimer = null;
  let localSyncEventSource = null;

  function createDefaultScoreHelper(roundCount = 5) {
    const count = Math.max(1, Math.min(9, Math.trunc(Number(roundCount) || 5)));
    return {
      version: 1,
      roundCount: count,
      activeRound: 1,
      rounds: Array.from({ length: count }, (_, i) => ({
        round: i + 1,
        pending: [],
        manualPending: [],
        completed: [],
      })),
      updatedAt: null,
    };
  }

  function safeLocalStorageSet(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (e) {
      console.warn("localStorage 写入失败：", e);
      return false;
    }
  }

  function safeLocalStorageGet(key) {
    try {
      return localStorage.getItem(key);
    } catch (e) {
      console.warn("localStorage 读取失败：", e);
      return null;
    }
  }

  function safeLocalStorageRemove(key) {
    try {
      localStorage.removeItem(key);
      return true;
    } catch (e) {
      console.warn("localStorage 删除失败：", e);
      return false;
    }
  }

  function scheduleSave() {
    state.savedAt = now();
    lastLocalEditAt = state.savedAt;
    if (saveTimer) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      saveTimer = null;
      const ok = safeLocalStorageSet(STORAGE_KEY, JSON.stringify(state));
      if (ok) updateAutosaveChip(state.savedAt);
      if (!ok) {
        const ts = now();
        if (ts - lastSaveFailAt > 8000) {
          lastSaveFailAt = ts;
          showSnackbar(
            "⚠️ 自动保存失败：可能是浏览器禁用/容量不足（仍可继续使用）",
            3500,
          );
        }
      }
      queueLocalSyncPush();
    }, 180);
  }

  // Flush pending autosave immediately.
  // Useful when the page is being backgrounded/closed (especially on mobile Safari).
  function flushSave() {
    state.savedAt = now();
    lastLocalEditAt = state.savedAt;
    if (saveTimer) window.clearTimeout(saveTimer);
    saveTimer = null;
    if (safeLocalStorageSet(STORAGE_KEY, JSON.stringify(state))) {
      updateAutosaveChip(state.savedAt);
    }
    queueLocalSyncPush({ immediate: true });
  }

  function loadFromStorage() {
    const raw = safeLocalStorageGet(STORAGE_KEY);
    if (!raw) return null;

    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;

      // Allow loading previous schema as long as version matches.
      if (parsed.version !== STORAGE_VERSION) return null;

      return sanitizeLoadedState(parsed);
    } catch (e) {
      console.warn("解析本地状态失败：", e);
      return null;
    }
  }

  function getSyncChipEl() {
    return typeof document !== "undefined"
      ? document.getElementById("sync-chip")
      : null;
  }

  function setLocalSyncStatus(kind, text) {
    const chip = getSyncChipEl();
    if (!chip) return;
    const k = kind || "idle";
    chip.classList.remove(
      "sync-chip--idle",
      "sync-chip--ok",
      "sync-chip--busy",
      "sync-chip--error",
    );
    chip.classList.add(`sync-chip--${k}`);
    chip.textContent = text || "本地同步：未连接";
  }

  function reportLocalSyncError(message, error) {
    const detail =
      error && error.message ? String(error.message) : String(error || "");
    const text = detail ? `${message}：${detail}` : message;
    console.error("[local-sync]", text, error || "");
    setLocalSyncStatus("error", "本地同步：错误");

    const ts = now();
    if (ts - localSyncLastErrorAt > 7000) {
      localSyncLastErrorAt = ts;
      showSnackbar(`本地同步错误：${message}`, 5200, "查看", () => {
        showAlert("本地同步错误", text);
      });
    }
  }

  function cloneStateForLocalSync() {
    const copy = deepClone(state);
    if (!copy || typeof copy !== "object") return null;
    copy.localSync = {
      clientId: LOCAL_SYNC_CLIENT_ID,
      source: "frontend",
      savedAt: now(),
    };
    return copy;
  }

  function queueLocalSyncPush(options = {}) {
    if (!LOCAL_SYNC_ENABLED || localSyncApplyingRemote) return;
    if (!state || Number(state.version) !== STORAGE_VERSION) return;

    if (localSyncPushTimer) window.clearTimeout(localSyncPushTimer);
    const delay = options && options.immediate ? 0 : 420;
    localSyncPushTimer = window.setTimeout(() => {
      localSyncPushTimer = null;
      pushLocalSyncState();
    }, delay);
  }

  async function pushLocalSyncState() {
    if (!LOCAL_SYNC_ENABLED || localSyncApplyingRemote) return;
    if (localSyncPushInFlight) {
      localSyncPendingPush = true;
      return;
    }

    const payload = cloneStateForLocalSync();
    if (!payload) return;

    localSyncPushInFlight = true;
    setLocalSyncStatus("busy", "本地同步：保存中");
    try {
      const response = await fetch(LOCAL_SYNC_STATE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ source: "frontend", state: payload }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result || result.ok !== true) {
        throw new Error(
          (result && (result.detail || result.error)) ||
            `HTTP ${response.status}`,
        );
      }
      localSyncLastRevision = Number(result.revision);
      setLocalSyncStatus("ok", "本地同步：已保存");
    } catch (error) {
      reportLocalSyncError("写入共享状态失败", error);
    } finally {
      localSyncPushInFlight = false;
      if (localSyncPendingPush) {
        localSyncPendingPush = false;
        queueLocalSyncPush({ immediate: true });
      }
    }
  }

  function applyRemoteState(remoteState, meta = {}) {
    const loaded = sanitizeLoadedState(remoteState);
    if (!loaded || !Array.isArray(loaded.players)) {
      throw new Error("共享状态无法通过前端校验");
    }

    const remoteSavedAt = Number(loaded.savedAt) || 0;
    const localSavedAt = Number(state && state.savedAt) || 0;
    const hasLocalPlayers = Boolean(
      state && Array.isArray(state.players) && state.players.length > 0,
    );
    const hasRemotePlayers = Boolean(
      loaded && Array.isArray(loaded.players) && loaded.players.length > 0,
    );

    if (
      hasLocalPlayers &&
      hasRemotePlayers &&
      remoteSavedAt + 1000 < localSavedAt &&
      now() - lastLocalEditAt < 120000
    ) {
      showSnackbar(
        "共享文件较旧，已拒绝覆盖当前浏览器进度。请让我查看后再处理。",
        6000,
      );
      setLocalSyncStatus("error", "本地同步：有冲突");
      return false;
    }

    localSyncApplyingRemote = true;
    try {
      state = loaded;
      if (state.step !== "score-helper") {
        state.step = hasRemotePlayers ? "checkin" : state.step;
      }
      viewStepOverride = null;
      applyStateToUI();
      safeLocalStorageSet(STORAGE_KEY, JSON.stringify(state));
      updateAutosaveChip(state.savedAt);
      setLocalSyncStatus("ok", "本地同步：已载入");
      if (meta && meta.showToast) {
        showSnackbar("已从共享 JSON 载入最新签到状态", 2600);
      }
      return true;
    } finally {
      localSyncApplyingRemote = false;
    }
  }

  async function fetchLocalSyncState(options = {}) {
    if (!LOCAL_SYNC_ENABLED) return;
    try {
      const response = await fetch(`${LOCAL_SYNC_STATE_URL}?t=${Date.now()}`, {
        method: "GET",
        cache: "no-store",
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result || result.ok !== true) {
        throw new Error(
          (result && (result.detail || result.error)) ||
            `HTTP ${response.status}`,
        );
      }

      const revisionValue = Number(result.revision);
      if (
        Number.isFinite(revisionValue) &&
        revisionValue === localSyncLastRevision &&
        !options.force
      ) {
        setLocalSyncStatus("ok", "本地同步：已连接");
        return;
      }

      if (Number.isFinite(revisionValue)) localSyncLastRevision = revisionValue;

      if (!result.state) {
        setLocalSyncStatus("ok", "本地同步：已连接");
        if (options.pushIfEmpty !== false) {
          queueLocalSyncPush({ immediate: true });
        }
        return;
      }

      applyRemoteState(result.state, {
        showToast: Boolean(options.showToast),
      });
    } catch (error) {
      reportLocalSyncError("读取共享状态失败", error);
    }
  }

  function startLocalSync() {
    if (!LOCAL_SYNC_ENABLED) {
      setLocalSyncStatus("idle", "本地同步：未连接");
      return;
    }

    setLocalSyncStatus("busy", "本地同步：连接中");
    fetchLocalSyncState({ force: true, showToast: false, pushIfEmpty: true });

    if (typeof EventSource !== "undefined") {
      try {
        localSyncEventSource = new EventSource(LOCAL_SYNC_EVENTS_URL);
        localSyncEventSource.onopen = () => {
          setLocalSyncStatus("ok", "本地同步：已连接");
        };
        localSyncEventSource.onmessage = (event) => {
          try {
            const payload = JSON.parse(event.data || "{}");
            if (payload && payload.type === "error") {
              throw new Error(payload.error || "服务端文件监听错误");
            }
            if (payload && payload.type === "state") {
              const rev = Number(payload.revision);
              if (Number.isFinite(rev) && rev === localSyncLastRevision) {
                return;
              }
              fetchLocalSyncState({ force: true, showToast: true });
            }
          } catch (error) {
            reportLocalSyncError("处理同步事件失败", error);
          }
        };
        localSyncEventSource.onerror = () => {
          setLocalSyncStatus("error", "本地同步：监听断开");
        };
      } catch (error) {
        reportLocalSyncError("启动同步监听失败", error);
      }
    }

    localSyncPollTimer = window.setInterval(() => {
      fetchLocalSyncState({ force: false, showToast: false });
    }, 5000);
  }

  // ------------------------------
  // Undo helpers (删除/清空/批量操作)
  // - 目标：最小侵入、最小风险，尽量用“快照恢复”而不是复杂的差异回滚
  // - 说明：撤销只在当前页面生命周期内有效（刷新后不保证）
  // ------------------------------
  function deepClone(value) {
    // structuredClone is supported by most modern browsers; fall back to JSON clone.
    if (typeof structuredClone === "function") {
      try {
        return structuredClone(value);
      } catch (_) {
        /* fall through */
      }
    }
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (e) {
      return value;
    }
  }

  function captureUndoSnapshot() {
    return deepClone({ state, viewStepOverride });
  }

  function restoreUndoSnapshot(snapshot) {
    if (!snapshot || !snapshot.state) return;
    state = snapshot.state;
    viewStepOverride = snapshot.viewStepOverride || null;
    applyStateToUI();
    // Flush immediately so undo survives pagehide on mobile Safari/WeChat.
    flushSave();
  }

  function clearStorageAndReset() {
    const snapshot = captureUndoSnapshot();

    // Clear persisted storage first (so a refresh won't resurrect old state)
    safeLocalStorageRemove(STORAGE_KEY);

    state = initialState();
    viewStepOverride = null;
    applyStateToUI(true);
    queueLocalSyncPush({ immediate: true });

    showUndoSnackbar("已清除本地进度", () => {
      restoreUndoSnapshot(snapshot);
      showSnackbar("已撤销清除", 2200);
    });
  }

  // ------------------------------
  // Sorting / parsing utilities
  // ------------------------------
  const nameCollator = (() => {
    // Some extremely old/embedded browsers may not have Intl.
    // Fall back to a safe string comparison to avoid crashing.
    const safeFallback = {
      compare: (a, b) => {
        const A = String(a ?? "");
        const B = String(b ?? "");
        if (A === B) return 0;
        return A < B ? -1 : 1;
      },
    };

    try {
      if (typeof Intl === "undefined" || typeof Intl.Collator !== "function") {
        return safeFallback;
      }

      try {
        return new Intl.Collator("zh-Hans-CN-u-co-pinyin", {
          numeric: true,
          sensitivity: "base",
        });
      } catch (e1) {
        try {
          return new Intl.Collator("zh-Hans-CN", {
            numeric: true,
            sensitivity: "base",
          });
        } catch (e2) {
          return new Intl.Collator(undefined, {
            numeric: true,
            sensitivity: "base",
          });
        }
      }
    } catch (e) {
      return safeFallback;
    }
  })();

  function normalizeWhitespace(str) {
    return (
      (str || "")
        .replace(/\uFEFF/g, "")
        // Normalize uncommon unicode spaces (NBSP / thin spaces / hangul filler etc.)
        // to reduce hidden-char duplicates from pasted text.
        .replace(
          /[\u00A0\u1680\u2000-\u200D\u202F\u205F\u2060-\u2063\u3000\u3164]/g,
          " ",
        )
        .replace(/[ \t\r\f\v]+/g, " ")
        .trim()
    );
  }

  function unwrapBrackets(str) {
    return (
      (str || "")
        .replace(/\[(.*?)\]/g, " $1 ")
        // Fullwidth / CJK brackets commonly seen in relays and chat apps
        .replace(/【(.*?)】/g, " $1 ")
        .replace(/「(.*?)」/g, " $1 ")
        .replace(/《(.*?)》/g, " $1 ")
        .replace(/（(.*?)）/g, " $1 ")
        .replace(/\((.*?)\)/g, " $1 ")
    );
  }

  function stripListIndex(str) {
    // Remove common list numbering prefixes.
    // Examples:
    //   "1. 张三" / "1．张三" / "1、张三" / "1)张三" / "1]张三"
    // Important: do NOT treat numeric names like "3.1415" as list numbering.
    // Therefore, for '.' / '．' we only strip when it is NOT followed by a digit.
    return (str || "")
      .replace(/^\s*(?:\d{1,3}|[０-９]{1,3})\s*[\.．](?![0-9０-９])\s*/, "")
      .replace(/^\s*(?:\d{1,3}|[０-９]{1,3})\s*[、\)\]）］]\s*/, "")
      .replace(/^\s*(?:\d{1,3}|[０-９]{1,3})\s*[-–—－]\s+/, "");
  }

  function normalizeKey(str) {
    return normalizeWhitespace(str).toLowerCase();
  }

  function escapeHtml(unsafe) {
    return String(unsafe ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // ------------------------------
  // State sanitization (robust restore)
  // ------------------------------
  function sanitizeLoadedState(parsed) {
    try {
      const safe = initialState();
      safe.version = STORAGE_VERSION;

      safe.step =
        parsed.step === "checkin" ||
        parsed.step === "import" ||
        parsed.step === "score-helper"
          ? parsed.step
          : "import";
      safe.competitionName =
        normalizeWhitespace(parsed.competitionName) || "比赛签到表";
      safe.clubText =
        typeof parsed.clubText === "string" ? parsed.clubText : "";
      safe.relayText =
        typeof parsed.relayText === "string" ? parsed.relayText : "";
      safe.groupRules = sanitizeGroupRules(parsed.groupRules);
      safe.scoreHelper = sanitizeScoreHelper(parsed.scoreHelper);
      safe.savedAt = Number.isFinite(Number(parsed.savedAt))
        ? Number(parsed.savedAt)
        : now();

      // ui prefs (optional)
      const ui = parsed && typeof parsed.ui === "object" ? parsed.ui : {};
      safe.ui.group =
        typeof ui.group === "string" && ui.group ? ui.group : "all";
      safe.ui.callMode = Boolean(ui.callMode);
      safe.ui.showTime = Boolean(ui.showTime);

      const rawPlayers = Array.isArray(parsed.players) ? parsed.players : [];
      const usedIds = new Set();
      let maxId = 0;

      for (const p of rawPlayers) {
        const obj = p && typeof p === "object" ? p : {};
        const displayName = normalizeWhitespace(obj.displayName || obj.name);
        if (!displayName) continue;

        let id = Number(obj.id);
        id = Number.isFinite(id) ? Math.trunc(id) : 0;

        const account = normalizeWhitespace(obj.account || "");
        const club = normalizeWhitespace(obj.club || "");
        const platform = normalizeWhitespace(obj.platform || "");
        const group = normalizeWhitespace(obj.group || "") || "未分组";

        const checkedIn = Boolean(obj.checkedIn);
        const checkedInAtRaw = Number(obj.checkedInAt);
        const checkedInAt =
          Number.isFinite(checkedInAtRaw) && checkedInAtRaw > 0
            ? checkedInAtRaw
            : null;

        const isNew = Boolean(obj.isNew);

        const player = {
          id: 0,
          displayName,
          account,
          club,
          platform,
          group,
          checkedIn,
          checkedInAt,
          isNew,
        };

        // Keep valid unique ids; mark others for reassignment
        if (id > 0 && !usedIds.has(id)) {
          player.id = id;
          usedIds.add(id);
          maxId = Math.max(maxId, id);
        } else {
          player.id = 0;
        }

        safe.players.push(player);
      }

      // Reassign invalid/duplicate ids (id=0)
      let nextId = maxId + 1;
      for (const p of safe.players) {
        if (p.id > 0) continue;
        while (usedIds.has(nextId)) nextId++;
        p.id = nextId++;
        usedIds.add(p.id);
      }

      // Always keep nextPlayerId safe (>= maxId + 1)
      const derivedNext =
        safe.players.reduce((m, p) => Math.max(m, p.id), 0) + 1;
      const parsedNext = Number(parsed.nextPlayerId);
      const parsedNextSafe =
        Number.isFinite(parsedNext) && parsedNext > 0
          ? Math.trunc(parsedNext)
          : 1;
      safe.nextPlayerId = Math.max(derivedNext, parsedNextSafe);

      // If "checkin" but no players, fall back to import to avoid blank checkin page.
      if (safe.step === "checkin" && safe.players.length === 0)
        safe.step = "import";
      if (safe.step === "score-helper" && safe.players.length === 0)
        safe.step = "import";

      // Ensure consistent ordering (group -> name)
      safe.players.sort(comparePlayersForList);

      // If selected group no longer exists, reset to 'all'
      if (
        safe.ui.group !== "all" &&
        !safe.players.some((p) => p.group === safe.ui.group)
      ) {
        safe.ui.group = "all";
      }

      return safe;
    } catch (e) {
      console.warn("恢复数据校验失败：", e);
      return null;
    }
  }

  function sanitizeScoreItem(raw) {
    const obj = raw && typeof raw === "object" ? raw : {};
    const sender = normalizeWhitespace(obj.sender || obj.senderName || "");
    const opponent = normalizeWhitespace(obj.opponent || obj.opponentName || "");
    const loserStoneRaw =
      obj.loserStoneCount != null
        ? Number(obj.loserStoneCount)
        : obj.loser_stone_count != null
          ? Number(obj.loser_stone_count)
          : obj.isDraw
            ? 32
            : Number(obj.opponentScore);
    const senderScoreRaw = Number(obj.senderScore);
    const opponentScoreRaw = Number(obj.opponentScore);
    const roundRaw = Number(obj.round);
    return {
      id:
        normalizeWhitespace(obj.id) ||
        `score-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`,
      round: Number.isFinite(roundRaw) && roundRaw > 0 ? Math.trunc(roundRaw) : 1,
      sourceTime: normalizeWhitespace(obj.sourceTime || obj.time || ""),
      sender,
      wechatSender: normalizeWhitespace(obj.wechatSender || ""),
      senderAccount: normalizeWhitespace(obj.senderAccount || ""),
      opponent,
      loserStoneCount: Number.isFinite(loserStoneRaw)
        ? Math.max(0, Math.trunc(loserStoneRaw))
        : null,
      verdict: normalizeWhitespace(obj.verdict || obj.status || ""),
      senderScore: Number.isFinite(senderScoreRaw)
        ? Math.max(0, Math.trunc(senderScoreRaw))
        : null,
      opponentScore: Number.isFinite(opponentScoreRaw)
        ? Math.max(0, Math.trunc(opponentScoreRaw))
        : null,
      resultText: normalizeWhitespace(obj.resultText || obj.summary || ""),
      reason: normalizeWhitespace(obj.reason || ""),
      imagePath: normalizeWhitespace(obj.imagePath || obj.pngPath || obj.previewPath || ""),
      sourceMessageKey: normalizeWhitespace(obj.sourceMessageKey || ""),
      sourceLocalId: normalizeWhitespace(obj.sourceLocalId || obj.local_id || ""),
      ocrText: normalizeWhitespace(obj.ocrText || ""),
      confidence: normalizeWhitespace(obj.confidence || ""),
      registeredAt: Number.isFinite(Number(obj.registeredAt))
        ? Number(obj.registeredAt)
        : null,
      manualPendingAt: Number.isFinite(Number(obj.manualPendingAt))
        ? Number(obj.manualPendingAt)
        : null,
    };
  }

  function sanitizeScoreRound(raw, fallbackRound) {
    const obj = raw && typeof raw === "object" ? raw : {};
    const roundRaw = Number(obj.round);
    const round =
      Number.isFinite(roundRaw) && roundRaw > 0
        ? Math.trunc(roundRaw)
        : fallbackRound;
    const pending = Array.isArray(obj.pending)
      ? obj.pending.map(sanitizeScoreItem)
      : [];
    const manualPending = Array.isArray(obj.manualPending)
      ? obj.manualPending.map(sanitizeScoreItem)
      : [];
    const completed = Array.isArray(obj.completed)
      ? obj.completed.map(sanitizeScoreItem)
      : [];
    pending.forEach((item) => {
      item.round = round;
    });
    manualPending.forEach((item) => {
      item.round = round;
    });
    completed.forEach((item) => {
      item.round = round;
    });
    return { round, pending, manualPending, completed };
  }

  function sanitizeScoreHelper(raw) {
    const obj = raw && typeof raw === "object" ? raw : {};
    const parsedCount = Number(obj.roundCount);
    const sourceRounds = Array.isArray(obj.rounds) ? obj.rounds : [];
    const derivedCount = sourceRounds.length || parsedCount || 5;
    const roundCount = Math.max(
      1,
      Math.min(9, Math.trunc(Number(derivedCount) || 5)),
    );
    const rounds = [];
    for (let i = 0; i < roundCount; i++) {
      rounds.push(sanitizeScoreRound(sourceRounds[i], i + 1));
    }
    const activeRaw = Number(obj.activeRound);
    const activeRound =
      Number.isFinite(activeRaw) && activeRaw >= 1 && activeRaw <= roundCount
        ? Math.trunc(activeRaw)
        : 1;
    return {
      version: 1,
      roundCount,
      activeRound,
      rounds,
      updatedAt: Number.isFinite(Number(obj.updatedAt))
        ? Number(obj.updatedAt)
        : null,
    };
  }

  function comparePlayersForList(a, b) {
    const ga = normalizeWhitespace(a && a.group) || "未分组";
    const gb = normalizeWhitespace(b && b.group) || "未分组";
    const gcmp = nameCollator.compare(ga, gb);
    if (gcmp !== 0) return gcmp;

    // Prefer players with account first (helps dedupe readability)
    const ha = a && a.account ? 1 : 0;
    const hb = b && b.account ? 1 : 0;
    if (ha !== hb) return hb - ha;

    const na = normalizeWhitespace(a && a.displayName);
    const nb = normalizeWhitespace(b && b.displayName);
    return nameCollator.compare(na, nb);
  }

  // ------------------------------
  // Import parsing
  // ------------------------------
  const instructionKeywords = [
    "接龙",
    "接龍",
    "报名",
    "比赛",
    "截止",
    "签到",
    "点名",
    "开始",
    "格式",
    "昵称",
    "账号",
    "平台",
    "时间",
    "名单",
    "全部",
    "长期",
    "成员",
    "俱乐部",
    "赛事",
    "重要",
    "要求",
    "赛制",
    "详情",
    "查看",
    "文件",
    "正式版",
    "奖金",
    "红包",
    "发放",
    "裁判",
    "对局",
    "记录",
    "分数",
    "无问号",
    "以下",
    "vint",
    "xot",
    "5min",
    "注册",
    "房间",
    "点击",
    "http",
    "https",
  ];

  const standaloneNoiseLines = new Set([
    "oq",
    "othelloquest",
    "othello quest",
    "playok",
    "vint",
    "xot",
    "已签到",
    "等待中",
    "待签到",
    "签到",
    "取消签到",
    "已取消",
    "设为新人",
    "取消新人",
    "新人",
    "编辑",
    "删除",
    "无差别组",
    "青少年组",
    "新人赛",
    "新人组",
    "特殊赛",
    "长期名单",
    "长期成员",
  ]);

  function normalizeStandaloneNoiseLine(line) {
    let t = normalizeWhitespace(line);
    if (!t) return "";
    t = unwrapBrackets(t);
    t = stripListIndex(t);
    t = t.replace(/[|｜丨]/g, " ");
    t = t.replace(/[#:：]/g, " ");
    t = normalizeWhitespace(t.replace(/[，,。.;；]+$/g, ""));
    return t;
  }

  function isStandaloneUiOrPlatformNoiseLine(line) {
    const t = normalizeStandaloneNoiseLine(line);
    if (!t) return true;
    const lower = t.toLowerCase();
    if (standaloneNoiseLines.has(t) || standaloneNoiseLines.has(lower)) {
      return true;
    }
    if (/^(?:平台|platform)\s*(?:oq|othello\s*quest|othelloquest|playok|vint|xot)$/i.test(t)) {
      return true;
    }
    if (/^(?:状态|status)\s*(?:已签到|等待中|待签到)$/i.test(t)) {
      return true;
    }
    if (/^(?:组别|group)\s*(?:无差别组|青少年组|新人赛|新人组|特殊赛|长期名单|长期成员)$/i.test(t)) {
      return true;
    }
    return false;
  }

  function looksLikeGroupHeading(line) {
    const t = normalizeWhitespace(line);
    if (!t) return null;

    // Examples: "无差别组：" "新人赛：" "特殊赛：" "青少年组："
    // Also allow "xxx组" / "xxx赛" without colon.
    if (/^.{1,16}(组|赛)\s*[:：]?$/.test(t) && !/[a-z0-9_]/i.test(t)) {
      // Normalize: remove trailing colon
      return normalizeWhitespace(t.replace(/[:：]\s*$/, ""));
    }
    return null;
  }

  function detectGroupHeadingByRules(line, activeRules = null) {
    const t = normalizeWhitespace(line);
    if (!t) return null;

    // Simple headings are handled first.
    const simple = looksLikeGroupHeading(t);
    if (simple) {
      // Keep group naming consistent: map common aliases (e.g. “新人赛组” → “新人赛”) when
      // they match an existing rule keyword. If no rule matches, keep the original heading.
      const compactSimple = simple.toLowerCase().replace(/\s+/g, "");
      const rules = Array.isArray(activeRules)
        ? activeRules
        : getActiveGroupRules();
      for (const rule of rules) {
        const keywords = Array.isArray(rule.keywords) ? rule.keywords : [];
        for (const kw of keywords) {
          const needle = normalizeWhitespace(kw)
            .toLowerCase()
            .replace(/\s+/g, "");
          if (!needle) continue;
          if (
            compactSimple.includes(needle) ||
            needle.includes(compactSimple)
          ) {
            return normalizeWhitespace(rule.group) || simple;
          }
        }
      }
      return simple;
    }

    // Avoid turning numbered player rows into group headings.
    if (/^\s*(?:\d{1,3}|[０-９]{1,3})\s*[\.．、\)\]）］]/.test(t)) return null;

    // Heuristic context: title-like lines in relays.
    const headingLike =
      /[#【】\[\]「」《》]/.test(t) ||
      /接龙|接龍|报名|比賽|比赛|签到|点名|名单|组|赛/.test(t);
    if (!headingLike) return null;

    const compact = t.toLowerCase().replace(/\s+/g, "");
    const rules = Array.isArray(activeRules)
      ? activeRules
      : getActiveGroupRules();
    for (const rule of rules) {
      const keywords = Array.isArray(rule.keywords) ? rule.keywords : [];
      for (const kw of keywords) {
        const needle = normalizeWhitespace(kw)
          .toLowerCase()
          .replace(/\s+/g, "");
        if (!needle) continue;
        if (compact.includes(needle))
          return normalizeWhitespace(rule.group) || null;
      }
    }
    return null;
  }

  function looksLikeInstructionLine(rawLine) {
    const t = normalizeWhitespace(rawLine);
    if (!t) return true;
    if (isStandaloneUiOrPlatformNoiseLine(t)) return true;

    if (t.startsWith("#")) return true;
    if (/^如\s*[:：]/.test(t) || /^例如\s*[:：]/.test(t)) return true;
    if (/^(注|附)\s*[:：]/.test(t)) return true;
    // English "example" prefixes commonly used in some groups.
    if (/^(?:ex\.?|e\.g\.?|eg\.?|example)\s*/i.test(t)) return true;

    // Avoid over-filtering: some nicknames may contain punctuation.
    // Only treat as instruction when it looks like a full sentence.
    if (/[。！？；]/.test(t)) {
      const wordCount = t.split(/\s+/).filter(Boolean).length;
      if (t.length > 28 || wordCount > 6) return true;
    }

    const lower = t.toLowerCase();

    // Some users paste key-value style lines (common in Mainland CN chat apps):
    //   "昵称：张三 账号：abc 俱乐部：...")
    // These lines contain keywords like "昵称/账号/俱乐部" but are actually valid player records.
    // To avoid losing data, if it looks like a KV record (and not a format/example sentence),
    // try a quick parse and accept it when it yields a meaningful name + account/club.
    try {
      const kvHint = /(昵称|姓名|账号|俱乐部|平台|组别)\s*[:：]/.test(t);
      const maybeExample =
        /格式|示例|例如/.test(t) ||
        /^如\s*[:：]/.test(t) ||
        /^例如\s*[:：]/.test(t);
      const hasLink = /https?:\/\//i.test(t) || lower.includes("http");
      if (kvHint && !maybeExample && !hasLink) {
        const parsed = parseLineToFields(t, { group: "", platform: "oq" });
        if (parsed && parsed.displayName && (parsed.account || parsed.club)) {
          return false;
        }
      }
    } catch (_) {
      // ignore
    }

    for (const kw of instructionKeywords) {
      if (lower.includes(kw)) return true;
    }
    return false;
  }

  function isLongTermSectionStart(line) {
    const t = normalizeWhitespace(line);
    if (!t) return false;
    // Latest format example: "长期选手，长期俱乐部格式：" then "全部名单:" then lines...
    if (t.includes("长期选手") && t.includes("俱乐部") && t.includes("格式"))
      return true;
    // Common variants from manually edited relays.
    if (/^长期(?:人员)?名单\s*[:：]?$/.test(t)) return true;
    if (/^全部名单(?:[（(][^）)]*[）)])?\s*[:：]/.test(t)) return true;
    return false;
  }

  const NOT_PARTICIPATING_DASH_CHARS = "\\-‐‑‒–—―﹘﹣－−";
  const NOT_PARTICIPATING_LEADING_DASH_RE = new RegExp(
    `^(?:[${NOT_PARTICIPATING_DASH_CHARS}]\\s*){2,}`,
    "u",
  );
  const NOT_PARTICIPATING_TRAILING_DASH_RE = new RegExp(
    `\\s*(?:[${NOT_PARTICIPATING_DASH_CHARS}]\\s*){2,}\\s*[,，.。;；:：、]*\\s*$`,
    "u",
  );

  function stripNotParticipatingMark(line) {
    // Two or more dash-like marks indicate not participating this time.
    // Examples: "Wang Yiyu --", "Wang Yiyu ——", "Wang Yiyu －－".
    const t = normalizeWhitespace(line);
    if (!t) return { name: "", skip: true };

    const notJoinHint = /(不参加本次比赛|不参赛|不参加本场|弃赛)/;

    // Explanation lines like "--为不参加本次比赛" should not be treated as player names.
    if (NOT_PARTICIPATING_LEADING_DASH_RE.test(t) || notJoinHint.test(t)) {
      return { name: "", skip: true };
    }

    // If line ends with a dash marker, treat as not participating and skip.
    if (NOT_PARTICIPATING_TRAILING_DASH_RE.test(t)) {
      const name = normalizeWhitespace(
        t.replace(NOT_PARTICIPATING_TRAILING_DASH_RE, ""),
      );
      return { name, skip: true };
    }

    return { name: t, skip: false };
  }

  function cleanPlayerLine(rawLine) {
    let cleaned = normalizeWhitespace(rawLine);
    if (!cleaned) return "";

    cleaned = unwrapBrackets(cleaned);
    cleaned = stripListIndex(cleaned);

    // Common bullet prefixes
    cleaned = cleaned.replace(/^[>*•·\-–—\s]+/, "");
    cleaned = cleaned.replace(/^[.。．]\s*(?=[\u4e00-\u9fffA-Za-z])/, "");

    // Plus sign sometimes used as separator: "昵称+账号"
    cleaned = cleaned.replace(/\+/g, " ");

    // Normalize dash-like unicode chars to ASCII hyphen
    // so patterns like "name—account" can be parsed reliably.
    cleaned = cleaned.replace(/[‐‑‒–—―﹘﹣－]/g, "-");

    // Replace some separators
    cleaned = cleaned.replace(/[#:：]/g, " ");
    cleaned = cleaned.replace(/([\u4e00-\u9fff])[,，]\s*([A-Za-z0-9_])/g, "$1 $2");
    // Common column separators when copying from tables or chat messages
    cleaned = cleaned.replace(/[|｜丨]/g, " ");
    cleaned = cleaned.replace(/[\/／]/g, " ");
    cleaned = cleaned.replace(/↓|×/g, " ");

    cleaned = normalizeWhitespace(cleaned);

    // Remove common field labels (so lines like "昵称：张三 账号：abc 俱乐部：Zeb" can be parsed)
    try {
      const drop = new Set(["昵称", "姓名", "账号", "俱乐部", "平台", "组别"]);
      const tokens = cleaned
        .split(" ")
        .map((x) => normalizeWhitespace(x))
        .filter(Boolean)
        .filter((tok) => {
          if (drop.has(tok)) return false;
          const low = tok.toLowerCase();
          if (low === "id" || low === "club") return false;
          return true;
        });
      cleaned = normalizeWhitespace(tokens.join(" "));
    } catch (_) {
      // ignore
    }

    // Remove trailing punctuation
    cleaned = cleaned.replace(/[，,。.;；:：]+$/g, "");
    cleaned = normalizeWhitespace(cleaned);

    return cleaned;
  }

  function isDecorativeOnlyLine(line) {
    const t = normalizeWhitespace(line);
    if (!t) return true;
    return /^(?:[👇☝️👆⬇️⬆️↓↑↧↥]+|\/?\s*[👇☝️👆⬇️⬆️↓↑↧↥]+)$/u.test(t);
  }

  function isNonPlayerNoiseLine(line) {
    const t = normalizeWhitespace(line);
    if (!t) return true;
    if (isStandaloneUiOrPlatformNoiseLine(t)) return true;
    if (isDecorativeOnlyLine(t)) return true;
    if (/^[\[【]?(?:当前擂主|赛后抽奖|本次赞助|奖金追加)[\]】]?\s*[：:]/.test(t))
      return true;
    if (/接个龙先|避免找不到/.test(t)) return true;
    return false;
  }

  function looksLikeNumberedRelayLine(line) {
    return /^\s*(?:\d{1,3}|[０-９]{1,3})\s*[\.．、\)\]）］]/.test(
      String(line || ""),
    );
  }

  function splitCompositeJoinedNameCandidates(line, platform) {
    const t = normalizeWhitespace(line);
    if (!t) return [];
    if (!/[&＆]/.test(t)) return [];
    // Keep this conservative: only split when the whole line is a joined-name token.
    if (/\s/.test(t)) return [];

    const parts = t
      .split(/[&＆]/)
      .map((x) => normalizeWhitespace(x))
      .filter(Boolean);
    if (parts.length < 2 || parts.length > 3) return [];

    // Avoid splitting obvious handle/account styles.
    const plat = normalizeWhitespace(platform || "").toLowerCase();
    for (const part of parts) {
      if (!/^[A-Za-z\u4e00-\u9fff·•・'\-]{2,24}$/.test(part)) return [];
      if (/[0-9_]/.test(part)) return [];
      if (plat === "oq" && /^[A-Za-z]{1,2}$/.test(part)) return [];
    }

    const uniq = new Set(parts.map((x) => normalizeKey(x)));
    if (uniq.size < 2) return [];

    return parts;
  }

  function guessPlatformByGroup(group) {
    const g = normalizeWhitespace(group);
    if (!g) return "";
    const lower = g.toLowerCase();
    // Heuristic: 特殊赛 is typically vint in the provided format reference.
    if (g.includes("特殊") || lower.includes("vint") || lower.includes("xot"))
      return "vint";
    return "oq";
  }

  function tokenHasChinese(token) {
    return /[\u4e00-\u9fff]/.test(String(token || ""));
  }

  function tokenIsAsciiLike(token) {
    return /^[A-Za-z0-9_][A-Za-z0-9_\-]*$/.test(String(token || ""));
  }

  const NON_ACCOUNT_HINTS = [
    "人数不知",
    "人数未知",
    "待定",
    "暂定",
    "未知",
    "不参加",
    "弃赛",
    "报名",
    "接龙",
    "格式",
    "说明",
    "长期选手",
    "长期成员",
    "全部名单",
  ];

  function tokenLooksLikeRomanNameWord(token) {
    const t = String(token || "");
    if (/^[A-Z][a-z]{1,20}$/.test(t)) return true;
    if (/^[a-z]{2,20}$/.test(t)) return true;
    return false;
  }

  function looksLikeRomanizedFullNameTokens(tokens) {
    const list = Array.isArray(tokens) ? tokens : [];
    if (list.length < 2 || list.length > 4) return false;
    return list.every((t) => /^[A-Z][a-z]{1,20}$/.test(String(t || "")));
  }

  function isLongTermGroup(group) {
    const g = normalizeWhitespace(group);
    return !!g && g.includes("长期");
  }

  function tokenLooksLikeLooseRomanWord(token) {
    const t = String(token || "");
    return /^[A-Za-z]{2,24}$/.test(t);
  }

  // Common romanized Chinese surnames (single-token pinyin forms).
  // Used only for anomaly hints, to avoid over-flagging arbitrary English nicknames.
  const COMMON_PINYIN_SURNAMES = new Set([
    "an",
    "bai",
    "bao",
    "cai",
    "cao",
    "chang",
    "chen",
    "cheng",
    "chong",
    "chou",
    "chu",
    "cui",
    "dai",
    "deng",
    "di",
    "ding",
    "dong",
    "dou",
    "du",
    "duan",
    "fan",
    "fang",
    "fei",
    "feng",
    "fu",
    "gao",
    "gong",
    "gu",
    "guo",
    "han",
    "hao",
    "he",
    "hou",
    "hu",
    "hua",
    "huang",
    "ji",
    "jia",
    "jiang",
    "jin",
    "kang",
    "kong",
    "lai",
    "lan",
    "lang",
    "lei",
    "li",
    "lian",
    "liang",
    "liao",
    "lin",
    "liu",
    "long",
    "lou",
    "lu",
    "luo",
    "lv",
    "ma",
    "mao",
    "meng",
    "min",
    "mo",
    "mu",
    "ni",
    "ou",
    "pan",
    "pang",
    "pei",
    "peng",
    "qi",
    "qian",
    "qiao",
    "qin",
    "qiu",
    "qu",
    "ren",
    "shao",
    "shen",
    "shi",
    "song",
    "su",
    "sun",
    "tan",
    "tang",
    "tao",
    "tian",
    "wan",
    "wang",
    "wei",
    "wen",
    "wu",
    "xia",
    "xiao",
    "xie",
    "xin",
    "xing",
    "xiong",
    "xu",
    "xue",
    "yan",
    "yang",
    "yao",
    "ye",
    "yi",
    "yin",
    "ying",
    "you",
    "yu",
    "yuan",
    "zeng",
    "zha",
    "zhai",
    "zhan",
    "zhang",
    "zhao",
    "zhen",
    "zheng",
    "zhong",
    "zhou",
    "zhu",
    "zou",
    "zuo",
    // Common compound surnames
    "ouyang",
    "sima",
    "shangguan",
    "zhuge",
    "dongfang",
    "huangfu",
    "gongsun",
    "linghu",
    "situ",
    "sikong",
    "dugu",
    "nangong",
    "xiahou",
    "zhangsun",
    "murong",
    "gongyang",
    "wuma",
    "helian",
    "huyan",
    "yuchi",
  ]);

  function looksLikeRomanizedSurnameOnly(name) {
    const t = normalizeWhitespace(name || "");
    if (!t || t.includes(" ")) return false;
    if (!/^[A-Za-z]{2,12}$/.test(t)) return false;
    return COMMON_PINYIN_SURNAMES.has(t.toLowerCase());
  }

  function tokenLooksLikeLikelyPinyinWord(token) {
    const t = String(token || "").toLowerCase();
    if (!/^[a-z]{2,8}$/.test(t)) return false;
    // Include "v" for copied pinyin like "lv".
    if (!/[aeiouv]/.test(t)) return false;
    // Words ending with "...ry/...ly" are usually not pinyin syllables.
    if (/[^aeiouv]y$/.test(t) && !/(ay|ey|oy)$/.test(t)) return false;
    // Most pinyin syllables end with vowel / n / ng / r / v.
    // This keeps "Wang Xiao Ming" as name, while reducing false matches
    // for account-like words such as "Head".
    if (!/(?:ng|[aeiouvnr])$/.test(t)) return false;
    return true;
  }

  function looksLikeLikelyLowerPinyinTwoWordName(tokens) {
    const list = Array.isArray(tokens) ? tokens : [];
    if (list.length !== 2) return false;
    const a = String(list[0] || "");
    const b = String(list[1] || "");
    if (!/^[a-z]{2,8}$/.test(a) || !/^[a-z]{2,8}$/.test(b)) return false;
    if (a.length > 6 || b.length > 8) return false;
    return (
      tokenLooksLikeLikelyPinyinWord(a) && tokenLooksLikeLikelyPinyinWord(b)
    );
  }

  function looksLikeLikelyLowerPinyinThreeWordName(tokens) {
    const list = Array.isArray(tokens) ? tokens : [];
    if (list.length !== 3) return false;
    const a = String(list[0] || "");
    const b = String(list[1] || "");
    const c = String(list[2] || "");
    if (
      !/^[a-z]{2,8}$/.test(a) ||
      !/^[a-z]{2,8}$/.test(b) ||
      !/^[a-z]{2,8}$/.test(c)
    )
      return false;
    if (a.length > 6 || b.length > 6 || c.length > 8) return false;
    return (
      tokenLooksLikeLikelyPinyinWord(a) &&
      tokenLooksLikeLikelyPinyinWord(b) &&
      tokenLooksLikeLikelyPinyinWord(c)
    );
  }

  function looksLikeLooseRomanTwoWordName(tokens) {
    const list = Array.isArray(tokens) ? tokens : [];
    if (list.length !== 2) return false;
    return list.every(
      (t) => tokenLooksLikeLooseRomanWord(t) && !/[_0-9]/.test(String(t || "")),
    );
  }

  function looksLikeRomanizedThreeWordNameTokens(tokens) {
    const list = Array.isArray(tokens) ? tokens : [];
    if (list.length !== 3) return false;
    return list.every((t) => /^[A-Z][a-z]{1,20}$/.test(String(t || "")));
  }

  function looksLikeLooseRomanThreeWordName(tokens) {
    const list = Array.isArray(tokens) ? tokens : [];
    if (list.length !== 3) return false;
    return list.every(
      (t) => tokenLooksLikeLooseRomanWord(t) && !/[_0-9]/.test(String(t || "")),
    );
  }

  function tokenLooksLikeShortChineseNameWord(token) {
    return /^[\u4e00-\u9fff]{2,4}$/.test(String(token || ""));
  }

  function tokenLooksLikeAccount(token, platform) {
    const t = String(token || "");
    const trimmed = normalizeWhitespace(t);
    if (!trimmed) return 0;

    for (const hint of NON_ACCOUNT_HINTS) {
      if (trimmed.includes(hint)) return 0;
    }
    if (/^(?:none|null|n\/a|na|待定|未知|暂无|无)$/i.test(trimmed)) return 0;

    // Numeric-only (e.g. vint id)
    if (/^\d{3,12}$/.test(trimmed)) return 4;

    // Special case: some pasted data contains an account split into 2 short tokens,
    // and we intentionally merge them into one token (e.g. "Liao yi").
    // For OQ this is uncommon but can happen via copy/paste; treat it as a weak
    // account signal to avoid mis-parsing it as a club.
    if (trimmed.includes(" ")) {
      const parts = trimmed.split(" ").filter(Boolean);
      // Keep it conservative: only accept 2 parts and both must be ascii-like-ish.
      if (
        parts.length === 2 &&
        parts.every((p) => tokenIsAsciiLike(p) || /^\d{3,10}$/.test(p))
      ) {
        const joined = parts.join("");
        let score = 1;
        if (/[0-9]/.test(joined)) score += 2;
        if (/_/.test(joined)) score += 1;
        if (joined.length >= 4) score += 1;
        if (joined.length > 28) score -= 2;
        return Math.max(1, score);
      }
    }

    // Ascii-like handle
    if (tokenIsAsciiLike(trimmed)) {
      let score = 2;
      const hasStrongChars = /[0-9_]/.test(trimmed);
      if (/[0-9]/.test(trimmed)) score += 2;
      if (/_/.test(trimmed)) score += 1;
      if (trimmed.length >= 4) score += 1;
      if (platform === "oq" && !hasStrongChars) {
        if (/^[A-Z][a-z]{1,20}$/.test(trimmed)) score -= 2;
        else if (tokenLooksLikeRomanNameWord(trimmed)) score -= 1;
      }
      if (!hasStrongChars && trimmed.length <= 2) score -= 1;
      if (trimmed.length > 24) score -= 2;
      return score;
    }

    // For vint: allow Chinese / spaces as账号（部分平台昵称允许中文）
    if (platform === "vint") {
      // Avoid treating obvious instruction text as账号
      if (tokenLooksLikeShortChineseNameWord(trimmed)) return 0;
      if (trimmed.length >= 2 && trimmed.length <= 32) return 1;
    }

    return 0;
  }

  function tokensLookLikeClub(tokens) {
    const list = Array.isArray(tokens) ? tokens : [];
    if (list.length === 0) return 0;

    const joined = list.join(" ");
    const compact = joined.replace(/\s+/g, "").toLowerCase();
    if (
      [
        "redskin",
        "redskn",
        "htn",
        "zeb",
        "poqi",
        "poq",
        "断藤斋",
      ].includes(compact)
    )
      return 3;

    const hasCn = tokenHasChinese(joined);
    if (hasCn) return 3;

    // Short uppercase abbreviation like "HTN"
    if (list.length === 1 && /^[A-Z]{2,6}$/.test(list[0])) return 2;

    // Otherwise weak signal
    return 0;
  }

  function tokensLookLikeName(tokens) {
    const list = Array.isArray(tokens) ? tokens : [];
    if (list.length === 0) return 0;

    const joined = list.join(" ");
    // Pure Chinese name or mixed
    if (tokenHasChinese(joined)) return 4;

    // Typical romanized name: Capitalized words
    let score = 0;
    for (const t of list) {
      if (/^[A-Z][a-z]{1,20}$/.test(t)) score += 2;
      else if (/^[A-Za-z]{2,20}$/.test(t)) score += 1;
      else if (tokenIsAsciiLike(t) && /[_0-9]/.test(t))
        score -= 2; // looks more like an id/handle
      else score += 0;
    }
    return score;
  }

  function splitChineseAndAccountIfPossible(oneToken) {
    const t = String(oneToken || "");
    // Chinese + account glued together: "王光轩wgxzwl"
    const m = t.match(
      /^([\u4e00-\u9fff]{1,10})([A-Za-z0-9_][A-Za-z0-9_\-]{2,})$/,
    );
    if (m) {
      return { displayName: m[1], account: m[2] };
    }
    return null;
  }

  function splitChineseAccountClubIfPossible(oneToken) {
    const t = String(oneToken || "");
    const m = t.match(
      /^([\u4e00-\u9fff]{1,10})([A-Za-z0-9_][A-Za-z0-9_\-]{2,})([\u4e00-\u9fff].*)$/,
    );
    if (!m) return null;
    return {
      displayName: normalizeWhitespace(m[1]),
      account: normalizeWhitespace(m[2]),
      club: normalizeWhitespace(m[3]),
    };
  }

  function splitSymbolNameAndAccountIfPossible(oneToken, platform) {
    const t = normalizeWhitespace(oneToken);
    if (!t || /\s/.test(t)) return null;
    const m = t.match(/^([^A-Za-z0-9_]{1,12})([A-Za-z0-9_][A-Za-z0-9_\-]{2,})$/u);
    if (!m) return null;
    const displayName = normalizeWhitespace(m[1]);
    const account = normalizeWhitespace(m[2]);
    if (!displayName || tokenHasChinese(displayName)) return null;
    if (tokenLooksLikeAccount(account, platform) < 2) return null;
    return { displayName, account };
  }

  function isNewcomerGroup(group) {
    const g = normalizeWhitespace(group);
    return g.includes("新人");
  }

  function isKnownNonParticipantRecord(fields, group) {
    if (!fields || !isNewcomerGroup(group)) return false;
    const name = normalizeWhitespace(fields.displayName);
    const account = normalizeWhitespace(fields.account);
    return name === "深红" && /^Eklos$/i.test(account);
  }

  function splitRomanNameAndAccountIfPossible(oneToken, platform) {
    // Common pasted pattern without spaces:
    // "zhangyujieT0Thuiyi" -> "zhangyujie" + "T0Thuiyi"
    // Keep strict to avoid over-splitting normal single-token nicknames.
    if (platform !== "oq") return null;

    const t = normalizeWhitespace(oneToken);
    if (!t) return null;
    if (!/^[A-Za-z0-9_]{7,36}$/.test(t)) return null;

    const m = t.match(/^([a-z]{4,18})([A-Z0-9][A-Za-z0-9_]{2,20})$/);
    if (!m) return null;

    const left = m[1];
    const right = m[2];

    const upperCount = (right.match(/[A-Z]/g) || []).length;
    const titleCaseRight = /^[A-Z][a-z]{4,20}$/.test(right);
    const leftLooksPinyinish =
      tokenLooksLikeLikelyPinyinWord(left) && /(?:zh|ch|sh|x|q|j)/.test(left);
    const strongHint =
      /[0-9_]/.test(right) ||
      upperCount >= 2 ||
      (titleCaseRight && leftLooksPinyinish);
    if (!strongHint) return null;
    const minAccScore =
      titleCaseRight &&
      leftLooksPinyinish &&
      !(/[0-9_]/.test(right) || upperCount >= 2)
        ? 1
        : 2;
    if (tokenLooksLikeAccount(right, platform) < minAccScore) return null;

    return { displayName: left, account: right };
  }

  function splitDashAccountInLastToken(tokens) {
    // Try: "... bofeng-rola" => name "... bofeng" + account "rola"
    if (!Array.isArray(tokens) || tokens.length === 0) return null;

    const last = tokens[tokens.length - 1];
    if (!last || typeof last !== "string") return null;
    if (!last.includes("-")) return null;

    // Only split on the last '-' (some handles might contain multiple)
    const idx = last.lastIndexOf("-");
    if (idx <= 0 || idx >= last.length - 1) return null;

    const left = last.slice(0, idx);
    const right = last.slice(idx + 1);

    // Heuristic: right looks like account (ascii-like)
    if (!tokenIsAsciiLike(right) && !/^\d{3,10}$/.test(right)) return null;

    // left should look like name part (letters only, no digits)
    if (/[0-9_]/.test(left)) return null;

    const nameTokens = tokens.slice(0, -1).concat([left]).filter(Boolean);
    const account = right;

    return { nameTokens, account };
  }

  function parseLineToFields(rawLine, { group, platform } = {}) {
    const cleaned = cleanPlayerLine(rawLine);
    if (!cleaned) return null;

    const g = normalizeWhitespace(group) || "未分组";
    const plat = normalizeWhitespace(platform) || guessPlatformByGroup(g) || "";

    // Tokenize
    let tokens = cleaned.split(/\s+/).filter(Boolean);

    if (isDecorativeOnlyLine(cleaned)) return null;

    if (
      isNewcomerGroup(g) &&
      plat === "oq" &&
      tokens.length === 2 &&
      tokenHasChinese(tokens[0]) &&
      (tokenHasChinese(tokens[1]) || /^\d{1,3}岁$/.test(tokens[1]))
    ) {
      return {
        displayName: tokens[0],
        account: tokens[1],
        club: "",
      };
    }

    if (
      plat === "oq" &&
      tokens.length === 3 &&
      /^[A-Z]{2,20}$/.test(tokens[0]) &&
      /^[A-Z]{2,20}$/.test(tokens[1]) &&
      tokenLooksLikeAccount(tokens[2], plat) >= 2
    ) {
      return {
        displayName: `${tokens[0]} ${tokens[1]}`,
        account: tokens[2],
        club: "",
      };
    }

    // OQ: duplicated token like "Liaoyi Liaoyi" usually means "昵称 + 账号" rather than a full name.
    if (plat === "oq" && tokens.length === 2) {
      const aKey = normalizeKey(tokens[0]);
      const bKey = normalizeKey(tokens[1]);
      if (aKey && bKey && aKey === bKey) {
        return {
          displayName: tokens[0],
          account: tokens[1],
          club: "",
        };
      }
    }

    // OQ: sometimes "中文名+数字" and账号尾巴被空格拆开 (e.g. "馒头926 wjp").
    if (plat === "oq" && tokens.length === 2) {
      const m = String(tokens[0] || "").match(
        /^([\u4e00-\u9fff]{1,10})(\d{2,6})$/,
      );
      const tail = String(tokens[1] || "");
      if (m && /^[a-z0-9_]{2,12}$/.test(tail) && /[a-z]/.test(tail)) {
        const mergedAcc = `${m[2]}${tail}`;
        const mergedScore = tokenLooksLikeAccount(mergedAcc, plat);
        const sepScore = tokenLooksLikeAccount(tail, plat);
        if (mergedScore >= 2 && mergedScore > sepScore) {
          return {
            displayName: m[1],
            account: mergedAcc,
            club: "",
          };
        }
      }
    }

    if (plat === "oq" && tokens.length === 2) {
      const m = String(tokens[0] || "").match(
        /^([\u4e00-\u9fff]{1,10})(\d{7,12})$/,
      );
      const tail = String(tokens[1] || "");
      if (m && tokenIsAsciiLike(tail)) {
        return {
          displayName: m[1],
          account: m[2],
          club: tail,
        };
      }
    }

    // Chinese name + glued account + optional club tail.
    // Example: "馒头926wjp Zeb" => 名称: 馒头, 账号: 926wjp, 俱乐部: Zeb
    if (tokens.length >= 2) {
      const firstCnSplit = splitChineseAndAccountIfPossible(tokens[0]);
      if (firstCnSplit && /[A-Za-z_]/.test(firstCnSplit.account)) {
        const splitAccScore = tokenLooksLikeAccount(firstCnSplit.account, plat);
        const nextTokenScore = tokenLooksLikeAccount(tokens[1], plat);
        if (splitAccScore >= 2 && splitAccScore >= nextTokenScore) {
          return {
            displayName: firstCnSplit.displayName,
            account: firstCnSplit.account,
            club: normalizeWhitespace(tokens.slice(1).join(" ")),
          };
        }
      }
    }

    // OQ + two romanized words is more likely a full name than "昵称 + 账号".
    // Example: "Lin Feng" / "Li Si" in 长期名单.
    if (
      plat === "oq" &&
      tokens.length === 2 &&
      looksLikeRomanizedFullNameTokens(tokens)
    ) {
      return {
        displayName: tokens.join(" "),
        account: "",
        club: "",
      };
    }

    // OQ + short pinyin-like two-word names are commonly surname+given-name,
    // and should not be aggressively split into name+account.
    if (
      plat === "oq" &&
      tokens.length === 2 &&
      looksLikeLooseRomanTwoWordName(tokens) &&
      String(tokens[0]).length <= 4 &&
      String(tokens[1]).length <= 6 &&
      tokenLooksLikeLikelyPinyinWord(tokens[0]) &&
      tokenLooksLikeLikelyPinyinWord(tokens[1])
    ) {
      return {
        displayName: tokens.join(" "),
        account: "",
        club: "",
      };
    }

    // OQ + two lowercase pinyin-like words (slightly longer) are still often姓名。
    // Example: "zhang qiang"
    if (plat === "oq" && looksLikeLikelyLowerPinyinTwoWordName(tokens)) {
      return {
        displayName: tokens.join(" "),
        account: "",
        club: "",
      };
    }

    // OQ + three strict title-cased words may be a full romanized name.
    // Keep this conservative: only when all three words also look pinyin-like.
    // Example: "Wang De Hua" should not become "Wang De" + account "Hua".
    if (
      plat === "oq" &&
      tokens.length === 3 &&
      looksLikeRomanizedThreeWordNameTokens(tokens) &&
      tokens.every(tokenLooksLikeLikelyPinyinWord)
    ) {
      return {
        displayName: tokens.join(" "),
        account: "",
        club: "",
      };
    }

    // OQ + three lowercase pinyin-like words are also commonly full names.
    // Example: "wang de hua"
    if (plat === "oq" && looksLikeLikelyLowerPinyinThreeWordName(tokens)) {
      return {
        displayName: tokens.join(" "),
        account: "",
        club: "",
      };
    }

    // Long-term lists often contain plain two-word romanized names (lower/upper mixed).
    // Be conservative here to avoid turning personal names into OQ accounts.
    if (
      plat === "oq" &&
      isLongTermGroup(g) &&
      looksLikeLooseRomanTwoWordName(tokens)
    ) {
      return {
        displayName: tokens.join(" "),
        account: "",
        club: "",
      };
    }

    // Long-term lists may also contain three-part romanized names.
    if (
      plat === "oq" &&
      isLongTermGroup(g) &&
      looksLikeLooseRomanThreeWordName(tokens)
    ) {
      return {
        displayName: tokens.join(" "),
        account: "",
        club: "",
      };
    }

    // vint 分组中若仅两段中文，常见是“姓名被空格切开”，不强行识别第二段为账号。
    if (
      plat === "vint" &&
      tokens.length === 2 &&
      tokenHasChinese(tokens[0]) &&
      tokenHasChinese(tokens[1]) &&
      tokenLooksLikeShortChineseNameWord(tokens[1])
    ) {
      return {
        displayName: tokens.join(" "),
        account: "",
        club: "",
      };
    }

    // vint 中常见“中文昵称 + 两段英文账号（含空格）”，避免误识别第二段为俱乐部。
    if (
      plat === "vint" &&
      tokens.length === 3 &&
      tokenHasChinese(tokens[0]) &&
      tokenLooksLikeLooseRomanWord(tokens[1]) &&
      tokenLooksLikeLooseRomanWord(tokens[2]) &&
      !/[_0-9]/.test(`${tokens[1]}${tokens[2]}`)
    ) {
      return {
        displayName: tokens[0],
        account: `${tokens[1]} ${tokens[2]}`,
        club: "",
      };
    }

    // Copy/paste variants may append a club token: "中文昵称 + 两段英文账号 + 俱乐部"
    // (Common when users copy a formatted line from chat/exported tables.)
    if (
      (plat === "vint" || plat === "oq") &&
      tokens.length === 4 &&
      tokenHasChinese(tokens[0]) &&
      tokenLooksLikeLooseRomanWord(tokens[1]) &&
      tokenLooksLikeLooseRomanWord(tokens[2]) &&
      !/[_0-9]/.test(`${tokens[1]}${tokens[2]}`) &&
      (tokenHasChinese(tokens[3]) || String(tokens[3] || "").includes("俱乐部"))
    ) {
      return {
        displayName: tokens[0],
        account: `${tokens[1]} ${tokens[2]}`,
        club: tokens[3],
      };
    }

    // Special case: single token like "张三abc123"
    if (tokens.length === 1) {
      const one = tokens[0];

      const cnAccountClub = splitChineseAccountClubIfPossible(one);
      if (cnAccountClub) {
        return cnAccountClub;
      }

      const symbolSplit = splitSymbolNameAndAccountIfPossible(one, plat);
      if (symbolSplit) {
        return {
          displayName: symbolSplit.displayName,
          account: symbolSplit.account,
          club: "",
        };
      }

      const cnSplit = splitChineseAndAccountIfPossible(one);
      if (cnSplit) {
        return {
          displayName: cnSplit.displayName,
          account: cnSplit.account,
          club: "",
        };
      }

      const romanSplit = splitRomanNameAndAccountIfPossible(one, plat);
      if (romanSplit) {
        return {
          displayName: romanSplit.displayName,
          account: romanSplit.account,
          club: "",
        };
      }

      // Single token with separator: "name-account" / "name+account" (plus already handled)
      const dashIdx = one.lastIndexOf("-");
      if (dashIdx > 0 && dashIdx < one.length - 1) {
        const left = one.slice(0, dashIdx);
        const right = one.slice(dashIdx + 1);
        if (tokenLooksLikeAccount(right, plat) >= 2) {
          return {
            displayName: left,
            account: right,
            club: "",
          };
        }
      }

      // Otherwise treat as name only
      return {
        displayName: one,
        account: "",
        club: "",
      };
    }

    // Special case: last token very short (like "yi") and previous is ascii => combine last two as account
    if (tokens.length >= 3) {
      const t1 = tokens[tokens.length - 1];
      const t2 = tokens[tokens.length - 2];
      if (
        String(t1).length <= 2 &&
        tokenIsAsciiLike(t2) &&
        tokenIsAsciiLike(t1)
      ) {
        // Combine as a single account token candidate (e.g. "Liao yi")
        tokens = tokens.slice(0, -2).concat([`${t2} ${t1}`]);
      }
    }

    // Attempt to split dash in last token (bofeng-rola)
    const dashSplit = splitDashAccountInLastToken(tokens);
    if (dashSplit && dashSplit.nameTokens && dashSplit.nameTokens.length >= 1) {
      // Replace tokens with nameTokens + [account]
      tokens = dashSplit.nameTokens.concat([dashSplit.account]);
    }

    // Choose best split index (i = account token position)
    let best = null;

    for (let i = 1; i <= tokens.length - 1; i++) {
      const nameTokens = tokens.slice(0, i);
      const accountToken = tokens[i];
      const clubTokens = tokens.slice(i + 1);

      const nameScore = tokensLookLikeName(nameTokens);
      const accScore = tokenLooksLikeAccount(accountToken, plat);
      const clubScore = tokensLookLikeClub(clubTokens);

      // Penalize if account token obviously looks like club abbreviation AND club tokens absent
      let penalty = 0;
      if (
        clubTokens.length === 0 &&
        /^[A-Z]{2,6}$/.test(String(accountToken || ""))
      )
        penalty += 2;

      const score = nameScore * 2 + accScore * 3 + clubScore * 2 - penalty;

      if (!best || score > best.score) {
        best = { i, score, nameTokens, accountToken, clubTokens, accScore };
      }
    }

    // If no reasonable account candidate found, treat as name only
    if (!best || best.accScore <= 0) {
      return {
        displayName: tokens.join(" "),
        account: "",
        club: "",
      };
    }

    // If platform is oq and account token contains Chinese, be conservative (likely a 2-part real name)
    if (
      plat === "oq" &&
      tokenHasChinese(best.accountToken) &&
      best.accScore <= 1
    ) {
      return {
        displayName: tokens.join(" "),
        account: "",
        club: "",
      };
    }

    const displayName = normalizeWhitespace(best.nameTokens.join(" "));
    const account = normalizeWhitespace(best.accountToken);
    const club = normalizeWhitespace(best.clubTokens.join(" "));

    return { displayName, account, club };
  }

  function makePlayer(
    fields,
    { isNew = false, group = "未分组", platform = "", id = null } = {},
  ) {
    const safeFields = fields || {};
    const idNum = Number(id);
    const safeId =
      Number.isFinite(idNum) && idNum > 0
        ? Math.trunc(idNum)
        : state.nextPlayerId++;
    return {
      id: safeId,
      displayName: normalizeWhitespace(safeFields.displayName || ""),
      account: normalizeWhitespace(safeFields.account || ""),
      club: normalizeWhitespace(safeFields.club || ""),
      platform: normalizeWhitespace(platform || safeFields.platform || ""),
      group: normalizeWhitespace(group || safeFields.group || "") || "未分组",
      checkedIn: false,
      checkedInAt: null,
      isNew: Boolean(isNew),
    };
  }

  function mergePlayers(existing, incoming) {
    // Merge "incoming" into "existing" with preference for richer fields.
    if (!existing || !incoming) return existing || incoming;

    // Prefer "more specific" group over fallback buckets like 未分组/长期成员/长期名单
    const lowPriorityGroups = new Set(["未分组", "长期成员", "长期名单"]);
    const eg = normalizeWhitespace(existing.group) || "未分组";
    const ig = normalizeWhitespace(incoming.group) || "";
    if (ig) {
      const egLow = lowPriorityGroups.has(eg);
      const igLow = lowPriorityGroups.has(ig);
      if ((!eg || egLow) && !igLow) {
        existing.group = ig;
      }
    }

    // Prefer non-empty platform
    if (!existing.platform && incoming.platform)
      existing.platform = incoming.platform;

    // Prefer having account
    if (!existing.account && incoming.account)
      existing.account = incoming.account;

    // Prefer having club
    if (!existing.club && incoming.club) existing.club = incoming.club;

    // Prefer longer/more informative displayName (avoid losing spaces)
    if (
      incoming.displayName &&
      incoming.displayName.length > existing.displayName.length
    ) {
      existing.displayName = incoming.displayName;
    }

    // checkedIn state: keep checked if either says checked; keep earliest time if both exist
    if (incoming.checkedIn && !existing.checkedIn) {
      existing.checkedIn = true;
      existing.checkedInAt =
        incoming.checkedInAt || existing.checkedInAt || now();
    } else if (incoming.checkedIn && existing.checkedIn) {
      const a = Number(existing.checkedInAt) || 0;
      const b = Number(incoming.checkedInAt) || 0;
      if (a === 0 && b > 0) existing.checkedInAt = b;
      else if (a > 0 && b > 0) existing.checkedInAt = Math.min(a, b);
    }

    existing.isNew = Boolean(existing.isNew || incoming.isNew);

    return existing;
  }

  function dedupeAndSortPlayers(list) {
    const players = Array.isArray(list) ? list : [];

    const byAcc = new Map(); // accKey -> player
    const byName = new Map(); // nameKey -> player
    const byAccName = new Map(); // accKey|nameKey -> player (dedupe repeats even under account conflicts)
    const conflictExtras = []; // keep conflicting records as separate players for suspect checks

    const put = (p) => {
      if (!p) return;

      const dn = normalizeWhitespace(p.displayName);
      if (!dn) return;

      const nameKey = normalizeKey(dn);
      const plat = normalizeWhitespace(p.platform || "");
      const acc = normalizeWhitespace(p.account || "");
      const accKey = acc ? `acc:${plat}|${normalizeKey(acc)}` : "";
      const accNameKey = accKey ? `${accKey}|${nameKey}` : "";

      // Merge priority:
      // 1) Same accKey => merge
      // 2) Same nameKey => merge (handles clubText -> relayText upgrade)
      // 3) Otherwise insert
      if (accNameKey && byAccName.has(accNameKey)) {
        mergePlayers(byAccName.get(accNameKey), p);
        return;
      }

      if (accKey && byAcc.has(accKey)) {
        const existingByAcc = byAcc.get(accKey);
        const existingByAccNameKey = normalizeKey(
          normalizeWhitespace(existingByAcc && existingByAcc.displayName),
        );
        const hasAccountConflictByName = Boolean(
          existingByAccNameKey && existingByAccNameKey !== nameKey,
        );
        if (hasAccountConflictByName) {
          const newP = p;
          conflictExtras.push(newP);
          // Map to latest conflicting record so exact repeats can still merge.
          byAcc.set(accKey, newP);
          if (accNameKey) byAccName.set(accNameKey, newP);
          return;
        }

        mergePlayers(existingByAcc, p);
        if (accNameKey) byAccName.set(accNameKey, existingByAcc);
        return;
      }

      if (byName.has(nameKey)) {
        const existing = byName.get(nameKey);
        const existingPlat = normalizeWhitespace(existing.platform || "");
        const existingAcc = normalizeWhitespace(existing.account || "");
        const existingAccKey = existingAcc
          ? `acc:${existingPlat}|${normalizeKey(existingAcc)}`
          : "";
        const hasNameConflictByAccount = Boolean(
          accKey && existingAccKey && accKey !== existingAccKey,
        );

        // Keep same-name but conflicting-account records as separate players,
        // so duplicate/suspect checks can surface this conflict to users.
        if (hasNameConflictByAccount) {
          const newP = p;
          conflictExtras.push(newP);
          if (accKey) byAcc.set(accKey, newP);
          if (accNameKey) byAccName.set(accNameKey, newP);
          return;
        }

        mergePlayers(existing, p);
        if (accKey) byAcc.set(accKey, existing);
        if (accNameKey) byAccName.set(accNameKey, existing);
        return;
      }

      // Insert new
      const newP = p;
      byName.set(nameKey, newP);
      if (accKey) byAcc.set(accKey, newP);
      if (accNameKey) byAccName.set(accNameKey, newP);
    };

    for (const p of players) put(p);

    const outRaw = Array.from(byName.values()).concat(conflictExtras);
    const out = [];
    const exactMap = new Map();

    // Final exact-pass dedupe keeps this function idempotent.
    // It also prevents preview/final-count drift when conflicting records
    // appear repeatedly in pasted source text.
    for (const p of outRaw) {
      const dn = normalizeWhitespace(p && p.displayName);
      if (!dn) continue;

      const key = [
        normalizeKey(dn),
        normalizeKey(p && p.platform),
        normalizeKey(p && p.account),
        normalizeKey(p && p.group) || "未分组",
      ].join("|");

      if (exactMap.has(key)) {
        mergePlayers(exactMap.get(key), p);
        continue;
      }

      exactMap.set(key, p);
      out.push(p);
    }

    out.sort(comparePlayersForList);
    return out;
  }

  function parseImportTextsDetailed(clubText, relayText) {
    const clubLines = String(clubText || "").split("\n");
    const relayLines = String(relayText || "").split("\n");
    const activeGroupRules = getActiveGroupRules();

    const allLines = clubLines.concat(relayLines);

    const report = {
      totalLines: allLines.length,
      kept: 0,
      ignored: 0,
      ignoredItems: [], // full list, per plan
      ignoredReasons: new Map(),
    };

    const collected = [];
    let tempId = 1;
    const makeTempPlayer = (fields, opts = {}) =>
      makePlayer(fields, { ...opts, id: tempId++ });

    function addIgnored(reason, rawLine, meta = {}) {
      report.ignored++;
      report.ignoredReasons.set(
        reason,
        (report.ignoredReasons.get(reason) || 0) + 1,
      );
      report.ignoredItems.push({
        line: normalizeWhitespace(rawLine),
        reason,
        source: meta.source || "",
        groupHint: normalizeWhitespace(meta.groupHint || "") || "",
      });
    }

    // 1) clubText: treat as "长期成员"
    const clubGroup = "长期成员";
    const clubPlatform = "oq";

    for (const raw of clubLines) {
      const t = normalizeWhitespace(raw);
      if (!t) continue;

      // club list is supposed to be a plain list; still ignore obvious instruction/title/group lines
      if (
        looksLikeInstructionLine(t) ||
        looksLikeGroupHeading(t) ||
        detectGroupHeadingByRules(t, activeGroupRules) ||
        isLongTermSectionStart(t)
      ) {
        addIgnored("俱乐部区：说明/标题行", raw, {
          source: "club",
          groupHint: clubGroup,
        });
        continue;
      }

      const mark = stripNotParticipatingMark(t);
      if (mark.skip) {
        addIgnored("俱乐部区：标记不参赛/说明行", raw, {
          source: "club",
          groupHint: clubGroup,
        });
        continue;
      }

      const fields = parseLineToFields(mark.name, {
        group: clubGroup,
        platform: clubPlatform,
      });
      if (!fields || !fields.displayName) {
        addIgnored("俱乐部区：无法解析", raw, {
          source: "club",
          groupHint: clubGroup,
        });
        continue;
      }

      collected.push(
        makeTempPlayer(fields, {
          isNew: false,
          group: clubGroup,
          platform: clubPlatform,
        }),
      );
      report.kept++;
    }

    // 2) relayText: support group headings + long-term section
    let currentGroup = "未分组";
    let inLongTerm = false;
    let currentPlatformHint = "";

    for (let i = 0; i < relayLines.length; i++) {
      const raw = String(relayLines[i] ?? "");
      const t = normalizeWhitespace(raw);
      if (!t) continue;

      const heading = detectGroupHeadingByRules(t, activeGroupRules);
      if (heading) {
        currentGroup = heading;
        inLongTerm = false;
        currentPlatformHint = guessPlatformByGroup(currentGroup) || "";
        addIgnored("段落标题/组别标题", raw, {
          source: "relay",
          groupHint: currentGroup,
        });
        continue;
      }

      if (isLongTermSectionStart(t)) {
        inLongTerm = true;
        currentGroup = "长期名单";
        currentPlatformHint = "oq";
        addIgnored("段落标题/说明", raw, {
          source: "relay",
          groupHint: currentGroup,
        });
        continue;
      }

      // Long-term list ends when we meet an obvious new group heading or another section marker.
      if (
        inLongTerm &&
        (detectGroupHeadingByRules(t, activeGroupRules) || t.startsWith("#"))
      ) {
        inLongTerm = false;
      }

      // Detect platform hints from surrounding instruction lines (vint / playok / pl账号).
      const lowerT = t.toLowerCase();
      if (
        lowerT.includes("playok") ||
        lowerT.includes("pl账号") ||
        lowerT.includes("pl 账号")
      ) {
        currentPlatformHint = "pl";
      } else if (lowerT.includes("vint") || lowerT.includes("xot")) {
        currentPlatformHint = "vint";
      }

      const groupHint = currentGroup || (inLongTerm ? "长期名单" : "未分组");
      const platform = currentPlatformHint || guessPlatformByGroup(groupHint);

      if (isNonPlayerNoiseLine(t)) {
        addIgnored("说明/公告行", raw, { source: "relay", groupHint });
        continue;
      }

      // Handle lines that explicitly mark "not participating"
      const nonJoin = stripNotParticipatingMark(t);
      if (nonJoin.skip) {
        addIgnored(
          inLongTerm ? "长期名单：标记不参赛/说明行" : "标记不参赛/说明行",
          raw,
          { source: "relay", groupHint },
        );
        continue;
      }

      const line = nonJoin.name;

      // Ignore obvious instruction lines
      if (isNonPlayerNoiseLine(line) || looksLikeInstructionLine(line)) {
        addIgnored("说明/公告行", raw, { source: "relay", groupHint });
        continue;
      }

      // Joined names like "zhanganping&zhangxiaoguo" -> split into multiple players.
      const splitCandidates = splitCompositeJoinedNameCandidates(
        cleanPlayerLine(line),
        platform,
      );
      if (splitCandidates.length > 1) {
        let added = 0;
        for (const candidate of splitCandidates) {
          const fields = parseLineToFields(candidate, {
            group: groupHint,
            platform,
          });
          if (!fields || !fields.displayName) continue;
          collected.push(
            makeTempPlayer(fields, {
              isNew: false,
              group: groupHint,
              platform,
            }),
          );
          report.kept++;
          added++;
        }
        if (added > 0) continue;
      }

      const fields = parseLineToFields(line, { group: groupHint, platform });
      if (!fields || !fields.displayName) {
        addIgnored(inLongTerm ? "长期名单：无法解析" : "无法解析", raw, {
          source: "relay",
          groupHint,
        });
        continue;
      }

      if (!fields.account && !fields.club && looksLikeNumberedRelayLine(raw)) {
        const nextRaw =
          i + 1 < relayLines.length ? String(relayLines[i + 1] ?? "") : "";
        const nextLine = normalizeWhitespace(nextRaw);
        const nextClean = cleanPlayerLine(nextLine);
        if (
          nextLine &&
          !looksLikeNumberedRelayLine(nextRaw) &&
          !detectGroupHeadingByRules(nextLine, activeGroupRules) &&
          !isLongTermSectionStart(nextLine) &&
          !isNonPlayerNoiseLine(nextLine) &&
          !looksLikeInstructionLine(nextLine) &&
          nextClean &&
          !/\s/.test(nextClean) &&
          tokenLooksLikeAccount(nextClean, platform) >= 3
        ) {
          fields.account = nextClean;
          i++;
        }
      }

      if (isKnownNonParticipantRecord(fields, groupHint)) {
        addIgnored("裁判/不参赛记录", raw, { source: "relay", groupHint });
        continue;
      }

      collected.push(
        makeTempPlayer(fields, { isNew: false, group: groupHint, platform }),
      );
      report.kept++;
    }

    // Deduplicate & sort
    const merged = dedupeAndSortPlayers(collected);

    return { players: merged, report };
  }

  function buildImportReportText(result) {
    const players =
      result && Array.isArray(result.players) ? result.players : [];
    const report =
      result && result.report
        ? result.report
        : { kept: 0, ignored: 0, ignoredItems: [], ignoredReasons: new Map() };

    const groupMap = new Map();
    for (const p of players) {
      const g = normalizeWhitespace(p.group) || "未分组";
      groupMap.set(g, (groupMap.get(g) || 0) + 1);
    }

    const lines = [];
    lines.push(`解析到选手：${players.length} 人`);
    if (groupMap.size) {
      const groupSummary = Array.from(groupMap.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([g, c]) => `${g}:${c}`)
        .join("  ");
      lines.push(`组别分布：${groupSummary}`);
    }
    lines.push(`忽略行数：${report.ignored} 行`);

    if (report.ignoredReasons && report.ignoredReasons.size) {
      lines.push("");
      lines.push("忽略原因统计：");
      const entries = Array.from(report.ignoredReasons.entries()).sort(
        (a, b) => b[1] - a[1],
      );
      for (const [k, v] of entries) {
        lines.push(`- ${k}: ${v}`);
      }
    }

    // IMPORTANT: print full ignored samples (no 10-line limit)
    if (report.ignoredItems && report.ignoredItems.length) {
      lines.push("");
      lines.push(
        `被忽略的行（共 ${report.ignoredItems.length} 行，已完整列出）：`,
      );
      for (const it of report.ignoredItems) {
        const tag = it.groupHint ? `【${it.groupHint}】` : "";
        const reason = it.reason ? `（${it.reason}）` : "";
        lines.push(`- ${tag}${it.line}${reason}`);
      }
    }

    return lines.join("\n");
  }

  // ------------------------------
  // Import correction preview (Plan #2)
  // ------------------------------

  function buildImportPreviewNode(parseResult) {
    const players = parseResult.players || [];
    const report = parseResult.report || {
      ignoredItems: [],
      ignoredReasons: new Map(),
    };

    const container = document.createElement("div");
    container.className = "import-preview";

    // Summary
    const groupMap = new Map();
    for (const p of players) {
      const g = normalizeWhitespace(p.group) || "未分组";
      groupMap.set(g, (groupMap.get(g) || 0) + 1);
    }

    const summary = document.createElement("div");
    summary.className = "import-summary";
    summary.innerHTML = `
      <div class="import-summary__title">解析到选手：${players.length} 人</div>
      <div class="import-summary__sub">忽略行数：${report.ignored || 0} 行</div>
    `;
    container.appendChild(summary);

    if (groupMap.size) {
      const groupLine = document.createElement("div");
      groupLine.className = "import-groups";

      const entries = Array.from(groupMap.entries()).sort(
        (a, b) => b[1] - a[1],
      );
      groupLine.textContent =
        "组别：" + entries.map(([g, c]) => `${g}(${c})`).join("  ");
      container.appendChild(groupLine);
    }

    // Ignored list (full)
    const ignored = Array.isArray(report.ignoredItems)
      ? report.ignoredItems
      : [];

    const details = document.createElement("details");
    details.className = "import-ignored";
    details.open = false;

    const sum = document.createElement("summary");
    sum.className = "import-ignored__summary";

    const sumLeft = document.createElement("div");
    sumLeft.className = "import-ignored__summary-left";

    const sumTitle = document.createElement("div");
    sumTitle.className = "import-ignored__title";
    sumTitle.textContent = `被忽略的行（${ignored.length} 行）`;

    const sumHint = document.createElement("div");
    sumHint.className = "import-ignored__hint";
    sumHint.textContent = "展开后可勾选“强制加入”";

    sumLeft.appendChild(sumTitle);
    sumLeft.appendChild(sumHint);

    // Chevron icon
    const chev = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    chev.setAttribute("aria-hidden", "true");
    chev.classList.add("ms-icon", "import-ignored__chev");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "#i-expand-more");
    use.setAttribute("xlink:href", "#i-expand-more");
    chev.appendChild(use);

    sum.appendChild(sumLeft);
    sum.appendChild(chev);

    details.appendChild(sum);

    const ignoredWrap = document.createElement("div");
    ignoredWrap.className = "import-ignored__panel";

    if (ignored.length === 0) {
      const empty = document.createElement("div");
      empty.className = "import-empty";
      empty.textContent = "没有被忽略的行。";
      ignoredWrap.appendChild(empty);
    } else {
      ignored.forEach((it, idx) => {
        const row = document.createElement("label");
        row.className = "ignored-row";

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.dataset.ignoredIndex = String(idx);

        const reasonText = String(it.reason || "");
        if (reasonText.includes("标题")) {
          cb.disabled = true;
          cb.title = "标题行不建议强制加入";
          row.classList.add("ignored-row--disabled");
        }

        const box = document.createElement("span");
        box.className = "ignored-row__box";
        box.setAttribute("aria-hidden", "true");

        const text = document.createElement("div");
        text.className = "ignored-row__text";

        const line = escapeHtml(it.line || "");
        const reason = escapeHtml(it.reason || "");
        const groupHint = escapeHtml(it.groupHint || "未分组");

        const groupChip = groupHint
          ? `<span class="chip-small import-group">${groupHint}</span>`
          : "";

        text.innerHTML = `
          <div class="ignored-row__main">${groupChip}<span class="ignored-row__line">${line}</span></div>
          <div class="ignored-row__reason">${reason ? "原因：" + reason : ""}</div>
        `;

        row.appendChild(cb);
        row.appendChild(box);
        row.appendChild(text);

        ignoredWrap.appendChild(row);
      });
    }

    details.appendChild(ignoredWrap);
    container.appendChild(details);

    // Manual add
    const manual = document.createElement("div");
    manual.className = "import-manual";

    const manualTitle = document.createElement("div");
    manualTitle.className = "import-manual__title";
    manualTitle.textContent = "手动补充（每行一人，可写：昵称 账号 俱乐部）";
    manual.appendChild(manualTitle);

    const manualGroupRow = document.createElement("div");
    manualGroupRow.className = "import-manual__row";

    const groupLabel = document.createElement("span");
    groupLabel.className = "import-manual__label";
    groupLabel.textContent = "补充归入组别：";

    const sel = document.createElement("select");
    sel.className = "input import-manual__select";
    sel.id = "import-manual-group";

    const groups = Array.from(
      new Set(players.map((p) => normalizeWhitespace(p.group) || "未分组")),
    );
    const options = [
      "未分组",
      ...groups.filter((g) => g && g !== "未分组"),
    ].slice(0, 50);

    for (const g of options) {
      const opt = document.createElement("option");
      opt.value = g;
      opt.textContent = g;
      sel.appendChild(opt);
    }

    manualGroupRow.appendChild(groupLabel);
    manualGroupRow.appendChild(sel);
    manual.appendChild(manualGroupRow);

    const ta = document.createElement("textarea");
    ta.id = "import-manual-text";
    ta.className = "textarea import-manual__textarea";
    ta.placeholder = "例如：\n夜洛 Nightspoke 神秘猫猫教\n王光轩 wgxzwl";
    manual.appendChild(ta);

    container.appendChild(manual);

    return container;
  }

  function applyImportWithCorrections(parseResult, previewRoot) {
    const basePlayers = Array.isArray(parseResult.players)
      ? parseResult.players.slice()
      : [];
    const report = parseResult.report || {};
    const ignored = Array.isArray(report.ignoredItems)
      ? report.ignoredItems
      : [];

    const chosen = [];
    let tempId =
      basePlayers.reduce((m, p) => Math.max(m, Number((p && p.id) || 0)), 0) +
      1;
    const makeTempPlayer = (fields, opts = {}) =>
      makePlayer(fields, { ...opts, id: tempId++ });

    // Forced include ignored lines
    if (previewRoot) {
      const checkboxes = previewRoot.querySelectorAll(
        'input[type="checkbox"][data-ignored-index]',
      );
      checkboxes.forEach((cb) => {
        if (!cb.checked) return;
        const idx = Number(cb.dataset.ignoredIndex);
        if (!Number.isFinite(idx) || idx < 0 || idx >= ignored.length) return;

        const it = ignored[idx];
        const groupHint = normalizeWhitespace(it.groupHint) || "未分组";
        const platform = guessPlatformByGroup(groupHint);
        const fields = parseLineToFields(it.line, {
          group: groupHint,
          platform,
        });
        if (fields && fields.displayName) {
          chosen.push(
            makeTempPlayer(fields, {
              group: groupHint,
              platform,
              isNew: false,
            }),
          );
        }
      });
    }

    // Manual additions
    if (previewRoot) {
      const ta = previewRoot.querySelector("#import-manual-text");
      const sel = previewRoot.querySelector("#import-manual-group");
      const manualText = ta && typeof ta.value === "string" ? ta.value : "";
      const manualGroup =
        sel && typeof sel.value === "string" ? sel.value : "未分组";
      const groupHint = normalizeWhitespace(manualGroup) || "未分组";
      const platform = guessPlatformByGroup(groupHint);

      const lines = String(manualText || "").split("\n");
      for (const raw of lines) {
        const t = normalizeWhitespace(raw);
        if (!t) continue;
        const fields = parseLineToFields(t, { group: groupHint, platform });
        if (fields && fields.displayName) {
          chosen.push(
            makeTempPlayer(fields, { group: groupHint, platform, isNew: true }),
          );
        }
      }
    }

    // Keep preview/final consistency when user doesn't apply any correction.
    // parseResult.players is already deduped/sorted.
    const merged =
      chosen.length === 0
        ? basePlayers.slice().sort(comparePlayersForList)
        : dedupeAndSortPlayers(basePlayers.concat(chosen));

    if (merged.length === 0) {
      showAlert(
        "导入失败",
        "导入后仍未得到任何有效选手，请检查输入或勾选/补充。",
      );
      return null;
    }

    return merged;
  }

  // ------------------------------
  // UI: dialogs + snackbar
  // ------------------------------
  const dialogBackdrop = $("#dialog-backdrop");
  const dialogTitle = $("#dialog-title");
  const dialogMessage = $("#dialog-message");
  const dialogButtons = $("#dialog-buttons");

  function closeDialog() {
    if (dialogBackdrop) dialogBackdrop.classList.add("hidden");
  }

  function showDialog({ title, message, contentNode, buttons }) {
    if (!dialogBackdrop || !dialogTitle || !dialogMessage || !dialogButtons) {
      const fallback = [
        title || "提示",
        typeof message === "string" ? message : "",
      ]
        .filter(Boolean)
        .join("\n");
      if (typeof window.alert === "function") {
        window.alert(fallback || "提示");
      } else {
        console.warn("对话框节点缺失：", fallback);
      }
      return;
    }

    dialogTitle.textContent = title || "提示";
    dialogMessage.innerHTML = "";
    dialogMessage.style.whiteSpace = "pre-line";

    if (contentNode && isNode(contentNode)) {
      dialogMessage.style.whiteSpace = "normal";
      dialogMessage.appendChild(contentNode);
    } else {
      dialogMessage.textContent = typeof message === "string" ? message : "";
    }

    dialogButtons.innerHTML = "";

    // When there are many buttons, allow wrapping on small screens.
    const btnCount = Array.isArray(buttons) ? buttons.length : 0;
    if (dialogButtons.classList) {
      dialogButtons.classList.toggle("dialog__footer--wrap", btnCount > 2);
    }

    (buttons || []).forEach((btn) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = btn.className || "btn btn-filled";
      b.textContent = btn.label || "确定";
      b.addEventListener("click", () => {
        let shouldClose = true;
        try {
          if (typeof btn.onClick === "function") {
            const r = btn.onClick();
            // If the handler explicitly returns false, keep the dialog open (useful for form validation).
            if (r === false) shouldClose = false;
          }
        } catch (e) {
          console.error("对话框按钮回调异常：", e);
        } finally {
          if (shouldClose) closeDialog();
        }
      });
      dialogButtons.appendChild(b);
    });

    dialogBackdrop.classList.remove("hidden");
  }

  function showAlert(title, message) {
    showDialog({
      title,
      message,
      buttons: [{ label: "好的", className: "btn btn-filled" }],
    });
  }

  function showConfirm(title, message, onConfirm, confirmLabel = "确认") {
    showDialog({
      title,
      message,
      buttons: [
        { label: "取消", className: "btn btn-outlined" },
        {
          label: confirmLabel,
          className: "btn btn-filled",
          onClick: () => {
            if (typeof onConfirm === "function") onConfirm();
          },
        },
      ],
    });
  }

  const snackbar = $("#snackbar");
  const snackbarText = $("#snackbar .snackbar__text");
  const snackbarAction = $("#snackbar-action");

  let snackbarTimer = null;
  let snackbarActionHandler = null;

  function hideSnackbar() {
    if (!snackbar) return;
    snackbar.classList.remove("show");
    if (snackbarTimer) window.clearTimeout(snackbarTimer);
    snackbarTimer = null;

    if (snackbarAction) {
      snackbarAction.hidden = true;
      snackbarAction.textContent = "";
    }
    snackbarActionHandler = null;
  }

  function showSnackbar(
    text,
    duration = 2500,
    actionLabel = "",
    actionHandler = null,
  ) {
    if (!snackbar) return;
    if (snackbarText) snackbarText.textContent = text;
    else snackbar.textContent = text;

    if (snackbarTimer) window.clearTimeout(snackbarTimer);
    snackbarTimer = null;

    if (snackbarAction) {
      if (actionLabel && typeof actionHandler === "function") {
        snackbarAction.hidden = false;
        snackbarAction.textContent = actionLabel;
        snackbarActionHandler = actionHandler;
      } else {
        snackbarAction.hidden = true;
        snackbarAction.textContent = "";
        snackbarActionHandler = null;
      }
    }

    snackbar.classList.add("show");

    // duration=0 => persistent until user action / next snackbar / close
    const d = Number(duration);
    if (Number.isFinite(d) && d > 0) {
      snackbarTimer = window.setTimeout(() => {
        hideSnackbar();
      }, d);
    }
  }

  function showUndoSnackbar(text, onUndo, duration = UNDO_SNACKBAR_DURATION) {
    showSnackbar(text, duration, "撤销", () => {
      if (typeof onUndo === "function") onUndo();
    });
  }

  // ------------------------------
  // UI: step switching + elements
  // ------------------------------
  const stepImport = $("#step-import");
  const stepCheckin = $("#step-checkin");
  const stepScoreHelper = $("#step-score-helper");

  const clubMembersEl = $("#club-members");
  const relayInfoEl = $("#relay-info");
  const groupRulesEl = $("#group-rules");
  const btnAddGroupRule = $("#btn-add-group-rule");
  const btnResetGroupRules = $("#btn-reset-group-rules");

  const btnImport = $("#btn-import");
  const btnResume = $("#btn-resume");

  const btnBack = $("#btn-back");
  const btnBatch = $("#btn-batch");
  const btnFinish = $("#btn-finish");
  const btnExportQuick = $("#btn-export-quick");
  const scoreHelperTitle = $("#score-helper-title");
  const scoreRoundCountInput = $("#score-round-count");
  const btnScoreApplyRounds = $("#btn-score-apply-rounds");
  const btnScoreBackCheckin = $("#btn-score-back-checkin");
  const scoreRoundTabs = $("#score-round-tabs");
  const scoreHelperSummary = $("#score-helper-summary");
  const scorePendingList = $("#score-pending-list");
  const scoreManualPendingList = $("#score-manual-pending-list");
  const scoreCompletedList = $("#score-completed-list");

  const competitionTitleEl = $("#competition-title");
  const competitionNameInput = $("#competition-name-input");

  const groupFilterEl = $("#group-filter");
  const btnCallMode = $("#btn-call-mode");
  const btnShowTime = $("#btn-show-time");
  const btnSuspects = $("#btn-suspects");

  const searchBox = $("#search-box");
  const btnClearSearch = $("#btn-clear-search");
  const playerList = $("#player-list");
  const iosPlayerListAnchor = $("#ios-player-list-anchor");

  const totalCountEl = $("#total-count");
  const checkedInCountEl = $("#checked-in-count");
  const notCheckedInCountEl = $("#not-checked-in-count");
  const statFilteredContainer = $("#stat-filtered-container");
  const statFilteredEl = $("#stat-filtered");

  const addPlayerNameInput = $("#add-player-name");
  const btnAdd = $("#btn-add");
  const importEmptyState = $("#import-empty-state");
  const autosaveTimeEl = $("#autosave-time");

  const btnReset = $("#btn-reset");
  const btnHelp = $("#btn-help");
  const btnInstall = $("#btn-install");
  const panelInstallBtn = $("#panel-install-btn");

  const btnExportJson = $("#btn-export-json");
  const btnImportJsonPaste = $("#btn-import-json-paste");
  const importJsonInput = $("#import-json-input");

  // Export modal
  const exportBackdrop = $("#export-backdrop");
  const exportContainer = $("#export-container");
  const exportInappTip = $("#export-inapp-tip");
  const btnExportClose = $("#btn-export-close");
  const btnDownloadPng = $("#btn-download-png");
  const btnDownloadCsv = $("#btn-download-csv");
  const btnCopy = $("#btn-copy");
  const exportGroupSel = $("#export-group");
  const exportScopeSel = $("#export-scope");
  const exportOrderSel = $("#export-order");
  const exportWithGroupEl = $("#export-with-group");
  const exportWithPlatformEl = $("#export-with-platform");
  const exportWithAccountEl = $("#export-with-account");
  const exportWithClubEl = $("#export-with-club");
  const exportWithTimeEl = $("#export-with-time");

  function shouldUseIOSTouchCheckinLayout() {
    try {
      const touchPoints =
        window.navigator && Number(window.navigator.maxTouchPoints);
      const hasTouch = touchPoints > 0 || "ontouchstart" in window;
      if (!hasTouch) return false;

      const ua = getUA();
      if (isIOS() || /Android/i.test(ua)) return true;
      if (navigator.virtualKeyboard) return true;

      const coarse =
        window.matchMedia &&
        window.matchMedia("(pointer: coarse) and (hover: none)").matches;
      return Boolean(coarse);
    } catch (_) {
      return false;
    }
  }

  function shouldUseTabletCheckinLayout() {
    try {
      const ua = getUA();
      const touchPoints =
        window.navigator && Number(window.navigator.maxTouchPoints);
      const iPadOS =
        window.navigator.platform === "MacIntel" && touchPoints > 1;
      if (/iPad/i.test(ua) || iPadOS) return true;
      if (!/Android/i.test(ua)) return false;

      const minSide = Math.min(
        Number(window.screen && window.screen.width) || window.innerWidth || 0,
        Number(window.screen && window.screen.height) || window.innerHeight || 0,
      );
      return (
        minSide >= 600 ||
        (touchPoints > 1 &&
          Math.min(window.innerWidth || 0, window.innerHeight || 0) >= 600)
      );
    } catch (_) {
      return false;
    }
  }

  function setupIOSTouchCheckinLayout() {
    const root = document.documentElement;
    const body = document.body;
    const enabled = shouldUseIOSTouchCheckinLayout();
    const tabletEnabled = enabled && shouldUseTabletCheckinLayout();
    if (root && root.classList) {
      root.classList.toggle("ios-touch-checkin", enabled);
      root.classList.toggle("screen-keyboard-checkin", enabled);
      root.classList.toggle("ios-tablet-checkin", tabletEnabled);
      root.classList.toggle("tablet-checkin", tabletEnabled);
    }

    if (!enabled || !playerList || !iosPlayerListAnchor) return;
    iosPlayerListAnchor.appendChild(playerList);

    const isKeyboardLikelyOpen = () => {
      const vv = window.visualViewport;
      const layoutHeight = Number(window.innerHeight) || 0;
      const visualHeight = vv && Number(vv.height) > 0 ? Number(vv.height) : 0;
      return Boolean(
        visualHeight &&
          layoutHeight &&
          visualHeight < Math.max(320, layoutHeight * 0.86),
      );
    };

    const updateVisualViewportVars = () => {
      if (!root || !root.style) return;
      const vv = window.visualViewport;
      const height =
        vv && Number(vv.height) > 0 ? Number(vv.height) : window.innerHeight;
      const offsetTop =
        vv && Number.isFinite(Number(vv.offsetTop))
          ? Number(vv.offsetTop)
          : 0;
      root.style.setProperty(
        "--ios-checkin-visual-height",
        `${Math.max(320, Math.round(height || 0))}px`,
      );
      root.style.setProperty(
        "--ios-checkin-visual-offset-top",
        `${Math.max(0, Math.round(offsetTop))}px`,
      );
    };

    const setEditing = (value) => {
      updateVisualViewportVars();
      if (body && body.classList) {
        body.classList.toggle("ios-checkin-editing", Boolean(value));
      }
      if (
        value &&
        root &&
        root.classList.contains("screen-keyboard-checkin")
      ) {
        window.requestAnimationFrame(() => {
          if (playerList) playerList.scrollTop = 0;
        });
      }
    };

    updateVisualViewportVars();
    window.addEventListener("resize", updateVisualViewportVars, {
      passive: true,
    });
    if (window.visualViewport) {
      window.visualViewport.addEventListener(
        "resize",
        updateVisualViewportVars,
        { passive: true },
      );
      window.visualViewport.addEventListener(
        "scroll",
        updateVisualViewportVars,
        { passive: true },
      );
    }

    document.addEventListener("focusin", (e) => {
      const target = isElement(e.target) ? e.target : null;
      if (!target || !stepCheckin || stepCheckin.classList.contains("hidden")) {
        return;
      }
      if (!target.closest("#step-checkin")) return;
      const tag = String(target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") {
        setEditing(true);
      }
    });
    document.addEventListener("focusout", () => {
      window.setTimeout(() => {
        const active = isElement(document.activeElement)
          ? document.activeElement
          : null;
        if (active && active.closest("#step-checkin")) return;
        if (
          root &&
          root.classList.contains("screen-keyboard-checkin") &&
          isKeyboardLikelyOpen()
        ) {
          setEditing(true);
          return;
        }
        setEditing(false);
      }, 80);
    });
  }

  function getCurrentStep() {
    const s = String(viewStepOverride || "").trim();
    if (s === "import" || s === "checkin" || s === "score-helper") return s;
    return state.step || "import";
  }

  function showExportModal(options = {}) {
    if (!exportBackdrop) {
      showAlert("操作失败", "导出弹窗未正确加载，请刷新页面后重试。");
      return;
    }

    // Mainland China in-app browsers (WeChat/QQ/Weibo) often block downloads.
    const inApp = isLikelyInAppBrowser();
    const inAppName = getInAppBrowserName();
    if (exportInappTip) {
      exportInappTip.classList.toggle("hidden", !inApp);
      const sub = exportInappTip.querySelector(".export-inapp-tip__sub");
      if (sub && isElement(sub)) {
        sub.textContent = inApp
          ? `当前环境：${inAppName}内置浏览器。若“下载 CSV/PNG”失败，建议优先使用“复制文本”，或右上角菜单选择“在浏览器打开”。`
          : "若在微信/QQ/微博等内置浏览器中“下载 CSV/PNG”失败，建议使用“复制文本”，或右上角菜单选择“在浏览器打开”。";
      }
    }
    if (btnCopy) {
      btnCopy.classList.toggle("btn-tonal", inApp);
      btnCopy.classList.toggle("btn-outlined", !inApp);
      btnCopy.title = inApp ? "内置浏览器中推荐优先使用复制文本" : "复制文本";
    }
    if (btnDownloadPng) {
      btnDownloadPng.title = isIOS()
        ? "iPhone/iPad 会打开图片预览页，请长按图片保存到相册；快捷键：⌘/Ctrl + Shift + S"
        : "下载 PNG；快捷键：⌘/Ctrl + Shift + S";
    }
    if (inApp && safeLocalStorageGet(INAPP_EXPORT_TIP_KEY) !== "1") {
      showSnackbar(
        "当前是内置浏览器，建议优先使用“复制文本”导出。",
        3200,
        "不再提示",
        () => {
          safeLocalStorageSet(INAPP_EXPORT_TIP_KEY, "1");
        },
      );
    }

    exportBackdrop.classList.remove("hidden");
    if (options && options.focusPng && btnDownloadPng) {
      window.setTimeout(() => {
        try {
          btnDownloadPng.focus({ preventScroll: true });
        } catch (_) {
          try {
            btnDownloadPng.focus();
          } catch (e) {
            // ignore
          }
        }
      }, 0);
    }
  }

  function closeExportModal() {
    if (!exportBackdrop) return;
    exportBackdrop.classList.add("hidden");
  }

  function applyStepUI() {
    const step = getCurrentStep();
    if (step === "checkin") {
      stepImport && stepImport.classList.add("hidden");
      stepCheckin && stepCheckin.classList.remove("hidden");
      stepScoreHelper && stepScoreHelper.classList.add("hidden");
    } else if (step === "score-helper") {
      stepImport && stepImport.classList.add("hidden");
      stepCheckin && stepCheckin.classList.add("hidden");
      stepScoreHelper && stepScoreHelper.classList.remove("hidden");
    } else {
      stepCheckin && stepCheckin.classList.add("hidden");
      stepScoreHelper && stepScoreHelper.classList.add("hidden");
      stepImport && stepImport.classList.remove("hidden");
    }
  }

  function getAllGroupsFromPlayers() {
    const set = new Set();
    for (const p of state.players) {
      const g = normalizeWhitespace(p.group) || "未分组";
      set.add(g);
    }
    return Array.from(set).sort((a, b) => nameCollator.compare(a, b));
  }

  function ensureValidSelectedGroup() {
    if (!state.ui)
      state.ui = { group: "all", callMode: false, showTime: false };
    if (!state.ui.group) state.ui.group = "all";

    if (state.ui.group === "all") return;

    const exists = state.players.some((p) => p.group === state.ui.group);
    if (!exists) state.ui.group = "all";
  }

  function createRuleId() {
    return `rule-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 7)}`;
  }

  function readGroupRulesFromEditor() {
    if (!groupRulesEl) return sanitizeGroupRules(state.groupRules);

    const nodes = Array.from(groupRulesEl.querySelectorAll(".group-rule"));
    const rules = [];

    nodes.forEach((node) => {
      const id = normalizeWhitespace(node.getAttribute("data-rule-id"));
      if (!id) return;

      const groupInput = node.querySelector('input[data-role="group"]');
      const keywordsInput = node.querySelector(
        'textarea[data-role="keywords"]',
      );
      const enabledInput = node.querySelector('input[data-role="enabled"]');

      const group = normalizeWhitespace(groupInput && groupInput.value);
      const keywords = normalizeGroupRuleKeywords(
        keywordsInput && keywordsInput.value,
      );
      const enabled = !(enabledInput && enabledInput.checked === false);

      rules.push({ id, group, keywords, enabled });
    });

    return sanitizeGroupRules(rules);
  }

  function renderGroupRulesEditor() {
    if (!groupRulesEl) return;

    state.groupRules = sanitizeGroupRules(state.groupRules);
    const rules = state.groupRules;
    groupRulesEl.innerHTML = "";

    for (const rule of rules) {
      const item = document.createElement("div");
      item.className = "group-rule";
      item.setAttribute("data-rule-id", rule.id);

      const title = escapeHtml(rule.group || "");
      const keywordsText = escapeHtml((rule.keywords || []).join(", "));

      item.innerHTML = `
        <div class="group-rule__top">
          <label class="switch">
            <input type="checkbox" data-role="enabled" ${rule.enabled ? "checked" : ""} />
            <span>启用</span>
          </label>
          <button class="btn btn-text" type="button" data-role="delete" aria-label="删除组别规则">删除</button>
        </div>
        <div class="group-rule__row">
          <div class="field">
            <label>组别名称</label>
            <input type="text" data-role="group" value="${title}" placeholder="例如：无差别组" />
          </div>
          <div class="field">
            <label>关键词（逗号/换行分隔）</label>
            <textarea rows="2" data-role="keywords" placeholder="例如：无差别组, open">${keywordsText}</textarea>
          </div>
        </div>
      `;

      groupRulesEl.appendChild(item);
    }
  }

  function renderGroupFilter() {
    if (!groupFilterEl) return;

    ensureValidSelectedGroup();

    const groups = getAllGroupsFromPlayers();
    const counts = new Map();
    for (const p of state.players) {
      const g = normalizeWhitespace(p.group) || "未分组";
      counts.set(g, (counts.get(g) || 0) + 1);
    }

    // Build buttons
    groupFilterEl.innerHTML = "";

    const addBtn = (label, value, count) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "seg-btn";
      b.dataset.group = value;
      const selected = state.ui.group === value;
      b.setAttribute("aria-selected", selected ? "true" : "false");
      b.setAttribute("role", "tab");
      // Roving tabindex: improves keyboard navigation/accessibility.
      b.tabIndex = selected ? 0 : -1;
      b.textContent = typeof count === "number" ? `${label}(${count})` : label;
      groupFilterEl.appendChild(b);
    };

    addBtn("全部", "all", state.players.length);

    for (const g of groups) {
      addBtn(g, g, counts.get(g) || 0);
    }
  }

  function applyModeClasses() {
    const body =
      document && document.body && document.body.classList
        ? document.body
        : null;
    if (body)
      body.classList.toggle(
        "mode-call",
        Boolean(state.ui && state.ui.callMode),
      );

    if (btnCallMode) {
      const on = Boolean(state.ui && state.ui.callMode);
      btnCallMode.setAttribute("aria-pressed", on ? "true" : "false");
      btnCallMode.textContent = on ? "点名模式：开" : "点名模式";
    }

    if (btnShowTime) {
      const on = Boolean(state.ui && state.ui.showTime);
      btnShowTime.setAttribute("aria-pressed", on ? "true" : "false");
      btnShowTime.textContent = on ? "显示时间：开" : "显示时间";
    }

    updateProgressBar();
  }

  function updateProgressBar() {
    const progressBar = document.getElementById("progress-bar");
    if (!progressBar) return;
    const currentStep = getCurrentStep();
    const fill = progressBar.querySelector(".progress-bar__fill");
    const labels = progressBar.querySelectorAll(".progress-bar__label");
    const onImport = currentStep === "import";
    if (fill) fill.style.width = onImport ? "50%" : "100%";
    progressBar.setAttribute("aria-valuenow", onImport ? "1" : "2");

    if (labels && labels.length >= 2) {
      labels[0].classList.toggle("progress-bar__label--active", onImport);
      labels[1].classList.toggle("progress-bar__label--active", !onImport);
    }
  }

  function updateClearSearchButton() {
    if (!btnClearSearch || !searchBox) return;
    btnClearSearch.hidden = !normalizeWhitespace(searchBox.value || "");
  }

  function updateImportEmptyState() {
    if (!importEmptyState) return;
    const hasText = Boolean(
      normalizeWhitespace((clubMembersEl && clubMembersEl.value) || "") ||
        normalizeWhitespace((relayInfoEl && relayInfoEl.value) || ""),
    );
    importEmptyState.hidden = hasText;
  }

  function updateAutosaveChip(ts) {
    if (!autosaveTimeEl) return;
    const text = formatShortTime(ts || (state && state.savedAt));
    if (!text) {
      autosaveTimeEl.hidden = true;
      return;
    }
    autosaveTimeEl.textContent = text;
    autosaveTimeEl.hidden = false;
  }

  function renderEmptyPlayerState() {
    const empty = document.createElement("div");
    empty.className = "empty-state empty-state--list";

    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.classList.add("empty-state__icon");
    icon.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "#i-search");
    icon.appendChild(use);

    const textWrap = document.createElement("div");
    const title = document.createElement("div");
    title.className = "empty-state__title";
    const text = document.createElement("div");
    text.className = "empty-state__text";

    const hasSearch =
      searchBox && Boolean(normalizeWhitespace(searchBox.value || ""));
    if (hasSearch || (state.ui && state.ui.callMode)) {
      title.textContent = "没有匹配的选手";
      text.textContent = hasSearch
        ? "可清除搜索词，或切换组别和点名模式后再查看。"
        : "当前范围内没有等待签到的选手。";
    } else {
      title.textContent = "暂无选手";
      text.textContent = "返回上一步导入名单，或在上方输入框临时添加选手。";
    }

    textWrap.appendChild(title);
    textWrap.appendChild(text);
    empty.appendChild(icon);
    empty.appendChild(textWrap);
    return empty;
  }

  function getStatsScopePlayers() {
    // Stats are based on selected group, NOT affected by callMode/search.
    let list = Array.isArray(state.players) ? state.players : [];
    if (state.ui && state.ui.group && state.ui.group !== "all") {
      list = list.filter((p) => p.group === state.ui.group);
    }
    return list;
  }

  function updateStats(visiblePlayers) {
    const list = getStatsScopePlayers();
    const total = list.length;
    const checkedIn = list.filter((p) => p.checkedIn).length;

    if (totalCountEl) totalCountEl.textContent = String(total);
    if (checkedInCountEl) checkedInCountEl.textContent = String(checkedIn);
    if (notCheckedInCountEl)
      notCheckedInCountEl.textContent = String(total - checkedIn);

    // 显示筛选计数
    const searchTerm =
      searchBox && searchBox.value ? normalizeWhitespace(searchBox.value) : "";
    const isFiltered = Boolean(
      (state.ui && state.ui.callMode) ||
        (state.ui && state.ui.group !== "all") ||
        searchTerm,
    );

    if (visiblePlayers && isFiltered && visiblePlayers.length !== total) {
      if (statFilteredContainer) statFilteredContainer.hidden = false;
      if (statFilteredEl) statFilteredEl.textContent = String(visiblePlayers.length);
    } else {
      if (statFilteredContainer) statFilteredContainer.hidden = true;
    }
  }

  function getVisiblePlayers() {
    let list = getStatsScopePlayers();

    // call mode => only unchecked players
    if (state.ui && state.ui.callMode) {
      list = list.filter((p) => !p.checkedIn);
    }

    // search filter (displayName + account + club)
    const term = normalizeWhitespace(
      searchBox && typeof searchBox.value === "string" ? searchBox.value : "",
    ).toLowerCase();
    if (term) {
      list = list.filter((p) => {
        const hay = [p.displayName, p.account, p.club, p.group, p.platform]
          .map((x) => normalizeWhitespace(x).toLowerCase())
          .join(" ");
        return hay.includes(term);
      });
    }

    return list;
  }

  function renderPlayerList(visiblePlayers) {
    if (!playerList) return;

    const prevScrollTop = playerList.scrollTop;
    const visible = visiblePlayers || getVisiblePlayers();
    const shouldPinFirstPlayerToBottom =
      document.documentElement &&
      document.documentElement.classList &&
      document.documentElement.classList.contains("screen-keyboard-checkin") &&
      document.body &&
      document.body.classList &&
      document.body.classList.contains("ios-checkin-editing");

    playerList.innerHTML = "";

    if (visible.length === 0) {
      playerList.appendChild(renderEmptyPlayerState());
      return;
    }

    visible.forEach((player, index) => {
      const row = document.createElement("div");
      row.className = `player-item ${player.checkedIn ? "player-item--checked" : "player-item--waiting"}`;
      if (player.isNew) row.classList.add("player-item--new");
      row.dataset.playerId = String(player.id);

      const left = document.createElement("div");
      left.className = "player-left";

      const idx = document.createElement("div");
      idx.className = "player-index";
      idx.textContent = `${index + 1}.`;

      const meta = document.createElement("div");
      meta.className = "player-meta";

      const name = document.createElement("div");
      name.className = "player-name";
      name.textContent = player.displayName;

      const sub = document.createElement("div");
      sub.className = "player-sub";

      const parts = [];
      if (player.platform) {
        parts.push(player.platform.toUpperCase());
      }
      if (player.account) {
        parts.push(player.account);
      }
      if (player.club) {
        parts.push(`俱乐部:${player.club}`);
      }
      sub.textContent = parts.join(" · ");

      const tags = document.createElement("div");
      tags.className = "player-tags";

      const status = document.createElement("span");
      status.className = `chip-small ${player.checkedIn ? "chip-good" : "chip-warn"}`;
      status.textContent = player.checkedIn ? "已签到" : "等待中";
      tags.appendChild(status);

      // Group tag (helpful in "全部"视图)
      if (player.group && player.group !== "未分组") {
        const gchip = document.createElement("span");
        gchip.className = "chip-small";
        gchip.textContent = player.group;
        tags.appendChild(gchip);
      }

      if (player.isNew) {
        const newChip = document.createElement("span");
        newChip.className = "chip-small chip-new";
        newChip.textContent = "新人";
        tags.appendChild(newChip);
      }

      if (
        state.ui &&
        state.ui.showTime &&
        player.checkedIn &&
        player.checkedInAt
      ) {
        const tchip = document.createElement("span");
        tchip.className = "chip-small";
        tchip.textContent = formatTime(player.checkedInAt);
        tags.appendChild(tchip);
      }

      meta.appendChild(name);
      if (parts.length) meta.appendChild(sub);
      meta.appendChild(tags);

      left.appendChild(idx);
      left.appendChild(meta);

      const actions = document.createElement("div");
      actions.className = "player-actions";

      // Check-in toggle
      const checkBtn = document.createElement("button");
      checkBtn.type = "button";
      checkBtn.className = `action-btn ${player.checkedIn ? "" : "action-btn--primary"}`;
      checkBtn.dataset.action = "toggle-checkin";
      checkBtn.dataset.playerId = String(player.id);
      checkBtn.textContent = player.checkedIn ? "取消签到" : "签到";

      // New toggle
      const newBtn = document.createElement("button");
      newBtn.type = "button";
      newBtn.className = "action-btn";
      newBtn.dataset.action = "toggle-new";
      newBtn.dataset.playerId = String(player.id);
      newBtn.textContent = player.isNew ? "取消新人" : "设为新人";

      // Edit
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "action-btn";
      editBtn.dataset.action = "edit";
      editBtn.dataset.playerId = String(player.id);
      editBtn.textContent = "编辑";

      // Delete
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "action-btn action-btn--danger";
      delBtn.dataset.action = "delete";
      delBtn.dataset.playerId = String(player.id);
      delBtn.textContent = "删除";

      actions.appendChild(checkBtn);
      actions.appendChild(newBtn);
      actions.appendChild(editBtn);
      actions.appendChild(delBtn);

      row.appendChild(left);
      row.appendChild(actions);

      playerList.appendChild(row);
    });

    playerList.scrollTop = shouldPinFirstPlayerToBottom ? 0 : prevScrollTop;
  }

  function shouldPreserveTouchKeyboardCheckinScroll() {
    return Boolean(
      document.documentElement &&
        document.documentElement.classList &&
        document.documentElement.classList.contains("screen-keyboard-checkin") &&
        document.body &&
        document.body.classList &&
        document.body.classList.contains("ios-checkin-editing"),
    );
  }

  function preserveViewportScrollDuring(fn) {
    if (typeof fn !== "function") return;
    if (!shouldPreserveTouchKeyboardCheckinScroll()) {
      fn();
      return;
    }

    const scrollX = Number(window.scrollX) || 0;
    const scrollY = Number(window.scrollY) || 0;
    const docEl = document.documentElement;
    const body = document.body;
    const docTop = docEl ? Number(docEl.scrollTop) || 0 : 0;
    const bodyTop = body ? Number(body.scrollTop) || 0 : 0;

    const restore = () => {
      try {
        window.scrollTo(scrollX, scrollY);
        if (docEl) docEl.scrollTop = docTop;
        if (body) body.scrollTop = bodyTop;
      } catch (_) {
        // ignore scroll restoration errors
      }
    };

    fn();
    restore();
    window.requestAnimationFrame(restore);
  }

  function refreshCheckinUI() {
    renderGroupFilter();
    applyModeClasses();

    // 只计算一次 visible players，避免重复调用
    const visiblePlayers = getVisiblePlayers();

    updateStats(visiblePlayers);
    renderPlayerList(visiblePlayers);
  }

  // ------------------------------
  // Suspects (疑似重复/疑似异常) panel
  // - 在导入完成后自动提示一次（可关闭）
  // - 也可通过“检查重复”手动打开
  // ------------------------------
  const SUSPECTS_PREF_KEY = "checkin_assistant_suspects_auto_v1";
  const SUSPECTS_LAST_HASH_KEY = "checkin_assistant_suspects_last_hash_v1";

  function normalizeForSimilarity(str) {
    // Keep chinese + letters + digits, remove most separators.
    // This helps catch duplicates like "WangGang" vs "Wang Gang" vs "Wang-Gang".
    return normalizeWhitespace(str || "")
      .toLowerCase()
      .replace(
        /[\s\u2000-\u206F\u2E00-\u2E7F'"“”‘’`·•・\.,，。:：;；!?！？、\/\\\-_=\(\)\[\]\{\}<>《》【】（）]+/g,
        "",
      );
  }

  function looksLikeHandleStyle(text) {
    const t = normalizeWhitespace(text || "");
    if (!t) return false;
    if (t.includes(" ")) return false;
    if (/^\d{3,10}$/.test(t)) return true;
    if (tokenIsAsciiLike(t) && /[0-9_]/.test(t) && t.length >= 3) return true;
    return false;
  }

  function makeBigrams(str) {
    const s = String(str || "");
    if (!s) return [];
    if (s.length === 1) return [s];
    const out = [];
    for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
    return out;
  }

  function diceSimilarity(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;

    const A = makeBigrams(a);
    const B = makeBigrams(b);
    if (!A.length || !B.length) return 0;

    const map = new Map();
    for (const g of A) map.set(g, (map.get(g) || 0) + 1);

    let inter = 0;
    for (const g of B) {
      const c = map.get(g) || 0;
      if (c > 0) {
        inter++;
        if (c === 1) map.delete(g);
        else map.set(g, c - 1);
      }
    }

    return (2 * inter) / (A.length + B.length);
  }

  function computeSuspectReport(
    players,
    { limitPairs = 80, limitAnomalies = 80 } = {},
  ) {
    const list = Array.isArray(players) ? players : [];

    const pairMap = new Map(); // key -> {a,b,reasons[], kinds:Set, score}
    const anomalies = [];

    // --- anomalies ---
    for (const p of list) {
      if (!p) continue;
      const reasons = [];

      const nameRaw = normalizeWhitespace(p.displayName);
      const nameNorm = normalizeForSimilarity(nameRaw);
      const accRaw = normalizeWhitespace(p.account);
      const accNorm = normalizeForSimilarity(accRaw);
      const group = normalizeWhitespace(p.group) || "未分组";
      const plat = normalizeWhitespace(p.platform || "");

      if (!nameRaw) reasons.push("昵称为空");
      if (nameRaw && nameRaw.length > 24) reasons.push("昵称过长");
      if (nameRaw && nameRaw.length < 2) reasons.push("昵称过短");

      // Account-related heuristics (OQ账号通常为字母/数字/下划线)
      if (plat === "oq" && accRaw && tokenHasChinese(accRaw)) {
        reasons.push("OQ账号包含中文（可能粘贴错列）");
      }

      // "Surname + account" often means only 姓 was provided, missing full name pinyin.
      if (
        plat === "oq" &&
        accRaw &&
        !String(group).includes("长期") &&
        looksLikeRomanizedSurnameOnly(nameRaw) &&
        tokenLooksLikeAccount(accRaw, plat) >= 2
      ) {
        reasons.push("昵称疑似仅填写姓氏（建议补全姓名拼音）");
      }

      // Missing account (exclude long-term club list)
      if (!accRaw && plat && !String(group).includes("长期")) {
        if (plat === "oq") reasons.push("未填写账号");
        else if (plat === "vint")
          reasons.push("未填写账号（vint 组可人工确认）");
        else reasons.push("未填写账号");
      }

      // Name looks like handle but account is empty -> likely column mismatch (OQ only)
      if (
        !accRaw &&
        plat === "oq" &&
        !String(group).includes("长期") &&
        looksLikeHandleStyle(nameRaw)
      ) {
        reasons.push("昵称形态更像账号（可能错列）");
      }

      // Name/account look effectively identical -> likely duplicated paste.
      // For vint, nickname==账号 is relatively common and lower-signal, so skip.
      if (
        nameNorm &&
        accNorm &&
        nameNorm.length >= 4 &&
        nameNorm === accNorm &&
        plat !== "vint"
      ) {
        reasons.push("昵称与账号几乎相同（可能重复粘贴）");
      }

      // suspicious keywords accidentally included as player
      if (
        nameNorm &&
        instructionKeywords.some((k) =>
          nameNorm.includes(normalizeForSimilarity(k)),
        )
      ) {
        reasons.push("昵称疑似包含说明文字");
      }

      const uniqueReasons = Array.from(new Set(reasons));
      if (uniqueReasons.length) {
        let severity = "low";
        if (
          uniqueReasons.includes("昵称为空") ||
          uniqueReasons.includes("昵称疑似包含说明文字")
        ) {
          severity = "high";
        } else if (
          uniqueReasons.includes("OQ账号包含中文（可能粘贴错列）") ||
          uniqueReasons.includes("未填写账号") ||
          uniqueReasons.includes("昵称形态更像账号（可能错列）") ||
          uniqueReasons.includes("昵称疑似仅填写姓氏（建议补全姓名拼音）")
        ) {
          severity = "medium";
        }

        anomalies.push({
          id: p.id,
          displayName: p.displayName || "",
          group,
          platform: plat,
          account: p.account || "",
          reasons: uniqueReasons,
          severity,
        });
      }
    }

    // --- duplicates / similarity pairs ---
    const n = list.length;
    for (let i = 0; i < n; i++) {
      const a = list[i];
      if (!a) continue;
      const aNameRaw = normalizeWhitespace(a.displayName);
      const aName = normalizeForSimilarity(aNameRaw);
      const aAccRaw = normalizeWhitespace(a.account);
      const aAcc = normalizeForSimilarity(aAccRaw);
      const aPlat = normalizeWhitespace(a.platform || "");

      for (let j = i + 1; j < n; j++) {
        const b = list[j];
        if (!b) continue;

        const bNameRaw = normalizeWhitespace(b.displayName);
        const bName = normalizeForSimilarity(bNameRaw);
        const bAccRaw = normalizeWhitespace(b.account);
        const bAcc = normalizeForSimilarity(bAccRaw);
        const bPlat = normalizeWhitespace(b.platform || "");
        const bothNoAccount = !aAcc && !bAcc;

        const key = `${a.id}|${b.id}`;
        let entry = null;

        const addPair = (reason, score, kind = "generic") => {
          entry = entry ||
            pairMap.get(key) || {
              a,
              b,
              reasons: [],
              kinds: new Set(),
              score: 0,
            };
          if (reason && !entry.reasons.includes(reason))
            entry.reasons.push(reason);
          entry.kinds.add(kind);
          entry.score = Math.max(entry.score, score);
          pairMap.set(key, entry);
        };

        // Name similarity
        if (aName && bName) {
          const maxLen = Math.max(aName.length, bName.length);
          const minLen = Math.min(aName.length, bName.length);

          if (aName === bName) {
            // Same after normalization
            if (aNameRaw !== bNameRaw) {
              addPair(
                "昵称规范化后相同",
                bothNoAccount ? 0.96 : 1,
                "name_exact",
              );
            } else {
              addPair(
                "昵称完全相同",
                bothNoAccount ? 0.96 : 0.99,
                "name_exact_raw",
              );
              if (aAcc && bAcc && aAcc !== bAcc) {
                addPair("同名但账号不同", 0.99, "name_account_conflict");
              }
              if (aPlat && bPlat && aPlat !== bPlat) {
                addPair("同名但平台不同", 0.97, "name_platform_conflict");
              }
            }
          } else if (maxLen >= 4 && minLen >= 3) {
            const sim = diceSimilarity(aName, bName);
            // Threshold tuned for short names to reduce false positives
            let threshold = maxLen >= 10 ? 0.88 : maxLen >= 7 ? 0.9 : 0.93;
            if (bothNoAccount) threshold = Math.min(0.98, threshold + 0.05);
            if (sim >= threshold)
              addPair(
                `昵称相似度 ${(sim * 100).toFixed(0)}%`,
                sim,
                "name_similar",
              );
          }
        }

        // Account similarity
        if (aAcc && bAcc) {
          const maxLen = Math.max(aAcc.length, bAcc.length);
          const minLen = Math.min(aAcc.length, bAcc.length);

          if (aAcc === bAcc) {
            // Same normalized account
            if (aAccRaw !== bAccRaw)
              addPair("账号规范化后相同", 1, "account_exact");
            else addPair("账号完全相同", 1, "account_exact_raw");
            // If the same account appears with different *raw* nicknames (even if they normalize
            // to the same form), it's still worth surfacing to help the user cleanup.
            if (aNameRaw && bNameRaw && aNameRaw !== bNameRaw) {
              addPair("同账号但昵称不同", 1, "account_name_conflict");
            }
            if (aPlat && bPlat && aPlat !== bPlat)
              addPair("账号相同但平台不同", 0.98, "account_cross_platform");
          } else if (maxLen >= 5 && minLen >= 4) {
            const sim = diceSimilarity(aAcc, bAcc);
            const threshold = maxLen >= 10 ? 0.88 : maxLen >= 7 ? 0.9 : 0.93;
            if (sim >= threshold)
              addPair(
                `账号相似度 ${(sim * 100).toFixed(0)}%`,
                sim,
                "account_similar",
              );
          }
        }
      }
    }

    const pairs = Array.from(pairMap.values()).map((it) => {
      const kinds = Array.from(it.kinds || []);
      const hasAccountExact =
        kinds.includes("account_exact") || kinds.includes("account_exact_raw");
      const hasStrongAccountSimilar =
        kinds.includes("account_similar") && Number(it.score || 0) >= 0.97;
      const hasCrossPlatform = kinds.includes("account_cross_platform");
      const hasNameConflict =
        kinds.includes("name_account_conflict") ||
        kinds.includes("name_platform_conflict");
      const hasAccountNameConflict = kinds.includes("account_name_conflict");
      const hasNameExact =
        kinds.includes("name_exact") || kinds.includes("name_exact_raw");
      const highConfidence =
        hasAccountExact ||
        hasStrongAccountSimilar ||
        hasNameConflict ||
        hasAccountNameConflict;
      // Cross-platform same account is useful, but often less certain than same-platform exact match.
      const mediumConfidence =
        !highConfidence && (hasCrossPlatform || hasNameExact);
      return {
        a: it.a,
        b: it.b,
        reasons: Array.isArray(it.reasons)
          ? Array.from(new Set(it.reasons))
          : [],
        score: Number(it.score || 0),
        kinds,
        highConfidence,
        mediumConfidence,
      };
    });
    pairs.sort((x, y) => (y.score || 0) - (x.score || 0));

    const highConfidencePairs = pairs.filter((p) => p.highConfidence);
    const mediumConfidencePairs = pairs.filter((p) => p.mediumConfidence);
    const crossPlatformPairs = pairs.filter(
      (p) =>
        Array.isArray(p.kinds) && p.kinds.includes("account_cross_platform"),
    );
    const highConflictPairs = highConfidencePairs.filter((p) => {
      const kinds = Array.isArray(p && p.kinds) ? p.kinds : [];
      return (
        kinds.includes("name_account_conflict") ||
        kinds.includes("account_name_conflict") ||
        (kinds.includes("account_similar") && Number(p.score || 0) >= 0.97)
      );
    });
    const highExactDuplicatePairs = highConfidencePairs.filter((p) => {
      const kinds = Array.isArray(p && p.kinds) ? p.kinds : [];
      const hasAccountExact =
        kinds.includes("account_exact") || kinds.includes("account_exact_raw");
      if (!hasAccountExact) return false;
      if (
        kinds.includes("name_account_conflict") ||
        kinds.includes("account_name_conflict")
      )
        return false;
      return true;
    });
    const highSeverityAnomalies = anomalies.filter(
      (a) => a.severity === "high",
    );
    const mediumSeverityAnomalies = anomalies.filter(
      (a) => a.severity === "medium",
    );
    const severityWeight = { high: 3, medium: 2, low: 1 };
    anomalies.sort((a, b) => {
      const sa = severityWeight[a.severity] || 0;
      const sb = severityWeight[b.severity] || 0;
      if (sa !== sb) return sb - sa;
      return nameCollator.compare(
        String(a.displayName || ""),
        String(b.displayName || ""),
      );
    });

    // Auto prompt strategy:
    // - Always prompt for high-confidence conflict pairs (账号/昵称冲突等强信号).
    // - High-confidence exact duplicates only trigger when they are dense enough
    //   (to reduce single-pair noise on large lists).
    // - Always prompt for obvious high-severity anomalies.
    // - Medium-severity anomalies only trigger auto prompt when they are dense enough.
    // - Cross-platform same-account pairs are treated as medium confidence; prompt only when they are dense.
    const mediumReasonBuckets = new Set();
    let mediumMissingAccountCount = 0;
    for (const item of mediumSeverityAnomalies) {
      const reasons = Array.isArray(item && item.reasons) ? item.reasons : [];
      for (const reason of reasons) {
        const text = String(reason || "");
        if (!text) continue;
        if (text.includes("未填写账号")) {
          mediumReasonBuckets.add("missing_account");
          mediumMissingAccountCount++;
          continue;
        }
        if (text.includes("错列") || text.includes("包含中文")) {
          mediumReasonBuckets.add("column_mismatch");
          continue;
        }
        mediumReasonBuckets.add("other");
      }
    }

    const mediumThreshold = list.length <= 20 ? 4 : list.length <= 40 ? 5 : 6;
    const mediumRatioThreshold =
      list.length <= 20 ? 0.28 : list.length <= 40 ? 0.2 : 0.15;
    const mediumRatio =
      mediumSeverityAnomalies.length / Math.max(1, list.length);
    const mediumMissingRatio =
      mediumMissingAccountCount / Math.max(1, list.length);
    const mediumDiverse =
      mediumReasonBuckets.size >= 2 ||
      !mediumReasonBuckets.has("missing_account");
    const mediumMissingDominant =
      mediumSeverityAnomalies.length > 0 &&
      mediumMissingAccountCount / Math.max(1, mediumSeverityAnomalies.length) >=
        0.85;
    const mediumHasActionableReason =
      mediumReasonBuckets.has("column_mismatch") ||
      mediumReasonBuckets.has("other");
    const mediumAllowedByMissingOnly =
      mediumMissingRatio >= 0.5 &&
      mediumSeverityAnomalies.length >= mediumThreshold + 2;
    const mediumTriggerQualityOk =
      !mediumMissingDominant ||
      (mediumHasActionableReason &&
        mediumSeverityAnomalies.length >= mediumThreshold + 1);
    const mediumOnlyTrigger =
      list.length >= 8 &&
      highConfidencePairs.length === 0 &&
      highSeverityAnomalies.length === 0 &&
      mediumSeverityAnomalies.length >= mediumThreshold &&
      mediumRatio >= mediumRatioThreshold &&
      (mediumHasActionableReason ||
        mediumAllowedByMissingOnly ||
        mediumDiverse) &&
      mediumTriggerQualityOk;

    const mediumDuplicatePairs = mediumConfidencePairs.filter((p) => {
      const kinds = Array.isArray(p && p.kinds) ? p.kinds : [];
      return !kinds.includes("account_cross_platform");
    });
    // Similar-name pairs are useful hints but often produce false positives,
    // especially for拼音/短昵称. To reduce noisy auto-popups, we exclude *pure*
    // “name_similar only” pairs from the *auto-trigger* calculation, while still
    // keeping them in the report list.
    const mediumDuplicatePairsForAuto = mediumDuplicatePairs.filter((p) => {
      const kinds = Array.isArray(p && p.kinds) ? p.kinds : [];
      return !(kinds.length === 1 && kinds[0] === "name_similar");
    });
    const mediumDupThreshold =
      list.length <= 20 ? 2 : list.length <= 40 ? 3 : 4;
    const mediumDupRatioThreshold =
      list.length <= 20 ? 0.1 : list.length <= 40 ? 0.08 : 0.06;
    const mediumDuplicateOnlyTrigger =
      list.length >= 8 &&
      highConfidencePairs.length === 0 &&
      highSeverityAnomalies.length === 0 &&
      mediumDuplicatePairsForAuto.length >= mediumDupThreshold &&
      mediumDuplicatePairsForAuto.length / Math.max(1, list.length) >=
        mediumDupRatioThreshold;

    const crossPlatformThreshold = Math.max(3, Math.ceil(list.length * 0.12));
    const crossPlatformRatio =
      crossPlatformPairs.length / Math.max(1, list.length);
    const crossPlatformOnlyTrigger =
      highConfidencePairs.length === 0 &&
      highSeverityAnomalies.length === 0 &&
      crossPlatformPairs.length >= crossPlatformThreshold &&
      crossPlatformRatio >= 0.12;

    const highExactDupMin = list.length <= 24 ? 1 : list.length <= 80 ? 2 : 3;
    const highExactDupRatioMin =
      list.length <= 24 ? 0 : list.length <= 80 ? 0.05 : 0.04;
    const highExactDupRatio =
      highExactDuplicatePairs.length / Math.max(1, list.length);
    const highExactDuplicateOnlyTrigger =
      highExactDuplicatePairs.length >= highExactDupMin &&
      (highExactDupRatioMin === 0 || highExactDupRatio >= highExactDupRatioMin);

    // Auto-prompt high confidence when conflict is clear (账号/昵称冲突),
    // or when exact duplicates are dense enough (to reduce single-pair noise on large lists).
    const highConfidenceTrigger =
      highConflictPairs.length > 0 || highExactDuplicateOnlyTrigger;

    const autoPromptRecommended =
      highConfidenceTrigger ||
      highSeverityAnomalies.length > 0 ||
      mediumOnlyTrigger ||
      mediumDuplicateOnlyTrigger ||
      crossPlatformOnlyTrigger;

    // Limit output to keep UI responsive on very large lists
    const limitedPairs = pairs.slice(0, limitPairs);
    const limitedAnom = anomalies.slice(0, limitAnomalies);

    return {
      totalPlayers: list.length,
      duplicatePairs: limitedPairs,
      duplicatePairsTotal: pairs.length,
      anomalies: limitedAnom,
      anomaliesTotal: anomalies.length,
      highConfidencePairsTotal: highConfidencePairs.length,
      highConflictPairsTotal: highConflictPairs.length,
      highExactDuplicatePairsTotal: highExactDuplicatePairs.length,
      mediumConfidencePairsTotal: mediumConfidencePairs.length,
      mediumDuplicatePairsTotal: mediumDuplicatePairs.length,
      crossPlatformPairsTotal: crossPlatformPairs.length,
      highSeverityAnomaliesTotal: highSeverityAnomalies.length,
      mediumSeverityAnomaliesTotal: mediumSeverityAnomalies.length,
      autoPromptRecommended,
    };
  }

  function reopenSuspectsDialogFromCurrentState() {
    const report = computeSuspectReport(
      state && Array.isArray(state.players) ? state.players : [],
    );
    showSuspectsDialog(report, { allowDisableAuto: true });
  }

  function openEditPlayerFromSuspects(playerId) {
    const id = Number(playerId);
    if (!Number.isFinite(id)) return;
    if (!getPlayerById(id)) {
      showSnackbar("该选手已不存在，请刷新后重试", 2200);
      return;
    }
    showEditPlayerDialog(id, {
      onReturnToSuspects: reopenSuspectsDialogFromCurrentState,
    });
  }

  function buildSuspectsPanel(report) {
    const root = document.createElement("div");
    root.className = "suspects-panel import-preview";
    root.style.whiteSpace = "normal";

    const title = document.createElement("div");
    title.className = "import-summary__title";
    title.textContent = `疑似重复：${report.duplicatePairsTotal} 对 · 疑似异常：${report.anomaliesTotal} 条`;

    const sub = document.createElement("div");
    sub.className = "import-summary__sub";
    sub.textContent = `说明：以下为自动检测结果（仅供参考，可能误判）。高置信重复 ${report.highConfidencePairsTotal || 0} 对，中置信重复 ${report.mediumDuplicatePairsTotal || report.mediumConfidencePairsTotal || 0} 对，跨平台同账号 ${report.crossPlatformPairsTotal || 0} 对，高优先异常 ${report.highSeverityAnomaliesTotal || 0} 条。点击下方选手名称可直接编辑并保存。`;

    root.appendChild(title);
    root.appendChild(sub);

    // Duplicate pairs
    const dupDetails = document.createElement("details");
    dupDetails.className = "import-ignored";
    dupDetails.open = report.duplicatePairsTotal > 0;

    const dupSummary = document.createElement("summary");
    dupSummary.className = "import-ignored__summary";
    const dupLeft = document.createElement("div");
    dupLeft.className = "import-ignored__summary-left";
    const dupIcon = document.createElement("svg");
    dupIcon.className = "ms-icon import-ignored__chev";
    dupIcon.setAttribute("aria-hidden", "true");
    dupIcon.innerHTML = '<use href="#i-expand-more"></use>';
    const dupT = document.createElement("div");
    dupT.className = "import-ignored__title";
    dupT.textContent = `疑似重复/相似（展示 ${report.duplicatePairs.length} / ${report.duplicatePairsTotal}）`;
    const dupH = document.createElement("div");
    dupH.className = "import-ignored__hint";
    dupH.textContent = "点击展开/收起";
    dupLeft.appendChild(dupIcon);
    dupLeft.appendChild(dupT);
    dupLeft.appendChild(dupH);
    dupSummary.appendChild(dupLeft);
    dupDetails.appendChild(dupSummary);

    const dupPanel = document.createElement("div");
    dupPanel.className = "import-ignored__panel";

    if (report.duplicatePairsTotal === 0) {
      const p = document.createElement("div");
      p.className = "suspects-empty";
      p.textContent = "未发现明显重复。";
      dupPanel.appendChild(p);
    } else {
      report.duplicatePairs.forEach((it) => {
        const row = document.createElement("div");
        row.className = "suspect-row";
        if (it && it.highConfidence) row.classList.add("suspect-row--high");
        else if (
          it &&
          Array.isArray(it.kinds) &&
          it.kinds.includes("account_cross_platform")
        )
          row.classList.add("suspect-row--cross");

        const main = document.createElement("div");
        main.className = "suspect-row__main suspect-row__main--pair";

        const aBtn = document.createElement("button");
        aBtn.type = "button";
        aBtn.className = "suspect-row__player-btn";
        aBtn.textContent =
          normalizeWhitespace(it && it.a && it.a.displayName) || "（空昵称）";
        aBtn.title = "点击编辑该选手";
        aBtn.addEventListener("click", () => {
          openEditPlayerFromSuspects(it && it.a && it.a.id);
        });

        const sep = document.createElement("span");
        sep.className = "suspect-row__sep";
        sep.textContent = "↔";

        const bBtn = document.createElement("button");
        bBtn.type = "button";
        bBtn.className = "suspect-row__player-btn";
        bBtn.textContent =
          normalizeWhitespace(it && it.b && it.b.displayName) || "（空昵称）";
        bBtn.title = "点击编辑该选手";
        bBtn.addEventListener("click", () => {
          openEditPlayerFromSuspects(it && it.b && it.b.id);
        });

        main.appendChild(aBtn);
        main.appendChild(sep);
        main.appendChild(bBtn);

        const meta = document.createElement("div");
        meta.className = "suspect-row__meta";

        const aInfo = [];
        if (it.a.group) aInfo.push(it.a.group);
        if (it.a.platform) aInfo.push(String(it.a.platform).toUpperCase());
        if (it.a.account) aInfo.push(it.a.account);

        const bInfo = [];
        if (it.b.group) bInfo.push(it.b.group);
        if (it.b.platform) bInfo.push(String(it.b.platform).toUpperCase());
        if (it.b.account) bInfo.push(it.b.account);

        meta.textContent = `${it.reasons.join(" · ")} · A：${aInfo.join(" / ") || "（无）"} · B：${bInfo.join(" / ") || "（无）"}`;

        row.appendChild(main);
        row.appendChild(meta);
        dupPanel.appendChild(row);
      });
    }

    dupDetails.appendChild(dupPanel);
    root.appendChild(dupDetails);

    // Anomalies
    const anDetails = document.createElement("details");
    anDetails.className = "import-ignored";
    anDetails.open = report.anomaliesTotal > 0;

    const anSummary = document.createElement("summary");
    anSummary.className = "import-ignored__summary";
    const anLeft = document.createElement("div");
    anLeft.className = "import-ignored__summary-left";
    const anIcon = document.createElement("svg");
    anIcon.className = "ms-icon import-ignored__chev";
    anIcon.setAttribute("aria-hidden", "true");
    anIcon.innerHTML = '<use href="#i-expand-more"></use>';
    const anT = document.createElement("div");
    anT.className = "import-ignored__title";
    anT.textContent = `疑似异常（展示 ${report.anomalies.length} / ${report.anomaliesTotal}）`;
    const anH = document.createElement("div");
    anH.className = "import-ignored__hint";
    anH.textContent = "点击展开/收起";
    anLeft.appendChild(anIcon);
    anLeft.appendChild(anT);
    anLeft.appendChild(anH);
    anSummary.appendChild(anLeft);
    anDetails.appendChild(anSummary);

    const anPanel = document.createElement("div");
    anPanel.className = "import-ignored__panel";

    if (report.anomaliesTotal === 0) {
      const p = document.createElement("div");
      p.className = "suspects-empty";
      p.textContent = "未发现明显异常。";
      anPanel.appendChild(p);
    } else {
      report.anomalies.forEach((it) => {
        const row = document.createElement("div");
        row.className = "suspect-row";
        if (it && it.severity === "high")
          row.classList.add("suspect-row--high");
        else if (it && it.severity === "medium")
          row.classList.add("suspect-row--mid");

        const main = document.createElement("button");
        main.type = "button";
        main.className =
          "suspect-row__main suspect-row__player-btn suspect-row__player-btn--solo";
        main.textContent = it.displayName || "（空昵称）";
        main.title = "点击编辑该选手";
        main.addEventListener("click", () => {
          openEditPlayerFromSuspects(it && it.id);
        });

        const meta = document.createElement("div");
        meta.className = "suspect-row__meta";
        const info = [];
        if (it.group) info.push(it.group);
        if (it.platform) info.push(String(it.platform).toUpperCase());
        if (it.account) info.push(it.account);
        meta.textContent = `${it.reasons.join(" · ")} · ${info.join(" / ")}`;

        row.appendChild(main);
        row.appendChild(meta);
        anPanel.appendChild(row);
      });
    }

    anDetails.appendChild(anPanel);
    root.appendChild(anDetails);

    return root;
  }

  function showSuspectsDialog(report, { allowDisableAuto = true } = {}) {
    const panel = buildSuspectsPanel(report);

    const buttons = [];
    if (allowDisableAuto) {
      buttons.push({
        label: "不再自动提示",
        className: "btn btn-outlined",
        onClick: () => {
          safeLocalStorageSet(SUSPECTS_PREF_KEY, "1");
          showSnackbar("已关闭自动提示（仍可手动点击“检查重复”查看）", 2600);
        },
      });
    }

    buttons.push({ label: "关闭", className: "btn btn-filled" });

    showDialog({
      title: "疑似重复/异常提示",
      contentNode: panel,
      buttons,
    });
  }

  function buildSuspectsStateHash(players) {
    const list = Array.isArray(players) ? players : [];
    const raw = list
      .map((p) => {
        const name = normalizeForSimilarity(p && p.displayName);
        const acc = normalizeForSimilarity(p && p.account);
        const grp = normalizeForSimilarity(p && p.group);
        const plat = normalizeForSimilarity(p && p.platform);
        return `${name}|${acc}|${grp}|${plat}`;
      })
      .sort()
      .join("\n");

    // Simple deterministic hash (djb2 variant)
    let h = 5381;
    for (let i = 0; i < raw.length; i++) {
      h = ((h << 5) + h) ^ raw.charCodeAt(i);
    }
    return String(h >>> 0);
  }

  function shouldSoftHintForLargeSuspectsReport(report, players) {
    const list = Array.isArray(players) ? players : [];
    if (!report || list.length < 70) return false;
    if ((report.highSeverityAnomaliesTotal || 0) > 0) return false;

    const highPairs = Number(report.highConfidencePairsTotal || 0);
    const duplicatePairs = Number(report.duplicatePairsTotal || 0);
    const mediumAnomalies = Number(report.mediumSeverityAnomaliesTotal || 0);

    const isVeryLarge = list.length >= 120;
    const highPairMin = isVeryLarge ? 45 : 18;
    const duplicatePairMin = isVeryLarge ? 60 : 24;
    const highPairRatioMin = isVeryLarge ? 0.22 : 0.2;
    const duplicatePairRatioMin = isVeryLarge ? 0.3 : 0.28;
    const mediumAnomalyMax = isVeryLarge
      ? Math.max(10, Math.floor(list.length * 0.08))
      : Math.max(6, Math.floor(list.length * 0.06));

    if (highPairs < highPairMin || duplicatePairs < duplicatePairMin)
      return false;
    if (highPairs / Math.max(1, list.length) < highPairRatioMin) return false;
    if (duplicatePairs / Math.max(1, list.length) < duplicatePairRatioMin)
      return false;
    if (mediumAnomalies > mediumAnomalyMax) return false;

    const groupCounter = new Map();
    for (const p of list) {
      const g = normalizeWhitespace(p && p.group) || "未分组";
      groupCounter.set(g, (groupCounter.get(g) || 0) + 1);
    }
    const groupCountMin = isVeryLarge ? 4 : 3;
    if (groupCounter.size < groupCountMin) return false;

    const counts = Array.from(groupCounter.values()).sort((a, b) => b - a);
    const sizeableGroups = counts.filter((c) => c >= 12).length;
    const maxGroup = counts[0] || 0;
    const sizeableGroupMin = isVeryLarge ? 4 : 3;
    const dominanceLimit = isVeryLarge ? 0.55 : 0.65;

    // Typical archive-like import: many sizeable groups, no single group dominates.
    return (
      sizeableGroups >= sizeableGroupMin &&
      maxGroup <= Math.floor(list.length * dominanceLimit)
    );
  }

  function maybeAutoShowSuspectsAfterImport() {
    try {
      if (safeLocalStorageGet(SUSPECTS_PREF_KEY) === "1") return;
      if (!state || !Array.isArray(state.players) || state.players.length < 2)
        return;

      const report = computeSuspectReport(state.players);
      if (
        (report.duplicatePairsTotal || 0) === 0 &&
        (report.anomaliesTotal || 0) === 0
      )
        return;
      if (!report.autoPromptRecommended) return;

      const currentHash = buildSuspectsStateHash(state.players);
      if (lastAutoSuspectHash === currentHash) return;
      const lastHashFromStorage = safeLocalStorageGet(SUSPECTS_LAST_HASH_KEY);
      if (lastHashFromStorage && lastHashFromStorage === currentHash) return;
      lastAutoSuspectHash = currentHash;
      safeLocalStorageSet(SUSPECTS_LAST_HASH_KEY, currentHash);

      if (shouldSoftHintForLargeSuspectsReport(report, state.players)) {
        showSnackbar(
          "已检测到较多疑似重复记录；本次不自动弹窗，可按需点击“检查重复”查看。",
          3600,
        );
        return;
      }

      showSuspectsDialog(report, { allowDisableAuto: true });
    } catch (e) {
      console.warn("疑似重复提示生成失败：", e);
    }
  }

  // ------------------------------
  // Import / step actions
  // ------------------------------
  function detectCompetitionNameFromRelay(relayText) {
    const relayLines = String(relayText || "").split("\n");
    const titleLine = relayLines.find((line) => {
      const s = String(line || "");
      return s.includes("比赛报名接龙") || s.includes("比赛报名接龍");
    });
    const detectedCompetitionName = titleLine
      ? normalizeWhitespace(
          titleLine
            .replace(/#接龍|#接龙/g, "")
            .replace(/比赛报名接龙|比赛报名接龍/g, ""),
        )
      : "比赛签到表";
    return detectedCompetitionName || "比赛签到表";
  }

  function processImport() {
    try {
      const clubText =
        clubMembersEl && typeof clubMembersEl.value === "string"
          ? clubMembersEl.value
          : "";
      const relayText =
        relayInfoEl && typeof relayInfoEl.value === "string"
          ? relayInfoEl.value
          : "";
      state.groupRules = readGroupRulesFromEditor();

      // Persist current pasted text (for refresh/restore)
      state.clubText = clubText;
      state.relayText = relayText;
      scheduleSave();

      const detectedCompetitionName = detectCompetitionNameFromRelay(relayText);

      const result = parseImportTextsDetailed(clubText, relayText);

      if (!result.players || result.players.length === 0) {
        showDialog({
          title: "导入失败",
          message:
            buildImportReportText(result) ||
            "未能解析到任何有效的选手名称，请检查输入内容。",
          buttons: [{ label: "好的", className: "btn btn-filled" }],
        });
        return;
      }

      // Preview + correction UI
      const previewNode = buildImportPreviewNode(result);

      showDialog({
        title: "导入预览（可纠错）",
        contentNode: previewNode,
        buttons: [
          { label: "返回修改", className: "btn btn-outlined" },
          {
            label: "开始签到",
            className: "btn btn-filled",
            onClick: () => {
              const mergedPlayers = applyImportWithCorrections(
                result,
                previewNode,
              );
              if (!mergedPlayers || mergedPlayers.length === 0) return;

              // Reset ids with new list
              state.nextPlayerId = 1;
              state.players = mergedPlayers.map((p) => {
                const safe = makePlayer(p, {
                  isNew: Boolean(p.isNew),
                  group: p.group,
                  platform: p.platform,
                });
                safe.checkedIn = Boolean(p.checkedIn);
                safe.checkedInAt = p.checkedInAt || null;
                safe.account = p.account || "";
                safe.club = p.club || "";
                safe.displayName = p.displayName || "";
                return safe;
              });

              state.players.sort(comparePlayersForList);

              state.competitionName = detectedCompetitionName || "比赛签到表";
              state.step = "checkin";
              viewStepOverride = null;

              // If current group filter doesn't exist, reset
              if (
                state.ui &&
                state.ui.group !== "all" &&
                !state.players.some((p) => p.group === state.ui.group)
              ) {
                state.ui.group = "all";
              }

              // UI
              if (competitionTitleEl)
                competitionTitleEl.textContent = state.competitionName;
              if (competitionNameInput)
                competitionNameInput.value = state.competitionName;

              if (searchBox) searchBox.value = "";
              if (addPlayerNameInput) addPlayerNameInput.value = "";

              applyStepUI();
              refreshCheckinUI();
              scheduleSave();
              showSnackbar("已开始签到（进度会自动保存）", 2400);

              // Auto show suspects panel (after this preview dialog closes)
              window.setTimeout(() => {
                maybeAutoShowSuspectsAfterImport();
              }, 0);
            },
          },
        ],
      });
    } catch (e) {
      console.error("导入时发生错误：", e);
      showAlert("处理失败", "处理导入数据时发生未知错误。");
    }
  }

  function backToImport() {
    showConfirm(
      "返回确认",
      "确定要返回并重新导入吗？当前签到进度将被清空（可在底部提示条中撤销）。已粘贴的文本会保留。",
      () => {
        const snapshot = captureUndoSnapshot();

        state.step = "import";
        viewStepOverride = null;
        state.players = [];
        state.nextPlayerId = 1;

        applyStepUI();
        refreshCheckinUI();
        scheduleSave();

        showUndoSnackbar("已返回导入页面", () => {
          restoreUndoSnapshot(snapshot);
          showSnackbar("已撤销返回", 2200);
        });
      },
      "返回",
    );
  }

  // ------------------------------
  // Player actions
  // ------------------------------
  function getPlayerById(id) {
    const pid = Number(id);
    if (!Number.isFinite(pid)) return null;
    return state.players.find((p) => p.id === pid) || null;
  }

  function toggleNewStatus(playerId) {
    const player = getPlayerById(playerId);
    if (!player) return;
    player.isNew = !player.isNew;
    refreshCheckinUI();
    scheduleSave();
  }

  function setCheckIn(playerId, checked) {
    const player = getPlayerById(playerId);
    if (!player) return;

    const next = Boolean(checked);
    const prev = Boolean(player.checkedIn);
    const prevAt = player.checkedInAt;
    if (next === prev) return;

    player.checkedIn = next;
    player.checkedInAt = next ? now() : null;

    preserveViewportScrollDuring(() => {
      refreshCheckinUI();
    });
    scheduleSave();

    // Undo action (minimal risk)
    const action = next ? "已签到" : "已取消";
    showUndoSnackbar(
      `${action}：${player.displayName}`,
      () => {
        player.checkedIn = prev;
        player.checkedInAt = prev ? prevAt || now() : null;
        preserveViewportScrollDuring(() => {
          refreshCheckinUI();
        });
        scheduleSave();
        showSnackbar("已撤销", 1800);
      },
      5200,
    );
  }

  function toggleCheckIn(playerId) {
    const player = getPlayerById(playerId);
    if (!player) return;
    setCheckIn(playerId, !player.checkedIn);
  }

  function deletePlayer(playerId) {
    const player = getPlayerById(playerId);
    if (!player) return;

    showConfirm(
      "删除确认",
      `确定要删除「${player.displayName}」吗？删除后可在底部提示条中撤销。`,
      () => {
        const snapshot = captureUndoSnapshot();

        state.players = state.players.filter((p) => p.id !== playerId);

        // If current group is now empty, go back to "all"
        if (
          state.ui &&
          state.ui.group !== "all" &&
          !state.players.some((p) => p.group === state.ui.group)
        ) {
          state.ui.group = "all";
        }

        refreshCheckinUI();
        scheduleSave();

        showUndoSnackbar(`已删除「${player.displayName}」`, () => {
          restoreUndoSnapshot(snapshot);
          showSnackbar("已撤销删除", 2200);
        });
      },
      "删除",
    );
  }

  // ------------------------------
  // Inline edit (最小侵入：在选手右侧增加“编辑”按钮)
  // ------------------------------
  function sanitizeAccountInput(raw) {
    let s = normalizeWhitespace(raw || "");
    if (!s) return "";
    // Remove surrounding brackets/parentheses commonly used in pasted lists
    s = s.replace(/^[\[\(（【\{]\s*(.*?)\s*[\]\)）】\}]\s*$/, "$1");
    s = normalizeWhitespace(s);
    // Remove leading "@"
    s = s.replace(/^@+/, "");
    return s;
  }

  function sanitizeClubInput(raw) {
    let s = normalizeWhitespace(raw || "");
    if (!s) return "";
    s = s.replace(/^俱乐部\s*[:：]\s*/i, "");
    return s;
  }

  function showEditPlayerDialog(playerId, options = {}) {
    const player = getPlayerById(playerId);
    if (!player) return;
    const onReturnToSuspects =
      options && typeof options.onReturnToSuspects === "function"
        ? options.onReturnToSuspects
        : null;

    const root = document.createElement("div");
    root.className = "edit-form";
    root.style.whiteSpace = "normal";

    const note = document.createElement("div");
    note.className = "edit-note";
    note.textContent = onReturnToSuspects
      ? "提示：修改后会自动保存，并返回到“检查重复/异常”界面。"
      : "提示：修改后会自动保存。本工具不会上传数据；如需检查是否出现重复，可点页面上的“检查重复”。";

    const error = document.createElement("div");
    error.className = "form-error";
    error.setAttribute("role", "alert");

    const grid = document.createElement("div");
    grid.className = "form-grid";

    // Name
    const fName = document.createElement("label");
    fName.className = "field";
    const fNameLabel = document.createElement("span");
    fNameLabel.className = "field__label";
    fNameLabel.textContent = "选手名称";
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.value = player.displayName || "";
    nameInput.placeholder = "例如：王小明 / Wang Xiaoming";
    fName.appendChild(fNameLabel);
    fName.appendChild(nameInput);

    // Platform
    const fPlat = document.createElement("label");
    fPlat.className = "field";
    const fPlatLabel = document.createElement("span");
    fPlatLabel.className = "field__label";
    fPlatLabel.textContent = "平台";
    const platSel = document.createElement("select");
    platSel.className = "input";
    const platOptions = [
      { v: "", t: "（空）/ 未知" },
      { v: "oq", t: "OQ" },
      { v: "vint", t: "VINT" },
    ];
    platOptions.forEach((o) => {
      const opt = document.createElement("option");
      opt.value = o.v;
      opt.textContent = o.t;
      platSel.appendChild(opt);
    });
    platSel.value = normalizeWhitespace(player.platform || "");
    fPlat.appendChild(fPlatLabel);
    fPlat.appendChild(platSel);

    // Account
    const fAcc = document.createElement("label");
    fAcc.className = "field";
    const fAccLabel = document.createElement("span");
    fAccLabel.className = "field__label";
    fAccLabel.textContent = "账号（OQ/Vint）";
    const accInput = document.createElement("input");
    accInput.type = "text";
    accInput.value = player.account || "";
    accInput.placeholder = "例如：PoQi_G / Danica";
    fAcc.appendChild(fAccLabel);
    fAcc.appendChild(accInput);

    // Club
    const fClub = document.createElement("label");
    fClub.className = "field";
    const fClubLabel = document.createElement("span");
    fClubLabel.className = "field__label";
    fClubLabel.textContent = "俱乐部";
    const clubInput = document.createElement("input");
    clubInput.type = "text";
    clubInput.value = player.club || "";
    clubInput.placeholder = "例如：栢龙 / XX俱乐部";
    fClub.appendChild(fClubLabel);
    fClub.appendChild(clubInput);

    // Group
    const fGroup = document.createElement("label");
    fGroup.className = "field";
    const fGroupLabel = document.createElement("span");
    fGroupLabel.className = "field__label";
    fGroupLabel.textContent = "组别";
    const groupInput = document.createElement("input");
    groupInput.type = "text";
    groupInput.value = player.group || "未分组";
    groupInput.placeholder = "例如：无差别组 / 新人赛 / 特殊赛";

    // Datalist suggestions (existing groups)
    try {
      const uniqueGroups = Array.from(
        new Set(
          (state.players || []).map((p) =>
            normalizeWhitespace(p.group || "未分组"),
          ),
        ),
      ).filter(Boolean);
      uniqueGroups.sort((a, b) => nameCollator.compare(a, b));
      const dl = document.createElement("datalist");
      const dlId = `group-suggest-${playerId}-${Math.random().toString(16).slice(2)}`;
      dl.id = dlId;
      uniqueGroups.forEach((g) => {
        const opt = document.createElement("option");
        opt.value = g;
        dl.appendChild(opt);
      });
      groupInput.setAttribute("list", dlId);
      root.appendChild(dl);
    } catch (_) {
      // ignore datalist failures
    }

    fGroup.appendChild(fGroupLabel);
    fGroup.appendChild(groupInput);

    // isNew
    const fIsNew = document.createElement("label");
    fIsNew.className = "toggle toggle--inline";
    const isNewInput = document.createElement("input");
    isNewInput.type = "checkbox";
    isNewInput.checked = Boolean(player.isNew);
    const isNewText = document.createElement("span");
    isNewText.textContent = "新人标记";
    fIsNew.appendChild(isNewInput);
    fIsNew.appendChild(isNewText);

    grid.appendChild(fName);
    grid.appendChild(fPlat);
    grid.appendChild(fAcc);
    grid.appendChild(fClub);
    grid.appendChild(fGroup);

    root.appendChild(note);
    root.appendChild(error);
    root.appendChild(grid);
    root.appendChild(fIsNew);

    // Focus name for quick edit (mobile friendly)
    window.setTimeout(() => {
      try {
        nameInput.focus();
        nameInput.select();
      } catch (_) {}
    }, 0);

    const buttons = [];
    if (onReturnToSuspects) {
      buttons.push({
        label: "返回检查结果",
        className: "btn btn-tonal",
        onClick: () => {
          onReturnToSuspects();
          return false;
        },
      });
    }
    buttons.push({ label: "取消", className: "btn btn-outlined" });
    buttons.push({
      label: onReturnToSuspects ? "保存并返回" : "保存",
      className: "btn btn-filled",
      onClick: () => {
        error.textContent = "";
        const newName = normalizeWhitespace(nameInput.value);
        if (!newName) {
          error.textContent = "选手名称不能为空。";
          return false; // keep dialog open
        }

        const newPlatform = normalizeWhitespace(platSel.value);
        const newAccount = sanitizeAccountInput(accInput.value);
        const newClub = sanitizeClubInput(clubInput.value);
        const newGroup = normalizeWhitespace(groupInput.value) || "未分组";
        const newIsNew = Boolean(isNewInput.checked);

        const snapshot = captureUndoSnapshot();

        player.displayName = newName;
        player.platform = newPlatform;
        player.account = newAccount;
        player.club = newClub;
        player.group = newGroup;
        player.isNew = newIsNew;

        // Keep list order consistent with the rest of the app
        state.players.sort(comparePlayersForList);

        // If current group filter is invalid now, reset
        if (
          state.ui &&
          state.ui.group !== "all" &&
          !state.players.some((p) => p.group === state.ui.group)
        ) {
          state.ui.group = "all";
        }

        refreshCheckinUI();
        scheduleSave();

        showUndoSnackbar("已保存修改", () => {
          restoreUndoSnapshot(snapshot);
          showSnackbar("已撤销修改", 2200);
        });

        if (onReturnToSuspects) {
          onReturnToSuspects();
          return false;
        }
      },
    });

    showDialog({
      title: "编辑选手信息",
      contentNode: root,
      buttons,
    });
  }

  // ------------------------------
  // Batch operations (批量操作) + Undo
  // ------------------------------
  function getBatchScopePlayers() {
    // Scope: current group filter (与统计范围一致)，更符合“当前组别”预期
    return getStatsScopePlayers();
  }

  function batchSetCheckIn(checked) {
    const scope = getBatchScopePlayers();
    if (!scope || scope.length === 0) {
      showSnackbar("当前范围没有可操作的选手", 2200);
      return;
    }

    const snapshot = captureUndoSnapshot();

    let changed = 0;
    const ts = now();
    scope.forEach((p) => {
      if (!p) return;
      if (Boolean(p.checkedIn) === Boolean(checked)) return;
      p.checkedIn = Boolean(checked);
      p.checkedInAt = checked ? ts : null;
      changed++;
    });

    refreshCheckinUI();
    scheduleSave();

    const label = checked
      ? `已批量签到（${changed} 人）`
      : `已批量取消签到（${changed} 人）`;
    showUndoSnackbar(label, () => {
      restoreUndoSnapshot(snapshot);
      showSnackbar("已撤销批量操作", 2200);
    });
  }

  function batchDeleteCurrentGroup() {
    if (!state.ui || !state.ui.group || state.ui.group === "all") {
      showSnackbar("请先选择一个具体组别后再批量删除", 3000);
      return;
    }

    const group = String(state.ui.group);
    const scope = getBatchScopePlayers();
    const count = scope.length;

    if (count === 0) {
      showSnackbar("该组别为空，无需删除", 2200);
      return;
    }

    const snapshot = captureUndoSnapshot();

    state.players = (state.players || []).filter(
      (p) => p && String(p.group || "未分组") !== group,
    );
    state.ui.group = "all";

    refreshCheckinUI();
    scheduleSave();

    showUndoSnackbar(`已删除组别「${group}」的 ${count} 人`, () => {
      restoreUndoSnapshot(snapshot);
      showSnackbar("已撤销批量删除", 2200);
    });
  }

  function showBatchDialog() {
    const group = state.ui && state.ui.group ? String(state.ui.group) : "all";
    const scope = getBatchScopePlayers();
    const scopeLabel = group === "all" ? "全部组别" : `组别「${group}」`;
    const scopeCount = scope.length;

    const root = document.createElement("div");
    root.className = "batch-panel";
    root.style.whiteSpace = "normal";

    const p = document.createElement("div");
    p.className = "batch-panel__desc";
    p.textContent = `操作范围：${scopeLabel}（${scopeCount} 人）。所有批量操作都可在底部提示条中撤销。`;
    root.appendChild(p);

    showDialog({
      title: "批量操作",
      contentNode: root,
      buttons: [
        { label: "关闭", className: "btn btn-outlined" },
        {
          label: "全部签到",
          className: "btn btn-tonal",
          onClick: () => batchSetCheckIn(true),
        },
        {
          label: "全部取消签到",
          className: "btn btn-tonal",
          onClick: () => batchSetCheckIn(false),
        },
        {
          label: "删除当前组别",
          className: "btn btn-outlined",
          onClick: () => {
            if (group === "all") {
              showSnackbar(
                "为降低误删风险：请先选择一个具体组别，再使用“删除当前组别”。",
                3500,
              );
              return false; // keep dialog open
            }

            // Close this dialog first, then show confirm (avoid nested dialog auto-close)
            window.setTimeout(() => {
              showConfirm(
                "批量删除确认",
                `确定要删除组别「${group}」的全部 ${scopeCount} 人吗？删除后可在底部提示条中撤销。`,
                () => batchDeleteCurrentGroup(),
                "删除",
              );
            }, 0);
          },
        },
      ],
    });
  }

  function addPlayer() {
    if (!addPlayerNameInput) return;

    const raw = normalizeWhitespace(addPlayerNameInput.value);
    if (!raw) {
      showAlert("操作失败", "选手名称不能为空。");
      return;
    }

    // Use current selected group (or 未分组)
    const group =
      state.ui && state.ui.group && state.ui.group !== "all"
        ? state.ui.group
        : "未分组";
    const platform = guessPlatformByGroup(group);

    const fields = parseLineToFields(raw, { group, platform }) || {
      displayName: raw,
      account: "",
      club: "",
    };

    if (!fields.displayName) {
      showAlert(
        "操作失败",
        "无法解析该输入。请仅输入昵称/账号/俱乐部（每行一人）。",
      );
      return;
    }

    const nameKey = normalizeKey(fields.displayName);
    const accKey = fields.account
      ? `acc:${platform}|${normalizeKey(fields.account)}`
      : "";
    const exists = state.players.some((p) => {
      const nk = normalizeKey(p.displayName);
      if (nk === nameKey) return true;
      if (
        accKey &&
        p.account &&
        `acc:${normalizeWhitespace(p.platform)}|${normalizeKey(p.account)}` ===
          accKey
      )
        return true;
      return false;
    });

    if (exists) {
      showAlert("操作失败", "该选手已存在于列表中（按昵称或账号去重）。");
      return;
    }

    state.players.push(makePlayer(fields, { isNew: true, group, platform }));
    state.players.sort(comparePlayersForList);

    addPlayerNameInput.value = "";
    refreshCheckinUI();
    scheduleSave();
    showSnackbar("已添加选手（已标记为新人）", 2000);
  }

  // ------------------------------
  // Swipe gestures (Plan #7)
  // ------------------------------
  function setupSwipeGestures() {
    if (!playerList) return;

    let active = null;

    const threshold = 56; // px
    const maxVertical = 38;

    const getRowFromEvent = (e) => {
      const target = isElement(e.target) ? e.target : null;
      if (!target) return null;
      if (target.closest("button, input, textarea, select, a, label"))
        return null;
      const row = target.closest(".player-item");
      if (!row || !row.dataset || !row.dataset.playerId) return null;
      return row;
    };

    const onPointerDown = (e) => {
      // Only primary pointer
      if (e.button !== undefined && e.button !== 0) return;

      const row = getRowFromEvent(e);
      if (!row) return;

      active = {
        id: Number(row.dataset.playerId),
        row,
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        moved: false,
        pointerId: e.pointerId,
      };

      try {
        row.setPointerCapture && row.setPointerCapture(e.pointerId);
      } catch (_) {
        // ignore
      }
    };

    const onPointerMove = (e) => {
      if (!active) return;
      if (
        active.pointerId != null &&
        e.pointerId != null &&
        active.pointerId !== e.pointerId
      )
        return;

      const dx = e.clientX - active.startX;
      const dy = e.clientY - active.startY;

      active.lastX = e.clientX;
      active.lastY = e.clientY;

      if (Math.abs(dy) > maxVertical && Math.abs(dy) > Math.abs(dx)) {
        // treat as scroll
        active = null;
        return;
      }

      if (Math.abs(dx) > 8) {
        active.moved = true;
        // Small visual feedback
        active.row.style.transform = `translateX(${Math.max(-80, Math.min(80, dx))}px)`;
        active.row.style.transition = "none";
      }
    };

    const resetRow = (row) => {
      if (!row) return;
      row.style.transform = "";
      row.style.transition = "";
    };

    const onPointerUp = () => {
      if (!active) return;

      const row = active.row;
      const dx = active.lastX - active.startX;
      const dy = active.lastY - active.startY;

      resetRow(row);

      // Only treat as swipe when mainly horizontal
      if (
        active.moved &&
        Math.abs(dx) >= threshold &&
        Math.abs(dx) > Math.abs(dy) * 1.2
      ) {
        const pid = Number(active.id);
        if (Number.isFinite(pid)) {
          if (dx > 0)
            setCheckIn(pid, true); // right swipe => check-in
          else setCheckIn(pid, false); // left swipe => uncheck
        }
      }

      active = null;
    };

    // Pointer events are widely supported; fall back to touch events if missing
    if ("PointerEvent" in window) {
      playerList.addEventListener("pointerdown", onPointerDown, {
        passive: true,
      });
      playerList.addEventListener("pointermove", onPointerMove, {
        passive: true,
      });
      playerList.addEventListener("pointerup", onPointerUp, { passive: true });
      playerList.addEventListener("pointercancel", onPointerUp, {
        passive: true,
      });
    } else {
      // Touch fallback (very old iOS)
      let touchActive = null;

      playerList.addEventListener(
        "touchstart",
        (e) => {
          if (!e.touches || e.touches.length !== 1) return;
          const row = getRowFromEvent(e);
          if (!row) return;

          const t = e.touches[0];
          touchActive = {
            id: Number(row.dataset.playerId),
            row,
            startX: t.clientX,
            startY: t.clientY,
            lastX: t.clientX,
            lastY: t.clientY,
            moved: false,
          };
        },
        { passive: true },
      );

      playerList.addEventListener(
        "touchmove",
        (e) => {
          if (!touchActive || !e.touches || e.touches.length !== 1) return;
          const t = e.touches[0];
          const dx = t.clientX - touchActive.startX;
          const dy = t.clientY - touchActive.startY;

          touchActive.lastX = t.clientX;
          touchActive.lastY = t.clientY;

          if (Math.abs(dy) > maxVertical && Math.abs(dy) > Math.abs(dx)) {
            resetRow(touchActive.row);
            touchActive = null;
            return;
          }

          if (Math.abs(dx) > 8) {
            touchActive.moved = true;
            touchActive.row.style.transform = `translateX(${Math.max(-80, Math.min(80, dx))}px)`;
            touchActive.row.style.transition = "none";
          }
        },
        { passive: true },
      );

      playerList.addEventListener(
        "touchend",
        () => {
          if (!touchActive) return;
          const dx = touchActive.lastX - touchActive.startX;
          const dy = touchActive.lastY - touchActive.startY;
          resetRow(touchActive.row);

          if (
            touchActive.moved &&
            Math.abs(dx) >= threshold &&
            Math.abs(dx) > Math.abs(dy) * 1.2
          ) {
            const pid = Number(touchActive.id);
            if (Number.isFinite(pid)) {
              if (dx > 0) setCheckIn(pid, true);
              else setCheckIn(pid, false);
            }
          }
          touchActive = null;
        },
        { passive: true },
      );

      playerList.addEventListener(
        "touchcancel",
        () => {
          if (!touchActive) return;
          resetRow(touchActive.row);
          touchActive = null;
        },
        { passive: true },
      );
    }
  }

  // ------------------------------
  // Export
  // ------------------------------
  function populateExportGroupOptions() {
    if (!exportGroupSel) return;

    const previousValue = String(exportGroupSel.value || "current");
    exportGroupSel.innerHTML = "";

    const optCurrent = document.createElement("option");
    optCurrent.value = "current";
    optCurrent.textContent = "当前筛选";
    exportGroupSel.appendChild(optCurrent);

    const optAll = document.createElement("option");
    optAll.value = "all";
    optAll.textContent = "全部组别";
    exportGroupSel.appendChild(optAll);

    const groups = getAllGroupsFromPlayers();
    for (const g of groups) {
      const opt = document.createElement("option");
      opt.value = g;
      opt.textContent = g;
      exportGroupSel.appendChild(opt);
    }

    const hasPreviousValue = Array.from(exportGroupSel.options).some(
      (opt) => opt.value === previousValue,
    );
    exportGroupSel.value = hasPreviousValue ? previousValue : "current";
  }

  function getExportSettings() {
    const group = exportGroupSel
      ? String(exportGroupSel.value || "current")
      : "current";
    const scope = exportScopeSel
      ? String(exportScopeSel.value || "all")
      : "all";
    const order = exportOrderSel
      ? String(exportOrderSel.value || "uncheckedFirst")
      : "uncheckedFirst";

    const withGroup = exportWithGroupEl
      ? Boolean(exportWithGroupEl.checked)
      : false;
    const withPlatform = exportWithPlatformEl
      ? Boolean(exportWithPlatformEl.checked)
      : false;
    const withAccount = exportWithAccountEl
      ? Boolean(exportWithAccountEl.checked)
      : true;
    const withClub = exportWithClubEl
      ? Boolean(exportWithClubEl.checked)
      : false;
    const withTime = exportWithTimeEl
      ? Boolean(exportWithTimeEl.checked)
      : true;

    return {
      group,
      scope,
      order,
      withGroup,
      withPlatform,
      withAccount,
      withClub,
      withTime,
    };
  }

  function getExportBasePlayers(settings) {
    const s = settings || getExportSettings();

    let list = Array.isArray(state.players) ? state.players.slice() : [];

    // group selection
    let group = s.group || "current";
    if (group === "current") {
      group = state.ui && state.ui.group ? state.ui.group : "all";
    }

    if (group && group !== "all") {
      list = list.filter((p) => p.group === group);
    }

    return list;
  }

  function getExportViewPlayers(settings) {
    const s = settings || getExportSettings();
    let list = getExportBasePlayers(s);

    // scope filter
    if (s.scope === "checked") list = list.filter((p) => p.checkedIn);
    else if (s.scope === "unchecked") list = list.filter((p) => !p.checkedIn);

    const stable = (cmp) =>
      list
        .map((p, idx) => ({ p, idx }))
        .sort((a, b) => cmp(a.p, b.p) || a.idx - b.idx)
        .map((x) => x.p);

    if (s.order === "checkedFirst") {
      list = stable((a, b) => (b.checkedIn ? 1 : 0) - (a.checkedIn ? 1 : 0));
    } else if (s.order === "uncheckedFirst") {
      list = stable((a, b) => (a.checkedIn ? 1 : 0) - (b.checkedIn ? 1 : 0));
    } else if (s.order === "groupThenName") {
      list = stable(comparePlayersForList);
    }

    return list;
  }

  function buildExportHtml(viewPlayers, settings) {
    const s = settings || getExportSettings();
    const players = Array.isArray(viewPlayers) ? viewPlayers : [];

    const totalAll = state.players.length;
    const checkedAll = state.players.filter((p) => p.checkedIn).length;
    const total = players.length;
    const checkedIn = players.filter((p) => p.checkedIn).length;

    const title = escapeHtml(state.competitionName || "比赛签到表");
    const stats = `当前导出：${total}　|　已签到：${checkedIn}　|　等待中：${total - checkedIn}  （总表：${totalAll} / 已签到：${checkedAll}）`;

    // Build columns
    const cols = [];
    cols.push({ key: "index", label: "#", width: "72px" });
    cols.push({ key: "displayName", label: "昵称/姓名" });

    if (s.withAccount) cols.push({ key: "account", label: "账号" });
    if (s.withClub) cols.push({ key: "club", label: "俱乐部" });
    if (s.withPlatform) cols.push({ key: "platform", label: "平台" });
    if (s.withGroup) cols.push({ key: "group", label: "组别" });

    cols.push({ key: "status", label: "签到状态", width: "140px" });
    if (s.withTime)
      cols.push({ key: "time", label: "签到时间", width: "120px" });
    cols.push({ key: "isNew", label: "新人", width: "72px" });

    const ths = cols
      .map((c) => {
        const w = c.width ? ` style="width:${c.width};"` : "";
        return `<th${w}>${escapeHtml(c.label)}</th>`;
      })
      .join("");

    const rows = players
      .map((p, idx) => {
        const cells = cols
          .map((c) => {
            if (c.key === "index") return `<td>${idx + 1}</td>`;
            if (c.key === "displayName")
              return `<td>${escapeHtml(p.displayName)}</td>`;
            if (c.key === "account")
              return `<td>${escapeHtml(p.account || "")}</td>`;
            if (c.key === "club") return `<td>${escapeHtml(p.club || "")}</td>`;
            if (c.key === "platform")
              return `<td>${escapeHtml((p.platform || "").toUpperCase())}</td>`;
            if (c.key === "group")
              return `<td>${escapeHtml(p.group || "")}</td>`;
            if (c.key === "status") {
              const status = p.checkedIn ? "✔ 已签到" : "等待中";
              const statusClass = p.checkedIn
                ? 'style="color: var(--md-sys-color-primary); font-weight: 800;"'
                : 'style="opacity:.85"';
              return `<td ${statusClass}>${escapeHtml(status)}</td>`;
            }
            if (c.key === "time") {
              const t =
                p.checkedIn && p.checkedInAt ? formatTime(p.checkedInAt) : "";
              return `<td>${escapeHtml(t)}</td>`;
            }
            if (c.key === "isNew") {
              return `<td>${p.isNew ? '<span class="export-new-tag">是</span>' : ""}</td>`;
            }
            return `<td></td>`;
          })
          .join("");

        return `<tr>${cells}</tr>`;
      })
      .join("");

    return `
      <h4 class="export-title">${title}</h4>
      <div class="export-stats">${escapeHtml(stats)}</div>
      <table class="export-table">
        <thead><tr>${ths}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  function renderExportPreview() {
    if (!exportContainer) return;
    const settings = getExportSettings();
    const players = getExportViewPlayers(settings);
    exportContainer.innerHTML = buildExportHtml(players, settings);
  }

  function generateFinalTable(options = {}) {
    if (!exportContainer) return;
    if (!prepareExportPreview()) return;
    showExportModal(options);
  }

  function ensureScoreHelper() {
    state.scoreHelper = sanitizeScoreHelper(state.scoreHelper);
    return state.scoreHelper;
  }

  function getActiveScoreRound() {
    const helper = ensureScoreHelper();
    const index = Math.max(0, Math.min(helper.roundCount - 1, helper.activeRound - 1));
    return helper.rounds[index] || helper.rounds[0];
  }

  function setScoreRoundCount(nextCount) {
    const helper = ensureScoreHelper();
    const count = Math.max(1, Math.min(9, Math.trunc(Number(nextCount) || helper.roundCount || 5)));
    const nextRounds = [];
    for (let i = 0; i < count; i++) {
      const existing = helper.rounds[i];
      nextRounds.push(
        existing
          ? sanitizeScoreRound({ ...existing, round: i + 1 }, i + 1)
          : { round: i + 1, pending: [], manualPending: [], completed: [] },
      );
    }
    helper.roundCount = count;
    helper.rounds = nextRounds;
    helper.activeRound = Math.max(1, Math.min(count, helper.activeRound || 1));
    helper.updatedAt = now();
  }

  function scoreItemSummary(item) {
    const sender = normalizeWhitespace(item && item.sender) || "发图者未识别";
    const loserStoneCount =
      item && Number.isFinite(Number(item.loserStoneCount))
        ? String(Math.trunc(Number(item.loserStoneCount)))
        : "待判定";
    return `${sender}　输者子数：${loserStoneCount}`;
  }

  function renderScoreItem(item, index, mode) {
    const isDone = mode === "completed";
    const isManual = mode === "manualPending";
    const title = scoreItemSummary(item);
    const meta = [
      item.sourceTime ? `时间 ${escapeHtml(item.sourceTime)}` : "",
      item.verdict ? `状态 ${escapeHtml(item.verdict)}` : "",
      item.confidence ? `置信 ${escapeHtml(item.confidence)}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    const actions =
      mode === "pending"
        ? `<div class="score-card__actions">
            <button class="score-card__btn score-card__btn--primary" type="button" data-score-action="complete" data-score-mode="pending" data-score-index="${index}">登记</button>
            <button class="score-card__btn" type="button" data-score-action="manual-pending" data-score-mode="pending" data-score-index="${index}">暂缓</button>
          </div>`
        : mode === "completed"
          ? `<div class="score-card__actions">
              <button class="score-card__btn" type="button" data-score-action="manual-pending" data-score-mode="completed" data-score-index="${index}">暂缓</button>
            </div>`
          : `<div class="score-card__actions">
              <button class="score-card__btn score-card__btn--primary" type="button" data-score-action="restore-pending" data-score-mode="manualPending" data-score-index="${index}">移回待登记</button>
              <button class="score-card__btn" type="button" data-score-action="complete" data-score-mode="manualPending" data-score-index="${index}">登记</button>
            </div>`;
    return `
      <article class="score-card ${index === 0 && mode === "pending" ? "score-card--active" : ""} ${isManual ? "score-card--manual" : ""}">
        <div class="score-card__index">${isDone ? "✓" : isManual ? "P" : index + 1}</div>
        <div class="score-card__main">
          <div class="score-card__title">${escapeHtml(title)}</div>
          <div class="score-card__detail">选手：${escapeHtml(item.sender || "")}</div>
          ${meta ? `<div class="score-card__meta">${meta}</div>` : ""}
          ${item.resultText ? `<div class="score-card__note">${escapeHtml(item.resultText)}</div>` : ""}
          ${actions}
        </div>
      </article>
    `;
  }

  function renderScoreHelper() {
    if (!stepScoreHelper) return;
    const helper = ensureScoreHelper();
    const activeRound = getActiveScoreRound();
    if (scoreHelperTitle)
      scoreHelperTitle.textContent = state.competitionName || "比分登记辅助";
    if (scoreRoundCountInput) scoreRoundCountInput.value = String(helper.roundCount);

    if (scoreRoundTabs) {
      scoreRoundTabs.innerHTML = helper.rounds
        .map((round) => {
          const pending = round.pending.length;
          const manualPending = Array.isArray(round.manualPending)
            ? round.manualPending.length
            : 0;
          const completed = round.completed.length;
          const active = round.round === helper.activeRound;
          return `<button class="seg-btn" type="button" role="tab" aria-selected="${active ? "true" : "false"}" data-round="${round.round}">第 ${round.round} 轮 <span>${pending}+${manualPending}/${pending + manualPending + completed}</span></button>`;
        })
        .join("");
    }

    if (scoreHelperSummary) {
      const pending = activeRound.pending.length;
      const manualPending = Array.isArray(activeRound.manualPending)
        ? activeRound.manualPending.length
        : 0;
      const completed = activeRound.completed.length;
      scoreHelperSummary.textContent = `第 ${activeRound.round} 轮：待登记 ${pending}，手动 pending ${manualPending}，已登记 ${completed}。按 Enter 默认完成主待登记最上面一条。`;
    }

    if (scorePendingList) {
      scorePendingList.innerHTML = activeRound.pending.length
        ? activeRound.pending.map((item, index) => renderScoreItem(item, index, "pending")).join("")
        : `<div class="empty-state empty-state--list"><svg class="empty-state__icon" aria-hidden="true"><use href="#i-done-all"></use></svg><div><div class="empty-state__title">当前轮没有待登记截图</div><div class="empty-state__text">agent 识别后会写入共享 JSON，并显示在这里。</div></div></div>`;
    }

    if (scoreManualPendingList) {
      const manualPending = Array.isArray(activeRound.manualPending)
        ? activeRound.manualPending
        : [];
      scoreManualPendingList.innerHTML = manualPending.length
        ? manualPending.map((item, index) => renderScoreItem(item, index, "manualPending")).join("")
        : `<div class="score-manual-pending__empty">没有手动 pending 项</div>`;
    }

    if (scoreCompletedList) {
      scoreCompletedList.innerHTML = activeRound.completed.length
        ? activeRound.completed.map((item, index) => renderScoreItem(item, index, "completed")).join("")
        : `<div class="score-completed__empty">还没有登记完成项</div>`;
    }
  }

  function enterScoreHelper() {
    ensureScoreHelper();
    state.step = "score-helper";
    viewStepOverride = null;
    applyStepUI();
    renderScoreHelper();
    scheduleSave();
  }

  function returnToCheckinFromScoreHelper() {
    state.step = "checkin";
    viewStepOverride = null;
    applyStepUI();
    refreshCheckinUI();
    scheduleSave();
  }

  function completeTopScoreItem() {
    if (!completeScoreItem("pending", 0)) {
      showSnackbar("当前轮没有待登记项", 1800);
    }
  }

  function scoreItemBucket(round, mode) {
    if (!round) return null;
    if (mode === "pending") return round.pending;
    if (mode === "manualPending") return round.manualPending;
    if (mode === "completed") return round.completed;
    return null;
  }

  function completeScoreItem(mode, index) {
    const helper = ensureScoreHelper();
    const round = getActiveScoreRound();
    const source = scoreItemBucket(round, mode);
    const idx = Math.trunc(Number(index));
    if (!Array.isArray(source) || !Number.isFinite(idx) || idx < 0 || idx >= source.length) {
      return false;
    }
    const snapshot = captureUndoSnapshot();
    const item = source.splice(idx, 1)[0];
    item.registeredAt = now();
    item.manualPendingAt = null;
    round.completed.unshift(item);
    helper.updatedAt = now();
    renderScoreHelper();
    scheduleSave();
    showUndoSnackbar(`已登记：${scoreItemSummary(item)}`, () => {
      restoreUndoSnapshot(snapshot);
      showSnackbar("已撤销登记", 1800);
    });
    return true;
  }

  function moveScoreItemToManualPending(mode, index) {
    const helper = ensureScoreHelper();
    const round = getActiveScoreRound();
    const source = scoreItemBucket(round, mode);
    const idx = Math.trunc(Number(index));
    if (!Array.isArray(source) || !Number.isFinite(idx) || idx < 0 || idx >= source.length) {
      showSnackbar("没有找到该比分项", 1800);
      return;
    }
    const snapshot = captureUndoSnapshot();
    const item = source.splice(idx, 1)[0];
    item.registeredAt = null;
    item.manualPendingAt = now();
    if (!Array.isArray(round.manualPending)) round.manualPending = [];
    round.manualPending.unshift(item);
    helper.updatedAt = now();
    renderScoreHelper();
    scheduleSave();
    showUndoSnackbar(`已移入手动 pending：${scoreItemSummary(item)}`, () => {
      restoreUndoSnapshot(snapshot);
      showSnackbar("已撤销暂缓", 1800);
    });
  }

  function restoreScoreItemToPending(index) {
    const helper = ensureScoreHelper();
    const round = getActiveScoreRound();
    const source = Array.isArray(round && round.manualPending)
      ? round.manualPending
      : [];
    const idx = Math.trunc(Number(index));
    if (!Number.isFinite(idx) || idx < 0 || idx >= source.length) {
      showSnackbar("没有找到该 pending 项", 1800);
      return;
    }
    const snapshot = captureUndoSnapshot();
    const item = source.splice(idx, 1)[0];
    item.manualPendingAt = null;
    round.pending.unshift(item);
    helper.updatedAt = now();
    renderScoreHelper();
    scheduleSave();
    showUndoSnackbar(`已移回待登记：${scoreItemSummary(item)}`, () => {
      restoreUndoSnapshot(snapshot);
      showSnackbar("已撤销移回", 1800);
    });
  }

  function handleScoreItemAction(e) {
    const target = isElement(e.target) ? e.target : null;
    const btn = target && target.closest("button[data-score-action]");
    if (!btn) return;
    const action = btn.dataset.scoreAction;
    const mode = btn.dataset.scoreMode || "";
    const index = Number(btn.dataset.scoreIndex);
    if (action === "complete") completeScoreItem(mode, index);
    else if (action === "manual-pending") moveScoreItemToManualPending(mode, index);
    else if (action === "restore-pending") restoreScoreItemToPending(index);
  }

  function makeSafeFilename(name) {
    const base = normalizeWhitespace(name || "比赛签到表") || "比赛签到表";
    return (
      base
        .replace(/[\\\/:*?"<>|]/g, "_")
        .replace(/[\u0000-\u001F]/g, "_")
        .replace(/\s+/g, "_")
        .slice(0, 80) || "比赛签到表"
    );
  }

  function supportsAnchorDownload() {
    const a = document.createElement("a");
    return typeof a.download === "string";
  }

  function isStandaloneMode() {
    return (
      (window.matchMedia &&
        window.matchMedia("(display-mode: standalone)").matches) ||
      window.navigator.standalone === true
    );
  }

  function getUA() {
    return String(window.navigator.userAgent || "");
  }

  function isWeChat() {
    return /MicroMessenger/i.test(getUA());
  }

  function isQQInApp() {
    const ua = getUA();
    return /\bQQ\//i.test(ua) && !/QQBrowser/i.test(ua);
  }

  function isWeCom() {
    return /wxwork/i.test(getUA());
  }

  function isWeibo() {
    return /Weibo/i.test(getUA());
  }

  function isDingTalk() {
    return /DingTalk/i.test(getUA());
  }

  function isAlipay() {
    return /AlipayClient/i.test(getUA());
  }

  function isFeishu() {
    return /Feishu|Lark/i.test(getUA());
  }

  function isBaiduBoxApp() {
    return /baiduboxapp/i.test(getUA());
  }

  function isXiaohongshu() {
    return /XiaoHongShu|xiaohongshu|xhsapp|xhs\//i.test(getUA());
  }

  function isDouyinInApp() {
    return /Aweme|Douyin/i.test(getUA());
  }

  function isToutiaoInApp() {
    return /NewsArticle|Toutiao|BytedanceWebview/i.test(getUA());
  }

  function isKuaishouInApp() {
    return /Kwai|KUAISHOU/i.test(getUA());
  }

  function isBilibiliInApp() {
    return /BiliApp/i.test(getUA());
  }

  function getInAppBrowserName() {
    if (isWeChat()) return "微信";
    if (isWeCom()) return "企业微信";
    if (isQQInApp()) return "QQ";
    if (isWeibo()) return "微博";
    if (isDingTalk()) return "钉钉";
    if (isAlipay()) return "支付宝";
    if (isFeishu()) return "飞书/Lark";
    if (isBaiduBoxApp()) return "百度";
    if (isXiaohongshu()) return "小红书";
    if (isDouyinInApp()) return "抖音";
    if (isToutiaoInApp()) return "今日头条";
    if (isKuaishouInApp()) return "快手";
    if (isBilibiliInApp()) return "哔哩哔哩";
    return "内置浏览器";
  }

  function isLikelyInAppBrowser() {
    // These webviews are common among Mainland CN users and may limit
    // downloads / PWA installation / clipboard APIs.
    return (
      isWeChat() ||
      isWeCom() ||
      isQQInApp() ||
      isWeibo() ||
      isDingTalk() ||
      isAlipay() ||
      isFeishu() ||
      isBaiduBoxApp() ||
      isXiaohongshu() ||
      isDouyinInApp() ||
      isToutiaoInApp() ||
      isKuaishouInApp() ||
      isBilibiliInApp()
    );
  }

  async function copyCurrentPageUrl() {
    const href = normalizeWhitespace(
      (window.location && window.location.href) || "",
    );
    if (!href) {
      showSnackbar("无法读取当前链接，请手动复制地址栏网址。", 2600);
      return false;
    }

    try {
      if (
        navigator.clipboard &&
        typeof navigator.clipboard.writeText === "function"
      ) {
        await navigator.clipboard.writeText(href);
        showSnackbar("已复制当前链接，可粘贴到系统浏览器打开。", 2600);
        return true;
      }
    } catch (e) {
      console.warn("复制链接失败（Clipboard API）：", e);
    }

    try {
      const ta = document.createElement("textarea");
      ta.value = href;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      const copied = document.execCommand("copy");
      document.body.removeChild(ta);
      if (copied) {
        showSnackbar("已复制当前链接，可粘贴到系统浏览器打开。", 2600);
        return true;
      }
    } catch (e) {
      console.warn("复制链接失败（execCommand）：", e);
    }

    showManualCopyDialog(href);
    return false;
  }

  function showInAppBrowserGuide(appName, prefKey) {
    const ios = isIOS();
    const platformBrowser = ios ? "Safari" : "Chrome/Edge";
    const message = [
      `检测到你正在使用 ${appName} 内置浏览器，可能出现以下限制：`,
      "1) 下载 CSV/PNG/JSON 可能被拦截",
      "2) “添加到主屏幕”入口可能不可用",
      "",
      "建议操作：",
      "• 先点击「复制当前链接」",
      `• 粘贴到系统浏览器（${platformBrowser}）再打开`,
      "• 导出时优先使用“复制文本”可避免下载拦截",
    ].join("\n");

    showDialog({
      title: "内置浏览器使用提示",
      message,
      buttons: [
        {
          label: "复制当前链接",
          className: "btn btn-tonal",
          onClick: () => {
            copyCurrentPageUrl();
            return false;
          },
        },
        {
          label: "不再提示",
          className: "btn btn-outlined",
          onClick: () => {
            safeLocalStorageSet(prefKey, "1");
            showSnackbar("已关闭内置浏览器提示（仍可在帮助中查看）", 2400);
          },
        },
        { label: "关闭", className: "btn btn-filled" },
      ],
    });
  }

  function maybeShowInAppBrowserTipOnce() {
    try {
      const ua = getUA();
      const isMobile = /Android|iPhone|iPad|iPod/i.test(ua);
      if (!isMobile) return;
      if (!isLikelyInAppBrowser()) return;

      const KEY = "checkin_assistant_inapp_tip_v1";
      if (safeLocalStorageGet(KEY)) return;

      const appName = getInAppBrowserName();

      showSnackbar(
        `检测到${appName}内置浏览器：若下载失败或无法添加到桌面，可点“查看方法”。`,
        9000,
        "查看方法",
        () => {
          showInAppBrowserGuide(appName, KEY);
        },
      );
    } catch (e) {
      // No-op
    }
  }

  function isLikelyMobileDevice() {
    try {
      const ua = getUA();
      if (/Android|iPhone|iPad|iPod/i.test(ua)) return true;

      const touchPoints = Number(window.navigator.maxTouchPoints) || 0;
      const coarse =
        window.matchMedia &&
        window.matchMedia("(pointer: coarse) and (hover: none)").matches;
      const minSide = Math.min(
        Number(window.innerWidth) || 0,
        Number(window.innerHeight) || 0,
      );
      return Boolean(touchPoints > 1 && coarse && minSide > 0 && minSide <= 1024);
    } catch (_) {
      return false;
    }
  }

  function isIOS() {
    const ua = getUA();
    const platform = String(
      (window.navigator.userAgentData &&
        window.navigator.userAgentData.platform) ||
        window.navigator.platform ||
        "",
    );
    const iDevice = /iPhone|iPad|iPod/i.test(ua);
    const macLike = /Mac/i.test(platform) || /\bMacintosh\b|\bMac OS X\b/i.test(ua);
    const touchPoints = Number(window.navigator.maxTouchPoints) || 0;
    const definitelyNotApple = /Windows|Win32|Win64|Android|Linux/i.test(
      `${ua} ${platform}`,
    );
    const iPadOS = !definitelyNotApple && macLike && touchPoints > 1;
    return iDevice || iPadOS;
  }

  function canDirectDownloadInCurrentBrowser() {
    const mobileRestrictedInApp = isLikelyInAppBrowser() && isLikelyMobileDevice();
    return supportsAnchorDownload() && !isIOS() && !mobileRestrictedInApp;
  }

  function shouldOpenPNGPreviewWindow() {
    return !canDirectDownloadInCurrentBrowser();
  }

  function triggerAnchorDownload(url, filename) {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.rel = "noopener";
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    window.setTimeout(() => {
      if (link.parentNode) link.parentNode.removeChild(link);
    }, 0);
  }

  function triggerObjectUrlDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const inApp = isLikelyInAppBrowser();
    const canDirectDownload = canDirectDownloadInCurrentBrowser();

    if (canDirectDownload) {
      triggerAnchorDownload(url, filename);
      window.setTimeout(() => URL.revokeObjectURL(url), 2000);
      return "download";
    }

    const opened = window.open(url, "_blank");
    if (!opened) triggerAnchorDownload(url, filename);
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
    if (opened) return "open";
    return inApp ? "inapp" : "download";
  }

  function canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
      if (!canvas || typeof canvas.toBlob !== "function") {
        resolve(null);
        return;
      }
      try {
        canvas.toBlob((blob) => resolve(blob || null), "image/png");
      } catch (e) {
        reject(e);
      }
    });
  }

  function fitTextToWidth(ctx, text, maxWidth) {
    const raw = String(text ?? "");
    if (!raw) return "";
    if (ctx.measureText(raw).width <= maxWidth) return raw;

    let out = raw;
    while (out.length > 1 && ctx.measureText(out + "…").width > maxWidth) {
      out = out.slice(0, -1);
    }
    return out + "…";
  }

  function buildExportCanvasFromData(viewPlayers, settings, options) {
    const s = settings || getExportSettings();
    const opts = options || {};
    const safeIOS = Boolean(opts.safeIOS);
    const players = Array.isArray(viewPlayers) ? viewPlayers : [];
    const title = state.competitionName || "比赛签到表";
    const total = players.length;
    const checkedIn = players.filter((p) => p.checkedIn).length;

    const width = safeIOS ? 1000 : 1280;
    const marginX = safeIOS ? 28 : 40;
    const marginY = safeIOS ? 24 : 30;
    const titleH = safeIOS ? 44 : 48;
    const statsH = safeIOS ? 28 : 28;
    const headerH = safeIOS ? 40 : 44;
    const rowH = safeIOS ? 36 : 40;
    const noteH = safeIOS ? 56 : 34;
    const bottomPad = safeIOS ? 22 : 26;
    const maxCanvasHeight = safeIOS ? 3600 : 32760;

    const tableY = marginY + titleH + statsH + 14;
    const reserved = headerH + bottomPad + noteH;
    const maxRows = Math.max(
      1,
      Math.floor((maxCanvasHeight - tableY - reserved) / rowH),
    );
    const visiblePlayers = players.slice(0, maxRows);
    const truncated = players.length > visiblePlayers.length;
    const noteRows = truncated ? 1 : 0;

    const height =
      tableY +
      headerH +
      visiblePlayers.length * rowH +
      noteRows * noteH +
      bottomPad;

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = Math.max(height, 240);

    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法获取 Canvas 2D 上下文");

    const fontFamily =
      '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif';

    // Background
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Title
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#1F2937";
    ctx.font = `${safeIOS ? "700 28px" : "700 30px"} ${fontFamily}`;
    ctx.fillText(title, width / 2, marginY + 20);

    // Stats
    ctx.textAlign = "left";
    ctx.fillStyle = "#4B5563";
    ctx.font = `${safeIOS ? "500 17px" : "500 18px"} ${fontFamily}`;
    ctx.fillText(
      `总人数：${total}  |  已签到：${checkedIn}  |  等待中：${total - checkedIn}`,
      marginX,
      marginY + titleH,
    );

    const tableX = marginX;
    const tableW = width - marginX * 2;
    const colIndexW = 88;
    const colStatusW = s.withTime ? 260 : 220;
    const colNameW = tableW - colIndexW - colStatusW;

    // Header
    ctx.fillStyle = "#F3F4F6";
    ctx.fillRect(tableX, tableY, tableW, headerH);

    ctx.fillStyle = "#111827";
    ctx.font = `${safeIOS ? "700 17px" : "700 18px"} ${fontFamily}`;
    ctx.textAlign = "center";
    ctx.fillText("#", tableX + colIndexW / 2, tableY + headerH / 2);
    ctx.textAlign = "left";
    ctx.fillText("选手信息", tableX + colIndexW + 12, tableY + headerH / 2);
    ctx.fillText(
      "签到状态",
      tableX + colIndexW + colNameW + 12,
      tableY + headerH / 2,
    );

    // Rows
    ctx.font = `${safeIOS ? "500 16px" : "500 17px"} ${fontFamily}`;
    for (let i = 0; i < visiblePlayers.length; i++) {
      const p = visiblePlayers[i];
      const y = tableY + headerH + i * rowH;
      const rowIsEven = i % 2 === 0;
      ctx.fillStyle = rowIsEven ? "#FFFFFF" : "#FAFAFA";
      ctx.fillRect(tableX, y, tableW, rowH);

      // Row border
      ctx.strokeStyle = "#E5E7EB";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(tableX, y + rowH);
      ctx.lineTo(tableX + tableW, y + rowH);
      ctx.stroke();

      // Name cell: include optional info in one line
      let nameRaw = p.displayName;
      const info = [];
      if (s.withAccount && p.account) info.push(p.account);
      if (s.withClub && p.club) info.push(`俱乐部:${p.club}`);
      if (s.withGroup && p.group) info.push(`组:${p.group}`);
      if (s.withPlatform && p.platform) info.push(p.platform.toUpperCase());
      if (p.isNew) info.push("新人");

      if (info.length) nameRaw = `${nameRaw}（${info.join(" · ")}）`;
      const name = fitTextToWidth(ctx, nameRaw, colNameW - 24);

      ctx.fillStyle = "#111827";
      ctx.textAlign = "center";
      ctx.fillText(String(i + 1), tableX + colIndexW / 2, y + rowH / 2);

      ctx.textAlign = "left";
      ctx.fillStyle = "#111827";
      ctx.fillText(name, tableX + colIndexW + 12, y + rowH / 2);

      ctx.fillStyle = p.checkedIn ? "#059669" : "#6B7280";
      const statusText = p.checkedIn ? "已签到" : "等待中";
      const t =
        s.withTime && p.checkedIn && p.checkedInAt
          ? ` ${formatTime(p.checkedInAt)}`
          : "";
      ctx.fillText(
        statusText + t,
        tableX + colIndexW + colNameW + 12,
        y + rowH / 2,
      );
    }

    // Outer border
    const rowsHeight = headerH + visiblePlayers.length * rowH;
    ctx.strokeStyle = "#D1D5DB";
    ctx.lineWidth = 1;
    ctx.strokeRect(tableX + 0.5, tableY + 0.5, tableW - 1, rowsHeight - 1);

    if (truncated) {
      const noteY = tableY + rowsHeight + Math.floor(noteH / 2);
      ctx.textAlign = "left";
      ctx.fillStyle = "#B45309";
      ctx.font = `${safeIOS ? "600 15px" : "600 16px"} ${fontFamily}`;
      const note = safeIOS
        ? `iOS 兼容模式：PNG 仅导出前 ${visiblePlayers.length} 人，完整数据请用 CSV。`
        : `名单较长，PNG 仅导出前 ${visiblePlayers.length} 人（完整数据请用 CSV）。`;
      ctx.fillText(fitTextToWidth(ctx, note, tableW), tableX, noteY);
    }

    return canvas;
  }

  function openPNGPreviewWindow() {
    try {
      const win = window.open("", "_blank");
      if (!win) return null;
      win.document.open();
      win.document.write(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>签到表图片</title>
  <style>
    body{margin:0;padding:18px;background:#f8fafc;color:#111827;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
    .tip{position:sticky;top:0;margin:-18px -18px 16px;padding:14px 18px;background:#fff7ed;border-bottom:1px solid #fed7aa;font-size:15px;line-height:1.5}
    .actions{display:flex;gap:12px;justify-content:center;flex-wrap:wrap;margin:0 0 16px}
    .btn{display:inline-flex;align-items:center;justify-content:center;padding:10px 16px;border:0;border-radius:999px;background:#111827;color:#fff;text-decoration:none;font-size:14px;font-weight:700;cursor:pointer}
    .wrap{display:flex;justify-content:center}
    img{max-width:100%;height:auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;box-shadow:0 10px 30px rgba(15,23,42,.12)}
  </style>
</head>
<body>
  <div class="tip">正在生成图片…如果稍后显示图片，可直接下载，或长按/右键图片保存。</div>
  <div class="actions">
    <button class="btn" id="png-back" type="button">返回主签到界面</button>
    <a class="btn" id="png-download" href="#" download="签到表.png">下载 PNG</a>
  </div>
  <div class="wrap"><img id="png-preview" alt="签到表图片" /></div>
</body>
</html>`);
      const backBtn = win.document.getElementById("png-back");
      if (backBtn) {
        backBtn.addEventListener("click", () => {
          try {
            if (win.opener && !win.opener.closed) {
              win.opener.focus();
            }
          } catch (e) {
            // ignore
          }
          try {
            win.close();
          } catch (e) {
            // ignore
          }
        });
      }
      win.document.close();
      return win;
    } catch (e) {
      return null;
    }
  }

  function renderPNGPreviewWindow(win, imageUrl, filename) {
    if (!win || !imageUrl) return false;
    try {
      const doc = win.document;
      const tip = doc.querySelector(".tip");
      const img = doc.getElementById("png-preview");
      const downloadLink = doc.getElementById("png-download");
      if (tip) {
        tip.textContent =
          "图片已生成。可点击“下载 PNG”，或长按/右键图片保存。";
      }
      if (img) img.src = imageUrl;
      if (downloadLink) {
        downloadLink.href = imageUrl;
        if (filename) downloadLink.download = filename;
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  function closePNGPreviewWindow(win) {
    if (!win) return;
    try {
      win.close();
    } catch (e) {
      // ignore
    }
  }

  async function saveCanvasAsPNG(canvas, filename, previewWindow) {
    const inApp = isLikelyInAppBrowser();
    const canDirectDownload = canDirectDownloadInCurrentBrowser();

    if (isIOS() && previewWindow) {
      const dataUrl = canvas.toDataURL("image/png");
      if (renderPNGPreviewWindow(previewWindow, dataUrl, filename)) return "preview";
    }

    const blob = await canvasToBlob(canvas);

    if (blob) {
      const url = URL.createObjectURL(blob);
      if (canDirectDownload) {
        triggerAnchorDownload(url, filename);
        window.setTimeout(() => URL.revokeObjectURL(url), 4000);
        return "download";
      }

      if (previewWindow && renderPNGPreviewWindow(previewWindow, url, filename)) {
        return "preview";
      }

      const opened = window.open(url, "_blank");
      if (!opened) triggerAnchorDownload(url, filename);
      if (!isIOS()) window.setTimeout(() => URL.revokeObjectURL(url), 4000);
      if (opened) return "open";
      return inApp ? "inapp" : "download";
    }

    const dataUrl = canvas.toDataURL("image/png");
    if (canDirectDownload) {
      triggerAnchorDownload(dataUrl, filename);
      return "download";
    }

    if (previewWindow && renderPNGPreviewWindow(previewWindow, dataUrl, filename)) {
      return "preview";
    }

    const opened = window.open(dataUrl, "_blank");
    if (!opened) triggerAnchorDownload(dataUrl, filename);
    if (opened) return "open";
    return inApp ? "inapp" : "download";
  }

  function notifyPNGResult(mode, compatMode = false) {
    if (mode === "inapp") {
      showSnackbar(
        "内置浏览器可能拦截图片下载；若未成功，请改用“复制文本”或右上角“在浏览器打开”。",
        3800,
      );
      return;
    }
    if (mode === "open") {
      showSnackbar(
        compatMode
          ? "已使用兼容模式生成 PNG，请在新窗口长按/右键另存为图片"
          : "PNG 已打开，请长按/右键另存为图片",
        3400,
      );
      return;
    }
    if (mode === "preview") {
      showSnackbar("PNG 已在新页面显示，请长按图片保存到相册。", 3600);
      return;
    }
    showSnackbar(
      compatMode ? "已使用兼容模式导出 PNG" : "已开始下载 PNG",
      2400,
    );
  }

  function setBtnBusy(btn, busy, labelWhenBusy, labelWhenIdle) {
    if (!btn) return;
    btn.disabled = Boolean(busy);
    btn.classList.toggle("is-loading", Boolean(busy));
    if (busy) btn.setAttribute("aria-busy", "true");
    else btn.removeAttribute("aria-busy");

    // Do not remove potential icons (we don't use icons inside here but keep safe)
    if (labelWhenBusy || labelWhenIdle) {
      const labelNode = btn.querySelector(".btn__label") || btn;
      if (labelNode) {
        if (busy && labelWhenBusy) labelNode.textContent = labelWhenBusy;
        if (!busy && labelWhenIdle) labelNode.textContent = labelWhenIdle;
      }
    }
  }

  async function captureExportPreviewCanvas(node) {
    if (typeof window.html2canvas !== "function") {
      throw new Error("html2canvas 未加载");
    }

    let clone = null;
    try {
      // Clone to avoid cropping due to scroll
      clone = node.cloneNode(true);
      clone.style.position = "absolute";
      clone.style.left = "-9999px";
      clone.style.top = "0";
      clone.style.width =
        Math.max(node.offsetWidth, node.scrollWidth, 320) + "px";
      clone.style.maxHeight = "none";
      clone.style.overflow = "visible";
      clone.style.background = "#ffffff";

      // Remove media nodes which may introduce cross-origin taint unexpectedly.
      clone
        .querySelectorAll("img,video,canvas,iframe,object,embed")
        .forEach((el) => el.remove());
      const allNodes = [clone, ...clone.querySelectorAll("*")];
      allNodes.forEach((el) => {
        if (isHTMLElement(el)) {
          el.style.backgroundImage = "none";
          el.style.maskImage = "none";
          el.style.webkitMaskImage = "none";
        }
      });

      document.body.appendChild(clone);
      await new Promise((r) => setTimeout(r, 80));

      const width = Math.max(clone.scrollWidth, clone.offsetWidth, 320);
      const height = Math.max(clone.scrollHeight, clone.offsetHeight, 180);

      // Keep canvas under common browser limits to reduce export failure on large lists.
      const sideLimit = 8192;
      const areaLimit = 16_000_000;
      const bySide = Math.min(2, sideLimit / Math.max(width, height));
      const byArea = Math.min(
        2,
        Math.sqrt(areaLimit / Math.max(1, width * height)),
      );
      const captureScale = Math.max(0.75, Math.min(2, bySide, byArea));

      try {
        return await window.html2canvas(clone, {
          scale: captureScale,
          useCORS: true,
          allowTaint: false,
          backgroundColor: "#ffffff",
          logging: false,
        });
      } catch (firstErr) {
        // Retry once with scale=1 for strict browsers / low-memory devices.
        return await window.html2canvas(clone, {
          scale: 1,
          useCORS: true,
          allowTaint: false,
          backgroundColor: "#ffffff",
          logging: false,
        });
      }
    } finally {
      if (clone && clone.parentNode) clone.parentNode.removeChild(clone);
    }
  }

  async function buildPNGCanvasForExport(settings, viewPlayers) {
    const node = exportContainer;
    if (!node) throw new Error("导出预览未加载");

    if (isIOS()) {
      return {
        canvas: buildExportCanvasFromData(viewPlayers, settings, {
          safeIOS: true,
        }),
        compatMode: true,
        iosSafeMode: true,
      };
    }

    try {
      return {
        canvas: await captureExportPreviewCanvas(node),
        compatMode: false,
        iosSafeMode: false,
      };
    } catch (e) {
      console.warn("html2canvas 导出失败，尝试兼容模式：", e);
      return {
        canvas: buildExportCanvasFromData(viewPlayers, settings),
        compatMode: true,
        iosSafeMode: false,
      };
    }
  }

  function prepareExportPreview() {
    if (!Array.isArray(state.players) || state.players.length === 0) {
      showAlert("无法生成总表", "当前没有任何选手数据，请先导入名单。");
      return false;
    }

    populateExportGroupOptions();
    renderExportPreview();
    return true;
  }

  async function exportPNG(options = {}) {
    if (!exportContainer) return;

    const opts = options || {};
    const triggerButton = opts.triggerButton || btnDownloadPng;
    const idleLabel = opts.idleLabel || "下载 PNG";
    const busyLabel = isIOS() ? "打开中…" : "生成中…";
    setBtnBusy(triggerButton, true, busyLabel, idleLabel);
    const settings = getExportSettings();
    const filename = `${makeSafeFilename(state.competitionName)}_签到表.png`;
    const viewPlayers = getExportViewPlayers(settings);
    const previewWindow = shouldOpenPNGPreviewWindow()
      ? openPNGPreviewWindow()
      : null;

    try {
      let canvas = null;
      let compatMode = false;
      if (opts.forceDataCanvas) {
        const iosSafeMode = isIOS();
        canvas = buildExportCanvasFromData(viewPlayers, settings, {
          safeIOS: iosSafeMode,
        });
        compatMode = iosSafeMode;
      } else {
        const built = await buildPNGCanvasForExport(settings, viewPlayers);
        canvas = built.canvas;
        compatMode = built.compatMode;
      }
      const mode = await saveCanvasAsPNG(canvas, filename, previewWindow);
      notifyPNGResult(mode, compatMode);
    } catch (e) {
      closePNGPreviewWindow(previewWindow);
      console.error("导出 PNG 失败：", e);
      showAlert(
        "导出失败",
        "导出 PNG 失败。iPhone/iPad 若无法打开图片页，请用「下载 CSV」或「复制文本」保留结果。",
      );
    } finally {
      setBtnBusy(triggerButton, false, busyLabel, idleLabel);
    }
  }

  async function downloadAsPNG() {
    if (!prepareExportPreview()) return;
    await exportPNG();
  }

  async function quickExportAsPNG() {
    if (!prepareExportPreview()) return;
    await exportPNG({
      triggerButton: btnExportQuick,
      idleLabel: "导出 PNG",
      forceDataCanvas: true,
    });
  }

  function csvEscape(value) {
    const s = String(value ?? "");
    if (/[,"\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }

  function downloadAsCSV() {
    const settings = getExportSettings();
    const players = getExportViewPlayers(settings);

    const headers = ["序号", "昵称/姓名"];
    if (settings.withAccount) headers.push("账号");
    if (settings.withClub) headers.push("俱乐部");
    if (settings.withPlatform) headers.push("平台");
    if (settings.withGroup) headers.push("组别");
    headers.push("签到状态");
    if (settings.withTime) headers.push("签到时间");
    headers.push("新人");

    const lines = [];
    lines.push(headers.join(","));

    players.forEach((p, idx) => {
      const row = [String(idx + 1), csvEscape(p.displayName)];
      if (settings.withAccount) row.push(csvEscape(p.account || ""));
      if (settings.withClub) row.push(csvEscape(p.club || ""));
      if (settings.withPlatform)
        row.push(csvEscape((p.platform || "").toUpperCase()));
      if (settings.withGroup) row.push(csvEscape(p.group || ""));
      row.push(p.checkedIn ? "已签到" : "等待中");
      if (settings.withTime)
        row.push(
          csvEscape(
            p.checkedIn && p.checkedInAt ? formatTime(p.checkedInAt) : "",
          ),
        );
      row.push(p.isNew ? "是" : "否");
      lines.push(row.join(","));
    });

    const csv = "\ufeff" + lines.join("\n"); // BOM for Excel
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const filename = `${makeSafeFilename(state.competitionName)}_签到表.csv`;
    const mode = triggerObjectUrlDownload(blob, filename);

    if (mode === "inapp") {
      showSnackbar(
        "内置浏览器可能拦截 CSV 下载；若未成功，请改用“复制文本”或右上角“在浏览器打开”。",
        3600,
      );
      return;
    }
    if (mode === "open") {
      showSnackbar("已在新窗口打开 CSV，请使用浏览器菜单保存文件", 3200);
      return;
    }
    showSnackbar("已开始下载 CSV", 2200);
  }

  function showManualCopyDialog(text) {
    const root = document.createElement("div");
    root.className = "edit-form";
    root.style.whiteSpace = "normal";

    const note = document.createElement("div");
    note.className = "edit-note";
    note.textContent = "当前环境可能限制自动复制，请手动全选并复制以下文本。";

    const ta = document.createElement("textarea");
    ta.className = "import-manual__textarea";
    ta.readOnly = true;
    ta.value = String(text || "");

    root.appendChild(note);
    root.appendChild(ta);

    showDialog({
      title: "手动复制",
      contentNode: root,
      buttons: [
        {
          label: "全选",
          className: "btn btn-tonal",
          onClick: () => {
            try {
              ta.focus();
              ta.select();
            } catch (_) {
              // ignore
            }
            return false;
          },
        },
        { label: "关闭", className: "btn btn-filled" },
      ],
    });
  }

  async function tryCopyTextToClipboard(text) {
    const value = String(text ?? "");
    if (!value) return false;

    // Modern Clipboard API
    try {
      if (
        navigator.clipboard &&
        typeof navigator.clipboard.writeText === "function"
      ) {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch (e) {
      // fall through
    }

    // Legacy fallback (execCommand). Some embedded browsers still require this.
    try {
      const ta = document.createElement("textarea");
      ta.value = value;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      ta.style.top = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return Boolean(ok);
    } catch (_) {
      return false;
    }
  }

  async function copyTextWithFallback(text, options = {}) {
    const value = String(text ?? "");
    const successToast = options.successToast || "";

    const ok = await tryCopyTextToClipboard(value);
    if (ok) {
      if (successToast) showSnackbar(successToast, 2200);
      return true;
    }

    // Last resort: let user manually copy.
    showManualCopyDialog(value);
    return false;
  }

  async function copyAsText() {
    const settings = getExportSettings();
    const players = getExportViewPlayers(settings);
    const total = players.length;
    const checkedIn = players.filter((p) => p.checkedIn).length;

    const lines = [];
    lines.push(state.competitionName || "比赛签到表");
    lines.push(
      `总人数: ${total} | 已签到: ${checkedIn} | 等待中: ${total - checkedIn}`,
    );
    lines.push("--------------------------------");

    players.forEach((p, idx) => {
      const status = p.checkedIn ? "已签到" : "等待中";
      const extra = [];
      if (settings.withGroup && p.group) extra.push(p.group);
      if (settings.withPlatform && p.platform)
        extra.push(p.platform.toUpperCase());
      if (settings.withAccount && p.account) extra.push(p.account);
      if (settings.withClub && p.club) extra.push(`俱乐部:${p.club}`);
      if (settings.withTime && p.checkedInAt && p.checkedIn)
        extra.push(formatTime(p.checkedInAt));
      if (p.isNew) extra.push("新人");

      const suffix = extra.length ? `（${extra.join(" · ")}）` : "";
      lines.push(`${idx + 1}. ${p.displayName}${suffix} - ${status}`);
    });

    const text = lines.join("\n");

    await copyTextWithFallback(text, { successToast: "已复制到剪贴板" });
  }

  // ------------------------------
  // JSON import/export (optional)
  // ------------------------------
  function buildProgressExportPayload() {
    return {
      version: STORAGE_VERSION,
      appVersion: APP_VERSION,
      exportedAt: now(),
      competitionName: state.competitionName,
      nextPlayerId: state.nextPlayerId,
      ui: state.ui,
      groupRules: sanitizeGroupRules(state.groupRules),
      scoreHelper: sanitizeScoreHelper(state.scoreHelper),
      players: state.players,
    };
  }

  function showExportProgressJSONFallbackDialog(jsonText, mode) {
    const root = document.createElement("div");
    root.className = "edit-form";
    root.style.whiteSpace = "normal";

    const note = document.createElement("div");
    note.className = "edit-note";

    if (mode === "inapp") {
      note.textContent =
        "检测到内置浏览器环境，文件下载可能被拦截。你可以点击“复制 JSON”，然后在另一台设备用“粘贴导入/导入进度”恢复。";
    } else if (mode === "open") {
      note.textContent =
        "浏览器已在新窗口打开 JSON（可能无法自动保存）。如未保存成功，可先复制 JSON 文本备用。";
    } else {
      note.textContent = "若下载未成功，可先复制 JSON 文本备用。";
    }

    const ta = document.createElement("textarea");
    ta.className = "import-manual__textarea";
    ta.readOnly = true;
    ta.value = String(jsonText || "");

    root.appendChild(note);
    root.appendChild(ta);

    showDialog({
      title: "导出进度 JSON（备用方案）",
      contentNode: root,
      buttons: [
        {
          label: "复制 JSON",
          className: "btn btn-filled",
          onClick: () => {
            // Keep dialog open; some browsers require a user gesture per copy.
            copyTextWithFallback(ta.value, {
              successToast: "已复制 JSON 到剪贴板",
            });
            return false;
          },
        },
        {
          label: "全选",
          className: "btn btn-tonal",
          onClick: () => {
            try {
              ta.focus();
              ta.select();
            } catch (_) {
              // ignore
            }
            return false;
          },
        },
        { label: "关闭", className: "btn btn-outlined" },
      ],
    });
  }

  function exportProgressAsJSON() {
    const payload = buildProgressExportPayload();
    const jsonText = JSON.stringify(payload, null, 2);

    const blob = new Blob([jsonText], {
      type: "application/json;charset=utf-8",
    });
    const filename = `${makeSafeFilename(state.competitionName)}_签到进度.json`;
    const mode = triggerObjectUrlDownload(blob, filename);

    if (mode === "download") {
      showSnackbar("已导出进度 JSON", 2000);
      return;
    }

    // Provide a robust fallback for Mainland CN in-app browsers (WeChat/QQ/Feishu, etc.)
    showExportProgressJSONFallbackDialog(jsonText, mode);
    if (mode === "inapp") {
      showSnackbar("下载可能被内置浏览器拦截：已提供“复制 JSON”备用方案", 3600);
      return;
    }
    if (mode === "open") {
      showSnackbar(
        "已在新窗口打开 JSON；若未保存成功，可在弹窗中复制 JSON 文本",
        3600,
      );
      return;
    }
  }

  function importProgressFromJSONText(rawText, meta = {}) {
    const source = String(meta.source || "text");
    const snapshot = captureUndoSnapshot();

    try {
      const text = String(rawText || "")
        .replace(/^\uFEFF/, "")
        .trim();
      if (!text) {
        showAlert("导入失败", "内容为空：请粘贴/选择有效的 JSON。");
        return false;
      }

      const parsed = JSON.parse(text);
      if (
        !parsed ||
        parsed.version !== STORAGE_VERSION ||
        !Array.isArray(parsed.players)
      ) {
        showAlert("导入失败", "文件/内容格式不正确或版本不匹配。");
        return false;
      }

      const loaded = sanitizeLoadedState({
        version: STORAGE_VERSION,
        step: "checkin",
        competitionName: parsed.competitionName,
        nextPlayerId: parsed.nextPlayerId,
        players: parsed.players,
        ui: parsed.ui || {},
        groupRules: parsed.groupRules,
        scoreHelper: parsed.scoreHelper,
        // Keep current import texts to avoid confusing the import page after restore.
        clubText: state.clubText || "",
        relayText: state.relayText || "",
        savedAt: now(),
      });

      if (!loaded || !loaded.players || loaded.players.length === 0) {
        showAlert("导入失败", "JSON 中未包含任何有效选手。");
        return false;
      }

      state = loaded;
      state.step = "checkin";
      viewStepOverride = null;

      if (competitionTitleEl)
        competitionTitleEl.textContent = state.competitionName;
      if (competitionNameInput)
        competitionNameInput.value = state.competitionName;

      applyStepUI();
      refreshCheckinUI();
      scheduleSave();

      const label =
        source === "file"
          ? "已导入进度（文件）"
          : source === "paste"
            ? "已导入进度（粘贴）"
            : "已导入进度";
      showUndoSnackbar(
        `${label}（并自动保存到本机）`,
        () => {
          restoreUndoSnapshot(snapshot);
          showSnackbar("已撤销导入", 2200);
        },
        6500,
      );
      return true;
    } catch (e) {
      console.error("导入 JSON 失败：", e);
      showAlert(
        "导入失败",
        "无法解析 JSON。请确认内容完整、未被聊天软件截断。",
      );
      return false;
    }
  }

  function importProgressFromJSONFile(file) {
    if (!file) return;

    const maxBytes = 5 * 1024 * 1024; // 5MB
    if (Number(file.size) > maxBytes) {
      showAlert(
        "导入失败",
        "JSON 文件过大（超过 5MB），请确认文件内容是否正确。",
      );
      if (importJsonInput) importJsonInput.value = "";
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => {
      console.error("读取 JSON 文件失败：", reader.error);
      showAlert(
        "导入失败",
        "读取 JSON 文件失败，请检查文件是否损坏或编码异常。",
      );
      if (importJsonInput) importJsonInput.value = "";
    };

    reader.onload = () => {
      try {
        importProgressFromJSONText(String(reader.result || ""), {
          source: "file",
        });
      } finally {
        if (importJsonInput) importJsonInput.value = "";
      }
    };

    reader.readAsText(file, "utf-8");
  }

  function showImportProgressPasteDialog() {
    const root = document.createElement("div");
    root.className = "edit-form";
    root.style.whiteSpace = "normal";

    const note = document.createElement("div");
    note.className = "edit-note";
    note.textContent =
      "将另一台设备“导出进度”得到的 JSON 内容粘贴到下面，然后点击“导入”。不会上传到服务器；导入会覆盖当前进度，可在导入后点击“撤销”。";

    const ta = document.createElement("textarea");
    ta.className = "import-manual__textarea";
    ta.placeholder = '{\n  "version": ...\n  "players": [...]\n}';
    ta.value = "";

    root.appendChild(note);
    root.appendChild(ta);

    showDialog({
      title: "粘贴导入进度 JSON",
      contentNode: root,
      buttons: [
        {
          label: "导入",
          className: "btn btn-filled",
          onClick: () => {
            const ok = importProgressFromJSONText(ta.value, {
              source: "paste",
            });
            return ok; // true -> close dialog
          },
        },
        {
          label: "清空",
          className: "btn btn-tonal",
          onClick: () => {
            ta.value = "";
            try {
              ta.focus();
            } catch (_) {
              /* ignore */
            }
            return false;
          },
        },
        { label: "关闭", className: "btn btn-outlined" },
      ],
    });

    // Focus after open for quick paste
    setTimeout(() => {
      try {
        ta.focus();
      } catch (_) {
        /* ignore */
      }
    }, 50);
  }

  // ------------------------------
  // Help + regression tests (Plan #1)
  // ------------------------------
  const IMPORT_TESTS = [
    {
      name: "基础：无差别组（账号含括号）",
      clubText: "",
      relayText: `无差别组：\n1. yetaiqi sky111\n2. zhang qiang [ fszq1191]\n`,
      expect: {
        total: 2,
        groups: { 无差别组: 2 },
        contains: [
          { displayName: "yetaiqi", account: "sky111" },
          { displayName: "zhang qiang", account: "fszq1191" },
        ],
      },
    },
    {
      name: "两段小写：昵称 + 纯字母账号",
      clubText: "",
      relayText: `无差别组：\n1. niuhongli mtqh\n`,
      expect: {
        total: 1,
        groups: { 无差别组: 1 },
        contains: [{ displayName: "niuhongli", account: "mtqh" }],
      },
    },
    {
      name: "无差别组：单词拼音姓氏 + 账号仍应解析为昵称+账号",
      clubText: "",
      relayText: `无差别组：\n1. Tang root498\n`,
      expect: {
        total: 1,
        groups: { 无差别组: 1 },
        contains: [{ displayName: "Tang", account: "root498" }],
      },
    },
    {
      name: "无差别组：同名不同账号不应在导入阶段被合并",
      clubText: "",
      relayText: `无差别组：\n1. dengyuqi yinguo_cat\n2. dengyuqi omgyouwin\n`,
      expect: {
        total: 2,
        groups: { 无差别组: 2 },
        contains: [
          { displayName: "dengyuqi", account: "yinguo_cat" },
          { displayName: "dengyuqi", account: "omgyouwin" },
        ],
      },
    },
    {
      name: "无差别组：同账号不同名不应在导入阶段被合并",
      clubText: "",
      relayText: `无差别组：\n1. zhangsan sky111\n2. lisi sky111\n`,
      expect: {
        total: 2,
        groups: { 无差别组: 2 },
        contains: [
          { displayName: "zhangsan", account: "sky111" },
          { displayName: "lisi", account: "sky111" },
        ],
      },
    },
    {
      name: "青少年组：中文名+账号粘连",
      clubText: "",
      relayText: `青少年组：\n13. 王光轩wgxzwl\n`,
      expect: {
        total: 1,
        groups: { 青少年组: 1 },
        contains: [{ displayName: "王光轩", account: "wgxzwl" }],
      },
    },
    {
      name: "新人赛：含俱乐部",
      clubText: "",
      relayText: `新人赛：\n4. 夜洛 Nightspoke 神秘猫猫教\n`,
      expect: {
        total: 1,
        groups: { 新人赛: 1 },
        contains: [
          { displayName: "夜洛", account: "Nightspoke", club: "神秘猫猫教" },
        ],
      },
    },
    {
      name: "标题识别：新人赛组应归入新人赛（兼容常见写法）",
      clubText: "",
      relayText: `新人赛组：\n1. 张三 zhangsan\n`,
      expect: {
        total: 1,
        groups: { 新人赛: 1 },
        contains: [{ displayName: "张三", account: "zhangsan" }],
      },
    },
    {
      name: "分隔符：竖线 | 支持三列（昵称|账号|俱乐部）",
      clubText: "",
      relayText: `无差别组：\n1. 张三|zhangsan|自由俱乐部\n`,
      expect: {
        total: 1,
        groups: { 无差别组: 1 },
        contains: [
          { displayName: "张三", account: "zhangsan", club: "自由俱乐部" },
        ],
      },
    },
    {
      name: "分隔符：斜杠 / 支持三列（昵称/账号/俱乐部）",
      clubText: "",
      relayText: `无差别组：\n1. 张三/zhangsan/自由俱乐部\n`,
      expect: {
        total: 1,
        groups: { 无差别组: 1 },
        contains: [
          { displayName: "张三", account: "zhangsan", club: "自由俱乐部" },
        ],
      },
    },
    {
      name: "字段标签：昵称/账号/俱乐部（常见聊天复制格式）",
      clubText: "",
      relayText: `无差别组：\n昵称：战鹰 账号：Steven ji 俱乐部：自由\n`,
      expect: {
        total: 1,
        groups: { 无差别组: 1 },
        contains: [{ displayName: "战鹰", account: "Steven ji", club: "自由" }],
      },
    },
    {
      name: "特殊赛：vint（含纯数字账号 & 中文账号）",
      clubText: "",
      relayText: `特殊赛：\n2. 神 35206\n3. 沉淀 点点要沉淀\n`,
      expect: {
        total: 2,
        groups: { 特殊赛: 2 },
      },
    },
    {
      name: "长期名单：--不参赛应忽略",
      clubText: "",
      relayText: `长期选手，长期俱乐部格式：\n全部名单:\nWang Chen --\nLin Feng\n--为不参加本次比赛\n`,
      expect: {
        total: 1,
        groups: { 长期名单: 1 },
        contains: [{ displayName: "Lin Feng" }],
      },
    },
    {
      name: "长期名单：中英文横杠不参赛标记应忽略",
      clubText: "",
      relayText: `长期选手，长期俱乐部格式：\n全部名单:\nAscii Hyphen --\nEn Dash ––\nEm Dash ——\nFullwidth Hyphen －－\nMinus Sign −−\nComma Tail --，\nLin Feng\n`,
      expect: {
        total: 1,
        groups: { 长期名单: 1 },
        contains: [{ displayName: "Lin Feng" }],
      },
    },
    {
      name: "长期名单：两段拼音姓名（小写）不应被拆成账号",
      clubText: "",
      relayText: `长期选手，长期俱乐部格式：\n全部名单:\nlin feng\n`,
      expect: {
        total: 1,
        groups: { 长期名单: 1 },
        contains: [{ displayName: "lin feng" }],
        accountEmptyFor: ["lin feng"],
      },
    },
    {
      name: "俱乐部区：两段拼音姓名（小写）不应被拆成账号",
      clubText: `yan yiru\n`,
      relayText: "",
      expect: {
        total: 1,
        groups: { 长期成员: 1 },
        contains: [{ displayName: "yan yiru" }],
        accountEmptyFor: ["yan yiru"],
      },
    },
    {
      name: "杂质：说明行应忽略，但不影响人数",
      clubText: "",
      relayText: `无差别组：\n报名接龙：请按格式\n1. Phoenix_Soul+TheAuEsted\n`,
      expect: {
        total: 1,
        groups: { 无差别组: 1 },
        contains: [{ displayName: "Phoenix_Soul", account: "TheAuEsted" }],
      },
    },
    {
      name: "连字符：name-account",
      clubText: "",
      relayText: `无差别组：\n17. jiabaolong-rainbow1010\n`,
      expect: {
        total: 1,
        contains: [{ displayName: "jiabaolong", account: "rainbow1010" }],
      },
    },
    {
      name: "账号含空格：两段英文（复制粘贴常见）",
      clubText: "",
      relayText: `青少年组：\n9. Liaoyi  Liao yi\n`,
      expect: {
        total: 1,
        groups: { 青少年组: 1 },
        contains: [{ displayName: "Liaoyi", account: "Liao yi" }],
      },
    },
    {
      name: "俱乐部区：简单名单去重并归入“长期成员”",
      clubText: `Alice\nBob\n`,
      relayText: `无差别组：\n1. Alice alice123\n`,
      expect: {
        total: 2,
        groups: { 无差别组: 1, 长期成员: 1 },
      },
    },
    {
      name: "括号/隐藏空格：方括号/中文括号/Hangul filler",
      clubText: "",
      relayText: `无差别组：\n20. Lu Wenting[eagleeee]ㅤ\n24. liducheng（sino001）\n`,
      expect: {
        total: 2,
        groups: { 无差别组: 2 },
        contains: [
          { displayName: "Lu Wenting", account: "eagleeee" },
          { displayName: "liducheng", account: "sino001" },
        ],
      },
    },
    {
      name: "全角编号：１．/２、应能正确剥离",
      clubText: "",
      relayText: `无差别组：\n１． 张三 zhangsan\n２、 李四 lisi\n`,
      expect: {
        total: 2,
        groups: { 无差别组: 2 },
        contains: [
          { displayName: "张三", account: "zhangsan" },
          { displayName: "李四", account: "lisi" },
        ],
      },
    },
    {
      name: "账号下划线尾缀：4z_",
      clubText: "",
      relayText: `新人赛：\n16. 柿子 4z_\n`,
      expect: {
        total: 1,
        groups: { 新人赛: 1 },
        contains: [{ displayName: "柿子", account: "4z_" }],
      },
    },
    {
      name: "全角空格：eagle　 he70（常见复制粘贴）",
      clubText: "",
      relayText: `特殊赛：\n4. eagle　 he70\n`,
      expect: {
        total: 1,
        groups: { 特殊赛: 1 },
        contains: [{ displayName: "eagle", account: "he70" }],
      },
    },
    {
      name: "特殊赛：两段短中文更像姓名时不强制识别账号",
      clubText: "",
      relayText: `特殊赛：\n1. 王 小明\n`,
      expect: {
        total: 1,
        groups: { 特殊赛: 1 },
        contains: [{ displayName: "王 小明" }],
        accountEmptyFor: ["王 小明"],
      },
    },
    {
      name: "特殊赛：中文名 + 双词英文账号（不应把第二词识别成俱乐部）",
      clubText: "",
      relayText: `特殊赛：\n20. 战鹰 Steven ji\n`,
      expect: {
        total: 1,
        groups: { 特殊赛: 1 },
        contains: [{ displayName: "战鹰", account: "Steven ji" }],
      },
    },
    {
      name: "无差别组：三段首字母大写更像姓名，不应误拆账号",
      clubText: "",
      relayText: `无差别组：\n1. Wang De Hua\n`,
      expect: {
        total: 1,
        groups: { 无差别组: 1 },
        contains: [{ displayName: "Wang De Hua" }],
        accountEmptyFor: ["Wang De Hua"],
      },
    },
    {
      name: "无差别组：三段标题式中若第3段更像英文ID，应识别为账号",
      clubText: "",
      relayText: `无差别组：\n1. Wang Zhen Fury\n`,
      expect: {
        total: 1,
        groups: { 无差别组: 1 },
        contains: [{ displayName: "Wang Zhen", account: "Fury" }],
      },
    },
    {
      name: "无差别组：三段标题式中第3段为普通英文词也应优先识别账号",
      clubText: "",
      relayText: `无差别组：\n1. Wang Zhen Head\n`,
      expect: {
        total: 1,
        groups: { 无差别组: 1 },
        contains: [{ displayName: "Wang Zhen", account: "Head" }],
      },
    },
    {
      name: "无差别组：三段典型拼音姓名仍不应误拆账号",
      clubText: "",
      relayText: `无差别组：\n1. Wang Xiao Ming\n`,
      expect: {
        total: 1,
        groups: { 无差别组: 1 },
        contains: [{ displayName: "Wang Xiao Ming" }],
        accountEmptyFor: ["Wang Xiao Ming"],
      },
    },
    {
      name: "无差别组：姓名与账号使用中文破折号连接（—）应可识别",
      clubText: "",
      relayText: `无差别组：\n1. wangyuchen—JiaoBu10\n`,
      expect: {
        total: 1,
        groups: { 无差别组: 1 },
        contains: [{ displayName: "wangyuchen", account: "JiaoBu10" }],
      },
    },
    {
      name: "无差别组：单词粘连的姓名+账号（含数字）应可拆分",
      clubText: "",
      relayText: `无差别组：\n1. zhangyujieT0Thuiyi\n`,
      expect: {
        total: 1,
        groups: { 无差别组: 1 },
        contains: [{ displayName: "zhangyujie", account: "T0Thuiyi" }],
      },
    },
    {
      name: "无差别组：两段短拼音更像姓名时不强制识别账号",
      clubText: "",
      relayText: `无差别组：\n1. lin feng\n`,
      expect: {
        total: 1,
        groups: { 无差别组: 1 },
        contains: [{ displayName: "lin feng" }],
        accountEmptyFor: ["lin feng"],
      },
    },
    {
      name: "无差别组：两段小写拼音姓名（较长）不应误拆账号",
      clubText: "",
      relayText: `无差别组：\n1. zhang qiang\n`,
      expect: {
        total: 1,
        groups: { 无差别组: 1 },
        contains: [{ displayName: "zhang qiang" }],
        accountEmptyFor: ["zhang qiang"],
      },
    },
    {
      name: "无差别组：三段小写拼音姓名不应误拆账号",
      clubText: "",
      relayText: `无差别组：\n1. wang de hua\n`,
      expect: {
        total: 1,
        groups: { 无差别组: 1 },
        contains: [{ displayName: "wang de hua" }],
        accountEmptyFor: ["wang de hua"],
      },
    },
    {
      name: "无差别组：三段中第3段为英文ID时仍应识别账号",
      clubText: "",
      relayText: `无差别组：\n1. Zhong Wei optionale\n`,
      expect: {
        total: 1,
        groups: { 无差别组: 1 },
        contains: [{ displayName: "Zhong Wei", account: "optionale" }],
      },
    },
    {
      name: "长期名单：三段小写拼音姓名不应误拆账号",
      clubText: "",
      relayText: `长期选手，长期俱乐部格式：\n全部名单:\nwang de hua\n`,
      expect: {
        total: 1,
        groups: { 长期名单: 1 },
        contains: [{ displayName: "wang de hua" }],
        accountEmptyFor: ["wang de hua"],
      },
    },
    {
      name: "长期名单：标题写成“长期人员名单”时也应归入长期名单",
      clubText: "",
      relayText: `长期人员名单：\nWu Jianxiang\n`,
      expect: {
        total: 1,
        groups: { 长期名单: 1 },
        contains: [{ displayName: "Wu Jianxiang" }],
      },
    },
    {
      name: "标题识别：仅有【x月无差别组】也能归组",
      clubText: "",
      relayText: `#接龙\n【1月无差别组】“栢龙杯”比赛报名接龙\n1. yetaiqi sky111\n`,
      expect: {
        total: 1,
        groups: { 无差别组: 1 },
        contains: [{ displayName: "yetaiqi", account: "sky111" }],
      },
    },
    {
      name: "标题识别：无差别赛事应归入无差别组",
      clubText: "",
      relayText: `无差别赛事：\n1. yetaiqi sky111\n`,
      expect: {
        total: 1,
        groups: { 无差别组: 1 },
        contains: [{ displayName: "yetaiqi", account: "sky111" }],
      },
    },
    {
      name: "中文昵称+粘连账号+尾部俱乐部应可解析",
      clubText: "",
      relayText: `新人赛：\n1. 馒头926wjp Zeb\n`,
      expect: {
        total: 1,
        groups: { 新人赛: 1 },
        contains: [{ displayName: "馒头", account: "926wjp", club: "Zeb" }],
      },
    },
    {
      name: "连接符&：连写双人名应拆分为两名选手",
      clubText: "",
      relayText: `无差别组：\n12. zhanganping&zhangxiaoguo\n`,
      expect: {
        total: 2,
        groups: { 无差别组: 2 },
        contains: [
          { displayName: "zhanganping" },
          { displayName: "zhangxiaoguo" },
        ],
        accountEmptyFor: ["zhanganping", "zhangxiaoguo"],
      },
    },
    {
      name: "去重稳定：同账号冲突行重复出现不应放大人数",
      clubText: "",
      relayText: `无差别组：\n1. Alice alice123\n2. Bob alice123\n3. Alice alice123\n`,
      expect: {
        total: 2,
        groups: { 无差别组: 2 },
        contains: [
          { displayName: "Alice", account: "alice123" },
          { displayName: "Bob", account: "alice123" },
        ],
      },
    },
  ];

  function runImportParseTests() {
    const lines = [];
    let pass = 0;
    let fail = 0;

    for (const t of IMPORT_TESTS) {
      const result = parseImportTextsDetailed(t.clubText, t.relayText);
      const players = result.players || [];
      const report = result.report || {};

      const groupCounts = new Map();
      for (const p of players) {
        const g = normalizeWhitespace(p.group) || "未分组";
        groupCounts.set(g, (groupCounts.get(g) || 0) + 1);
      }

      const expectedTotal =
        t.expect && typeof t.expect.total === "number" ? t.expect.total : null;

      let ok = true;
      const reasons = [];

      if (expectedTotal != null && players.length !== expectedTotal) {
        ok = false;
        reasons.push(`人数不符：期望 ${expectedTotal}，实际 ${players.length}`);
      }

      if (t.expect && t.expect.groups) {
        for (const [g, c] of Object.entries(t.expect.groups)) {
          const actual = groupCounts.get(g) || 0;
          if (actual !== c) {
            ok = false;
            reasons.push(`组别人数不符：${g} 期望 ${c}，实际 ${actual}`);
          }
        }
      }

      if (t.expect && Array.isArray(t.expect.contains)) {
        for (const want of t.expect.contains) {
          const dn = normalizeWhitespace(want.displayName);
          const acc = normalizeWhitespace(want.account || "");
          const club = normalizeWhitespace(want.club || "");

          const found = players.some((p) => {
            if (dn && normalizeWhitespace(p.displayName) !== dn) return false;
            if (acc && normalizeWhitespace(p.account) !== acc) return false;
            if (club && normalizeWhitespace(p.club) !== club) return false;
            return true;
          });

          if (!found) {
            ok = false;
            reasons.push(`缺少关键选手：${dn}${acc ? `(${acc})` : ""}`);
          }
        }
      }

      if (t.expect && Array.isArray(t.expect.accountEmptyFor)) {
        for (const dnRaw of t.expect.accountEmptyFor) {
          const dn = normalizeWhitespace(dnRaw);
          if (!dn) continue;
          const target = players.find(
            (p) => normalizeWhitespace(p.displayName) === dn,
          );
          if (!target) {
            ok = false;
            reasons.push(`未找到应为空账号的选手：${dn}`);
            continue;
          }
          if (normalizeWhitespace(target.account)) {
            ok = false;
            reasons.push(
              `账号应为空但实际为：${dn} -> ${normalizeWhitespace(target.account)}`,
            );
          }
        }
      }

      if (ok) pass++;
      else fail++;

      lines.push(`${ok ? "✅" : "❌"} ${t.name}`);
      lines.push(
        `  - 解析人数：${players.length}（忽略：${report.ignored || 0} 行）`,
      );
      if (groupCounts.size) {
        lines.push(
          "  - 组别：" +
            Array.from(groupCounts.entries())
              .map(([g, c]) => `${g}(${c})`)
              .join("  "),
        );
      }
      if (!ok) {
        for (const r of reasons) lines.push(`  - 问题：${r}`);
      }
      lines.push("");
    }

    lines.unshift(`导入解析回归测试：通过 ${pass} / ${pass + fail}`);
    lines.push(
      "提示：若你修改了解析规则，可先运行本测试对比人数/组别/忽略原因是否发生异常变化。",
    );

    showDialog({
      title: "解析回归测试结果",
      message: lines.join("\n"),
      buttons: [{ label: "关闭", className: "btn btn-filled" }],
    });
  }

  function showHelp() {
    const msg = [
      "• 本页面是纯前端静态程序：不会把名单/签到结果上传到任何服务器。",
      "• 签到进度会自动保存到当前设备浏览器（LocalStorage）。刷新页面也能继续。",
      "• 支持多组别：导入时识别“无差别组 / 新人赛 / 特殊赛 / 青少年组”等标题，并可在签到页用“组别筛选”切换。",
      "• 可在导入页「组别识别设置」里自定义关键词（例如给新赛道增加识别词）。",
      "• 点名模式：只显示未签到，按钮更大；支持电脑在搜索框按 Enter 直接给第一条匹配签到；支持左右滑动快捷签到/取消。",
      "• 导出：PNG / CSV / 复制文本。CSV 可选择是否带“签到时间”列。",
      "• 中国大陆常见内置浏览器（微信/QQ/微博/抖音等）会提供“查看方法”引导，可一键复制链接到系统浏览器打开。",
      "• 需要跨设备/备份：可用「导出进度/导入进度」JSON；若内置浏览器拦截下载，可用“复制 JSON → 粘贴导入”。",
      "• 如果在公共电脑/公共平板上使用，建议结束后点击右上角「清除」按钮清除本地进度。",
    ].join("\n");

    showDialog({
      title: "使用说明 / 隐私 / 自检",
      message: msg,
      buttons: [
        {
          label: "运行解析回归测试",
          className: "btn btn-tonal",
          onClick: runImportParseTests,
        },
        { label: "知道了", className: "btn btn-filled" },
      ],
    });
  }

  // ------------------------------
  // PWA: Add to Home Screen / Install
  // ------------------------------
  let deferredInstallPrompt = null;

  function isAndroid() {
    return /Android/i.test(getUA());
  }

  function isMacOS() {
    return /Macintosh/i.test(getUA());
  }

  function isSafari() {
    const ua = getUA();
    const hasSafari = /Safari/i.test(ua);
    const isOther = /Chrome|CriOS|Edg|OPR|FxiOS|Firefox/i.test(ua);
    return hasSafari && !isOther;
  }

  function isSafariOnMac() {
    return isMacOS() && !isIOS() && isSafari();
  }

  function updateInstallButton() {
    const standalone = isStandaloneMode();
    if (btnInstall) btnInstall.hidden = standalone;
    if (panelInstallBtn) {
      panelInstallBtn.disabled = standalone;
      panelInstallBtn.textContent = standalone
        ? "已在主屏幕运行"
        : "保存到主屏幕";
    }
  }

  async function handleInstallClick() {
    if (isStandaloneMode()) {
      updateInstallButton();
      showSnackbar("已在主屏幕/独立窗口模式运行", 2200);
      return;
    }

    // Mainland CN in-app browsers often block PWA install entry.
    if (isLikelyInAppBrowser()) {
      showDialog({
        title: "当前环境限制安装",
        message:
          "检测到内置浏览器（如微信/QQ/微博/钉钉等），通常不支持“添加到主屏幕”。\n\n建议：\n1) 右上角菜单选择「在浏览器打开」\n2) 在系统浏览器（Chrome/Edge/Safari）中再执行安装。",
        buttons: [
          {
            label: "复制当前链接",
            className: "btn btn-tonal",
            onClick: () => {
              copyCurrentPageUrl();
              return false;
            },
          },
          { label: "知道了", className: "btn btn-filled" },
        ],
      });
      return;
    }

    // Chromium install prompt
    if (deferredInstallPrompt) {
      try {
        deferredInstallPrompt.prompt();
        const choice = await deferredInstallPrompt.userChoice;
        deferredInstallPrompt = null;
        updateInstallButton();

        if (choice && choice.outcome === "accepted") {
          showSnackbar("已发起安装/添加到主屏幕", 2400);
        } else {
          showSnackbar("已取消安装（也可在浏览器菜单里再次安装）", 2600);
        }
      } catch (e) {
        console.warn("触发安装提示失败：", e);
        showInstallInstructions();
      }
      return;
    }

    showInstallInstructions();
  }

  function showInstallInstructions() {
    if (isIOS()) {
      if (!isSafari()) {
        showDialog({
          title: "在 iPhone/iPad 上添加到主屏幕",
          message:
            "iOS/iPadOS 上只有 Safari 支持「添加到主屏幕」。\n\n请复制当前网址，用 Safari 打开后：\n1) 点击底部「分享」按钮（方框向上箭头）\n2) 选择「添加到主屏幕」\n3) 点击「添加」完成。",
          buttons: [{ label: "知道了", className: "btn btn-filled" }],
        });
      } else {
        showDialog({
          title: "添加到主屏幕",
          message:
            "在 Safari 中：\n1) 点击底部「分享」按钮（方框向上箭头）\n2) 选择「添加到主屏幕」\n3) 点击「添加」。\n\n添加后可离线使用（PNG 导出也支持离线）。",
          buttons: [{ label: "好的", className: "btn btn-filled" }],
        });
      }
      return;
    }

    if (isSafariOnMac()) {
      showDialog({
        title: "添加到 Dock / 安装为应用",
        message:
          "在 macOS 的 Safari 中可以将网页添加为独立应用：\n1) 菜单栏「文件」→「添加到 Dock…」（Add to Dock…）\n2) 确认名称与图标后保存。\n\n添加后会以独立窗口运行，使用体验更接近原生应用。",
        buttons: [{ label: "知道了", className: "btn btn-filled" }],
      });
      return;
    }

    const platform = isAndroid() ? "Android" : "桌面端（Windows/macOS/Linux）";
    showDialog({
      title: "安装/添加到主屏幕",
      message: `在 ${platform} 的 Chrome/Edge 中：\n1) 打开浏览器菜单（右上角 ⋮/…）\n2) 选择「安装应用」或「安装 比赛签到助手」或「添加到主屏幕」\n3) 按提示完成。\n\n若地址栏右侧出现“安装”图标，也可直接点击安装。`,
      buttons: [{ label: "好的", className: "btn btn-filled" }],
    });
  }

  function setupPWAInstall() {
    if (LOCAL_SYNC_ENABLED) {
      deferredInstallPrompt = null;
      updateInstallButton();
      return;
    }

    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      deferredInstallPrompt = e;
      updateInstallButton();
    });

    window.addEventListener("appinstalled", () => {
      deferredInstallPrompt = null;
      updateInstallButton();
      showSnackbar("已添加到主屏幕/安装完成", 2400);
    });

    updateInstallButton();

    if (btnInstall) {
      btnInstall.addEventListener("click", handleInstallClick);
    }
  }

  // ------------------------------
  // PWA: Service Worker + update prompt (Plan #11)
  // ------------------------------
  function promptAppUpdate(reg) {
    showSnackbar("发现新版本，建议刷新以使用最新功能", 0, "刷新", () => {
      try {
        if (reg && reg.waiting) {
          reg.waiting.postMessage({ type: "SKIP_WAITING" });
        }
      } catch (_) {
        // ignore
      }
      window.location.reload();
    });
  }

  function registerServiceWorker() {
    const host = String(window.location.hostname || "").toLowerCase();
    const isLoopback =
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "[::1]";
    if (isLoopback) {
      if ("serviceWorker" in navigator) {
        navigator.serviceWorker
          .getRegistrations()
          .then((regs) => regs.forEach((reg) => reg.unregister()))
          .catch(() => {});
      }
      if (typeof caches !== "undefined" && caches && caches.keys) {
        caches
          .keys()
          .then((keys) =>
            Promise.all(
              keys
                .filter((key) => String(key).startsWith("checkin-assistant-cache-"))
                .map((key) => caches.delete(key)),
            ),
          )
          .catch(() => {});
      }
      return;
    }
    const isSecure = window.location.protocol === "https:" || isLoopback;
    if (!isSecure) return;
    if (!("serviceWorker" in navigator)) return;

    const sw = navigator.serviceWorker;
    if (!sw || typeof sw.register !== "function") return;

    const hadController = Boolean(sw.controller);

    let hasPrompted = false;

    const swUrl = `./sw.js?v=${encodeURIComponent(APP_VERSION)}`;
    sw.register(swUrl)
      .then((reg) => {
        if (!reg) return;

        // If already waiting, prompt immediately
        if (reg.waiting && sw.controller && !hasPrompted) {
          hasPrompted = true;
          promptAppUpdate(reg);
        }

        reg.addEventListener("updatefound", () => {
          const nw = reg.installing;
          if (!nw) return;
          nw.addEventListener("statechange", () => {
            if (nw.state === "installed") {
              // A new SW is installed: if we already have a controller, it is an update.
              if (sw.controller && !hasPrompted) {
                hasPrompted = true;
                promptAppUpdate(reg);
              }
            }
          });
        });
      })
      .catch((e) => {
        console.warn("Service Worker 注册失败：", e);
      });

    // controllerchange: new SW took over
    sw.addEventListener("controllerchange", () => {
      // On first install there was no controller; avoid confusing "update" prompt.
      if (!hadController) return;
      if (hasPrompted) return;
      hasPrompted = true;
      showSnackbar("应用已更新，点击刷新以加载最新界面", 0, "刷新", () =>
        window.location.reload(),
      );
    });
  }

  // ------------------------------
  // Event wiring
  // ------------------------------
  function wireEvents() {
    on(btnImport, "click", processImport);
    on(btnResume, "click", () => {
      if (
        !state ||
        !Array.isArray(state.players) ||
        state.players.length === 0
      ) {
        showSnackbar("没有可继续的签到进度", 2200);
        return;
      }
      viewStepOverride = null;
      if (state.step !== "score-helper") state.step = "checkin";
      applyStateToUI();
      showSnackbar("已继续上次进度", 2200);
    });

    const syncGroupRules = debounce(() => {
      state.groupRules = readGroupRulesFromEditor();
      scheduleSave();
    }, 140);

    on(groupRulesEl, "input", (e) => {
      const target = isElement(e.target) ? e.target : null;
      if (!target) return;
      const role = String(target.getAttribute("data-role") || "");
      if (role === "group" || role === "keywords") syncGroupRules();
    });

    on(groupRulesEl, "change", (e) => {
      const target = isElement(e.target) ? e.target : null;
      if (!target) return;
      const role = String(target.getAttribute("data-role") || "");
      if (role === "enabled") syncGroupRules();
    });

    on(groupRulesEl, "click", (e) => {
      const target = isElement(e.target) ? e.target : null;
      if (!target) return;
      const btn = target.closest('button[data-role="delete"]');
      if (!btn) return;

      const row = btn.closest(".group-rule");
      if (!row) return;

      const ruleNodes = groupRulesEl
        ? groupRulesEl.querySelectorAll(".group-rule")
        : [];
      if (ruleNodes && ruleNodes.length <= 1) {
        showSnackbar("至少保留 1 条组别规则", 1800);
        return;
      }

      if (row.parentNode) row.parentNode.removeChild(row);
      state.groupRules = readGroupRulesFromEditor();
      renderGroupRulesEditor();
      scheduleSave();
      showSnackbar("已删除组别规则", 1800);
    });

    on(btnAddGroupRule, "click", () => {
      const rules = readGroupRulesFromEditor();
      rules.push({
        id: createRuleId(),
        group: "新组别",
        keywords: ["新组别"],
        enabled: true,
      });
      state.groupRules = sanitizeGroupRules(rules);
      renderGroupRulesEditor();
      scheduleSave();
      showSnackbar("已新增组别规则", 1800);
    });

    on(btnResetGroupRules, "click", () => {
      state.groupRules = cloneDefaultGroupRules();
      renderGroupRulesEditor();
      scheduleSave();
      showSnackbar("已恢复默认组别规则", 2000);
    });

    on(btnBack, "click", backToImport);
    on(btnBatch, "click", showBatchDialog);
    on(btnFinish, "click", enterScoreHelper);
    on(btnScoreBackCheckin, "click", returnToCheckinFromScoreHelper);
    on(btnScoreApplyRounds, "click", () => {
      const snapshot = captureUndoSnapshot();
      setScoreRoundCount(scoreRoundCountInput && scoreRoundCountInput.value);
      renderScoreHelper();
      scheduleSave();
      showUndoSnackbar("已更新轮次设置", () => {
        restoreUndoSnapshot(snapshot);
        showSnackbar("已撤销轮次设置", 1800);
      });
    });
    on(scoreRoundTabs, "click", (e) => {
      const target = isElement(e.target) ? e.target : null;
      const btn = target && target.closest("button[data-round]");
      if (!btn) return;
      const round = Number(btn.dataset.round);
      const helper = ensureScoreHelper();
      if (!Number.isFinite(round) || round < 1 || round > helper.roundCount) return;
      helper.activeRound = Math.trunc(round);
      renderScoreHelper();
      scheduleSave();
    });
    on(scorePendingList, "click", handleScoreItemAction);
    on(scoreManualPendingList, "click", handleScoreItemAction);
    on(scoreCompletedList, "click", handleScoreItemAction);

    on(btnAdd, "click", addPlayer);
    on(addPlayerNameInput, "keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        addPlayer();
      }
    });

    // Search input
    on(
      searchBox,
      "input",
      debounce(() => {
        updateClearSearchButton();
        const visiblePlayers = getVisiblePlayers();
        updateStats(visiblePlayers);
        renderPlayerList(visiblePlayers);
      }, 120),
    );

    // Clear search button
    if (btnClearSearch) {
      on(btnClearSearch, "click", () => {
        if (searchBox) {
          searchBox.value = "";
          btnClearSearch.hidden = true;
          const visiblePlayers = getVisiblePlayers();
          updateStats(visiblePlayers);
          renderPlayerList(visiblePlayers);
          searchBox.focus();
        }
      });
    }
    on(searchBox, "keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const visible = getVisiblePlayers();
        if (visible.length === 0) return;
        // PC: Enter => check-in first match (Plan #7)
        setCheckIn(visible[0].id, true);
      }
    });

    // Group filter click (segmented)
    on(groupFilterEl, "click", (e) => {
      const target = isElement(e.target) ? e.target : null;
      if (!target) return;
      const btn = target.closest("button");
      if (!btn || !btn.dataset || !btn.dataset.group) return;

      const g = String(btn.dataset.group || "all");
      state.ui.group = g;
      scheduleSave();
      refreshCheckinUI();
    });

    // Group filter keyboard navigation (ArrowLeft/ArrowRight/Home/End)
    on(groupFilterEl, "keydown", (e) => {
      const key = String(e.key || "");
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(key)) return;

      const buttons = Array.from(
        groupFilterEl.querySelectorAll("button.seg-btn"),
      );
      if (!buttons.length) return;

      const target = isElement(e.target) ? e.target : null;
      const currentBtn = target ? target.closest("button.seg-btn") : null;

      let idx = currentBtn ? buttons.indexOf(currentBtn) : -1;
      if (idx < 0)
        idx = buttons.findIndex(
          (b) => b.getAttribute("aria-selected") === "true",
        );
      if (idx < 0) idx = 0;

      if (key === "Home") idx = 0;
      else if (key === "End") idx = buttons.length - 1;
      else if (key === "ArrowLeft")
        idx = (idx - 1 + buttons.length) % buttons.length;
      else if (key === "ArrowRight") idx = (idx + 1) % buttons.length;

      const next = buttons[idx];
      if (!next) return;

      e.preventDefault();

      const g = String(next.dataset.group || "all");
      state.ui.group = g;
      scheduleSave();
      refreshCheckinUI();

      // Rerendering recreates buttons; restore focus to the selected tab.
      try {
        const after = Array.from(
          groupFilterEl.querySelectorAll("button.seg-btn"),
        );
        const focusBtn = after.find((b) => String(b.dataset.group || "") === g);
        if (focusBtn) focusBtn.focus();
      } catch (_) {
        // ignore focus errors
      }
    });

    // Call mode / show time toggles
    on(btnCallMode, "click", () => {
      state.ui.callMode = !state.ui.callMode;
      scheduleSave();
      refreshCheckinUI();
      showSnackbar(
        state.ui.callMode ? "已开启点名模式" : "已关闭点名模式",
        1800,
      );
    });

    on(btnShowTime, "click", () => {
      state.ui.showTime = !state.ui.showTime;
      scheduleSave();
      refreshCheckinUI();
      showSnackbar(
        state.ui.showTime ? "已显示签到时间" : "已隐藏签到时间",
        1800,
      );
    });

    on(btnSuspects, "click", () => {
      if (
        !state ||
        !Array.isArray(state.players) ||
        state.players.length === 0
      ) {
        showSnackbar("当前没有名单可检查", 2200);
        return;
      }

      const report = computeSuspectReport(state.players);
      if (
        (report.duplicatePairsTotal || 0) === 0 &&
        (report.anomaliesTotal || 0) === 0
      ) {
        showSnackbar("未发现明显重复/异常", 2200);
        return;
      }

      showSuspectsDialog(report, { allowDisableAuto: true });
    });

    // Player list (delegation)
    on(playerList, "click", (e) => {
      const target = isElement(e.target) ? e.target : null;
      if (!target) return;

      const btn = target.closest("button");
      if (btn) {
        const action = btn.dataset.action;
        const id = Number(btn.dataset.playerId);
        if (!action || !Number.isFinite(id)) return;

        if (action === "toggle-checkin") toggleCheckIn(id);
        else if (action === "toggle-new") toggleNewStatus(id);
        else if (action === "edit") showEditPlayerDialog(id);
        else if (action === "delete") deletePlayer(id);
        return;
      }

      // Call mode: tap row to check-in quickly
      if (state.ui && state.ui.callMode) {
        const row = target.closest(".player-item");
        if (!row || !row.dataset || !row.dataset.playerId) return;
        const id = Number(row.dataset.playerId);
        if (!Number.isFinite(id)) return;
        setCheckIn(id, true);
      }
    });

    // Inputs -> state
    on(clubMembersEl, "input", () => {
      state.clubText = clubMembersEl.value || "";
      updateImportEmptyState();
      scheduleSave();
    });

    on(relayInfoEl, "input", () => {
      state.relayText = relayInfoEl.value || "";
      updateImportEmptyState();
      scheduleSave();
    });

    on(competitionNameInput, "input", () => {
      state.competitionName =
        normalizeWhitespace(competitionNameInput.value) || "比赛签到表";
      if (competitionTitleEl)
        competitionTitleEl.textContent = state.competitionName;
      scheduleSave();
    });

    // Reset + help
    on(btnReset, "click", () => {
      showConfirm(
        "清除本地进度",
        "将删除此设备上保存的签到进度（可在底部提示条中撤销）。确定继续吗？",
        clearStorageAndReset,
        "清除",
      );
    });

    on(btnHelp, "click", showHelp);

    // Export modal
    on(btnExportQuick, "click", quickExportAsPNG);
    on(btnExportClose, "click", closeExportModal);
    on(exportBackdrop, "click", (e) => {
      if (e.target === exportBackdrop) closeExportModal();
    });

    on(btnDownloadPng, "click", downloadAsPNG);
    on(btnDownloadCsv, "click", downloadAsCSV);
    on(btnCopy, "click", copyAsText);

    // Export options -> live preview
    on(exportGroupSel, "change", renderExportPreview);
    on(exportScopeSel, "change", renderExportPreview);
    on(exportOrderSel, "change", renderExportPreview);
    on(exportWithGroupEl, "change", renderExportPreview);
    on(exportWithPlatformEl, "change", renderExportPreview);
    on(exportWithAccountEl, "change", renderExportPreview);
    on(exportWithClubEl, "change", renderExportPreview);
    on(exportWithTimeEl, "change", renderExportPreview);

    // JSON export/import
    on(btnExportJson, "click", exportProgressAsJSON);
    on(btnImportJsonPaste, "click", showImportProgressPasteDialog);
    on(importJsonInput, "change", () => {
      const file = importJsonInput.files && importJsonInput.files[0];
      importProgressFromJSONFile(file);
    });

    // Dialog close on backdrop click
    on(dialogBackdrop, "click", (e) => {
      if (e.target === dialogBackdrop) closeDialog();
    });

    // Snackbar action
    on(snackbarAction, "click", () => {
      if (typeof snackbarActionHandler === "function") {
        try {
          snackbarActionHandler();
        } finally {
          hideSnackbar();
        }
      }
    });

    // ESC close
    on(window, "keydown", (e) => {
      const key = String(e.key || "").toLowerCase();
      const saveShortcut = (e.metaKey || e.ctrlKey) && e.shiftKey && key === "s";
      if (saveShortcut) {
        const exportOpen =
          exportBackdrop && !exportBackdrop.classList.contains("hidden");
        if (exportOpen) {
          e.preventDefault();
          downloadAsPNG();
          return;
        }

        if (getCurrentStep() === "checkin" && state.players.length > 0) {
          e.preventDefault();
          generateFinalTable();
          showSnackbar(
            "已打开签到总表预览。再次按 ⌘/Ctrl + Shift + S 保存图片。",
            3200,
          );
          return;
        }
      }

      if (
        e.key === "Enter" &&
        getCurrentStep() === "score-helper" &&
        !(e.target && /input|textarea|select/i.test(e.target.tagName || ""))
      ) {
        e.preventDefault();
        completeTopScoreItem();
        return;
      }

      if (e.key === "Escape") {
        if (dialogBackdrop && !dialogBackdrop.classList.contains("hidden"))
          closeDialog();
        if (exportBackdrop && !exportBackdrop.classList.contains("hidden"))
          closeExportModal();
        hideSnackbar();
      }
    });
  }

  // ------------------------------
  // Apply state to UI (on init)
  // ------------------------------
  function applyStateToUI(fromReset = false) {
    if (clubMembersEl) clubMembersEl.value = state.clubText || "";
    if (relayInfoEl) relayInfoEl.value = state.relayText || "";
    updateImportEmptyState();
    updateClearSearchButton();
    updateAutosaveChip(state.savedAt);
    renderGroupRulesEditor();

    if (competitionTitleEl)
      competitionTitleEl.textContent = state.competitionName || "比赛签到表";
    if (competitionNameInput)
      competitionNameInput.value = state.competitionName || "";

    applyStepUI();

    applyModeClasses();

    const step = getCurrentStep();

    // Show "继续上次进度" only when we are viewing import page but saved step is checkin.
    if (btnResume) {
      const canResume =
        step === "import" &&
        (state.step === "checkin" || state.step === "score-helper") &&
        Array.isArray(state.players) &&
        state.players.length > 0;
      btnResume.hidden = !canResume;
    }

    if (step === "checkin") {
      refreshCheckinUI();
    } else if (step === "score-helper") {
      renderScoreHelper();
    } else {
      if (playerList) playerList.innerHTML = "";
      renderGroupFilter();
      updateStats();
    }
  }

  // ------------------------------
  // Init
  // ------------------------------
  function init() {
    // Some embedded browsers report color-mix support incorrectly.
    // Add a defensive class fallback to keep UI readable.
    try {
      const root = document.documentElement;
      const css = window.CSS;
      const ok = !!(
        css &&
        typeof css.supports === "function" &&
        css.supports("color", "color-mix(in srgb, #000 50%, #fff)")
      );
      if (root && root.classList && !ok) root.classList.add("no-color-mix");
    } catch (_) {
      const root = document.documentElement;
      if (root && root.classList) root.classList.add("no-color-mix");
    }

    wireEvents();
    setupIOSTouchCheckinLayout();

    // Flush pending autosave when the page is backgrounded/closed.
    window.addEventListener("pagehide", flushSave);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden || document.visibilityState === "hidden") {
        flushSave();
      }
    });

    // PWA: offline cache + "添加到主屏幕"
    registerServiceWorker();
    setupPWAInstall();

    setupSwipeGestures();

    // Mainland CN: many users open this in in-app browsers (WeChat/QQ/Weibo...).
    // These webviews may restrict downloads & PWA installation; show a one-time tip.
    maybeShowInAppBrowserTipOnce();

    const loaded = loadFromStorage();
    if (loaded) {
      state = loaded;

      // Saved check-in progress exists: default to showing import page, without overwriting stored step.
      if (
        state.step === "checkin" &&
        state.players &&
        state.players.length > 0
      ) {
        viewStepOverride = "import";
      }

      applyStateToUI();

      if (state.step === "checkin" && state.players.length > 0) {
        showSnackbar("已从本地恢复签到进度", 2400);
      } else if (
        state.step === "import" &&
        (state.clubText || state.relayText)
      ) {
        showSnackbar("已恢复上次粘贴的文本", 2200);
      }
    } else {
      applyStateToUI(true);
    }

    startLocalSync();
  }

  // ------------------------------------------------------------
  // Node.js export (regression tests)
  // ------------------------------------------------------------
  if (IS_NODE) {
    // Export only the pure logic that tests rely on.
    module.exports = {
      // Parsing
      normalizeWhitespace,
      cleanPlayerLine,
      parseLineToFields,
      parseImportTextsDetailed,
      // Suspects / duplicates
      computeSuspectReport,
      // Utilities used by tests
      normalizeForSimilarity,
      diceSimilarity,
    };
    return;
  }

  init();
})();
