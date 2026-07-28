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
  const FTD_TRANSCRIPT = IS_NODE
    ? require("./ftd-transcript-shared.js")
    : window.FtdTranscriptShared;
  const FTD_PLAYER_REGISTRATION = IS_NODE
    ? require("./ftd-player-registration-shared.js")
    : window.FtdPlayerRegistrationShared;
  const FTD_ROUND = IS_NODE
    ? require("./ftd-round-shared.js")
    : window.FtdRoundShared;
  const STATE_SYNC = IS_NODE
    ? require("./frontend-state-sync.js")
    : window.TournamentStateSync;

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

  const SCORE_STAGE_SEMIFINAL = "semifinal";
  const SCORE_STAGE_FINALS = "finals";
  const SCORE_STAGE_PRELIMINARY = "preliminary";
  const SCORE_FINAL_STAGE_COUNT = 2;
  const MAX_PRELIMINARY_ROUNDS = 7;

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
    accountMapping: null,
    ftdPlayerAccountMapping: null,
    ftdPlayerRegistration: FTD_PLAYER_REGISTRATION.emptyRegistration(),
    wechatGroupNicks: null,
    ftdRound: null,
    egaAnalysis: {
      schema: "ega-analysis-state-v1",
      updatedAt: "",
      scope: "prelim-only",
      roundLimit: 7,
      summaryFile: "",
      gameCount: 0,
      playerCount: 0,
      topPlayers: [],
      pairingLossByRound: {},
      engine: {},
    },
    ui: {
      group: "all", // 'all' | groupName
      callMode: false, // 点名模式
      showTime: false, // 显示签到时间
      ftdUrl: "",
      oqPollSeconds: 60,
      checkinView: "players",
    },
    savedAt: now(),
  });

  let state = initialState();
  // UI-only override so we can show "导入页 + 继续上次进度" without overwriting saved step.
  let viewStepOverride = null;
  let saveTimer = null;
  let localSaveDirty = false;
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
  const LOCAL_SYNC_COMMAND_URL = "/api/state/commands";
  const LOCAL_SYNC_EVENTS_URL = "/api/events";
  const LOCAL_SYNC_FTD_ROUND_URL = "/api/ftd-round";
  const LOCAL_SYNC_FTD_TRANSCRIPT_PREPARE_URL = "/api/ftd-transcripts/prepare";
  const LOCAL_SYNC_WECHAT_MEMBER_MAP_URL = "/api/wechat-member-map";
  const LOCAL_SYNC_WECHAT_MEMBER_MAP_REFRESH_URL = "/api/wechat-member-map/refresh";
  const LOCAL_SYNC_OQ_ACCOUNTS_VALIDATE_URL = "/api/oq-accounts/validate";
  const LOCAL_SYNC_MAP_COLLAB_SYNC_URL = "/api/map-collab/sync";
  const LOCAL_SYNC_OQ_ROUND_SCORES_UPDATE_URL = "/api/oq-games/update-round-scores";
  const LOCAL_SYNC_OQ_ROUND_SCORES_STATUS_URL = "/api/oq-games/update-round-scores/status";
  const LOCAL_SYNC_AUTOMATION_STATUS_URL = "/api/automation/status";
  const LOCAL_SYNC_AUTOMATION_PROBE_URL = "/api/automation/probe";
  const LOCAL_SYNC_AUTOMATION_START_URL = "/api/automation/start";
  const LOCAL_SYNC_AUTOMATION_CLAIM_URL = "/api/automation/claim";
  const LOCAL_SYNC_AUTOMATION_PAUSE_URL = "/api/automation/pause";
  const LOCAL_SYNC_AUTOMATION_RESUME_URL = "/api/automation/resume";
  const LOCAL_SYNC_AUTOMATION_STOP_URL = "/api/automation/stop";
  const FTD_AUTOPILOT_CONTROL_KEY = "ftd-round-autopilot-control-v1";
  const LOCAL_SYNC_EGA_STATUS_URL = "/api/ega-analysis/status";
  const LOCAL_SYNC_EGA_START_URL = "/api/ega-analysis/start";
  const LOCAL_SYNC_EGA_STOP_URL = "/api/ega-analysis/stop";
  const LOCAL_SYNC_SELF_CHECK_URL = "/api/self-check";
  const LOCAL_SYNC_SELF_CHECK_RUN_URL = "/api/self-check/run";
  const LOCAL_SYNC_CLIENT_ID =
    !IS_NODE && typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `client-${Math.random().toString(16).slice(2)}-${Date.now()}`;
  let localSyncApplyingRemote = false;
  let localSyncPushTimer = null;
  let localSyncPushInFlight = false;
  let localSyncPushPromise = null;
  let localSyncPendingPush = false;
  let localSyncLastRevision = -1;
  let localSyncLastErrorAt = 0;
  let localSyncPollTimer = null;
  let localSyncEventSource = null;
  let localSyncLastFtdMtimeMs = 0;
  let localSyncIgnoreNextFtdEventUntil = 0;
  let localSyncSkippedRemoteCount = 0;
  let localSyncBaseState = null;
  let localSyncConnectedOnce = false;
  let activeInputDraft = null;
  let deferredEntityRender = false;
  const BROWSER_PREFS_KEY = "tournament-assistant-browser-ui-v1";

  function hasLocalSyncEditsInFlight() {
    return Boolean(
      localSaveDirty ||
        saveTimer ||
        localSyncPushTimer ||
        localSyncPushInFlight ||
        localSyncPendingPush ||
        (lastLocalEditAt && now() - lastLocalEditAt < 1200),
    );
  }

  function scoreStageForIndex(index, preliminaryRoundCount) {
    if (index < preliminaryRoundCount) return SCORE_STAGE_PRELIMINARY;
    if (index === preliminaryRoundCount) return SCORE_STAGE_SEMIFINAL;
    return SCORE_STAGE_FINALS;
  }

  function scoreStageLabel(round) {
    const stage = normalizeWhitespace(round && round.stage);
    if (stage === SCORE_STAGE_SEMIFINAL) return "半决赛";
    if (stage === SCORE_STAGE_FINALS) return "决赛阶段";
    return `第 ${Math.max(1, Math.trunc(Number(round && round.round) || 1))} 轮`;
  }

  function createEmptyScoreRound(round, stage) {
    return {
      round,
      stage,
      roundStartAt: "",
      roundStartSource: "",
      pending: [],
      manualPending: [],
      completed: [],
      ftdPairings: [],
    };
  }

  function createDefaultScoreHelper(preliminaryRoundCount = 1) {
    const preliminaryCount = Math.max(
      1,
      Math.min(MAX_PRELIMINARY_ROUNDS, Math.trunc(Number(preliminaryRoundCount) || 1)),
    );
    const count = preliminaryCount + SCORE_FINAL_STAGE_COUNT;
    return {
      version: 2,
      preliminaryRoundCount: preliminaryCount,
      roundCount: count,
      roundCountSource: "default",
      activeRound: 1,
      rounds: Array.from({ length: count }, (_, i) =>
        createEmptyScoreRound(i + 1, scoreStageForIndex(i, preliminaryCount)),
      ),
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
    localSaveDirty = true;
    state.savedAt = now();
    lastLocalEditAt = state.savedAt;
    if (saveTimer) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      saveTimer = null;
      const ok = saveBrowserPreferences();
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
    if (!localSaveDirty && !saveTimer) {
      if (localSyncPushTimer) {
        window.clearTimeout(localSyncPushTimer);
        localSyncPushTimer = null;
        pushLocalSyncState();
      }
      return;
    }
    state.savedAt = now();
    lastLocalEditAt = state.savedAt;
    if (saveTimer) window.clearTimeout(saveTimer);
    saveTimer = null;
    if (saveBrowserPreferences()) updateAutosaveChip(state.savedAt);
    queueLocalSyncPush({ immediate: true });
  }

  function saveStateToLocalOnly() {
    if (!state || Number(state.version) !== STORAGE_VERSION) return false;
    const ok = saveBrowserPreferences();
    if (ok) {
      updateAutosaveChip(state.savedAt);
    }
    return ok;
  }

  async function saveAndPushLocalSyncNow() {
    if (saveTimer) window.clearTimeout(saveTimer);
    saveTimer = null;
    if (localSyncPushTimer) window.clearTimeout(localSyncPushTimer);
    localSyncPushTimer = null;

    if (localSaveDirty) {
      state.savedAt = now();
      lastLocalEditAt = state.savedAt;
      saveStateToLocalOnly();
    }

    if (LOCAL_SYNC_ENABLED) {
      return await pushLocalSyncState();
    }
    return { ok: true, localOnly: true };
  }

  function saveScoreUserEditNow() {
    localSaveDirty = true;
    state.savedAt = now();
    lastLocalEditAt = state.savedAt;
    void saveAndPushLocalSyncNow();
  }

  function browserPreferences() {
    return {
      viewedStep: getCurrentStep(),
      viewedRound: Math.max(1, Math.trunc(Number(state && state.scoreHelper && state.scoreHelper.activeRound) || 1)),
      ui: state && state.ui ? deepClone(state.ui) : {},
    };
  }

  function saveBrowserPreferences() {
    return safeLocalStorageSet(BROWSER_PREFS_KEY, JSON.stringify(browserPreferences()));
  }

  function loadBrowserPreferences() {
    const raw = safeLocalStorageGet(BROWSER_PREFS_KEY);
    if (!raw) return null;

    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;

      return parsed;
    } catch (e) {
      console.warn("解析浏览器界面偏好失败：", e);
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

  async function pushLocalSyncState(options = {}) {
    if (!LOCAL_SYNC_ENABLED || localSyncApplyingRemote) return;
    if (localSyncPushInFlight) {
      localSyncPendingPush = true;
      return localSyncPushPromise;
    }

    if (!localSyncBaseState) return null;
    const mutations = STATE_SYNC.buildMutations(localSyncBaseState, state);
    if (!mutations.length) {
      localSaveDirty = false;
      return { ok: true, changed: false, revision: localSyncLastRevision, changedEntities: [] };
    }

    const showStatus = !(options && options.silentStatus);
    const run = (async () => {
      localSyncPushInFlight = true;
      if (showStatus) setLocalSyncStatus("busy", "本地同步：保存中");
      try {
        const response = await fetch(LOCAL_SYNC_COMMAND_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          cache: "no-store",
          body: JSON.stringify({
            commandId: `${LOCAL_SYNC_CLIENT_ID}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
            type: "entities.mutate",
            actor: "user",
            payload: { mutations },
          }),
        });
        const result = await response.json().catch(() => null);
        if (!response.ok || !result || result.ok !== true) {
          const conflict = new Error(
            (result && (result.detail || result.error)) ||
              `HTTP ${response.status}`,
          );
          conflict.status = response.status;
          conflict.payload = result;
          throw conflict;
        }
        localSyncLastRevision = Number(result.revision);
        STATE_SYNC.applyChangedEntities(localSyncBaseState, result.changedEntities || []);
        STATE_SYNC.applyChangedEntities(state, result.changedEntities || []);
        if (state.localSync) state.localSync.revision = localSyncLastRevision;
        if (localSyncBaseState.localSync) localSyncBaseState.localSync.revision = localSyncLastRevision;
        localSaveDirty = false;
        if (showStatus) setLocalSyncStatus("ok", "本地同步：已保存");
        return result;
      } catch (error) {
        if (error && error.status === 409 && error.payload && error.payload.authoritativeEntity) {
          const authoritative = error.payload.authoritativeEntity;
          STATE_SYNC.applyChangedEntities(localSyncBaseState, [{
            kind: authoritative.kind,
            id: authoritative.id,
            revision: authoritative.revision,
            entity: authoritative.entity,
          }]);
          showSnackbar("该行已被其他操作更新；你的输入草稿已保留，请核对后重试", 6200);
        }
        reportLocalSyncError("写入共享状态失败", error);
        return null;
      } finally {
        localSyncPushInFlight = false;
        if (localSyncPendingPush) {
          localSyncPendingPush = false;
          queueLocalSyncPush({ immediate: true });
        }
      }
    })();

    localSyncPushPromise = run;
    try {
      return await run;
    } finally {
      if (localSyncPushPromise === run) localSyncPushPromise = null;
    }
  }

  function applyRemoteState(remoteState, meta = {}) {
    const currentVisibleStep = getCurrentStep();
    const currentCheckinView = state && state.ui ? state.ui.checkinView : "";
    const currentUi = state && state.ui ? deepClone(state.ui) : {};
    const currentViewedRound = Math.max(1, Math.trunc(Number(state && state.scoreHelper && state.scoreHelper.activeRound) || 1));
    const loaded = sanitizeLoadedState(remoteState);
    if (!loaded || !Array.isArray(loaded.players)) {
      throw new Error("共享状态无法通过前端校验");
    }

    const hasRemotePlayers = Boolean(
      loaded && Array.isArray(loaded.players) && loaded.players.length > 0,
    );

    localSyncApplyingRemote = true;
    try {
      localSyncBaseState = deepClone(loaded);
      state = loaded;
      state.step = currentVisibleStep === "self-check" ? "checkin" : currentVisibleStep;
      state.ui = { ...(state.ui || {}), ...currentUi };
      if (state.scoreHelper) {
        state.scoreHelper.activeRound = Math.max(1, Math.min(state.scoreHelper.roundCount || 1, currentViewedRound));
      }
      if (currentVisibleStep === "self-check") {
        viewStepOverride = "self-check";
      } else if (currentVisibleStep === "checkin" && state.step === "score-helper") {
        viewStepOverride = "checkin";
      } else if (currentVisibleStep === "score-helper" && state.step === "checkin") {
        viewStepOverride = "score-helper";
      } else {
        viewStepOverride = null;
      }
      if (
        currentVisibleStep === "checkin" &&
        (currentCheckinView === "mapping" || currentCheckinView === "players" || currentCheckinView === "ftd-players")
      ) {
        state.ui.checkinView = currentCheckinView;
      }
      applyStateToUI();
      saveBrowserPreferences();
      updateAutosaveChip(state.savedAt);
      if (!(meta && meta.silentStatus)) {
        setLocalSyncStatus("ok", (meta && meta.statusText) || "本地同步：已连接");
      }
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
    if (!options.force && (hasLocalSyncEditsInFlight() || activeInputDraft)) {
      localSyncSkippedRemoteCount += 1;
      if (localSyncSkippedRemoteCount === 1 || localSyncSkippedRemoteCount % 6 === 0) {
        setLocalSyncStatus("busy", "本地同步：等待本地操作保存");
      }
      return;
    }
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
      localSyncSkippedRemoteCount = 0;

      if (!result.state) {
        setLocalSyncStatus("ok", "本地同步：已连接");
        if (options.pushIfEmpty !== false) {
          queueLocalSyncPush({ immediate: true });
        }
        return;
      }

      applyRemoteState(result.state, {
        showToast: Boolean(options.showToast),
        silentStatus: Boolean(options.silentStatus),
        statusText: "本地同步：已连接",
      });
    } catch (error) {
      reportLocalSyncError("读取共享状态失败", error);
    }
  }

  function normalizeFtdStage(value) {
    const text = normalizeWhitespace(value).toUpperCase();
    if (text === "SF" || text === "SEMI-FINALS" || text === "SEMIFINAL") return "SF";
    if (text === "F" || text === "FINALS" || text === "FINAL") return "F";
    if (text === "3/4" || text === "MATCH FOR 3RD PLACE" || text === "THIRD-PLACE") return "3/4";
    return "";
  }

  function ftdPayloadStage(payload) {
    return normalizeFtdStage(
      payload && (payload.stage || payload.roundName || payload.round_name || payload.ftdStage),
    );
  }

  function normalizeFtdPairingForState(raw, index, existingByKey, options = {}) {
    const sourceTableRaw = Number(raw && raw.table);
    const sourceTable =
      Number.isFinite(sourceTableRaw) && sourceTableRaw > 0
        ? Math.trunc(sourceTableRaw)
        : index + 1;
    const tableRaw = Number(options.localTable || sourceTable);
    const table =
      Number.isFinite(tableRaw) && tableRaw > 0
        ? Math.trunc(tableRaw)
        : index + 1;
    const black = normalizeWhitespace(raw && raw.black);
    const white = normalizeWhitespace(raw && raw.white);
    if (!black || !white) return null;

    const key = `${table}\n${normalizeKey(black)}\n${normalizeKey(white)}`;
    const existing = existingByKey && existingByKey.get(key);
    const base = {
      table,
      black,
      white,
      status: "imported",
      reporter: "",
      opponent: "",
      blackScore: null,
      whiteScore: null,
      resultText: "",
      reason: "",
      imagePath: "",
      sourceMessageKey: "",
      resultKind: "",
      updatedAt: now(),
      completedAt: null,
      lastEditedBy: "user",
      lastEditedAt: now(),
      ftdStage: normalizeFtdStage(options.ftdStage),
      ftdRound: Number.isFinite(Number(options.ftdRound))
        ? Math.trunc(Number(options.ftdRound))
        : null,
      ftdTable: sourceTable,
    };

    if (!existing) return normalizeFtdByePairing(base);

    // Re-importing the same FTD table should not erase already processed scores.
    const merged = sanitizeScoreRound({
      round: 1,
      ftdPairings: [{ ...base, ...existing, table, black, white }],
    }, 1).ftdPairings[0];
    return normalizeFtdByePairing(merged);
  }

  async function mergeFtdRoundIntoScoreHelper(ftdRound, options = {}) {
    const payload = ftdRound && typeof ftdRound === "object" ? ftdRound : null;
    if (!payload) throw new Error("FTD 轮次数据为空");

    const helper = ensureScoreHelper();
    const activeRound = getActiveScoreRound(helper);
    const importPreconditions = {
      roundId: activeRound && activeRound.entityId,
      roundRevision: Number(activeRound && activeRound.entityRevision) || 0,
      helperId: helper.entityId,
      helperRevision: Number(helper.entityRevision) || 0,
      ftdRoundRevision: Number(state.localSync && state.localSync.domains && state.localSync.domains.ftdRound && state.localSync.domains.ftdRound.entityRevision) || 0,
      scoreRows: (activeRound && Array.isArray(activeRound.ftdPairings) ? activeRound.ftdPairings : []).map((row) => ({
        id: row.entityId,
        revision: Number(row.entityRevision) || 0,
      })),
    };
    const activeStage = normalizeWhitespace(activeRound && activeRound.stage);
    const importedStage = ftdPayloadStage(payload);
    const ftdRoundRaw = Number(payload.ftdRound != null ? payload.ftdRound : payload.round);
    const ftdRoundId = Number.isFinite(ftdRoundRaw) && ftdRoundRaw > 0 ? Math.trunc(ftdRoundRaw) : null;
    let roundNumber = Math.trunc(Number(activeRound && activeRound.round) || helper.activeRound || 1);

    if (activeStage === SCORE_STAGE_PRELIMINARY) {
      if (importedStage) throw new Error(`当前选中的是预赛，但文件属于 FTD ${importedStage} 阶段`);
      const payloadRound = Math.trunc(Number(payload.round) || 0);
      if (payloadRound && payloadRound !== roundNumber) {
        throw new Error(`当前选中第 ${roundNumber} 轮，但文件属于 FTD 第 ${payloadRound} 轮`);
      }
    } else if (activeStage === SCORE_STAGE_SEMIFINAL) {
      if (importedStage !== "SF") throw new Error("半决赛只能导入带 SF 阶段标识的 FTD JSON");
    } else if (activeStage === SCORE_STAGE_FINALS) {
      if (importedStage !== "F" && importedStage !== "3/4") {
        throw new Error("决赛阶段只能导入带 F 或 3/4 阶段标识的 FTD JSON");
      }
    }

    const sourcePairings = Array.isArray(payload.pairings)
      ? payload.pairings
      : Array.isArray(payload.blankPairings)
        ? payload.blankPairings
        : [];
    if (!sourcePairings.length) {
      throw new Error("FTD 轮次没有可导入的配对");
    }

    helper.activeRound = roundNumber;
    const round = helper.rounds[roundNumber - 1];

    const existingByKey = new Map();
    const existingPairings = Array.isArray(round.ftdPairings)
      ? round.ftdPairings
      : [];
    for (const item of existingPairings) {
      const tableRaw = Number(item && item.table);
      const table =
        Number.isFinite(tableRaw) && tableRaw > 0 ? Math.trunc(tableRaw) : 0;
      const black = normalizeWhitespace(item && item.black);
      const white = normalizeWhitespace(item && item.white);
      if (!table || !black || !white) continue;
      existingByKey.set(
        `${table}\n${normalizeKey(black)}\n${normalizeKey(white)}`,
        item,
      );
    }

    if (activeStage === SCORE_STAGE_SEMIFINAL && sourcePairings.length !== 2) {
      throw new Error(`半决赛应有 2 台配对，当前文件包含 ${sourcePairings.length} 台`);
    }
    if (activeStage === SCORE_STAGE_FINALS && sourcePairings.length !== 1) {
      throw new Error(`${importedStage} 阶段应有 1 台配对，当前文件包含 ${sourcePairings.length} 台`);
    }

    const importedPairings = sourcePairings
      .map((item, index) =>
        normalizeFtdPairingForState(item, index, existingByKey, {
          localTable:
            activeStage === SCORE_STAGE_FINALS
              ? importedStage === "F" ? 1 : 2
              : null,
          ftdStage: importedStage,
          ftdRound: ftdRoundId,
        }),
      )
      .filter(Boolean);
    if (!importedPairings.length) {
      throw new Error("FTD 配对解析后为空");
    }

    const nextPairings =
      activeStage === SCORE_STAGE_FINALS
        ? existingPairings
            .filter((item) => normalizeFtdStage(item && item.ftdStage) !== importedStage)
            .concat(importedPairings)
            .sort((a, b) => Number(a.table) - Number(b.table))
        : importedPairings;

    round.ftdPairings = nextPairings;

    helper.updatedAt = now();
    state.ftdRound = sanitizeFtdRoundMeta({
      sourceFile: options.sourceFile || "",
      currentFile: options.currentFile || "",
      source: payload.source || "local-ftd-round",
      url: payload.url || "",
      title: payload.title || "",
      exportedAt: payload.exportedAt || "",
      importedAt: new Date().toISOString(),
      competitionName: payload.competitionName || "",
      round: roundNumber,
      stage: importedStage,
      ftdRound: ftdRoundId,
      pairingCount: nextPairings.length,
      note: "Scores intentionally discarded; only table, black, white, and explicit round count are imported.",
    });
    state.step = "score-helper";
    viewStepOverride = null;
    if (!importPreconditions.roundId || !importPreconditions.helperId) {
      throw new Error("共享状态尚未提供轮次实体身份，请重新连接本地服务后再导入");
    }
    const roundPatch = { ...round };
    delete roundPatch.ftdPairings;
    delete roundPatch.pending;
    delete roundPatch.manualPending;
    delete roundPatch.completed;
    delete roundPatch.entityId;
    delete roundPatch.entityRevision;
    const response = await fetch(LOCAL_SYNC_COMMAND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        commandId: `${LOCAL_SYNC_CLIENT_ID}-round-import-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        type: "round.import",
        actor: "user",
        target: { kind: "round", id: importPreconditions.roundId },
        expectedRevision: importPreconditions.roundRevision,
        preconditions: [
          { target: { kind: "scoreHelperMetadata", id: importPreconditions.helperId }, expectedRevision: importPreconditions.helperRevision },
          { target: { kind: "domain", id: "domain:ftdRound" }, expectedRevision: importPreconditions.ftdRoundRevision },
          ...importPreconditions.scoreRows.map((row) => ({
            target: { kind: "scoreRow", id: row.id },
            expectedRevision: row.revision,
          })),
        ],
        payload: {
          pairings: nextPairings,
          roundPatch,
          scoreHelperPatch: {
            version: helper.version,
            preliminaryRoundCount: helper.preliminaryRoundCount,
            roundCount: helper.roundCount,
            roundCountSource: helper.roundCountSource,
            autoRoundCountPlayerCount: helper.autoRoundCountPlayerCount,
            updatedAt: helper.updatedAt,
          },
          ftdRound: state.ftdRound,
        },
      }),
    });
    const commandResult = await response.json().catch(() => null);
    if (!response.ok || !commandResult || commandResult.ok !== true) {
      throw new Error((commandResult && (commandResult.error || commandResult.detail)) || `HTTP ${response.status}`);
    }
    STATE_SYNC.applyChangedEntities(localSyncBaseState, commandResult.changedEntities || []);
    STATE_SYNC.applyChangedEntities(state, commandResult.changedEntities || []);
    localSyncLastRevision = Number(commandResult.revision) || localSyncLastRevision;
    applyStateToUI();
    saveBrowserPreferences();
    return {
      round: roundNumber,
      label: scoreStageLabel(round),
      importedStage,
      importedPairingCount: importedPairings.length,
      pairingCount: nextPairings.length,
    };
  }

  async function fetchAndMergeFtdRound(options = {}) {
    if (!LOCAL_SYNC_ENABLED) return false;
    try {
      const response = await fetch(`${LOCAL_SYNC_FTD_ROUND_URL}?t=${Date.now()}`, {
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

      const mtimeMs = Number(result.mtimeMs);
      if (
        Number.isFinite(mtimeMs) &&
        mtimeMs > 0 &&
        mtimeMs === localSyncLastFtdMtimeMs &&
        !options.force
      ) {
        return false;
      }
      if (Number.isFinite(mtimeMs) && mtimeMs > 0) {
        localSyncLastFtdMtimeMs = mtimeMs;
      }
      if (!result.ftdRound) return false;

      const merged = await mergeFtdRoundIntoScoreHelper(result.ftdRound, {
        currentFile: result.file || "",
      });
      if (options.showToast !== false) {
        showSnackbar(
          `已导入 FTD 第 ${merged.round} 轮配对：${merged.pairingCount} 台`,
          3200,
        );
      }
      return true;
    } catch (error) {
      reportLocalSyncError("导入 FTD 配对失败", error);
      return false;
    }
  }

  function startLocalSync() {
    if (!LOCAL_SYNC_ENABLED) {
      setLocalSyncStatus("idle", "本地同步：未连接");
      return;
    }

    const draftElement = (target) => {
      if (!target || !target.matches || !target.matches("input, textarea, select, [contenteditable='true']")) return null;
      return target;
    };
    document.addEventListener("focusin", (event) => {
      const element = draftElement(event.target);
      if (!element) return;
      const owner = element.closest && element.closest("[data-entity-id]");
      activeInputDraft = {
        element,
        entityId: owner && owner.dataset ? String(owner.dataset.entityId || "") : "",
        value: "value" in element ? element.value : element.textContent,
        selectionStart: typeof element.selectionStart === "number" ? element.selectionStart : null,
        selectionEnd: typeof element.selectionEnd === "number" ? element.selectionEnd : null,
        dirty: false,
      };
    }, true);
    document.addEventListener("input", (event) => {
      const element = draftElement(event.target);
      if (!element || !activeInputDraft || activeInputDraft.element !== element) return;
      activeInputDraft.value = "value" in element ? element.value : element.textContent;
      activeInputDraft.selectionStart = typeof element.selectionStart === "number" ? element.selectionStart : null;
      activeInputDraft.selectionEnd = typeof element.selectionEnd === "number" ? element.selectionEnd : null;
      activeInputDraft.dirty = true;
    }, true);
    document.addEventListener("focusout", (event) => {
      if (!activeInputDraft || activeInputDraft.element !== event.target) return;
      window.setTimeout(() => {
        activeInputDraft = null;
        if (deferredEntityRender) {
          deferredEntityRender = false;
          applyStateToUI();
        }
      }, 0);
    }, true);

    const renderEntityChanges = (changes) => {
      if (activeInputDraft) {
        deferredEntityRender = true;
        return;
      }
      const kinds = new Set((changes || []).map((item) => item && item.kind));
      if (["scoreRow", "pending", "manualPending", "completedItem", "round", "scoreHelperMetadata"].some((kind) => kinds.has(kind))) {
        if (getCurrentStep() === "score-helper") renderScoreHelper();
      }
      if (["player", "mappingRow", "mappingMetadata", "registrationRow", "registrationMetadata"].some((kind) => kinds.has(kind))) {
        if (getCurrentStep() === "checkin") refreshCheckinUI();
      }
      if (kinds.has("domain")) applyStateToUI();
    };

    const applyEntityEvent = (payload) => {
      const changes = Array.isArray(payload && payload.changedEntities) ? payload.changedEntities : [];
      if (!changes.length) return;
      if (!localSyncBaseState) return;
      STATE_SYNC.applyChangedEntities(localSyncBaseState, changes);
      const result = STATE_SYNC.applyChangedEntities(state, changes, {
        blockedEntityId: activeInputDraft && activeInputDraft.dirty ? activeInputDraft.entityId : "",
      });
      const rev = Number(payload.revision);
      if (Number.isFinite(rev)) {
        localSyncLastRevision = Math.max(localSyncLastRevision, rev);
        if (state.localSync) state.localSync.revision = localSyncLastRevision;
        if (localSyncBaseState.localSync) localSyncBaseState.localSync.revision = localSyncLastRevision;
      }
      if (result.conflicts.length) {
        showSnackbar("服务器已更新你正在编辑的这一行；草稿和光标已保留，请核对后提交", 6500);
      }
      renderEntityChanges(changes.filter((item) => !result.conflicts.some((conflict) => conflict.id === item.id)));
    };

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
            if (payload && payload.type === "entities") {
              applyEntityEvent(payload);
            } else if (payload && payload.type === "snapshot-replaced") {
              fetchLocalSyncState({ force: false, showToast: true, silentStatus: true });
            } else if (payload && payload.type === "hello") {
              const rev = Number(payload.revision);
              if (localSyncConnectedOnce && Number.isFinite(rev) && rev !== localSyncLastRevision) {
                fetchLocalSyncState({ force: false, showToast: false, silentStatus: true });
              }
              localSyncConnectedOnce = true;
            } else if (payload && payload.type === "ftd-round") {
              if (Date.now() < localSyncIgnoreNextFtdEventUntil) {
                localSyncIgnoreNextFtdEventUntil = 0;
                return;
              }
              fetchAndMergeFtdRound({ force: true, showToast: true });
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
      String(str ?? "")
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

  function scoreResultSortKey(value) {
    const text = normalizeWhitespace(value);
    if (!text) return 0;
    const parsed = Date.parse(text.replace(" ", "T"));
    if (Number.isFinite(parsed)) return parsed;
    const numeric = Number(text);
    if (!Number.isFinite(numeric) || numeric <= 0) return 0;
    return numeric > 10000000000 ? numeric : numeric * 1000;
  }

  function localResultTimeFromMs(value) {
    const date = new Date(Number(value));
    if (!Number.isFinite(date.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
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

  function isByeName(str) {
    return normalizeKey(str) === "bye";
  }

  function isFtdByePairing(item) {
    return !!item && (isByeName(item.black) || isByeName(item.white));
  }

  function normalizeFtdByePairing(item) {
    if (!isFtdByePairing(item)) return item;
    const blackBye = isByeName(item.black);
    const whiteBye = isByeName(item.white);
    const blackScore = blackBye ? 31 : 33;
    const whiteScore = whiteBye ? 31 : 33;
    return {
      ...item,
      status: "completed",
      dirty: false,
      dirtyAt: null,
      dirtySource: "",
      reporter: blackBye ? item.white : item.black,
      opponent: "BYE",
      blackScore,
      whiteScore,
      resultText: `BYE ${blackScore}-${whiteScore}`,
      reason: "BYE",
      imagePath: "",
      sourceMessageKey: "",
      resultKind: "bye",
      updatedAt: Number.isFinite(Number(item.updatedAt)) ? Number(item.updatedAt) : now(),
      completedAt: Number.isFinite(Number(item.completedAt)) ? Number(item.completedAt) : now(),
    };
  }

  function escapeHtml(unsafe) {
    return String(unsafe ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function sanitizeEditAudit(raw) {
    const obj = raw && typeof raw === "object" ? raw : {};
    const by = normalizeWhitespace(obj.by) === "agent" ? "agent" : "user";
    return {
      by,
      action: normalizeWhitespace(obj.action || "编辑"),
      at: String(obj.at || ""),
    };
  }

  function editAudit(action, by = "user") {
    return {
      by: by === "agent" ? "agent" : "user",
      action: normalizeWhitespace(action || "编辑"),
      at: new Date().toISOString(),
    };
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
      safe.egaAnalysis = sanitizeEgaAnalysis(parsed.egaAnalysis);
      safe.accountMapping = sanitizeAccountMapping(parsed.accountMapping);
      safe.ftdPlayerAccountMapping = sanitizeFtdPlayerAccountMapping(parsed.ftdPlayerAccountMapping);
      safe.ftdPlayerRegistration = FTD_PLAYER_REGISTRATION.sanitizeRegistration(parsed.ftdPlayerRegistration);
      if (safe.ftdPlayerRegistration && parsed.ftdPlayerRegistration) {
        safe.ftdPlayerRegistration.entityId = parsed.ftdPlayerRegistration.entityId || "";
        safe.ftdPlayerRegistration.entityRevision = Number(parsed.ftdPlayerRegistration.entityRevision) || 0;
        const rawRegistrationRows = new Map((parsed.ftdPlayerRegistration.rows || []).map((row) => [String(row && row.rowId || ""), row]));
        (safe.ftdPlayerRegistration.rows || []).forEach((row) => {
          const rawRow = rawRegistrationRows.get(String(row.rowId || ""));
          if (rawRow) {
            row.entityId = rawRow.entityId || "";
            row.entityRevision = Number(rawRow.entityRevision) || 0;
          }
        });
      }
      safe.wechatGroupNicks = sanitizeWechatGroupNicks(parsed.wechatGroupNicks);
      safe.ftdRound = sanitizeFtdRoundMeta(parsed.ftdRound);
      safe.savedAt = Number.isFinite(Number(parsed.savedAt))
        ? Number(parsed.savedAt)
        : now();
      safe.localSync = parsed.localSync && typeof parsed.localSync === "object"
        ? deepClone(parsed.localSync)
        : {};

      // ui prefs (optional)
      const ui = parsed && typeof parsed.ui === "object" ? parsed.ui : {};
      safe.ui.group =
        typeof ui.group === "string" && ui.group ? ui.group : "all";
      safe.ui.callMode = Boolean(ui.callMode);
      safe.ui.showTime = Boolean(ui.showTime);
      safe.ui.ftdUrl = String(ui.ftdUrl || "");
      safe.ui.oqPollSeconds = Math.max(5, Math.trunc(Number(ui.oqPollSeconds || 60) || 60));
      safe.ui.checkinView = ui.checkinView === "mapping" || ui.checkinView === "ftd-players"
        ? ui.checkinView
        : "players";

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
          entityId: normalizeWhitespace(obj.entityId || ""),
          entityRevision: Math.max(0, Math.trunc(Number(obj.entityRevision) || 0)),
          id: 0,
          displayName,
          account,
          club,
          platform,
          group,
          checkedIn,
          checkedInAt,
          isNew,
          editAudit:
            obj.editAudit && typeof obj.editAudit === "object"
              ? sanitizeEditAudit(obj.editAudit)
              : null,
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
    const cloneScoreCandidate = (item) => {
      if (!item || typeof item !== "object") return null;
      try {
        return JSON.parse(JSON.stringify(item));
      } catch (_) {
        return { ...item };
      }
    };
    const sender = normalizeWhitespace(obj.sender || obj.senderName || "");
    const opponent = normalizeWhitespace(obj.opponent || obj.opponentName || "");
    const rawId = normalizeWhitespace(obj.id);
    const resultText = normalizeWhitespace(obj.resultText || obj.summary || "");
    const sourceTime = normalizeWhitespace(obj.sourceTime || obj.time || "");
    const resultTime = normalizeWhitespace(obj.resultTime || sourceTime);
    const explicitSortKey = Number(obj.resultSortKey);
    const legacyDirtyMatch = rawId.match(/^dirty-ftd-\d+-(\d+)-/) || resultText.match(/^脏数据：第\s*(\d+)\s*台/);
    const dirty = obj.dirty === true || obj.isDirty === true || !!legacyDirtyMatch;
    const dirtyTableRaw = Number(obj.dirtyTable);
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
      entityId: normalizeWhitespace(obj.entityId || ""),
      entityRevision: Math.max(0, Math.trunc(Number(obj.entityRevision) || 0)),
      id:
        rawId ||
        `score-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`,
      round: Number.isFinite(roundRaw) && roundRaw > 0 ? Math.trunc(roundRaw) : 1,
      sourceTime,
      resultTime,
      resultSortKey: Number.isFinite(explicitSortKey) && explicitSortKey > 0
        ? explicitSortKey
        : scoreResultSortKey(resultTime),
      sender,
      wechatSender: normalizeWhitespace(obj.wechatSender || ""),
      senderAccount: normalizeWhitespace(obj.senderAccount || ""),
      opponent,
      dirty,
      dirtySource: normalizeWhitespace(obj.dirtySource || (dirty ? "ftd-pairing" : "")),
      dirtyTable: Number.isFinite(dirtyTableRaw)
        ? Math.max(1, Math.trunc(dirtyTableRaw))
        : legacyDirtyMatch
          ? Math.max(1, Math.trunc(Number(legacyDirtyMatch[1])))
          : null,
      dirtyAt: Number.isFinite(Number(obj.dirtyAt))
        ? Number(obj.dirtyAt)
        : null,
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
      resultText,
      accountMismatchText: normalizeWhitespace(obj.accountMismatchText || ""),
      reason: normalizeWhitespace(obj.reason || ""),
      imagePath: normalizeWhitespace(obj.imagePath || obj.pngPath || obj.previewPath || ""),
      sourceMessageKey: normalizeWhitespace(obj.sourceMessageKey || ""),
      sourceLocalId: normalizeWhitespace(obj.sourceLocalId || obj.local_id || ""),
      confidence: normalizeWhitespace(obj.confidence || ""),
      pendingKind: normalizeWhitespace(obj.pendingKind || ""),
      pendingTable: normalizeWhitespace(obj.pendingTable || obj.table || ""),
      table: normalizeWhitespace(obj.table || ""),
      reviewAction: normalizeWhitespace(obj.reviewAction || ""),
      originalStatus: normalizeWhitespace(obj.originalStatus || ""),
      originalBlack: normalizeWhitespace(obj.originalBlack || ""),
      originalWhite: normalizeWhitespace(obj.originalWhite || ""),
      originalBlackScore: Number.isFinite(Number(obj.originalBlackScore))
        ? Math.max(0, Math.trunc(Number(obj.originalBlackScore)))
        : null,
      originalWhiteScore: Number.isFinite(Number(obj.originalWhiteScore))
        ? Math.max(0, Math.trunc(Number(obj.originalWhiteScore)))
        : null,
      originalScore: normalizeWhitespace(obj.originalScore || ""),
      resolvedByReferee: obj.resolvedByReferee === true,
      resolvedAt: Number.isFinite(Number(obj.resolvedAt))
        ? Number(obj.resolvedAt)
        : null,
      resolvedNote: normalizeWhitespace(obj.resolvedNote || ""),
      resolutionStatus: normalizeWhitespace(obj.resolutionStatus || (obj.resolvedByReferee === true ? "resolved" : "open")),
      resolvedByCommandId: normalizeWhitespace(obj.resolvedByCommandId || ""),
      selectedSourceKey: normalizeWhitespace(obj.selectedSourceKey || ""),
      registeredAt: Number.isFinite(Number(obj.registeredAt))
        ? Number(obj.registeredAt)
        : null,
      manualPendingAt: Number.isFinite(Number(obj.manualPendingAt))
        ? Number(obj.manualPendingAt)
        : null,
      oqPendingDetail:
        obj.oqPendingDetail && typeof obj.oqPendingDetail === "object"
          ? {
              ...obj.oqPendingDetail,
              candidates: Array.isArray(obj.oqPendingDetail.candidates)
                ? obj.oqPendingDetail.candidates
                    .filter((item) => item && typeof item === "object")
                    .map(cloneScoreCandidate)
                    .filter(Boolean)
                : [],
            }
          : null,
      oqFollowup:
        obj.oqFollowup && typeof obj.oqFollowup === "object"
          ? {
              ...obj.oqFollowup,
              candidates: Array.isArray(obj.oqFollowup.candidates)
                ? obj.oqFollowup.candidates
                    .filter((item) => item && typeof item === "object")
                    .map(cloneScoreCandidate)
                    .filter(Boolean)
                : [],
            }
          : null,
      oqFollowupCandidates: Array.isArray(obj.oqFollowupCandidates)
        ? obj.oqFollowupCandidates
            .filter((item) => item && typeof item === "object")
            .map(cloneScoreCandidate)
            .filter(Boolean)
        : [],
      lastEditedBy:
        normalizeWhitespace(obj.lastEditedBy) === "agent"
          ? "agent"
          : normalizeWhitespace(obj.lastEditedBy) === "automation"
            ? "automation"
          : normalizeWhitespace(obj.lastEditedBy) === "script"
            ? "script"
          : normalizeWhitespace(obj.lastEditedBy) === "user"
            ? "user"
            : "",
      lastEditedAt: Number.isFinite(Number(obj.lastEditedAt))
        ? Number(obj.lastEditedAt)
        : null,
    };
  }

  function sanitizeScoreRound(raw, fallbackRound, forcedStage = "") {
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
    const ftdPairings = Array.isArray(obj.ftdPairings)
      ? obj.ftdPairings
          .map((item, index) => {
            const tableRaw = Number(item && item.table);
            const black = normalizeWhitespace(item && item.black);
            const white = normalizeWhitespace(item && item.white);
            if (!black || !white) return null;
            const status = normalizeWhitespace(item && item.status);
            const blackScoreRaw = Number(item && item.blackScore);
            const whiteScoreRaw = Number(item && item.whiteScore);
            const pairing = {
              entityId: normalizeWhitespace(item && item.entityId),
              entityRevision: Math.max(0, Math.trunc(Number(item && item.entityRevision) || 0)),
              table:
                Number.isFinite(tableRaw) && tableRaw > 0
                  ? Math.trunc(tableRaw)
                  : index + 1,
              black,
              white,
              status:
                status === "ready" || status === "completed" || status === "dirty"
                  ? status
                  : "imported",
              dirty: item && item.dirty === true,
              dirtyAt: Number.isFinite(Number(item && item.dirtyAt))
                ? Number(item.dirtyAt)
                : null,
              dirtySource: normalizeWhitespace(item && item.dirtySource),
              reporter: normalizeWhitespace(item && item.reporter),
              opponent: normalizeWhitespace(item && item.opponent),
              blackScore: Number.isFinite(blackScoreRaw)
                ? Math.max(0, Math.trunc(blackScoreRaw))
                : null,
              whiteScore: Number.isFinite(whiteScoreRaw)
                ? Math.max(0, Math.trunc(whiteScoreRaw))
                : null,
              resultText: normalizeWhitespace(item && item.resultText),
              reason: normalizeWhitespace(item && item.reason),
              imagePath: normalizeWhitespace(item && item.imagePath),
              sourceMessageKey: normalizeWhitespace(item && item.sourceMessageKey),
              resultTime: normalizeWhitespace(item && item.resultTime),
              resultSortKey: Number.isFinite(Number(item && item.resultSortKey))
                ? Number(item.resultSortKey)
                : scoreResultSortKey(item && item.resultTime),
              resultKind: normalizeWhitespace(item && item.resultKind),
              resultSource: normalizeWhitespace(item && item.resultSource),
              updatedAt: Number.isFinite(Number(item && item.updatedAt))
                ? Number(item.updatedAt)
                : null,
              completedAt: Number.isFinite(Number(item && item.completedAt))
                ? Number(item.completedAt)
                : null,
              oqGameAvailable: item && item.oqGameAvailable === true,
              oqGameAvailableAt: Number.isFinite(Number(item && item.oqGameAvailableAt))
                ? Number(item.oqGameAvailableAt)
                : null,
              oqGameAvailableAudit:
                item && item.oqGameAvailableAudit && typeof item.oqGameAvailableAudit === "object"
                  ? { ...item.oqGameAvailableAudit }
                  : null,
              lastEditedBy:
                normalizeWhitespace(item && item.lastEditedBy) === "agent"
                  ? "agent"
                  : normalizeWhitespace(item && item.lastEditedBy) === "automation"
                    ? "automation"
                  : normalizeWhitespace(item && item.lastEditedBy) === "script"
                    ? "script"
                  : normalizeWhitespace(item && item.lastEditedBy) === "user"
                    ? "user"
                    : "",
              lastEditedAt: Number.isFinite(Number(item && item.lastEditedAt))
                ? Number(item.lastEditedAt)
                : null,
              userEditedFields:
                item && item.userEditedFields && typeof item.userEditedFields === "object"
                  ? { ...item.userEditedFields }
                  : {},
              oqAutoAudit:
                item && item.oqAutoAudit && typeof item.oqAutoAudit === "object"
                  ? { ...item.oqAutoAudit }
                  : null,
              ftdTranscriptImport: FTD_TRANSCRIPT.sanitizeTranscriptImport(
                item && item.ftdTranscriptImport,
              ),
              gameId: normalizeWhitespace(item && item.gameId),
              player0Id: normalizeWhitespace(item && item.player0Id),
              player1Id: normalizeWhitespace(item && item.player1Id),
              pairingFingerprint: normalizeWhitespace(item && item.pairingFingerprint),
              ftdImportReceipt:
                item && item.ftdImportReceipt && typeof item.ftdImportReceipt === "object"
                  ? { ...item.ftdImportReceipt }
                  : null,
              ftdScoreReceipt:
                item && item.ftdScoreReceipt && typeof item.ftdScoreReceipt === "object"
                  ? { ...item.ftdScoreReceipt }
                  : null,
              ftdTranscriptReceipt:
                item && item.ftdTranscriptReceipt && typeof item.ftdTranscriptReceipt === "object"
                  ? { ...item.ftdTranscriptReceipt }
                  : null,
              transcriptNotApplicable:
                item && item.transcriptNotApplicable && typeof item.transcriptNotApplicable === "object"
                  ? { ...item.transcriptNotApplicable }
                  : null,
              ftdStage: normalizeWhitespace(item && item.ftdStage),
              ftdRound: Number.isFinite(Number(item && item.ftdRound))
                ? Math.trunc(Number(item.ftdRound))
                : null,
              ftdTable: Number.isFinite(Number(item && item.ftdTable))
                ? Math.max(1, Math.trunc(Number(item.ftdTable)))
                : null,
            };
            return normalizeFtdByePairing(pairing);
          })
          .filter(Boolean)
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
    return {
      entityId: normalizeWhitespace(obj.entityId || ""),
      entityRevision: Math.max(0, Math.trunc(Number(obj.entityRevision) || 0)),
      round,
      stage:
        forcedStage === SCORE_STAGE_SEMIFINAL || forcedStage === SCORE_STAGE_FINALS
          ? forcedStage
          : forcedStage === SCORE_STAGE_PRELIMINARY
            ? SCORE_STAGE_PRELIMINARY
            : normalizeWhitespace(obj.stage) === SCORE_STAGE_SEMIFINAL ||
                normalizeWhitespace(obj.stage) === SCORE_STAGE_FINALS
              ? normalizeWhitespace(obj.stage)
              : SCORE_STAGE_PRELIMINARY,
      roundStartAt: normalizeWhitespace(obj.roundStartAt || ""),
      roundStartSource: normalizeWhitespace(obj.roundStartSource || ""),
      pending,
      manualPending,
      completed,
      ftdPairings,
      ftdDirectImport:
        obj.ftdDirectImport && typeof obj.ftdDirectImport === "object"
          ? { ...obj.ftdDirectImport }
          : null,
    };
  }

  function sanitizeEgaAnalysis(raw) {
    const obj = raw && typeof raw === "object" ? raw : {};
    const players = Array.isArray(obj.topPlayers)
      ? obj.topPlayers
          .map((rawPlayer) => {
            const player = rawPlayer && typeof rawPlayer === "object" ? rawPlayer : {};
            const key = normalizeWhitespace(player.key);
            const name = normalizeWhitespace(player.name);
            const account = normalizeWhitespace(player.account);
            const averageLoss = Number(player.averageLoss);
            const totalLoss = Number(player.totalLoss);
            const averageGameLoss = Number(player.averageGameLoss);
            const games = Array.isArray(player.games)
              ? player.games.map((rawGame) => {
                  const game = rawGame && typeof rawGame === "object" ? rawGame : {};
                  const round = Number(game.round);
                  const table = Number(game.table);
                  const gameTotal = Number(game.totalLoss);
                  const gameAvg = Number(game.averageLoss);
                  return {
                    round: Number.isFinite(round) ? Math.trunc(round) : 0,
                    table: Number.isFinite(table) ? Math.trunc(table) : 0,
                    gameId: normalizeWhitespace(game.gameId),
                    totalLoss: Number.isFinite(gameTotal) ? gameTotal : null,
                    averageLoss: Number.isFinite(gameAvg) ? gameAvg : null,
                    nodeCount: Number.isFinite(Number(game.nodeCount))
                      ? Math.max(0, Math.trunc(Number(game.nodeCount)))
                      : 0,
                    offlineFilled: game.offlineFilled === true,
                  };
                })
              : [];
            const plyGroups = {};
            if (player.plyGroups && typeof player.plyGroups === "object") {
              Object.keys(player.plyGroups).forEach((groupKey) => {
                const group = player.plyGroups[groupKey];
                const avg = Number(group && group.averageLoss);
                const count = Number(group && group.count);
                plyGroups[String(groupKey)] = {
                  averageLoss: Number.isFinite(avg) ? avg : null,
                  count: Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0,
                };
              });
            }
            if (!key && !name && !account) return null;
            return {
              key,
              name,
              account,
              gameCount: Number.isFinite(Number(player.gameCount))
                ? Math.max(0, Math.trunc(Number(player.gameCount)))
                : games.length,
              nodeCount: Number.isFinite(Number(player.nodeCount))
                ? Math.max(0, Math.trunc(Number(player.nodeCount)))
                : 0,
              totalLoss: Number.isFinite(totalLoss) ? totalLoss : 0,
              averageLoss: Number.isFinite(averageLoss) ? averageLoss : null,
              averageGameLoss: Number.isFinite(averageGameLoss) ? averageGameLoss : null,
              games,
              plyGroups,
            };
          })
          .filter(Boolean)
      : [];
    return {
      schema: normalizeWhitespace(obj.schema || "ega-analysis-state-v1"),
      updatedAt: normalizeWhitespace(obj.updatedAt),
      scope: normalizeWhitespace(obj.scope || "prelim-only"),
      roundLimit: Number.isFinite(Number(obj.roundLimit))
        ? Math.max(1, Math.trunc(Number(obj.roundLimit)))
        : 7,
      summaryFile: normalizeWhitespace(obj.summaryFile),
      gameCount: Number.isFinite(Number(obj.gameCount))
        ? Math.max(0, Math.trunc(Number(obj.gameCount)))
        : 0,
      playerCount: Number.isFinite(Number(obj.playerCount))
        ? Math.max(0, Math.trunc(Number(obj.playerCount)))
        : players.length,
      topPlayers: players,
      pairingLossByRound:
        obj.pairingLossByRound && typeof obj.pairingLossByRound === "object"
          ? { ...obj.pairingLossByRound }
          : {},
      engine: obj.engine && typeof obj.engine === "object" ? { ...obj.engine } : {},
    };
  }

  function sanitizeScoreHelper(raw) {
    const obj = raw && typeof raw === "object" ? raw : {};
    const parsedCount = Number(obj.roundCount);
    const sourceRounds = Array.isArray(obj.rounds) ? obj.rounds : [];
    const maxRoundNumber = sourceRounds.reduce((max, round, index) => {
      const roundRaw = Number(round && round.round);
      const roundNumber =
        Number.isFinite(roundRaw) && roundRaw > 0 ? Math.trunc(roundRaw) : index + 1;
      return Math.max(max, roundNumber);
    }, 0);
    const parsedPreliminaryCount = Number(obj.preliminaryRoundCount);
    const isStageAware = Number.isFinite(parsedPreliminaryCount);
    const legacyDerivedCount = Number.isFinite(parsedCount)
      ? parsedCount
      : Math.max(sourceRounds.length, maxRoundNumber, 1);
    const preliminaryRoundCount = Math.max(
      1,
      Math.min(
        MAX_PRELIMINARY_ROUNDS,
        Math.trunc(Number(isStageAware ? parsedPreliminaryCount : legacyDerivedCount) || 1),
      ),
    );
    const roundCount = preliminaryRoundCount + SCORE_FINAL_STAGE_COUNT;
    const semifinalSource = sourceRounds.find(
      (round) => normalizeWhitespace(round && round.stage) === SCORE_STAGE_SEMIFINAL,
    );
    const finalsSource = sourceRounds.find(
      (round) => normalizeWhitespace(round && round.stage) === SCORE_STAGE_FINALS,
    );
    const rounds = [];
    for (let i = 0; i < roundCount; i++) {
      const stage = scoreStageForIndex(i, preliminaryRoundCount);
      const source =
        stage === SCORE_STAGE_SEMIFINAL
          ? semifinalSource || (isStageAware ? sourceRounds[i] : null)
          : stage === SCORE_STAGE_FINALS
            ? finalsSource || (isStageAware ? sourceRounds[i] : null)
            : sourceRounds[i];
      rounds.push(sanitizeScoreRound(source, i + 1, stage));
    }
    const activeRaw = Number(obj.activeRound);
    const activeRound =
      Number.isFinite(activeRaw) && activeRaw >= 1 && activeRaw <= roundCount
        ? Math.trunc(activeRaw)
        : 1;
    return {
      entityId: normalizeWhitespace(obj.entityId || ""),
      entityRevision: Math.max(0, Math.trunc(Number(obj.entityRevision) || 0)),
      version: 2,
      preliminaryRoundCount,
      roundCount,
      roundCountSource:
        obj.roundCountSource === "manual" || obj.roundCountSource === "auto"
          ? obj.roundCountSource
          : "default",
      autoRoundCountPlayerCount: Number.isFinite(
        Number(obj.autoRoundCountPlayerCount),
      )
        ? Math.max(0, Math.trunc(Number(obj.autoRoundCountPlayerCount)))
        : null,
      activeRound,
      rounds,
      updatedAt: Number.isFinite(Number(obj.updatedAt))
        ? Number(obj.updatedAt)
        : null,
    };
  }

  function sanitizeAccountMapping(raw) {
    const obj = raw && typeof raw === "object" ? raw : null;
    if (!obj) return null;
    const rawIndex =
      obj.accountIndex && typeof obj.accountIndex === "object"
        ? obj.accountIndex
        : {};
    const accountIndex = {};
    Object.entries(rawIndex).forEach(([key, value]) => {
      const item = value && typeof value === "object" ? value : {};
      const safeKey = normalizeKey(key);
      const displayName = normalizeWhitespace(item.displayName || "");
      const account = normalizeWhitespace(item.account || "");
      if (!safeKey || !account) return;
      accountIndex[safeKey] = {
        displayName,
        account,
        playerId: item.playerId,
        source: normalizeWhitespace(item.source || ""),
        mappedAt: String(item.mappedAt || ""),
      };
    });
    const num = (value) => {
      const n = Number(value);
      return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
    };
    return {
      version: 1,
      scope: normalizeWhitespace(obj.scope || "checked-in-roster"),
      group: normalizeWhitespace(obj.group || ""),
      mappedAt: String(obj.mappedAt || ""),
      updatedAt: Number.isFinite(Number(obj.updatedAt))
        ? Number(obj.updatedAt)
        : null,
      checkedInCount: num(obj.checkedInCount),
      indexedCount: num(obj.indexedCount || Object.keys(accountIndex).length),
      appliedCount: num(obj.appliedCount),
      existingCount: num(obj.existingCount),
      unresolvedCount: num(obj.unresolvedCount),
      conflictCount: num(obj.conflictCount),
      accountIndex,
    };
  }

  function sanitizeWechatGroupNicks(raw) {
    const obj = raw && typeof raw === "object" ? raw : null;
    if (!obj) return null;
    const source =
      Array.isArray(obj.groupNicks)
        ? obj.groupNicks
        : Array.isArray(obj.members)
          ? obj.members.map((item) =>
              item && typeof item === "object"
                ? item.groupNick || item.group_nick || ""
                : item,
            )
          : [];
    const seen = new Set();
    const groupNicks = [];
    source.forEach((value) => {
      const nick = normalizeWhitespace(value);
      if (!nick || seen.has(nick)) return;
      seen.add(nick);
      groupNicks.push(nick);
    });
    groupNicks.sort((a, b) => a.localeCompare(b, "zh-Hans"));
    if (!groupNicks.length) return null;
    return {
      version: 1,
      groupName: normalizeWhitespace(obj.groupName || obj.group_name || ""),
      refreshedAt: String(obj.refreshedAt || obj.refreshed_at || ""),
      updatedAt: Number.isFinite(Number(obj.updatedAt)) ? Number(obj.updatedAt) : now(),
      groupNicks,
    };
  }

  function sanitizeFtdPlayerAccountMapping(raw) {
    if (
      raw &&
      typeof raw === "object" &&
      raw.type === "ftd-player-oq-account-map-clear" &&
      raw.cleared === true
    ) {
      return null;
    }
    const base = sanitizeAccountMapping(raw);
    if (!base) return null;
    const obj = raw && typeof raw === "object" ? raw : {};
    const sanitizeOqCheck = (value) => {
      const item = value && typeof value === "object" ? value : null;
      if (!item) return null;
      const status = normalizeWhitespace(item.status || "");
      if (!status) return null;
      return {
        account: normalizeWhitespace(item.account || ""),
        status,
        checkedAt: String(item.checkedAt || ""),
        forcedAt: String(item.forcedAt || ""),
        forcedBy: normalizeWhitespace(item.forcedBy || ""),
        elapsedMs: Number.isFinite(Number(item.elapsedMs)) ? Number(item.elapsedMs) : 0,
        totalGames: Number.isFinite(Number(item.totalGames)) ? Math.max(0, Math.trunc(Number(item.totalGames))) : 0,
        windowGames: Number.isFinite(Number(item.windowGames)) ? Math.max(0, Math.trunc(Number(item.windowGames))) : 0,
        error: normalizeWhitespace(item.error || ""),
      };
    };
    const safeRows = (rows, limit) =>
      (Array.isArray(rows) ? rows : [])
        .map((row) => {
          const item = row && typeof row === "object" ? row : {};
          const ftdName = normalizeWhitespace(item.ftdName || item.displayName || item.name || "");
          if (!ftdName) return null;
          return {
            entityId: normalizeWhitespace(item.entityId || ""),
            entityRevision: Math.max(0, Math.trunc(Number(item.entityRevision) || 0)),
            ftdName,
            ftdId: item.ftdId == null ? "" : item.ftdId,
            account: normalizeWhitespace(item.account || ""),
            groupNick: normalizeWhitespace(item.groupNick || item.group_nick || ""),
            oqCheck: sanitizeOqCheck(item.oqCheck || item.oq_check),
            source: normalizeWhitespace(item.source || ""),
            deleted: item.deleted === true || normalizeWhitespace(item.status) === "deleted",
            editAudit:
              item.editAudit && typeof item.editAudit === "object"
                ? sanitizeEditAudit(item.editAudit)
                : null,
          };
        })
        .filter(Boolean)
        .slice(0, limit);
    const players = safeRows(obj.players, 300);
    if (!players.length) return null;
    const rowOqCheckMatches = (row) => {
      const check = row && row.oqCheck && typeof row.oqCheck === "object" ? row.oqCheck : null;
      if (!check) return false;
      const checkedAccount = normalizeWhitespace(check.account || row.oqCheckAccount || "");
      if (!checkedAccount) return true;
      return normalizeKey(checkedAccount) === normalizeKey(row.account);
    };
    const rowOqCheckPassed = (row) => {
      const check = row && row.oqCheck && typeof row.oqCheck === "object" ? row.oqCheck : null;
      return Boolean(check && rowOqCheckMatches(row) && (check.status === "ok" || check.status === "forced-ok"));
    };
    const rowHasRequiredFields = (row) =>
      Boolean(
        row &&
          normalizeWhitespace(row.ftdName) &&
          normalizeWhitespace(row.account) &&
          normalizeWhitespace(row.groupNick),
      );
    const rowIsDeleted = (row) => Boolean(row && row.deleted);
    const rowIsInvalid = (row) => {
      const check = row && row.oqCheck && typeof row.oqCheck === "object" ? row.oqCheck : null;
      return Boolean(!rowIsDeleted(row) && rowHasRequiredFields(row) && check && rowOqCheckMatches(row) && check.status === "invalid");
    };
    const rowIsComplete = (row) => {
      const check = row && row.oqCheck && typeof row.oqCheck === "object" ? row.oqCheck : null;
      return Boolean(!rowIsDeleted(row) && !rowIsInvalid(row) && rowHasRequiredFields(row) && check && rowOqCheckPassed(row));
    };
    const activeRows = players.filter((row) => !rowIsDeleted(row));
    const invalidRows = activeRows.filter(rowIsInvalid);
    const unmatchedRows = activeRows.filter((row) => !rowIsComplete(row) && !rowIsInvalid(row));
    const accountIndex = {};
    activeRows.forEach((row) => {
      const key = normalizeKey(row.ftdName);
      const check = row.oqCheck && typeof row.oqCheck === "object" ? row.oqCheck : null;
      if (!key || !rowIsComplete(row) || !check) return;
      accountIndex[key] = {
        ftdName: row.ftdName,
        displayName: row.ftdName,
        account: normalizeWhitespace(row.account),
        groupNick: normalizeWhitespace(row.groupNick),
        ftdId: row.ftdId == null ? "" : row.ftdId,
        source: row.source || "",
        mappedAt: obj.mappedAt || "",
        oqStatus: check.status || "",
      };
    });
    return {
      ...base,
      entityId: normalizeWhitespace(obj.entityId || ""),
      entityRevision: Math.max(0, Math.trunc(Number(obj.entityRevision) || 0)),
      scope: normalizeWhitespace(obj.scope || "ftd-player-table"),
      type: normalizeWhitespace(obj.type || "ftd-player-oq-account-map"),
      sourceFile: normalizeWhitespace(obj.sourceFile || ""),
      ftdExportedAt: String(obj.ftdExportedAt || ""),
      ftdPageUrl: normalizeWhitespace(obj.ftdPageUrl || ""),
      playerCount: players.length,
      matchedCount: activeRows.filter(rowIsComplete).length,
      ambiguousCount: 0,
      invalidAccountCount: invalidRows.length,
      unmatchedCount: unmatchedRows.length,
      indexedCount: Object.keys(accountIndex).length,
      accountIndex,
      output: normalizeWhitespace(obj.output || ""),
      agentReviewStatus: normalizeWhitespace(obj.agentReviewStatus || ""),
      agentReviewedAt: String(obj.agentReviewedAt || ""),
      oqValidation:
        obj.oqValidation && typeof obj.oqValidation === "object"
          ? {
              checkedAt: String(obj.oqValidation.checkedAt || ""),
              checkedCount: Number.isFinite(Number(obj.oqValidation.checkedCount))
                ? Math.max(0, Math.trunc(Number(obj.oqValidation.checkedCount)))
                : 0,
              okCount: Number.isFinite(Number(obj.oqValidation.okCount))
                ? Math.max(0, Math.trunc(Number(obj.oqValidation.okCount)))
                : 0,
              invalidCount: Number.isFinite(Number(obj.oqValidation.invalidCount))
                ? Math.max(0, Math.trunc(Number(obj.oqValidation.invalidCount)))
                : 0,
              skippedCount: Number.isFinite(Number(obj.oqValidation.skippedCount))
                ? Math.max(0, Math.trunc(Number(obj.oqValidation.skippedCount)))
                : 0,
              incremental: obj.oqValidation.incremental === true,
              wallMs: Number.isFinite(Number(obj.oqValidation.wallMs)) ? Number(obj.oqValidation.wallMs) : 0,
            }
          : null,
      players,
      unmatched: unmatchedRows.slice(0, 120),
      invalidAccounts: invalidRows.slice(0, 120),
      ambiguous: [],
    };
  }

  function mappingUpdatedAt(mapping) {
    if (!mapping || typeof mapping !== "object") return 0;
    const candidates = [
      Number(mapping.updatedAt) || 0,
      mapping.mappedAt ? Date.parse(mapping.mappedAt) : 0,
      mapping.clearedAt ? Date.parse(mapping.clearedAt) : 0,
    ];
    if (Array.isArray(mapping.players)) {
      mapping.players.forEach((row) => {
        if (!row || typeof row !== "object") return;
        if (row.editAudit && row.editAudit.at) {
          candidates.push(Date.parse(row.editAudit.at));
        }
        if (row.oqCheck && row.oqCheck.checkedAt) {
          candidates.push(Date.parse(row.oqCheck.checkedAt));
        }
      });
    }
    return candidates.reduce((max, value) => {
      const n = Number(value);
      return Number.isFinite(n) && n > max ? n : max;
    }, 0);
  }

  function buildCheckedInAccountIndexForFtdExport() {
    const mapping = sanitizeAccountMapping(state.accountMapping);
    const out = {};
    const add = (name, account, extra = {}) => {
      const key = normalizeKey(name);
      const acc = normalizeWhitespace(account);
      if (!key || !acc || out[key]) return;
      out[key] = {
        displayName: normalizeWhitespace(name),
        account: acc,
        source: normalizeWhitespace(extra.source || ""),
        mappedAt: String(extra.mappedAt || ""),
      };
    };
    if (mapping && mapping.accountIndex) {
      Object.values(mapping.accountIndex).forEach((item) => {
        add(item.displayName, item.account, item);
      });
    }
    (Array.isArray(state.players) ? state.players : [])
      .filter((player) => player && player.checkedIn && player.account)
      .forEach((player) => {
        add(player.displayName, player.account, {
          source: "checked-in-roster",
          mappedAt: mapping && mapping.mappedAt,
        });
      });
    return out;
  }

  function accountMappingStatus() {
    const mapping = sanitizeAccountMapping(state.accountMapping);
    const checkedIn = (Array.isArray(state.players) ? state.players : []).filter(
      (player) => player && player.checkedIn,
    ).length;
    const accountIndex = buildCheckedInAccountIndexForFtdExport();
    return {
      mapping,
      checkedIn,
      indexed: Object.keys(accountIndex).length,
      accountIndex,
      ready: Boolean(mapping && Object.keys(accountIndex).length > 0),
    };
  }

  function sanitizeFtdRoundMeta(raw) {
    const obj = raw && typeof raw === "object" ? raw : null;
    if (!obj) return null;
    const roundRaw = Number(obj.round);
    const pairingCountRaw = Number(obj.pairingCount);
    return {
      sourceFile: normalizeWhitespace(obj.sourceFile),
      currentFile: normalizeWhitespace(obj.currentFile),
      source: normalizeWhitespace(obj.source),
      url: String(obj.url || ""),
      title: String(obj.title || ""),
      exportedAt: String(obj.exportedAt || ""),
      importedAt: String(obj.importedAt || ""),
      competitionName: normalizeWhitespace(obj.competitionName),
      round:
        Number.isFinite(roundRaw) && roundRaw > 0
          ? Math.trunc(roundRaw)
          : null,
      stage: normalizeFtdStage(obj.stage),
      ftdRound: Number.isFinite(Number(obj.ftdRound))
        ? Math.trunc(Number(obj.ftdRound))
        : null,
      pairingCount:
        Number.isFinite(pairingCountRaw) && pairingCountRaw >= 0
          ? Math.trunc(pairingCountRaw)
          : null,
      note: normalizeWhitespace(obj.note),
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
  const stepSelfCheck = $("#step-self-check");
  const selfCheckSummary = $("#self-check-summary");
  const selfCheckStatus = $("#self-check-status");
  const selfCheckPaths = $("#self-check-paths");
  const selfCheckResults = $("#self-check-results");
  const btnOpenSelfCheck = $("#btn-open-self-check");
  const btnSelfCheckBack = $("#btn-self-check-back");
  const btnSelfCheckFull = $("#btn-self-check-full");
  const btnSelfCheckCheckin = $("#btn-self-check-checkin");
  const btnSelfCheckRefresh = $("#btn-self-check-refresh");
  let selfCheckReturnStep = "checkin";

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
  const scoreRoundStartInput = $("#score-round-start");
  const scoreFtdUrlInput = $("#score-ftd-url");
  const btnScoreApplyRounds = $("#btn-score-apply-rounds");
  const btnScoreApplyCurrentTime = $("#btn-score-apply-current-time");
  const btnCopyAiRosterReviewPrompt = $("#btn-copy-ai-roster-review-prompt");
  const btnCopyAiCheckinPollPrompt = $("#btn-copy-ai-checkin-poll-prompt");
  const btnCopyAiFtdMapPrompt = $("#btn-copy-ai-ftd-map-prompt");
  const btnCopyAiFtdPlayerReviewPrompt = $("#btn-copy-ai-ftd-player-review-prompt");
  const btnCopyFtdPlayerImportConsole = $("#btn-copy-ftd-player-import-console");
  const btnCopyAiScoreRoundPrompt = $("#btn-copy-ai-score-round-prompt");
  const btnCopyFtdConsole = $("#btn-copy-ftd-console");
  const btnCopyFtdPlayerConsole = $("#btn-copy-ftd-player-console");
  const btnImportFtdMapJson = $("#btn-import-ftd-map-json");
  const btnRefreshWechatNicks = $("#btn-refresh-wechat-nicks");
  const btnSyncOnlineFtdMap = $("#btn-sync-online-ftd-map");
  const btnValidateOqAccounts = $("#btn-validate-oq-accounts");
  const ftdPlayerMapJsonInput = $("#ftd-player-map-json-input");
  const btnExportFtdMapPng = $("#btn-export-ftd-map-png");
  const btnApplyFtdMapToRoster = $("#btn-apply-ftd-map-to-roster");
  const btnClearFtdMap = $("#btn-clear-ftd-map");
  const btnCopyFtdScoreConsole = $("#btn-copy-ftd-score-console");
  const btnCopyFtdTranscriptConsole = $("#btn-copy-ftd-transcript-console");
  const btnUpdateRoundOqScores = $("#btn-update-round-oq-scores");
  const scoreOqPollSecondsInput = $("#score-oq-poll-seconds");
  const btnToggleOqScorePoll = $("#btn-toggle-oq-score-poll");
  const btnFtdAutopilotProbe = $("#btn-ftd-autopilot-probe");
  const btnFtdAutopilotStart = $("#btn-ftd-autopilot-start");
  const btnFtdAutopilotPause = $("#btn-ftd-autopilot-pause");
  const btnFtdAutopilotResume = $("#btn-ftd-autopilot-resume");
  const btnFtdAutopilotStop = $("#btn-ftd-autopilot-stop");
  const ftdAutopilotStatusEl = $("#ftd-autopilot-status");
  const btnToggleEgAnalysis = $("#btn-toggle-eg-analysis");
  const btnExportEgaReportPng = $("#btn-export-ega-report-png");
  const ftdRoundJsonInput = $("#ftd-round-json-input");
  const btnClearScoreRounds = $("#btn-clear-score-rounds");
  const btnScoreBackCheckin = $("#btn-score-back-checkin");
  const scoreRoundTabs = $("#score-round-tabs");
  const scoreHelperSummary = $("#score-helper-summary");
  const scoreFtdPairings = $("#score-ftd-pairings");
  const scoreFtdSearchBox = $("#score-ftd-search-box");
  const btnClearScoreFtdSearch = $("#btn-clear-score-ftd-search");
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
  const checkinViewTabs = $("#checkin-view-tabs");
  const playerList = $("#player-list");
  const checkinFtdPlayerMapView = $("#checkin-ftd-player-map-view");
  const checkinFtdPlayerRegistrationView = $("#checkin-ftd-player-registration-view");
  const iosPlayerListAnchor = $("#ios-player-list-anchor");

  const totalCountEl = $("#total-count");
  const totalCountLabelEl = $("#total-count-label");
  const checkedInCountEl = $("#checked-in-count");
  const checkedInCountLabelEl = $("#checked-in-count-label");
  const notCheckedInCountEl = $("#not-checked-in-count");
  const notCheckedInCountLabelEl = $("#not-checked-in-count-label");
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

  let lastCopiedFtdScoreBatch = null;
  let lastCopiedFtdConsoleAction = null;
  let oqScorePollTimer = null;
  let oqScorePollEnabled = false;
  let oqScorePollNextAt = 0;
  let oqScorePollInFlight = false;
  let ftdAutopilotStatus = null;
  let ftdAutopilotStatusTimer = null;
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
    if (s === "import" || s === "checkin" || s === "score-helper" || s === "self-check") return s;
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
      stepSelfCheck && stepSelfCheck.classList.add("hidden");
    } else if (step === "score-helper") {
      stepImport && stepImport.classList.add("hidden");
      stepCheckin && stepCheckin.classList.add("hidden");
      stepScoreHelper && stepScoreHelper.classList.remove("hidden");
      stepSelfCheck && stepSelfCheck.classList.add("hidden");
    } else if (step === "self-check") {
      stepImport && stepImport.classList.add("hidden");
      stepCheckin && stepCheckin.classList.add("hidden");
      stepScoreHelper && stepScoreHelper.classList.add("hidden");
      stepSelfCheck && stepSelfCheck.classList.remove("hidden");
    } else {
      stepCheckin && stepCheckin.classList.add("hidden");
      stepScoreHelper && stepScoreHelper.classList.add("hidden");
      stepSelfCheck && stepSelfCheck.classList.add("hidden");
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
    if (getCheckinView() === "mapping") {
      groupFilterEl.innerHTML = "";
      groupFilterEl.hidden = true;
      return;
    }
    groupFilterEl.hidden = false;

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

  function updateClearScoreFtdSearchButton() {
    if (!btnClearScoreFtdSearch || !scoreFtdSearchBox) return;
    btnClearScoreFtdSearch.hidden = !normalizeWhitespace(
      scoreFtdSearchBox.value || "",
    );
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

  function getFtdPlayerMapStatsScopeRows() {
    const mapping = sanitizeFtdPlayerAccountMapping(state.ftdPlayerAccountMapping);
    if (!mapping || !Array.isArray(mapping.players)) return [];
    return mapping.players.filter((row) => !isDeletedFtdPlayerMapRow(row));
  }

  function updateStats(visiblePlayers) {
    if (getCheckinView() === "ftd-players") {
      if (totalCountLabelEl) totalCountLabelEl.textContent = "总人数";
      if (checkedInCountLabelEl) checkedInCountLabelEl.textContent = "可登记";
      if (notCheckedInCountLabelEl) notCheckedInCountLabelEl.textContent = "待处理";
      const registration = FTD_PLAYER_REGISTRATION.sanitizeRegistration(state.ftdPlayerRegistration);
      const rows = Array.isArray(registration.rows) ? registration.rows : [];
      const resolved = new Set(FTD_PLAYER_REGISTRATION.RESOLVED_STATUSES);
      const registerable = rows.filter((row) =>
        row.status !== "ftd-written" && row.status !== "excluded" && resolved.has(row.resolutionStatus),
      ).length;
      const waiting = rows.filter((row) =>
        row.status === "pending" || row.status === "unmatched" || row.status === "name-parse-unresolved",
      ).length;
      if (totalCountEl) totalCountEl.textContent = String(rows.length);
      if (checkedInCountEl) checkedInCountEl.textContent = String(registerable);
      if (notCheckedInCountEl) notCheckedInCountEl.textContent = String(waiting);
      if (statFilteredContainer) statFilteredContainer.hidden = true;
      return;
    }
    if (getCheckinView() === "mapping") {
      if (totalCountLabelEl) totalCountLabelEl.textContent = "总人数";
      if (checkedInCountLabelEl) checkedInCountLabelEl.textContent = "已映射";
      if (notCheckedInCountLabelEl) notCheckedInCountLabelEl.textContent = "待映射";
      const rows = getFtdPlayerMapStatsScopeRows();
      const total = rows.length;
      const mapped = rows.filter(isCompleteFtdPlayerMapRow).length;
      const waiting = total - mapped;
      if (totalCountEl) totalCountEl.textContent = String(total);
      if (checkedInCountEl) checkedInCountEl.textContent = String(mapped);
      if (notCheckedInCountEl) notCheckedInCountEl.textContent = String(waiting);
      if (statFilteredContainer) statFilteredContainer.hidden = true;
      return;
    }

    if (totalCountLabelEl) totalCountLabelEl.textContent = "总人数";
    if (checkedInCountLabelEl) checkedInCountLabelEl.textContent = "已签到";
    if (notCheckedInCountLabelEl) notCheckedInCountLabelEl.textContent = "等待中";
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

  function getCheckinView() {
    const view = state && state.ui ? state.ui.checkinView : "";
    return view === "mapping" || view === "ftd-players" ? view : "players";
  }

  function renderCheckinViewTabs() {
    if (!checkinViewTabs) return;
    const view = getCheckinView();
    checkinViewTabs.querySelectorAll("button[data-checkin-view]").forEach((btn) => {
      const active = btn.dataset.checkinView === view;
      btn.setAttribute("aria-selected", active ? "true" : "false");
    });
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
      row.dataset.entityId = String(player.entityId || "");

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

      if (player.editAudit && player.editAudit.action) {
        const auditChip = document.createElement("span");
        auditChip.className = "chip-small";
        auditChip.textContent = `${player.editAudit.by === "agent" ? "agent" : "用户"} ${player.editAudit.action}`;
        tags.appendChild(auditChip);
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
    renderCheckinViewTabs();
    const view = getCheckinView();

    if (searchBox) {
      searchBox.placeholder =
        view === "mapping"
          ? "搜索 FTD 姓名、OQ 或群昵称..."
          : view === "ftd-players"
            ? "搜索签到姓名、规范姓名或 FTD Player..."
            : "搜索选手名称…";
    }

    // 只计算一次 visible players，避免重复调用
    const visiblePlayers = getVisiblePlayers();

    updateStats(visiblePlayers);
    if (playerList) playerList.classList.toggle("hidden", view !== "players");
    if (checkinFtdPlayerMapView) checkinFtdPlayerMapView.classList.toggle("hidden", view !== "mapping");
    if (checkinFtdPlayerRegistrationView) {
      checkinFtdPlayerRegistrationView.classList.toggle("hidden", view !== "ftd-players");
    }
    if (view === "mapping") renderCheckinFtdPlayerMap();
    else if (view === "ftd-players") renderFtdPlayerRegistration();
    else renderPlayerList(visiblePlayers);
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
    player.editAudit = editAudit(player.isNew ? "设为新人" : "取消新人");
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
    player.editAudit = editAudit(next ? "签到" : "取消签到");

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
        player.editAudit = editAudit("撤销签到操作");
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
        player.editAudit = editAudit("删除");

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
        player.editAudit = editAudit("编辑文字");

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
    let lastPinchHintAt = 0;

    const threshold = 56; // px
    const maxVertical = 38;
    const pinchHintText =
      "为防止误操作，选手列表内禁用双指缩放。请在上方组别筛选或标题区域进行页面缩放。";

    const showPinchZoomHint = () => {
      const now = Date.now();
      if (now - lastPinchHintAt < 3000) return;
      lastPinchHintAt = now;
      if (typeof showSnackbar === "function") {
        showSnackbar(pinchHintText, 3000);
      } else {
        showAlert("缩放提示", pinchHintText);
      }
    };

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
      if (
        e.pointerType === "touch" &&
        e.isPrimary === false &&
        playerList.contains(e.target)
      ) {
        active = null;
        showPinchZoomHint();
        return;
      }
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
      if (e.pointerType === "touch" && e.isPrimary === false) {
        active = null;
        showPinchZoomHint();
        return;
      }
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
          if (e.touches && e.touches.length >= 2) {
            touchActive = null;
            showPinchZoomHint();
            return;
          }
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
          if (e.touches && e.touches.length >= 2) {
            if (touchActive) resetRow(touchActive.row);
            touchActive = null;
            showPinchZoomHint();
            return;
          }
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

  function setupFtdPlayerMapSwipeGestures() {
    if (!checkinFtdPlayerMapView) return;
    let active = null;
    const threshold = 64;
    const maxVertical = 42;

    const getRowFromEvent = (e) => {
      const target = isElement(e.target) ? e.target : null;
      if (!target) return null;
      if (target.closest("button, input, textarea, select, a, label, details, summary, .score-ftd-map__nick")) return null;
      const row = target.closest('[data-ftd-map-row="1"]');
      if (!row || !row.dataset || !row.dataset.ftdMapName) return null;
      if (row.classList.contains("score-ftd-map__row--deleted")) return null;
      return row;
    };

    const resetRow = (row) => {
      if (!row) return;
      row.style.transform = "";
      row.style.transition = "";
    };

    const start = (row, x, y, pointerId) => {
      active = {
        row,
        name: row.dataset.ftdMapName || "",
        startX: x,
        startY: y,
        lastX: x,
        lastY: y,
        pointerId,
        moved: false,
      };
    };

    const move = (x, y, pointerId) => {
      if (!active) return;
      if (active.pointerId != null && pointerId != null && active.pointerId !== pointerId) return;
      const dx = x - active.startX;
      const dy = y - active.startY;
      active.lastX = x;
      active.lastY = y;
      if (Math.abs(dy) > maxVertical && Math.abs(dy) > Math.abs(dx)) {
        resetRow(active.row);
        active = null;
        return;
      }
      if (dx < -8) {
        active.moved = true;
        active.row.style.transform = `translateX(${Math.max(-96, dx)}px)`;
        active.row.style.transition = "none";
      }
    };

    const finish = () => {
      if (!active) return;
      const row = active.row;
      const dx = active.lastX - active.startX;
      const dy = active.lastY - active.startY;
      const name = active.name;
      resetRow(row);
      if (active.moved && dx <= -threshold && Math.abs(dx) > Math.abs(dy) * 1.25) {
        setFtdPlayerMapDeleted(name, true);
        showSnackbar("已删除映射行", 1600);
      }
      active = null;
    };

    if ("PointerEvent" in window) {
      checkinFtdPlayerMapView.addEventListener("pointerdown", (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        const row = getRowFromEvent(e);
        if (!row) return;
        start(row, e.clientX, e.clientY, e.pointerId);
        try {
          row.setPointerCapture && row.setPointerCapture(e.pointerId);
        } catch (_) {
          // ignore
        }
      }, { passive: true });
      checkinFtdPlayerMapView.addEventListener("pointermove", (e) => {
        move(e.clientX, e.clientY, e.pointerId);
      }, { passive: true });
      checkinFtdPlayerMapView.addEventListener("pointerup", finish, { passive: true });
      checkinFtdPlayerMapView.addEventListener("pointercancel", finish, { passive: true });
      return;
    }

    checkinFtdPlayerMapView.addEventListener("touchstart", (e) => {
      if (!e.touches || e.touches.length !== 1) return;
      const row = getRowFromEvent(e);
      if (!row) return;
      const t = e.touches[0];
      start(row, t.clientX, t.clientY, null);
    }, { passive: true });
    checkinFtdPlayerMapView.addEventListener("touchmove", (e) => {
      if (!e.touches || e.touches.length !== 1) return;
      const t = e.touches[0];
      move(t.clientX, t.clientY, null);
    }, { passive: true });
    checkinFtdPlayerMapView.addEventListener("touchend", finish, { passive: true });
    checkinFtdPlayerMapView.addEventListener("touchcancel", finish, { passive: true });
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

  function getCurrentPngExportMode() {
    return state && state.step === "checkin" && getCheckinView() === "mapping"
      ? "mapping"
      : "players";
  }

  function getFtdPlayerMapExportRows() {
    const mapping = sanitizeFtdPlayerAccountMapping(state.ftdPlayerAccountMapping);
    const rows = mapping && Array.isArray(mapping.players) ? mapping.players : [];
    return rows
      .filter((row) => !isDeletedFtdPlayerMapRow(row))
      .map((row, index) => ({ ...row, order: index }))
      .sort(compareFtdPlayerMapRows);
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

  function buildFtdPlayerMapExportHtml(rows) {
    const mappingRows = Array.isArray(rows) ? rows : getFtdPlayerMapExportRows();
    const mapped = mappingRows.filter((row) => normalizeWhitespace(row.account)).length;
    const title = escapeHtml(`${state.competitionName || "比赛签到表"} OQ映射表`);
    const stats = `映射人数：${mappingRows.length}　|　已登记：${mapped}　|　待登记：${mappingRows.length - mapped}`;
    const body = mappingRows
      .map((row, index) => {
        const account = normalizeWhitespace(row.account) || "【裁判未登记】";
        return `<tr><td>${index + 1}</td><td>${escapeHtml(row.ftdName || "")}</td><td>${escapeHtml(account)}</td></tr>`;
      })
      .join("");
    return `
      <h4 class="export-title">${title}</h4>
      <div class="export-stats">${escapeHtml(stats)}</div>
      <table class="export-table">
        <thead><tr><th style="width:72px;">#</th><th>选手</th><th>OQ账号</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    `;
  }

  function renderExportPreview() {
    if (!exportContainer) return;
    if (getCurrentPngExportMode() === "mapping") {
      exportContainer.innerHTML = buildFtdPlayerMapExportHtml(getFtdPlayerMapExportRows());
      return;
    }
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

  function getActiveScoreRound(existingHelper = null) {
    const helper = existingHelper || ensureScoreHelper();
    const index = Math.max(0, Math.min(helper.roundCount - 1, helper.activeRound - 1));
    return helper.rounds[index] || helper.rounds[0];
  }

  function preliminaryRoundCountForPlayerCount(playerCount) {
    const count = Math.max(0, Math.trunc(Number(playerCount) || 0));
    if (count >= 64) return 7;
    if (count >= 32) return 6;
    return 5;
  }

  function countFtdPairingPlayers(pairings) {
    const names = new Set();
    const add = (value) => {
      const name = normalizeWhitespace(value);
      if (!name || normalizeKey(name) === "bye") return;
      names.add(normalizeKey(name));
    };
    for (const item of Array.isArray(pairings) ? pairings : []) {
      add(item && item.black);
      add(item && item.white);
    }
    return names.size;
  }

  function setScoreRoundCount(nextCount, options = {}) {
    const helper = ensureScoreHelper();
    const preliminaryCount = Math.max(
      1,
      Math.min(
        MAX_PRELIMINARY_ROUNDS,
        Math.trunc(Number(nextCount) || helper.preliminaryRoundCount || 1),
      ),
    );
    const count = preliminaryCount + SCORE_FINAL_STAGE_COUNT;
    const existingSemifinal = helper.rounds.find(
      (round) => normalizeWhitespace(round && round.stage) === SCORE_STAGE_SEMIFINAL,
    );
    const existingFinals = helper.rounds.find(
      (round) => normalizeWhitespace(round && round.stage) === SCORE_STAGE_FINALS,
    );
    const nextRounds = [];
    for (let i = 0; i < count; i++) {
      const stage = scoreStageForIndex(i, preliminaryCount);
      const existing =
        stage === SCORE_STAGE_SEMIFINAL
          ? existingSemifinal
          : stage === SCORE_STAGE_FINALS
            ? existingFinals
            : helper.rounds[i] && helper.rounds[i].stage === SCORE_STAGE_PRELIMINARY
              ? helper.rounds[i]
              : null;
      nextRounds.push(
        existing
          ? sanitizeScoreRound({ ...existing, round: i + 1, stage }, i + 1, stage)
          : createEmptyScoreRound(i + 1, stage),
      );
    }
    helper.preliminaryRoundCount = preliminaryCount;
    helper.roundCount = count;
    if (options.source === "manual" || options.source === "auto") {
      helper.roundCountSource = options.source;
    }
    helper.rounds = nextRounds;
    helper.activeRound = Math.max(1, Math.min(count, helper.activeRound || 1));
    helper.updatedAt = now();
    return preliminaryCount;
  }

  function syncScoreRoundCountInput(input, preliminaryRoundCount, activeElement = null) {
    if (!input || activeElement === input) return false;
    const nextValue = String(
      Math.max(
        1,
        Math.min(
          MAX_PRELIMINARY_ROUNDS,
          Math.trunc(Number(preliminaryRoundCount) || 1),
        ),
      ),
    );
    if (input.value === nextValue) return false;
    input.value = nextValue;
    return true;
  }

  async function applyScoreRoundSettings() {
    const snapshot = captureUndoSnapshot();
    const appliedPreliminaryCount = setScoreRoundCount(
      scoreRoundCountInput && scoreRoundCountInput.value,
      { source: "manual" },
    );
    const expectedRoundCount = appliedPreliminaryCount + SCORE_FINAL_STAGE_COUNT;
    syncActiveScoreRoundStartFromInput();
    renderScoreHelper();

    localSaveDirty = true;
    state.savedAt = now();
    lastLocalEditAt = state.savedAt;
    if (btnScoreApplyRounds) setBtnBusy(btnScoreApplyRounds, true, "保存中…", "应用");

    try {
      const syncResult = await saveAndPushLocalSyncNow();
      if (!syncResult || syncResult.ok !== true) {
        throw new Error("本地共享状态写入失败");
      }

      const savedHelper = sanitizeScoreHelper(state.scoreHelper);
      if (
        savedHelper.preliminaryRoundCount !== appliedPreliminaryCount ||
        savedHelper.roundCount !== expectedRoundCount
      ) {
        throw new Error(
          `保存校验不一致：预赛 ${savedHelper.preliminaryRoundCount} 轮，总阶段 ${savedHelper.roundCount} 轮`,
        );
      }

      showUndoSnackbar(`已更新预赛轮次：${appliedPreliminaryCount} 轮`, async () => {
        restoreUndoSnapshot(snapshot);
        localSaveDirty = true;
        state.savedAt = now();
        lastLocalEditAt = state.savedAt;
        const undoResult = await saveAndPushLocalSyncNow();
        if (!undoResult || undoResult.ok !== true) {
          showAlert("撤销保存失败", "轮次已在当前页面撤销，但未能写入本地共享状态，请检查本地同步连接。");
          return;
        }
        showSnackbar("已撤销轮次设置", 1800);
      });
    } catch (error) {
      const detail = error && error.message ? String(error.message) : String(error || "");
      showAlert(
        "轮次保存失败",
        `预赛轮次已在当前页面修改，但未确认写入本地共享状态。请检查“本地同步”状态后重试。\n\n${detail}`,
      );
    } finally {
      if (btnScoreApplyRounds) setBtnBusy(btnScoreApplyRounds, false, "保存中…", "应用");
    }
  }

  function scoreRoundStartToInputValue(value) {
    const text = normalizeWhitespace(value || "");
    if (!text) return "";
    const normalized = text.replace(" ", "T");
    return normalized.length >= 19 ? normalized.slice(0, 19) : normalized;
  }

  function scoreRoundStartFromInputValue(value) {
    const text = normalizeWhitespace(value || "");
    if (!text) return "";
    const normalized = text.replace("T", " ");
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(normalized)) {
      return `${normalized}:00`;
    }
    return normalized;
  }

  function scoreRoundStartInputValueFromDate(date = new Date()) {
    const d = date instanceof Date ? date : new Date(date);
    if (!Number.isFinite(d.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function isValidScoreRoundStart(value) {
    const text = normalizeWhitespace(value || "");
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(text)) {
      return false;
    }
    const parsed = Date.parse(text.replace(" ", "T"));
    return Number.isFinite(parsed);
  }

  function syncActiveScoreRoundStartFromInput() {
    if (!scoreRoundStartInput) return "";
    const helper = ensureScoreHelper();
    const round = getActiveScoreRound();
    const start = scoreRoundStartFromInputValue(scoreRoundStartInput.value);
    if (!round || !Array.isArray(helper.rounds)) return start;
    round.roundStartAt = start;
    round.roundStartSource = start ? "frontend" : "";
    helper.updatedAt = now();
    return start;
  }

  function emptyScoreRound(roundNumber) {
    return createEmptyScoreRound(roundNumber, SCORE_STAGE_PRELIMINARY);
  }

  function parseScoreRoundSelection(input, roundCount) {
    const text = normalizeWhitespace(input);
    const count = Math.max(1, Math.trunc(Number(roundCount) || 1));
    if (!text) return [];
    if (/^(all|全部|全选|所有)$/i.test(text)) {
      return Array.from({ length: count }, (_, index) => index + 1);
    }
    const selected = new Set();
    const parts = text.split(/[,\uff0c\u3001\s]+/).filter(Boolean);
    for (const part of parts) {
      const range = part.match(/^(\d+)\s*[-~\uff5e]\s*(\d+)$/);
      if (range) {
        const start = Math.trunc(Number(range[1]));
        const end = Math.trunc(Number(range[2]));
        if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
        const lo = Math.min(start, end);
        const hi = Math.max(start, end);
        for (let round = lo; round <= hi; round++) selected.add(round);
        continue;
      }
      const round = Math.trunc(Number(part));
      if (!Number.isFinite(round)) return [];
      selected.add(round);
    }
    return Array.from(selected)
      .filter((round) => round >= 1 && round <= count)
      .sort((a, b) => a - b);
  }

  function clearScoreRoundsByPrompt() {
    const helper = ensureScoreHelper();
    const input = window.prompt(
      `输入要清理的轮次，支持 1、2、1-4、1,3,5、半决赛、决赛。当前预赛轮次：${helper.preliminaryRoundCount}`,
      String(helper.activeRound || 1),
    );
    if (input == null) return;
    const normalizedInput = normalizeWhitespace(input);
    const stageRound =
      /半决/.test(normalizedInput)
        ? helper.preliminaryRoundCount + 1
        : /决赛|3\/4/.test(normalizedInput)
          ? helper.preliminaryRoundCount + 2
          : 0;
    const rounds = stageRound
      ? [stageRound]
      : parseScoreRoundSelection(input, helper.roundCount);
    if (!rounds.length) {
      showSnackbar("没有可清理的轮次", 2200);
      return;
    }
    const label = rounds.join(", ");
    const ok = window.confirm(
      `确认清理第 ${label} 轮的配对表和所有比分登记数据？此操作会清空 FTD 配对、pending、手动 pending、已登记和待确认结果。`,
    );
    if (!ok) return;
    const snapshot = captureUndoSnapshot();
    const selected = new Set(rounds);
    helper.rounds = helper.rounds.map((round, index) =>
      selected.has(index + 1) ? emptyScoreRound(index + 1) : round,
    );
    helper.updatedAt = now();
    if (
      state.ftdRound &&
      selected.has(Math.trunc(Number(state.ftdRound.round) || 0))
    ) {
      state.ftdRound = null;
    }
    renderScoreHelper();
    scheduleSave();
    showUndoSnackbar(`已清理第 ${label} 轮比分登记`, () => {
      restoreUndoSnapshot(snapshot);
      showSnackbar("已撤销清理", 1800);
    });
  }

  function scoreItemSummary(item) {
    if (isUserPendingScoreItem(item)) {
      const table = normalizeWhitespace(item.pendingTable || item.table);
      return table ? `第 ${table} 桌 pending` : "用户 pending";
    }
    if (isAgentPendingScoreItem(item)) {
      const table = normalizeWhitespace(item.pendingTable || item.table);
      const verdict = normalizeWhitespace(item.verdict);
      const label = verdict.includes("account") ? "账号待核对" : "pending";
      return table ? `第 ${table} 桌 ${label}` : `agent ${label}`;
    }
    const sender = normalizeWhitespace(item && item.sender) || "发图者未识别";
    const loserStoneCount =
      item && Number.isFinite(Number(item.loserStoneCount))
        ? String(Math.trunc(Number(item.loserStoneCount)))
        : "待判定";
    return `${sender}　输者子数：${loserStoneCount}`;
  }

  function isUserPendingScoreItem(item) {
    return Boolean(item && normalizeWhitespace(item.pendingKind) === "user-pending");
  }

  function isAgentPendingScoreItem(item) {
    const verdict = normalizeWhitespace(item && item.verdict);
    return Boolean(
      item &&
        (normalizeWhitespace(item.pendingKind).startsWith("agent-") ||
          normalizeWhitespace(item.accountMismatchText) ||
          normalizeWhitespace(item.reviewAction) ||
          verdict === "account-mismatch" ||
          verdict === "account-mapping-unresolved" ||
          verdict === "account-incomplete" ||
          verdict === "account-gate-incomplete"),
    );
  }

  function renderAccountMismatchText(text) {
    const normalized = normalizeWhitespace(text);
    if (!normalized) return "";
    let display = normalized;
    if (normalized.startsWith("{") && normalized.endsWith("}")) {
      try {
        const parsed = JSON.parse(normalized);
        if (parsed && typeof parsed === "object") {
          const table = normalizeWhitespace(parsed.table);
          const black = normalizeWhitespace(parsed.black);
          const white = normalizeWhitespace(parsed.white);
          const blackAccount = normalizeWhitespace(parsed.blackAccount);
          const whiteAccount = normalizeWhitespace(parsed.whiteAccount);
          const candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
          const candidate = candidates[0] && typeof candidates[0] === "object" ? candidates[0] : null;
          const created = normalizeWhitespace(candidate && (candidate.createdLocal || candidate.createdAt));
          const timeText = created.length >= 16 ? created.slice(11, 16) : created;
          const blackScore = candidate && Number.isFinite(Number(candidate.blackScore))
            ? Math.trunc(Number(candidate.blackScore))
            : null;
          const whiteScore = candidate && Number.isFinite(Number(candidate.whiteScore))
            ? Math.trunc(Number(candidate.whiteScore))
            : null;
          const scoreText =
            blackScore != null && whiteScore != null ? `${blackScore}-${whiteScore}` : "";
          const winner =
            blackScore != null && whiteScore != null && blackScore !== whiteScore
              ? blackScore > whiteScore
                ? `${normalizeWhitespace(candidate.blackName) || black}胜`
                : `${normalizeWhitespace(candidate.whiteName) || white}胜`
              : blackScore != null && whiteScore != null
                ? "平局"
                : "";
          const candidateText = candidates.length
            ? `候选${candidates.length}局：${[timeText, scoreText, winner].filter(Boolean).join(" ")}`
            : "未找到可直接采用的 OQ 对局";
          display = `第${table}台 ${black}(${blackAccount || "无账号"}) vs ${white}(${whiteAccount || "无账号"})；${candidateText}`;
        }
      } catch (_) {
        display = normalized;
      }
    }
    const parts = display
      .split(/\s+\/\s+|；/)
      .map((part) => normalizeWhitespace(part))
      .filter(Boolean);
    const lines = parts.length > 1 ? parts : [display];
    return `<div class="score-card__reason score-card__reason--mismatch">
      <div>账号核对：</div>
      ${lines.map((line) => `<div>${escapeHtml(line)}</div>`).join("")}
    </div>`;
  }

  function scoreCandidateTimeText(candidate) {
    const created = normalizeWhitespace(
      candidate && (candidate.createdLocal || candidate.createdAt || candidate.resultTime),
    );
    if (!created) return "";
    return created.length >= 16 ? created.slice(0, 16) : created;
  }

  function scoreCandidateScoreText(candidate) {
    const blackScore = Number(candidate && candidate.blackScore);
    const whiteScore = Number(candidate && candidate.whiteScore);
    if (!Number.isFinite(blackScore) || !Number.isFinite(whiteScore)) return "";
    return `${Math.trunc(blackScore)}-${Math.trunc(whiteScore)}`;
  }

  function scoreCandidateCanApply(candidate) {
    const blackScore = Number(candidate && candidate.blackScore);
    const whiteScore = Number(candidate && candidate.whiteScore);
    return (
      candidate &&
      typeof candidate === "object" &&
      Number.isFinite(blackScore) &&
      Number.isFinite(whiteScore) &&
      blackScore >= 0 &&
      blackScore <= 64 &&
      whiteScore >= 0 &&
      whiteScore <= 64 &&
      Math.trunc(blackScore) + Math.trunc(whiteScore) === 64
    );
  }

  function scorePendingCandidates(item) {
    const detail = item && item.oqPendingDetail && typeof item.oqPendingDetail === "object"
      ? item.oqPendingDetail
      : null;
    const followup = item && item.oqFollowup && typeof item.oqFollowup === "object"
      ? item.oqFollowup
      : null;
    const direct = detail && Array.isArray(detail.candidates) ? detail.candidates : [];
    const followupCandidates = followup && Array.isArray(followup.candidates)
      ? followup.candidates
      : Array.isArray(item && item.oqFollowupCandidates)
        ? item.oqFollowupCandidates
        : [];
    return [...direct, ...followupCandidates]
      .filter((candidate) => candidate && typeof candidate === "object")
      .slice(0, 12);
  }

  function renderOqPendingCandidates(item, index, mode) {
    if (mode !== "pending") return "";
    const candidates = scorePendingCandidates(item);
    if (!candidates.length) return "";
    const table = normalizeWhitespace(
      (item && item.oqPendingDetail && item.oqPendingDetail.table) ||
        item.pendingTable ||
        item.table,
    );
    const rows = candidates
      .map((candidate, candidateIndex) => {
        const timeText = scoreCandidateTimeText(candidate) || "时间未知";
        const blackAccount = normalizeWhitespace(candidate.blackAccount || candidate.blackName);
        const whiteAccount = normalizeWhitespace(candidate.whiteAccount || candidate.whiteName);
        const scoreText = scoreCandidateScoreText(candidate);
        const gameId = normalizeWhitespace(candidate.gameId || candidate.candidateKey);
        const canApply = scoreCandidateCanApply(candidate);
        const error = normalizeWhitespace(candidate.error);
        return `<div class="score-candidate ${canApply ? "" : "score-candidate--disabled"}">
          <div class="score-candidate__body">
            <div class="score-candidate__headline">
              <span class="score-candidate__time">${escapeHtml(timeText)}</span>
              ${scoreText ? `<span class="score-candidate__score">${escapeHtml(scoreText)}</span>` : `<span class="score-candidate__score score-candidate__score--muted">待核算</span>`}
            </div>
            <div class="score-candidate__accounts">${escapeHtml(blackAccount || "黑方账号未知")} vs ${escapeHtml(whiteAccount || "白方账号未知")}</div>
            ${gameId ? `<div class="score-candidate__meta">game ${escapeHtml(gameId)}</div>` : ""}
            ${error ? `<div class="score-candidate__error">${escapeHtml(error)}</div>` : ""}
          </div>
          <button class="score-card__btn score-card__btn--primary score-candidate__apply" type="button" ${canApply ? "" : "disabled"} data-score-action="apply-oq-candidate" data-score-mode="pending" data-score-index="${index}" data-candidate-index="${candidateIndex}">
            应用到本台
          </button>
        </div>`;
      })
      .join("");
    return `<details class="score-candidates" open>
      <summary>
        <span>候选对局</span>
        <span>${escapeHtml(table ? `第 ${table} 台` : "")} · ${candidates.length} 项</span>
      </summary>
      <div class="score-candidates__list">${rows}</div>
    </details>`;
  }

  function renderScoreItem(item, index, mode) {
    const isDone = mode === "completed";
    const isManual = mode === "manualPending";
    const isDirty = item && item.dirty === true && !isUserPendingScoreItem(item);
    const isUserPending = isUserPendingScoreItem(item);
    const isAgentPending = isAgentPendingScoreItem(item);
    const isResolved = item && item.resolvedByReferee === true;
    const title = scoreItemSummary(item);
    const senderGroupNick = normalizeWhitespace(item && item.wechatSender);
    const accountMismatchText = normalizeWhitespace(item && item.accountMismatchText);
    const reviewAction = normalizeWhitespace(item && item.reviewAction);
    const resultText = normalizeWhitespace(item && item.resultText);
    const tableText = normalizeWhitespace(item && (item.pendingTable || item.table));
    const originalText = isUserPending
      ? [
          item.originalStatus ? `原状态 ${escapeHtml(item.originalStatus)}` : "",
          item.originalScore ? `原比分 ${escapeHtml(item.originalScore)}` : "",
        ].filter(Boolean).join(" · ")
      : "";
    const meta = [
      item.sourceTime ? `时间 ${escapeHtml(item.sourceTime)}` : "",
      item.verdict ? `状态 ${escapeHtml(item.verdict)}` : "",
      item.confidence ? `置信 ${escapeHtml(item.confidence)}` : "",
      isResolved ? "裁判已解决" : "",
    ]
      .filter(Boolean)
      .join(" · ");
    const actions =
      mode === "pending"
        ? `<div class="score-card__actions">
            ${
              isResolved
                ? `<button class="score-card__btn" type="button" disabled>已解决</button>`
                : `<button class="score-card__btn score-card__btn--primary" type="button" data-score-action="resolve-pending" data-score-mode="pending" data-score-index="${index}">我已解决</button>`
            }
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
      <article class="score-card ${index === 0 && mode === "pending" ? "score-card--active" : ""} ${mode === "pending" ? "score-card--pending-alert" : ""} ${isResolved ? "score-card--resolved" : ""} ${isManual ? "score-card--manual" : ""} ${isDirty ? "score-card--dirty" : ""}" data-entity-id="${escapeHtml(item && item.entityId || "")}">
        <div class="score-card__index">${isDone || isResolved ? "✓" : isManual ? "P" : isDirty ? "脏" : index + 1}</div>
        <div class="score-card__main">
          <div class="score-card__title">${escapeHtml(title)}</div>
          <div class="score-card__detail">${
            isUserPending
              ? `桌号：${escapeHtml(tableText || "")} · ${escapeHtml(item.sender || "")}`
              : isAgentPending
              ? `桌号：${escapeHtml(tableText || "")} · 发图者群昵称：${escapeHtml(senderGroupNick || "MISSING wechatSender")}`
              : `选手：${escapeHtml(item.sender || "")}`
          }</div>
          ${meta ? `<div class="score-card__meta">${meta}</div>` : ""}
          ${originalText ? `<div class="score-card__meta">${originalText}</div>` : ""}
          ${renderAccountMismatchText(accountMismatchText)}
          ${renderOqPendingCandidates(item, index, mode)}
          ${reviewAction ? `<div class="score-card__note">处理建议：${escapeHtml(reviewAction)}</div>` : ""}
          ${resultText ? `<div class="score-card__note">${escapeHtml(resultText)}</div>` : ""}
          ${item.reason ? `<div class="score-card__reason">原因：${escapeHtml(item.reason)}</div>` : ""}
          ${mode !== "pending" && !isAgentPending && item.imagePath ? `<div class="score-card__meta">图片：${escapeHtml(item.imagePath)}</div>` : ""}
          ${actions}
        </div>
      </article>
    `;
  }

  function getScoreFtdSearchTerm() {
    return normalizeWhitespace(
      scoreFtdSearchBox && typeof scoreFtdSearchBox.value === "string"
        ? scoreFtdSearchBox.value
        : "",
    ).toLowerCase();
  }

  function getFtdPairingStatusText(item) {
    if (isFtdByePairing(item)) return "BYE";
    if (item && item.status === "ready") return "待确认";
    if (item && item.status === "dirty") return "脏数据";
    if (item && item.status === "completed") return "已登记";
    return "未登记";
  }

  function markFtdPairingEdited(item, editor = "user", editedAt = now()) {
    if (!item || typeof item !== "object") return;
    item.lastEditedBy = editor === "agent" || editor === "script" || editor === "automation" ? editor : "user";
    item.lastEditedAt = editedAt;
  }

  function markFtdPairingUserEditedFields(item, fields, editedAt = now()) {
    if (!item || typeof item !== "object") return;
    const fieldList = Array.isArray(fields) ? fields : [];
    if (!fieldList.length) return;
    const current =
      item.userEditedFields && typeof item.userEditedFields === "object"
        ? { ...item.userEditedFields }
        : {};
    fieldList.forEach((field) => {
      const key = normalizeWhitespace(field);
      if (!key) return;
      current[key] = editedAt;
    });
    item.userEditedFields = current;
  }

  function getFtdPairingEditorText(item) {
    const editor = normalizeWhitespace(item && item.lastEditedBy);
    if (editor === "agent") return "agent 修改";
    if (editor === "automation") return "AP 验证";
    if (editor === "script") return "脚本修改";
    if (editor === "user") return "用户修改";
    return "";
  }

  function renderOqGameAvailableTag(item) {
    if (!item || item.oqGameAvailable !== true) return "";
    const audit = item.oqGameAvailableAudit && typeof item.oqGameAvailableAudit === "object"
      ? item.oqGameAvailableAudit
      : {};
    const game = audit.game && typeof audit.game === "object" ? audit.game : {};
    const gameId = normalizeWhitespace(game.gameId || "");
    const created = normalizeWhitespace(game.createdLocal || game.createdAt || "");
    const title = `OQ 棋谱可用${gameId ? `：${gameId}` : ""}${created ? `，${created}` : ""}`;
    return `<span class="score-ftd__oq-game" title="${escapeHtml(title)}">棋谱可用</span>`;
  }

  function renderFtdTranscriptImportTag(item) {
    if (!FTD_TRANSCRIPT.isCurrentTranscriptImport(item)) return "";
    const imported = FTD_TRANSCRIPT.sanitizeTranscriptImport(item.ftdTranscriptImport);
    const title = imported
      ? `已确认导入 OQ 棋谱：${imported.oqGameId}`
      : "已确认导入 OQ 棋谱";
    return `<span class="score-ftd__transcript-import" title="${escapeHtml(title)}">棋谱已导入</span>`;
  }

  function renderFtdAutomationReceiptTag(item) {
    if (!item || !item.ftdScoreReceipt || !item.ftdScoreReceipt.verifiedAt) return "";
    const scoreTitle = `FTD 比分精确回读：${normalizeWhitespace(item.ftdScoreReceipt.verifiedAt)}`;
    const transcriptVerified = item.ftdTranscriptReceipt && item.ftdTranscriptReceipt.verifiedAt;
    const transcriptNa = item.transcriptNotApplicable && item.transcriptNotApplicable.reason;
    const transcriptText = transcriptVerified ? " · 棋谱已回读" : transcriptNa ? " · 棋谱不适用" : "";
    return `<span class="score-ftd__transcript-import" title="${escapeHtml(scoreTitle)}">FTD已验证${escapeHtml(transcriptText)}</span>`;
  }

  function ftdPairingRowStatusClass(item) {
    return item && item.status === "completed" && item.resultKind === "absence"
      ? "absence-completed"
      : (item && item.status) || "imported";
  }

  function renderFtdPairingStatusMetadata(item) {
    const editorText = getFtdPairingEditorText(item);
    const editorHtml = editorText
      ? `<span class="score-ftd__editor score-ftd__editor--${escapeHtml(item.lastEditedBy)}">${escapeHtml(editorText)}</span>`
      : "";
    return `${escapeHtml(getFtdPairingStatusText(item))}${editorHtml}${renderFtdTranscriptImportTag(item)}${renderFtdAutomationReceiptTag(item)}`;
  }

  function getEgaPairingLoss(roundNo, table) {
    const analysis = state && state.egaAnalysis && typeof state.egaAnalysis === "object"
      ? state.egaAnalysis
      : {};
    const byRound = analysis.pairingLossByRound && typeof analysis.pairingLossByRound === "object"
      ? analysis.pairingLossByRound
      : {};
    const roundBucket = byRound[String(roundNo)] || byRound[roundNo];
    if (!roundBucket || typeof roundBucket !== "object") return null;
    const item = roundBucket[String(table)] || roundBucket[table];
    return item && typeof item === "object" ? item : null;
  }

  function getEgaPlayerLossForSide(roundNo, item, side) {
    const pairingLoss = getEgaPairingLoss(roundNo, item && item.table);
    if (!pairingLoss || !Array.isArray(pairingLoss.players)) return null;
    const targetName = normalizeKey(side === "black" ? item && item.black : item && item.white);
    const targetAccount = normalizeKey(side === "black" ? pairingLoss.blackAccount : pairingLoss.whiteAccount);
    const sidePlayers = pairingLoss.players.filter((player) => {
      const ftdSide = normalizeWhitespace(player && player.ftdSide).toLowerCase();
      const color = normalizeWhitespace(player && player.color).toLowerCase();
      return ftdSide ? ftdSide === side : (!color || color === side);
    });
    let found = sidePlayers.find((player) => normalizeKey(player && player.name) === targetName);
    if (!found && targetAccount) {
      found = sidePlayers.find((player) => normalizeKey(player && player.account) === targetAccount);
    }
    return found || null;
  }

  function renderEgaLossTag(roundNo, item, side) {
    const loss = getEgaPlayerLossForSide(roundNo, item, side);
    if (!loss || !Number.isFinite(Number(loss.totalLoss))) return "";
    const total = Number(loss.totalLoss);
    const avg = Number(loss.averageLoss);
    const totalText = Math.abs(total - Math.round(total)) < 0.001 ? String(Math.round(total)) : total.toFixed(1);
    const avgText = Number.isFinite(avg) ? avg.toFixed(2) : "N/A";
    const gameId = normalizeWhitespace(loss.gameId || "");
    const title = `Egaroucid 子损：总 ${totalText}，平均 ${avgText}${gameId ? `，game ${gameId}` : ""}`;
    return `<span class="score-ftd__ega-loss" title="${escapeHtml(title)}">子损 ${escapeHtml(totalText)}</span>`;
  }

  function ftdPairingMatchesSearch(item, term) {
    const q = normalizeWhitespace(term || "").toLowerCase();
    if (!q) return true;
    const table = normalizeWhitespace(item && item.table);
    const blackScore = Number.isFinite(Number(item && item.blackScore))
      ? String(Math.trunc(Number(item.blackScore)))
      : "";
    const whiteScore = Number.isFinite(Number(item && item.whiteScore))
      ? String(Math.trunc(Number(item.whiteScore)))
      : "";
    const hay = [
      table,
      table ? `#${table}` : "",
      table ? `第${table}台` : "",
      table ? `第 ${table} 台` : "",
      item && item.black,
      item && item.white,
      item && item.reporter,
      item && item.opponent,
      blackScore,
      whiteScore,
      blackScore && whiteScore ? `${blackScore}-${whiteScore}` : "",
      blackScore && whiteScore ? `${blackScore}:${whiteScore}` : "",
      getFtdPairingStatusText(item),
      item && item.status,
      getFtdPairingEditorText(item),
      item && item.lastEditedBy,
      item && item.resultKind,
      item && item.resultText,
      item && item.reason,
      item && item.ftdStage,
    ]
      .map((x) => normalizeWhitespace(x).toLowerCase())
      .filter(Boolean)
      .join(" ");
    return hay.includes(q);
  }

  function scorePairingTableLabel(round, item) {
    const table = Math.max(1, Math.trunc(Number(item && item.table) || 1));
    if (normalizeWhitespace(round && round.stage) === SCORE_STAGE_FINALS) {
      return table === 1 ? "决赛 #1" : table === 2 ? "3/4 #2" : `#${table}`;
    }
    return `#${table}`;
  }

  function orderedFtdPairingsForDisplay(round, searchTerm = "") {
    const pairings = Array.isArray(round && round.ftdPairings)
      ? round.ftdPairings
      : [];
    return pairings
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => ftdPairingMatchesSearch(item, searchTerm))
      .sort((a, b) => {
        const rank = { ready: 0, dirty: 1, imported: 2, completed: 3 };
        const ar = rank[a.item.status] ?? 1;
        const br = rank[b.item.status] ?? 1;
        if (ar !== br) return ar - br;
        if (a.item.status === "ready" && b.item.status === "ready") {
          const at = Number(a.item.resultSortKey) || scoreResultSortKey(a.item.resultTime);
          const bt = Number(b.item.resultSortKey) || scoreResultSortKey(b.item.resultTime);
          if (at && bt && at !== bt) return at - bt;
          if (at && !bt) return -1;
          if (!at && bt) return 1;
        }
        return Number(a.item.table || a.index + 1) - Number(b.item.table || b.index + 1);
      });
  }

  function renderFtdPairings(round) {
    const pairings = Array.isArray(round && round.ftdPairings)
      ? round.ftdPairings
      : [];
    if (!pairings.length) {
      return `
        <section class="score-ftd__panel score-ftd__panel--empty">
          <div class="score-ftd__head">
            <h3 class="score-ftd__title">FTD 配对表</h3>
            <span class="score-ftd__meta">未导入</span>
          </div>
          <div class="score-ftd__empty">当前轮还没有导入 FTD 配对。导入只保留台号和黑白双方，不携带比分。</div>
        </section>
      `;
    }
    const searchTerm = getScoreFtdSearchTerm();
    const ordered = orderedFtdPairingsForDisplay(round, searchTerm);
    const readyCount = pairings.filter((item) => !isFtdByePairing(item) && item.status === "ready").length;
    const completedCount = pairings.filter((item) => !isFtdByePairing(item) && item.status === "completed").length;
    const activeCount = pairings.filter((item) => !isFtdByePairing(item)).length;
    const rows = ordered.length
      ? ordered
      .map(
        ({ item, index }) => {
          const tableLabel = scorePairingTableLabel(round, item);
          const rowStatus = ftdPairingRowStatusClass(item);
          const editorText = getFtdPairingEditorText(item);
          const editorHtml = editorText
            ? `<span class="score-ftd__editor score-ftd__editor--${escapeHtml(item.lastEditedBy)}">${escapeHtml(editorText)}</span>`
            : "";
          const oqGameAvailableHtml = renderOqGameAvailableTag(item);
          if (isFtdByePairing(item)) {
            return `
          <div class="score-ftd__row score-ftd__row--completed score-ftd__row--bye" data-ftd-index="${index}" data-entity-id="${escapeHtml(item.entityId || "")}">
            <div class="score-ftd__table">${escapeHtml(tableLabel)}</div>
            <div class="score-ftd__match">
              <div class="score-ftd__player score-ftd__player--black">
                <div class="score-ftd__player-line">
                  <span class="score-ftd__name">${escapeHtml(item.black)}</span>
                </div>
              </div>
              <strong class="score-ftd__vs">vs</strong>
              <div class="score-ftd__player score-ftd__player--white">
                <div class="score-ftd__player-line">
                  <span class="score-ftd__name">${escapeHtml(item.white)}</span>
                </div>
              </div>
            </div>
            <div class="score-ftd__status">BYE${editorHtml}</div>
            <div class="score-ftd__actions">
              <button class="score-card__btn" type="button" disabled>BYE</button>
            </div>
          </div>
        `;
          }
          const blackScore = Number.isFinite(Number(item.blackScore))
            ? Math.trunc(Number(item.blackScore))
            : "";
          const whiteScore = Number.isFinite(Number(item.whiteScore))
            ? Math.trunc(Number(item.whiteScore))
            : "";
          const hasUserPending = hasUserPendingForFtdPairing(round, item);
          const blackEgaLoss = renderEgaLossTag(round.round, item, "black");
          const whiteEgaLoss = renderEgaLossTag(round.round, item, "white");
          const matchOqGameAvailableHtml = oqGameAvailableHtml
            ? `<div class="score-ftd__match-tags">${oqGameAvailableHtml}</div>`
            : "";
          return `
          <div class="score-ftd__row score-ftd__row--${escapeHtml(rowStatus)}" data-ftd-index="${index}" data-entity-id="${escapeHtml(item.entityId || "")}">
            <div class="score-ftd__table">${escapeHtml(tableLabel)}</div>
            <div class="score-ftd__match">
              <div class="score-ftd__player score-ftd__player--black">
                <div class="score-ftd__player-line">
                  <span class="score-ftd__name">${escapeHtml(item.black)}</span>
                  <button class="score-card__btn score-card__btn--ghost" type="button" data-ftd-action="absence" data-ftd-side="black" data-ftd-index="${index}">缺席</button>
                  ${blackEgaLoss}
                </div>
                <input class="score-ftd__input" type="number" min="0" max="64" inputmode="numeric" value="${escapeHtml(blackScore)}" aria-label="第 ${escapeHtml(item.table)} 台 ${escapeHtml(item.black)} 分数" data-ftd-score-side="black" data-ftd-index="${index}">
              </div>
              <strong class="score-ftd__vs">vs</strong>
              <div class="score-ftd__player score-ftd__player--white">
                <div class="score-ftd__player-line">
                  <span class="score-ftd__name">${escapeHtml(item.white)}</span>
                  <button class="score-card__btn score-card__btn--ghost" type="button" data-ftd-action="absence" data-ftd-side="white" data-ftd-index="${index}">缺席</button>
                  ${whiteEgaLoss}
                </div>
                <input class="score-ftd__input" type="number" min="0" max="64" inputmode="numeric" value="${escapeHtml(whiteScore)}" aria-label="第 ${escapeHtml(item.table)} 台 ${escapeHtml(item.white)} 分数" data-ftd-score-side="white" data-ftd-index="${index}">
              </div>
              ${matchOqGameAvailableHtml}
            </div>
            <div class="score-ftd__status">${renderFtdPairingStatusMetadata(item)}</div>
            <div class="score-ftd__actions">
              <button class="score-card__btn" type="button" data-ftd-action="complete" data-ftd-index="${index}">完成</button>
              <button class="score-card__btn" type="button" data-ftd-action="${hasUserPending ? "cancel-pending" : "pending"}" data-ftd-index="${index}">${hasUserPending ? "取消pending" : "pending"}</button>
              <button class="score-card__btn" type="button" data-ftd-action="delete-result" data-ftd-index="${index}">删除结果</button>
            </div>
          </div>
        `;
        },
      )
      .join("")
      : `<div class="empty-state empty-state--list score-ftd__empty-row"><svg class="empty-state__icon" aria-hidden="true"><use href="#i-search"></use></svg><div><div class="empty-state__title">没有匹配的配对</div><div class="empty-state__text">可清除搜索词，或切换轮次后再查看。</div></div></div>`;
    const searchMeta = searchTerm ? ` · 显示 ${ordered.length}/${pairings.length}` : "";
    return `
      <section class="score-ftd__panel">
        <div class="score-ftd__head">
          <h3 class="score-ftd__title">FTD 配对表</h3>
          <span class="score-ftd__meta">${escapeHtml(scoreStageLabel(round))} · ${pairings.length} 台${searchMeta} · 待确认 ${readyCount} · 已登记 ${completedCount}/${activeCount}</span>
        </div>
        <div class="score-ftd__rows">${rows}</div>
      </section>
    `;
  }

  function scoreRoundFtdStats(round) {
    const pairings = Array.isArray(round && round.ftdPairings)
      ? round.ftdPairings
      : [];
    const active = pairings.filter((item) => !isFtdByePairing(item));
    return {
      total: pairings.length,
      active: active.length,
      ready: active.filter((item) => item.status === "ready").length,
      completed: active.filter((item) => item.status === "completed").length,
      imported: active.filter((item) => item.status !== "ready" && item.status !== "completed").length,
      dirty: active.filter((item) => item.status === "dirty").length,
    };
  }

  function ftdPlayerMapRowMatches(row, term) {
    if (!term) return true;
    const hay = [
      row.ftdName,
      row.account,
      row.groupNick,
      row.editAudit && row.editAudit.action,
      row.editAudit && row.editAudit.by,
      row.pendingText,
      row.reason,
      row.source,
    ]
      .map((value) => normalizeKey(value))
      .join(" ");
    return hay.includes(term);
  }

  function isDeletedFtdPlayerMapRow(row) {
    return Boolean(row && row.deleted);
  }

  function oqCheckMatchesFtdPlayerMapAccount(row) {
    if (!row || !row.oqCheck || typeof row.oqCheck !== "object") return false;
    const account = normalizeWhitespace(row.account);
    const checkedAccount = normalizeWhitespace(row.oqCheck.account || row.oqCheckAccount || "");
    if (!checkedAccount) return true;
    return normalizeKey(checkedAccount) === normalizeKey(account);
  }

  function oqCheckPassesFtdPlayerMapAccount(row) {
    const oqCheck = row && row.oqCheck && typeof row.oqCheck === "object" ? row.oqCheck : null;
    return Boolean(
      oqCheck &&
        oqCheckMatchesFtdPlayerMapAccount(row) &&
        (oqCheck.status === "ok" || oqCheck.status === "forced-ok"),
    );
  }

  function isUnresolvedFtdPlayerMapRow(row) {
    if (!row || isDeletedFtdPlayerMapRow(row)) return false;
    const oqCheck = row.oqCheck && typeof row.oqCheck === "object" ? row.oqCheck : null;
    return (
      !normalizeWhitespace(row.ftdName) ||
      !normalizeWhitespace(row.account) ||
      !normalizeWhitespace(row.groupNick) ||
      !oqCheckPassesFtdPlayerMapAccount(row)
    );
  }

  function isInvalidOqFtdPlayerMapRow(row) {
    if (!row || isDeletedFtdPlayerMapRow(row)) return false;
    const oqCheck = row.oqCheck && typeof row.oqCheck === "object" ? row.oqCheck : null;
    return (
      Boolean(
        normalizeWhitespace(row.ftdName) &&
          normalizeWhitespace(row.account) &&
          normalizeWhitespace(row.groupNick) &&
          oqCheck &&
          oqCheckMatchesFtdPlayerMapAccount(row) &&
          oqCheck.status === "invalid",
      )
    );
  }

  function isForcedOqFtdPlayerMapRow(row) {
    if (!row || isDeletedFtdPlayerMapRow(row)) return false;
    const oqCheck = row.oqCheck && typeof row.oqCheck === "object" ? row.oqCheck : null;
    return Boolean(
      normalizeWhitespace(row.ftdName) &&
        normalizeWhitespace(row.account) &&
        normalizeWhitespace(row.groupNick) &&
        oqCheck &&
        oqCheckMatchesFtdPlayerMapAccount(row) &&
        oqCheck.status === "forced-ok",
    );
  }

  function ftdPlayerMapSortGroup(row) {
    if (isDeletedFtdPlayerMapRow(row)) return 4;
    if (isInvalidOqFtdPlayerMapRow(row)) return 1;
    if (isForcedOqFtdPlayerMapRow(row)) return 2;
    if (isUnresolvedFtdPlayerMapRow(row)) return 0;
    return 3;
  }

  function compareFtdPlayerMapRows(a, b) {
    const groupDiff = ftdPlayerMapSortGroup(a) - ftdPlayerMapSortGroup(b);
    if (groupDiff) return groupDiff;
    const orderDiff = Number(a && a.order) - Number(b && b.order);
    if (Number.isFinite(orderDiff) && orderDiff !== 0) return orderDiff;
    return normalizeKey(a && a.ftdName).localeCompare(normalizeKey(b && b.ftdName), "zh-Hans");
  }

  function ftdPlayerMapAuditLabel(row) {
    const audit = row && row.editAudit ? row.editAudit : {};
    if (audit.by === "user" || row && row.source === "user") return "\u7528\u6237\u4fee\u6539";
    return "agent\u4fee\u6539";
  }

  function normalizeOqAccountInput(value) {
    return String(value || "").replace(/\s+/g, "");
  }

  function invalidOqAccountChars(value) {
    const chars = [];
    const seen = new Set();
    String(value || "").replace(/\s+/g, "").split("").forEach((char) => {
      if (/^[A-Za-z0-9_]$/.test(char) || seen.has(char)) return;
      seen.add(char);
      chars.push(char);
    });
    return chars;
  }

  function alertInvalidOqAccount(value) {
    const chars = invalidOqAccountChars(value);
    if (!chars.length) return false;
    showAlert("OQ\u8d26\u53f7\u586b\u5199\u4e0d\u89c4\u8303", `OQ\u8d26\u53f7\u53ea\u652f\u6301\u5927\u5c0f\u5199\u82f1\u6587\u5b57\u6bcd\u3001\u6570\u5b57\u548c\u4e0b\u5212\u7ebf\uff1b\u51fa\u73b0\u5b57\u7b26\u201c${chars.join("\u201d\u201c")}\u201d\u3002`);
    return true;
  }

  function isCompleteFtdPlayerMapRow(row) {
    return Boolean(
      row &&
        !isDeletedFtdPlayerMapRow(row) &&
        !isInvalidOqFtdPlayerMapRow(row) &&
        normalizeWhitespace(row.ftdName) &&
        normalizeWhitespace(row.account) &&
        normalizeWhitespace(row.groupNick) &&
        row.oqCheck &&
        oqCheckPassesFtdPlayerMapAccount(row),
    );
  }

  function rebuildFtdPlayerMapStats(mapping, mappedAt = new Date().toISOString()) {
    const safe = sanitizeFtdPlayerAccountMapping(mapping);
    if (!safe) return null;
    const rows = Array.isArray(safe.players) ? safe.players : [];
    const accountIndex = {};
    rows.forEach((row) => {
      const key = normalizeKey(row.ftdName);
      if (!key || isDeletedFtdPlayerMapRow(row)) return;
      const account = normalizeWhitespace(row.account);
      const groupNick = normalizeWhitespace(row.groupNick);
      const oqCheck = row.oqCheck && typeof row.oqCheck === "object" ? row.oqCheck : null;
      if (!account) return;
      if (oqCheck && !oqCheckMatchesFtdPlayerMapAccount(row)) {
        row.oqCheck = null;
      }
      if (!groupNick || !oqCheckPassesFtdPlayerMapAccount(row)) return;
      accountIndex[key] = {
        ftdName: row.ftdName,
        displayName: row.ftdName,
        account,
        groupNick,
        ftdId: row.ftdId == null ? "" : row.ftdId,
        source: row.source || "",
        mappedAt,
        oqStatus: oqCheck && oqCheck.status ? oqCheck.status : "",
      };
    });
    const activeRows = rows.filter((row) => !isDeletedFtdPlayerMapRow(row));
    const invalidRows = activeRows.filter(isInvalidOqFtdPlayerMapRow);
    return {
      ...safe,
      mappedAt,
      updatedAt: now(),
      accountIndex,
      players: rows,
      playerCount: rows.length,
      indexedCount: Object.keys(accountIndex).length,
      matchedCount: activeRows.filter(isCompleteFtdPlayerMapRow).length,
      invalidAccountCount: invalidRows.length,
      ambiguousCount: 0,
      unmatchedCount: activeRows.filter((row) => !isCompleteFtdPlayerMapRow(row) && !isInvalidOqFtdPlayerMapRow(row)).length,
      unmatched: activeRows.filter((row) => !isCompleteFtdPlayerMapRow(row) && !isInvalidOqFtdPlayerMapRow(row)).slice(0, 120),
      invalidAccounts: invalidRows.slice(0, 120),
      ambiguous: [],
    };
  }

  function pruneMissingFtdPlayerMapGroupNicks(groupNicks, editedAt = new Date().toISOString()) {
    const mapping = sanitizeFtdPlayerAccountMapping(state.ftdPlayerAccountMapping);
    if (!mapping || !Array.isArray(mapping.players)) return 0;
    const valid = new Set((Array.isArray(groupNicks) ? groupNicks : []).map((nick) => normalizeWhitespace(nick)).filter(Boolean));
    if (!valid.size) return 0;
    let removed = 0;
    const rows = mapping.players.map((row) => {
      const nick = normalizeWhitespace(row.groupNick);
      if (!nick || valid.has(nick) || isDeletedFtdPlayerMapRow(row)) return row;
      removed += 1;
      return {
        ...row,
        groupNick: "",
        editAudit: { by: "agent", action: "群昵称已失效", at: editedAt },
      };
    });
    if (!removed) return 0;
    state.ftdPlayerAccountMapping = rebuildFtdPlayerMapStats({
      ...mapping,
      players: rows,
    }, editedAt);
    return removed;
  }

  function renderCheckinFtdPlayerMap() {
    const mapping = sanitizeFtdPlayerAccountMapping(state.ftdPlayerAccountMapping);
    if (!checkinFtdPlayerMapView) return;
    if (!mapping) {
      checkinFtdPlayerMapView.innerHTML = `<div class="score-ftd-map__empty">点击“导出player表”后让 agent 执行三阶段 FTD/OQ 映射流程。</div>`;
      return;
    }
    const mappedAt = mapping.mappedAt
      ? mapping.mappedAt.replace("T", " ").replace(/\+\d\d:\d\d$/, "")
      : "未知时间";
    const sourceRows = Array.isArray(mapping.players) ? mapping.players : [];
    const nickPool = sanitizeWechatGroupNicks(state.wechatGroupNicks);
    const groupNicks = nickPool && Array.isArray(nickPool.groupNicks) ? nickPool.groupNicks : [];
    const term = normalizeKey(searchBox && searchBox.value);
    const visibleRows = sourceRows
      .filter((row) => ftdPlayerMapRowMatches(row, term))
      .map((row, index) => ({ ...row, order: index }))
      .sort(compareFtdPlayerMapRows);
    const rows = visibleRows
      .map((row) => {
        const deleted = row.deleted;
        const invalidOq = isInvalidOqFtdPlayerMapRow(row);
        const forcedOq = isForcedOqFtdPlayerMapRow(row);
        const unresolved = isUnresolvedFtdPlayerMapRow(row);
        const rowStatusClass = deleted ? "deleted" : invalidOq ? "invalid-account" : forcedOq ? "forced" : unresolved ? "unresolved" : "matched";
        const auditLabel = ftdPlayerMapAuditLabel(row);
        const auditClass = auditLabel === "用户修改" ? "user" : "agent";
        const accountValue = normalizeWhitespace(row.account || "");
        const groupNickValue = normalizeWhitespace(row.groupNick || "");
        const rawOqCheck = row.oqCheck && typeof row.oqCheck === "object" ? row.oqCheck : null;
        const oqCheck = rawOqCheck && oqCheckMatchesFtdPlayerMapAccount(row) ? rawOqCheck : null;
        const oqStatusText = !accountValue
          ? "\u672a\u586b\u8d26\u53f7"
          : !oqCheck || !oqCheck.status
            ? "\u672a\u68c0\u9a8c"
            : oqCheck.status === "ok"
              ? "\u5df2\u68c0\u9a8c"
              : oqCheck.status === "forced-ok"
                ? "\u5f3a\u5236\u901a\u8fc7"
                : "\u68c0\u9a8c\u5931\u8d25";
        const oqStatusClass = !accountValue
          ? "unknown"
          : oqCheck && oqCheck.status === "ok"
            ? "ok"
            : oqCheck && oqCheck.status === "forced-ok"
              ? "forced"
              : oqCheck && oqCheck.status === "invalid"
                ? "invalid"
                : "unknown";
        const nickOptions = groupNicks
          .filter((nick) => {
            const rowKey = normalizeKey(row.ftdName);
            const nickKey = normalizeKey(nick);
            if (!term && rowKey && nickKey.includes(rowKey)) return true;
            if (!term) return false;
            return nickKey.includes(term);
          })
          .slice(0, 24);
        const defaultNickSet = new Set((nickOptions.length ? nickOptions : groupNicks.slice(0, 24)));
        return `
          <div class="score-ftd-map__row score-ftd-map__row--${escapeHtml(rowStatusClass)}" data-ftd-map-row="1" data-ftd-map-name="${escapeHtml(row.ftdName)}" data-entity-id="${escapeHtml(row.entityId || "")}">
            <div class="score-ftd-map__name-block">
              <div class="score-ftd-map__caption">姓名</div>
              <div class="score-ftd-map__name">${escapeHtml(row.ftdName || "未命名")}</div>
            </div>
            <label class="score-ftd-map__field">
              <span>OQ 账号</span>
              <input class="score-ftd-map__account" value="${escapeHtml(accountValue)}" placeholder="输入 OQ 账号" data-ftd-map-name="${escapeHtml(row.ftdName)}" ${deleted ? "disabled" : ""}>
            </label>
            <details class="score-ftd-map__nick">
              <summary>
                <span>群昵称</span>
                <strong>${escapeHtml(groupNickValue || "未选择")}</strong>
              </summary>
              <div class="score-ftd-map__nick-options">
                ${
                  groupNicks.length
                    ? `<input class="score-ftd-map__nick-search" type="search" placeholder="搜索群昵称..." autocomplete="off" data-ftd-map-nick-search="1">` +
                      `<div class="score-ftd-map__nick-hint">输入只用于筛选，选择下方候选后才会写入。</div>` +
                      groupNicks
                        .map((nick) => `<button class="score-ftd-map__nick-option" type="button" data-ftd-map-action="set-nick" data-ftd-map-name="${escapeHtml(row.ftdName)}" data-group-nick="${escapeHtml(nick)}" data-nick-key="${escapeHtml(normalizeKey(nick))}" ${defaultNickSet.has(nick) ? "" : "hidden"}>${escapeHtml(nick)}</button>`)
                        .join("")
                    : `<div class="score-ftd-map__nick-empty">先刷新群昵称列表</div>`
                }
                ${
                  groupNickValue
                    ? `<button class="score-ftd-map__nick-option score-ftd-map__nick-option--clear" type="button" data-ftd-map-action="clear-nick" data-ftd-map-name="${escapeHtml(row.ftdName)}">清除选择</button>`
                    : ""
                }
              </div>
            </details>
            <span class="score-ftd-map__audit score-ftd-map__audit--${escapeHtml(auditClass)}">${escapeHtml(auditLabel)}</span>
            <div class="score-ftd-map__oq-status score-ftd-map__oq-status--${escapeHtml(oqStatusClass)}">
              ${escapeHtml(oqStatusText)}
            </div>
            <div class="score-ftd-map__actions">
              ${
                deleted
                  ? `<button class="score-card__btn" type="button" data-ftd-map-action="restore" data-ftd-map-name="${escapeHtml(row.ftdName)}">\u6062\u590d</button>`
                  : ""
              }
              ${
                !deleted && invalidOq
                  ? `<button class="score-card__btn score-card__btn--primary" type="button" data-ftd-map-action="force-oq" data-ftd-map-name="${escapeHtml(row.ftdName)}">\u5f3a\u5236\u901a\u8fc7\u6821\u9a8c</button>`
                  : ""
              }
            </div>
          </div>
        `;
      })
      .join("");
    const searchMeta = term
      ? `<div class="score-ftd-map__search-meta">显示 ${escapeHtml(visibleRows.length)}/${escapeHtml(sourceRows.length)}</div>`
      : "";
    checkinFtdPlayerMapView.innerHTML =
      `<div class="score-ftd-map__summary score-ftd-map__summary--static">
        <div>
          <span class="score-ftd-map__title">FTD Player/OQ 映射表</span>
          <span class="score-ftd-map__hint">白色未完成；黄色为OQ账号校验不通过；绿色需姓名、OQ账号、群昵称齐全且OQ有效。</span>
        </div>
        <span class="score-ftd-map__meta">${escapeHtml(mapping.matchedCount)}/${escapeHtml(mapping.playerCount)} · ${escapeHtml(mappedAt)} · 群昵称 ${escapeHtml(groupNicks.length)} · 未完成 ${escapeHtml(mapping.unmatchedCount)} · 账号异常 ${escapeHtml(mapping.invalidAccountCount || 0)}</span>
      </div>` +
      searchMeta +
      (rows || `<div class="score-ftd-map__empty">没有匹配的映射记录。</div>`);
  }

  function ensureFtdPlayerRegistration() {
    state.ftdPlayerRegistration = FTD_PLAYER_REGISTRATION.sanitizeRegistration(
      state.ftdPlayerRegistration,
    );
    return state.ftdPlayerRegistration;
  }

  function ftdPlayerRegistrationRowDetail(row) {
    const selected = row && row.selectedPlayer;
    if (selected) {
      const rating = selected.rating == null ? "rating 空" : `rating ${selected.rating}`;
      return `FTD #${selected.id} · ${selected.surname || ""} ${selected.name || ""} · ${rating} · ${selected.country_code || "未填国家"}`;
    }
    if (row && row.newPlayer) {
      return `${row.newPlayer.surname} ${row.newPlayer.name} · ${row.newPlayer.country} · family ${row.newPlayer.family}`;
    }
    if (row && row.errorMessage) return row.errorMessage;
    return row && row.normalizedName ? `查询姓名：${row.normalizedName}` : "等待 Agent 核对";
  }

  function renderFtdPlayerRegistration() {
    if (!checkinFtdPlayerRegistrationView) return;
    const registration = ensureFtdPlayerRegistration();
    const term = normalizeKey(searchBox && searchBox.value);
    const selectedGroup = state.ui && state.ui.group !== "all" ? state.ui.group : "";
    const rows = registration.rows.filter((row) => {
      if (selectedGroup && row.rosterGroup !== selectedGroup) return false;
      if (!term) return true;
      return normalizeKey([
        row.rosterName,
        row.rosterAccount,
        row.normalizedName,
        row.selectedPlayer && row.selectedPlayer.surname,
        row.selectedPlayer && row.selectedPlayer.name,
        row.selectedPlayer && row.selectedPlayer.id,
      ].filter(Boolean).join(" ")).includes(term);
    });
    const written = registration.rows.filter((row) => row.status === "ftd-written").length;
    const failed = registration.rows.filter((row) => row.status === "ftd-write-failed").length;
    const unresolved = registration.rows.filter((row) =>
      row.status === "unmatched" || row.status === "name-parse-unresolved" || row.status === "pending",
    ).length;
    const pendingBatch = registration.pendingBatch && registration.pendingBatch.status === "pending"
      ? registration.pendingBatch
      : null;
    if (btnCopyFtdPlayerImportConsole) {
      btnCopyFtdPlayerImportConsole.textContent = pendingBatch
        ? "重新复制待确认批次"
        : "批量登记 Player";
    }
    const body = rows.map((row) => {
      const status = FTD_PLAYER_REGISTRATION.statusLabel(row.status);
      const statusClass = row.status === "ftd-written"
        ? "written"
        : row.status === "ftd-write-failed" || row.status === "unmatched" || row.status === "name-parse-unresolved"
          ? "problem"
          : row.status === "console-batch-pending"
            ? "pending"
            : "resolved";
      const tied = Array.isArray(row.tiedPlayerIds) && row.tiedPlayerIds.length
        ? `<div class="ftd-player-registration__tie">并列候选 ID：${escapeHtml(row.tiedPlayerIds.join(", "))}</div>`
        : "";
      return `<div class="ftd-player-registration__row ftd-player-registration__row--${statusClass}" data-ftd-player-row="${escapeHtml(row.rowId)}">
        <div class="ftd-player-registration__identity">
          <strong>${escapeHtml(row.rosterName || "未命名")}</strong>
          <span>${escapeHtml([row.rosterAccount, row.rosterGroup].filter(Boolean).join(" · "))}</span>
        </div>
        <div class="ftd-player-registration__match">
          <span class="chip-small">${escapeHtml(status)}</span>
          <strong>${escapeHtml(row.normalizedName || "未整理姓名")}</strong>
          <span>${escapeHtml(ftdPlayerRegistrationRowDetail(row))}</span>
          ${tied}
        </div>
        <div class="ftd-player-registration__actions">
          <button class="action-btn" type="button" data-ftd-player-action="review" data-row-id="${escapeHtml(row.rowId)}">${row.status === "unmatched" || row.status === "name-parse-unresolved" || row.status === "pending" ? "裁判处理" : "调整"}</button>
          ${row.status !== "pending" && row.status !== "ftd-written" && row.status !== "console-batch-pending" ? `<button class="action-btn" type="button" data-ftd-player-action="reset" data-row-id="${escapeHtml(row.rowId)}">重新待核对</button>` : ""}
        </div>
      </div>`;
    }).join("");
    checkinFtdPlayerRegistrationView.innerHTML = `<div class="ftd-player-registration__summary">
      <div><strong>FTD Player 核对与登记</strong><span>Agent 查询只负责匹配；新人必须由裁判明确确认。Console 结果需返回本页按 Shift+Enter 验证。</span></div>
      <span>总计 ${registration.rows.length} · 待处理 ${unresolved} · 已写入 ${written} · 失败 ${failed}</span>
    </div>
    ${pendingBatch ? `<div class="ftd-player-registration__batch">当前待确认批次：${escapeHtml(pendingBatch.batchId)}（${pendingBatch.rows.length} 项）。如剪贴板代码已丢失，可点击“重新复制待确认批次”取回同一批代码；在 FTD Console 执行后返回此页按 Shift+Enter。</div>` : ""}
    ${body || `<div class="score-ftd-map__empty">尚无 Agent 核对结果。请先点击“复制 Agent 姓名核对 Prompt”。</div>`}`;
  }

  function updateFtdPlayerRegistrationRow(rowId, updater) {
    const registration = ensureFtdPlayerRegistration();
    let changed = false;
    registration.rows = registration.rows.map((row) => {
      if (row.rowId !== rowId) return row;
      const next = deepClone(row);
      updater(next);
      next.resolvedAt = new Date().toISOString();
      next.resolverBatchId = "referee-frontend";
      changed = true;
      return FTD_PLAYER_REGISTRATION.sanitizeRow(next);
    });
    if (!changed) return false;
    registration.updatedAt = new Date().toISOString();
    state.ftdPlayerRegistration = registration;
    refreshCheckinUI();
    scheduleSave();
    return true;
  }

  function resetFtdPlayerRegistrationRow(rowId) {
    updateFtdPlayerRegistrationRow(rowId, (row) => {
      row.status = "pending";
      row.resolutionStatus = "";
      row.selectionRule = "";
      row.selectedPlayer = null;
      row.tiedPlayerIds = [];
      row.candidateCount = 0;
      row.newPlayer = null;
      row.categories = [];
      row.family = "";
      row.errorCode = "";
      row.errorMessage = "";
      row.console = {};
    });
  }

  function showFtdPlayerRefereeDialog(rowId) {
    const registration = ensureFtdPlayerRegistration();
    const row = registration.rows.find((item) => item.rowId === rowId);
    if (!row) return;
    if (row.status === "ftd-written" || row.status === "console-batch-pending") {
      showAlert("当前项目已锁定", row.status === "ftd-written" ? "该项目已经由 Console 重新读取验证成功。" : "该项目属于待确认的不可变 Console 批次，请先处理批次结果。");
      return;
    }
    const selected = row.selectedPlayer || {};
    const normalizedParts = normalizeWhitespace(row.normalizedName).split(" ");
    const defaultSurname = selected.surname || normalizedParts[0] || "";
    const defaultName = selected.name || normalizedParts.slice(1).join(" ") || "";
    const root = document.createElement("div");
    root.className = "dialog-form";
    root.innerHTML = `<p>仅裁判可在这里明确指定已有 Player、确认新人或排除。查询无结果不会自动变成新人。</p>
      <label class="field"><span class="field__label">处理方式</span><select data-ref-field="mode">
        <option value="manual">手动指定已有 Player</option>
        <option value="new">新人（裁判确认）</option>
        <option value="excluded">排除，不纳入 FTD</option>
      </select></label>
      <div class="dialog-form-grid">
        <label class="field"><span class="field__label">FTD 内部 Player ID（已有 Player 必填）</span><input data-ref-field="id" inputmode="numeric" value="${escapeHtml(selected.id == null ? "" : selected.id)}"></label>
        <label class="field"><span class="field__label">WOF ID（可选）</span><input data-ref-field="wof-id" inputmode="numeric" value="${escapeHtml(selected.wof_id == null ? "" : selected.wof_id)}"></label>
        <label class="field"><span class="field__label">Surname</span><input data-ref-field="surname" value="${escapeHtml(defaultSurname)}"></label>
        <label class="field"><span class="field__label">Name</span><input data-ref-field="name" value="${escapeHtml(defaultName)}"></label>
        <label class="field"><span class="field__label">Country code</span><input data-ref-field="country" value="${escapeHtml(selected.country_code || (row.newPlayer && row.newPlayer.country) || "CN")}"></label>
        <label class="field"><span class="field__label">Family</span><input data-ref-field="family" value="${escapeHtml(row.family || (row.newPlayer && row.newPlayer.family) || defaultSurname)}"></label>
        <label class="field"><span class="field__label">分类（逗号分隔，可空）</span><input data-ref-field="categories" value="${escapeHtml((row.categories || (row.newPlayer && row.newPlayer.categories) || []).join(", "))}"></label>
      </div>
      <div class="dialog-form__error" data-ref-error></div>`;
    showDialog({
      title: `处理 FTD Player：${row.rosterName}`,
      contentNode: root,
      buttons: [
        { label: "取消", className: "btn btn-outlined" },
        {
          label: "保存裁判决定",
          className: "btn btn-filled",
          onClick: () => {
            const get = (name) => normalizeWhitespace(root.querySelector(`[data-ref-field="${name}"]`).value);
            const mode = get("mode");
            const error = root.querySelector("[data-ref-error]");
            if (mode === "excluded") {
              updateFtdPlayerRegistrationRow(rowId, (next) => {
                next.status = "excluded";
                next.resolutionStatus = "";
                next.selectionRule = "referee-excluded";
                next.selectedPlayer = null;
                next.newPlayer = null;
                next.errorCode = "";
                next.errorMessage = "";
              });
              return;
            }
            const surname = get("surname");
            const name = get("name");
            const country = get("country").toUpperCase();
            const family = get("family");
            const categories = get("categories").split(/[,，]/).map(normalizeWhitespace).filter(Boolean);
            if (!surname || !name || !country || !family) {
              error.textContent = "Surname、Name、Country code 和 Family 均为必填。";
              return false;
            }
            if (mode === "manual") {
              const id = Number(get("id"));
              if (!Number.isFinite(id) || id <= 0) {
                error.textContent = "手动指定已有 Player 时必须填写有效的 FTD 内部 Player ID。";
                return false;
              }
              const wofIdRaw = get("wof-id");
              updateFtdPlayerRegistrationRow(rowId, (next) => {
                next.status = "referee-manual";
                next.resolutionStatus = "referee-manual";
                next.selectionRule = "referee-manual-player-id";
                next.selectedPlayer = { id, wof_id: wofIdRaw ? Number(wofIdRaw) : null, surname, name, rating: null, country_code: country };
                next.newPlayer = null;
                next.categories = categories;
                next.family = family;
                next.errorCode = "";
                next.errorMessage = "";
              });
              return;
            }
            updateFtdPlayerRegistrationRow(rowId, (next) => {
              next.status = "referee-new";
              next.resolutionStatus = "referee-new";
              next.selectionRule = "referee-confirmed-new";
              next.selectedPlayer = null;
              next.newPlayer = { surname, name, country, family, categories };
              next.categories = categories;
              next.family = family;
              next.errorCode = "";
              next.errorMessage = "";
            });
          },
        },
      ],
    });
  }

  async function copyFtdPlayerImportConsoleCode() {
    const before = deepClone(state.ftdPlayerRegistration);
    try {
      const prepared = FTD_PLAYER_REGISTRATION.prepareConsoleBatch(
        ensureFtdPlayerRegistration(),
        state.players,
        { sourceRevision: localSyncLastRevision },
      );
      state.ftdPlayerRegistration = prepared.registration;
      refreshCheckinUI();
      if (!prepared.reused) {
        localSaveDirty = true;
        const saved = await saveAndPushLocalSyncNow();
        if (!saved || saved.ok !== true) throw new Error("批次快照未能写入本地共享状态");
      }
      const code = FTD_PLAYER_REGISTRATION.buildConsoleCode(prepared.batch);
      const copied = await copyTextWithFallback(code, {
        successToast: `${prepared.reused ? "已重新复制" : "已复制"} ${prepared.batch.rows.length} 项 FTD Player 批量登记代码`,
      });
      if (copied) {
        showAlert(
          prepared.reused ? "待确认批次代码已重新复制" : "Console 批次已准备",
          `批次 ${prepared.batch.batchId} ${prepared.reused ? "保持不变并已重新复制" : "已保存，但尚未标记成功"}。\n\n请在目标 FTD /live/<tournamentId> 页面以 TD 账号执行剪贴板代码。代码会先核对已登记 Player，可安全重跑。Console 完成并把验证结果写回剪贴板后，返回本页按 Shift+Enter。`,
        );
      }
    } catch (error) {
      state.ftdPlayerRegistration = FTD_PLAYER_REGISTRATION.sanitizeRegistration(before);
      refreshCheckinUI();
      showAlert("无法生成批量登记代码", error && error.message ? error.message : String(error));
    }
  }

  async function applyFtdPlayerConsoleResultFromClipboard() {
    const registration = ensureFtdPlayerRegistration();
    if (!registration.pendingBatch || registration.pendingBatch.status !== "pending") return false;
    let raw;
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.readText !== "function") {
        throw new Error("当前浏览器不支持读取剪贴板");
      }
      raw = await navigator.clipboard.readText();
    } catch (error) {
      showAlert("无法读取 Console 结果", `剪贴板权限失败或不可用：${error && error.message ? error.message : error}`);
      return true;
    }
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (_) {
      showAlert("无法读取 Console 结果", "剪贴板内容不是有效 JSON；未修改任何项目。可点击“重新复制待确认批次”取回并重跑同一批代码。");
      return true;
    }
    const before = deepClone(state.ftdPlayerRegistration);
    try {
      const applied = FTD_PLAYER_REGISTRATION.applyConsoleResult(registration, parsed);
      state.ftdPlayerRegistration = applied.registration;
      localSaveDirty = true;
      refreshCheckinUI();
      const saved = await saveAndPushLocalSyncNow();
      if (!saved || saved.ok !== true) throw new Error("结果未能写入本地共享状态");
      showAlert(
        "FTD Player 结果已应用",
        `实际验证成功 ${applied.counts.success} 项；写入失败 ${applied.counts.failed} 项；未处理 ${applied.counts.unprocessed} 项。只有成功项显示“已写入 FTD”。`,
      );
    } catch (error) {
      state.ftdPlayerRegistration = FTD_PLAYER_REGISTRATION.sanitizeRegistration(before);
      refreshCheckinUI();
      showAlert("Console 结果未应用", `${error && error.message ? error.message : error}\n\n未修改任何项目。`);
    }
    return true;
  }

  function setFtdPlayerMapAccount(ftdName, account) {
    const mapping = sanitizeFtdPlayerAccountMapping(state.ftdPlayerAccountMapping);
    if (!mapping) return false;
    const key = normalizeKey(ftdName);
    const acc = normalizeOqAccountInput(account);
    if (alertInvalidOqAccount(acc)) return false;
    const editedAt = new Date().toISOString();
    mapping.players = (Array.isArray(mapping.players) ? mapping.players : []).map((row) => {
      if (normalizeKey(row.ftdName) !== key) return row;
      return {
        ...row,
        account: acc,
        oqCheck: null,
        source: "user",
        editAudit: { by: "user", action: "编辑账号", at: editedAt },
      };
    });
    state.ftdPlayerAccountMapping = rebuildFtdPlayerMapStats({
      ...mapping,
    }, editedAt);
    refreshCheckinUI();
    scheduleSave();
    return true;
  }

  function setFtdPlayerMapGroupNick(ftdName, groupNick) {
    const mapping = sanitizeFtdPlayerAccountMapping(state.ftdPlayerAccountMapping);
    if (!mapping) return false;
    const key = normalizeKey(ftdName);
    const nick = normalizeWhitespace(groupNick);
    const editedAt = new Date().toISOString();
    mapping.players = (Array.isArray(mapping.players) ? mapping.players : []).map((row) => {
      if (normalizeKey(row.ftdName) !== key) return row;
      const account = normalizeWhitespace(row.account);
      return {
        ...row,
        groupNick: nick,
        source: "user",
        editAudit: { by: "user", action: nick ? "选择群昵称" : "清除群昵称", at: editedAt },
      };
    });
    state.ftdPlayerAccountMapping = rebuildFtdPlayerMapStats({
      ...mapping,
    }, editedAt);
    refreshCheckinUI();
    scheduleSave();
    return true;
  }

  function setFtdPlayerMapDeleted(ftdName, deleted) {
    const mapping = sanitizeFtdPlayerAccountMapping(state.ftdPlayerAccountMapping);
    if (!mapping) return false;
    const key = normalizeKey(ftdName);
    const editedAt = new Date().toISOString();
    mapping.players = (Array.isArray(mapping.players) ? mapping.players : []).map((row) => {
      if (normalizeKey(row.ftdName) !== key) return row;
      return {
        ...row,
        deleted: Boolean(deleted),
        editAudit: { by: "user", action: deleted ? "删除映射" : "恢复映射", at: editedAt },
      };
    });
    state.ftdPlayerAccountMapping = rebuildFtdPlayerMapStats({
      ...mapping,
    }, editedAt);
    refreshCheckinUI();
    scheduleSave();
    return true;
  }

  function forceFtdPlayerMapOqValidation(ftdName) {
    const mapping = sanitizeFtdPlayerAccountMapping(state.ftdPlayerAccountMapping);
    if (!mapping) return false;
    const key = normalizeKey(ftdName);
    const editedAt = new Date().toISOString();
    const players = Array.isArray(mapping.players) ? mapping.players : [];
    const targetRow = players.find((row) => normalizeKey(row.ftdName) === key && isInvalidOqFtdPlayerMapRow(row));
    if (!targetRow) return false;
    const acc = normalizeOqAccountInput(targetRow.account);
    if (alertInvalidOqAccount(acc)) return false;
    let changed = false;
    mapping.players = players.map((row) => {
      if (normalizeKey(row.ftdName) !== key || !isInvalidOqFtdPlayerMapRow(row)) return row;
      changed = true;
      const previous = row.oqCheck && typeof row.oqCheck === "object" ? row.oqCheck : {};
      return {
        ...row,
        account: acc,
        oqCheck: {
          ...previous,
          account: acc,
          status: "forced-ok",
          checkedAt: String(previous.checkedAt || editedAt),
          forcedAt: editedAt,
          forcedBy: "user",
          error: "",
        },
        source: "user",
        editAudit: { by: "user", action: "强制通过OQ校验", at: editedAt },
      };
    });
    if (!changed) return false;
    state.ftdPlayerAccountMapping = rebuildFtdPlayerMapStats({
      ...mapping,
    }, editedAt);
    refreshCheckinUI();
    scheduleSave();
    return true;
  }

  function ftdPlayerTableName(player) {
    const item = player && typeof player === "object" ? player : {};
    return normalizeWhitespace(
      item.name ||
        item.displayName ||
        item.playerName ||
        item.fullName ||
        [item.surname, item.givenName].filter(Boolean).join(" ") ||
        [item.surname, item.name].filter(Boolean).join(" ") ||
        [item.lastName, item.firstName].filter(Boolean).join(" ") ||
        [item.last_name, item.first_name].filter(Boolean).join(" ") ||
        item.nick ||
        item.username ||
        "",
    );
  }

  function buildFtdPlayerMappingFromPlayerTable(playerTable, meta = {}) {
    const payload = playerTable && typeof playerTable === "object" ? playerTable : null;
    const rawPlayers = payload && Array.isArray(payload.players) ? payload.players : [];
    if (!rawPlayers.length) return null;

    const previous = sanitizeFtdPlayerAccountMapping(state.ftdPlayerAccountMapping);
    const previousIndex = previous && previous.accountIndex ? previous.accountIndex : {};
    const mappedAt = new Date().toISOString();
    const rows = [];

    rawPlayers.forEach((rawPlayer, index) => {
      const item = rawPlayer && typeof rawPlayer === "object" ? rawPlayer : {};
      const ftdName = ftdPlayerTableName(item);
      if (!ftdName || normalizeKey(ftdName) === "bye") return;
      const key = normalizeKey(ftdName);
      const existing = previousIndex[key] || {};
      const previousRow = previous && Array.isArray(previous.players)
        ? previous.players.find((row) => normalizeKey(row.ftdName) === key)
        : null;
      const account = normalizeWhitespace(existing.account || item.account || "");
      const groupNick = normalizeWhitespace(existing.groupNick || (previousRow && previousRow.groupNick) || "");
      const existingAudit = existing.editAudit && typeof existing.editAudit === "object"
        ? sanitizeEditAudit(existing.editAudit)
        : null;
      const row = {
        index: index + 1,
        ftdId: item.id == null ? "" : item.id,
        ftdName,
        surname: normalizeWhitespace(item.surname || ""),
        givenName: normalizeWhitespace(item.givenName || item.name || ""),
        ftdNick: normalizeWhitespace(item.nick || ""),
        ftdUsername: normalizeWhitespace(item.username || ""),
        account,
        groupNick,
        source: account ? normalizeWhitespace(existing.source || "user") : "frontend-player-table-import",
        editAudit: existingAudit || {
          by: account ? "user" : "agent",
          action: account ? "保留已有映射" : "导入player表",
          at: mappedAt,
        },
      };
      rows.push(row);
    });

    if (!rows.length) return null;
    return rebuildFtdPlayerMapStats({
      ok: true,
      type: "ftd-player-oq-account-map",
      version: 1,
      scope: "ftd-player-table",
      source: "frontend import ftd-player-table",
      mappedAt,
      sourceFile: normalizeWhitespace(meta.name || ""),
      ftdExportedAt: String(payload.exportedAt || ""),
      ftdPageUrl: normalizeWhitespace(payload.pageUrl || ""),
      target: payload.target && typeof payload.target === "object" ? payload.target : {},
      players: rows,
    }, mappedAt);
  }

  function markFtdPlayerMappingImportedByUser(mapping, importedAt) {
    const safe = sanitizeFtdPlayerAccountMapping(mapping);
    if (!safe) return null;
    const at = importedAt || new Date().toISOString();
    const rows = (Array.isArray(safe.players) ? safe.players : []).map((row) => {
      return {
        ...row,
        source: normalizeWhitespace(row.source || "user-import"),
        editAudit: {
          by: "user",
          action: "导入映射 JSON",
          at,
        },
      };
    });
    return rebuildFtdPlayerMapStats({
      ...safe,
      players: rows,
    }, at);
  }

  function importFtdPlayerMapFromJSONText(rawText, meta = {}) {
    const snapshot = captureUndoSnapshot();
    try {
      const text = String(rawText || "")
        .replace(/^\uFEFF/, "")
        .trim();
      if (!text) {
        showAlert("导入失败", "内容为空：请选择有效的映射 JSON。");
        return false;
      }
      const parsed = JSON.parse(text);
      const sourceType = normalizeWhitespace(parsed && parsed.type);
      const normalized =
        sourceType === "ftd-player-table"
          ? buildFtdPlayerMappingFromPlayerTable(parsed, meta)
          : parsed;
      const mapping = sanitizeFtdPlayerAccountMapping(normalized);
      if (!mapping || !Array.isArray(mapping.players) || mapping.players.length === 0) {
        showAlert("导入失败", "JSON 中没有有效的 FTD Player 表或 FTD Player/OQ 映射表。");
        return false;
      }
      const importedAt = new Date().toISOString();
      state.ftdPlayerAccountMapping = markFtdPlayerMappingImportedByUser({
        ...mapping,
        sourceFile: normalizeWhitespace(meta.name || mapping.sourceFile || ""),
      }, importedAt);
      state.ui.checkinView = "mapping";
      viewStepOverride = null;
      refreshCheckinUI();
      scheduleSave();
      showUndoSnackbar(
        `已导入映射 JSON：${mapping.players.length} 人`,
        () => {
          restoreUndoSnapshot(snapshot);
          showSnackbar("已撤销映射 JSON 导入", 2200);
        },
        6500,
      );
      return true;
    } catch (error) {
      console.error("导入映射 JSON 失败：", error);
      showAlert("导入失败", "无法解析映射 JSON。请确认文件完整、没有被截断。");
      return false;
    }
  }

  function importFtdPlayerMapFromJSONFile(file) {
    if (!file) return;
    const maxBytes = 5 * 1024 * 1024;
    if (Number(file.size) > maxBytes) {
      showAlert("导入失败", "JSON 文件过大（超过 5MB），请确认选择的是 FTD Player 表或映射表 JSON。");
      if (ftdPlayerMapJsonInput) ftdPlayerMapJsonInput.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => {
      showAlert("导入失败", "读取映射 JSON 文件失败，请检查文件是否损坏。");
      if (ftdPlayerMapJsonInput) ftdPlayerMapJsonInput.value = "";
    };
    reader.onload = () => {
      importFtdPlayerMapFromJSONText(reader.result || "", {
        source: "file",
        name: file.name || "",
      });
      if (ftdPlayerMapJsonInput) ftdPlayerMapJsonInput.value = "";
    };
    reader.readAsText(file, "utf-8");
  }

  function clearFtdPlayerMapState() {
    if (!sanitizeFtdPlayerAccountMapping(state.ftdPlayerAccountMapping)) {
      showSnackbar("当前没有映射表可清除", 1800);
      return;
    }
    const snapshot = captureUndoSnapshot();
    state.ftdPlayerAccountMapping = {
      type: "ftd-player-oq-account-map-clear",
      scope: "ftd-player-table",
      cleared: true,
      clearedAt: new Date().toISOString(),
      updatedAt: now(),
      editAudit: editAudit("清除映射表", "user"),
    };
    state.ui.checkinView = "mapping";
    refreshCheckinUI();
    scheduleSave();
    showUndoSnackbar(
      "已清除映射表",
      () => {
        restoreUndoSnapshot(snapshot);
        showSnackbar("已撤销清除映射表", 2200);
      },
      6500,
    );
  }

  function canonicalFtdRosterName(value) {
    return normalizeWhitespace(value)
      .toLowerCase()
      .replace(/[^\p{Script=Han}a-z0-9]+/gu, " ")
      .trim();
  }

  function compactFtdRosterName(value) {
    return canonicalFtdRosterName(value).replace(/\s+/g, "");
  }

  function reversedFtdRosterName(value) {
    const parts = canonicalFtdRosterName(value).split(/\s+/).filter(Boolean);
    if (parts.length < 2) return "";
    return parts.slice().reverse().join(" ");
  }

  function ftdRosterNameMatchScore(ftdName, playerName) {
    const ftd = canonicalFtdRosterName(ftdName);
    const player = canonicalFtdRosterName(playerName);
    if (!ftd || !player) return 0;
    if (ftd === player) return 1;
    if (compactFtdRosterName(ftd) === compactFtdRosterName(player)) return 0.98;
    const reversed = reversedFtdRosterName(ftd);
    if (reversed && reversed === player) return 0.96;
    const ftdCompact = compactFtdRosterName(ftd);
    const playerCompact = compactFtdRosterName(player);
    if (ftdCompact && playerCompact && (ftdCompact.endsWith(playerCompact) || playerCompact.endsWith(ftdCompact))) {
      return Math.min(ftdCompact.length, playerCompact.length) >= 4 ? 0.92 : 0.82;
    }
    return diceSimilarity(normalizeForSimilarity(ftd), normalizeForSimilarity(player));
  }

  function findBestRosterPlayerForFtdName(ftdName, usedIds) {
    let best = null;
    for (const player of Array.isArray(state.players) ? state.players : []) {
      if (!player || usedIds.has(player.id)) continue;
      const score = ftdRosterNameMatchScore(ftdName, player.displayName);
      if (!best || score > best.score) best = { player, score };
    }
    if (!best || best.score < 0.9) return null;
    return best;
  }

  function applyFtdPlayerMapToRoster() {
    const mapping = sanitizeFtdPlayerAccountMapping(state.ftdPlayerAccountMapping);
    if (!mapping || !Array.isArray(mapping.players) || mapping.players.length === 0) {
      showAlert("无法刷写", "当前没有可用的 FTD Player/OQ 映射表。");
      return;
    }
    if (!Array.isArray(state.players) || state.players.length === 0) {
      showAlert("无法刷写", "当前签到表没有选手名单。");
      return;
    }

    const rows = mapping.players.filter(
      (row) =>
        row &&
        !isDeletedFtdPlayerMapRow(row) &&
        normalizeWhitespace(row.ftdName),
    );
    if (!rows.length) {
      showAlert("无法刷写", "映射表里没有有效行。");
      return;
    }

    const snapshot = captureUndoSnapshot();
    const usedIds = new Set();
    const updates = new Map();
    const ambiguous = [];
    const unmatched = [];

    for (const row of rows) {
      const match = findBestRosterPlayerForFtdName(row.ftdName, usedIds);
      if (!match) {
        unmatched.push(row.ftdName);
        continue;
      }
      const conflict = Array.from(updates.values()).find(
        (item) => normalizeKey(item.ftdName) === normalizeKey(row.ftdName),
      );
      if (conflict) {
        ambiguous.push(row.ftdName);
        continue;
      }
      usedIds.add(match.player.id);
      updates.set(match.player.id, {
        ftdName: normalizeWhitespace(row.ftdName),
        account: normalizeWhitespace(row.account),
        score: match.score,
      });
    }

    if (!updates.size) {
      showAlert(
        "没有刷写",
        `未找到足够可靠的签到表匹配项。未匹配：${unmatched.slice(0, 12).join("、") || "无"}`,
      );
      return;
    }

    const editedAt = editAudit("映射表刷写", "user");
    state.players = state.players.map((player) => {
      const update = updates.get(player.id);
      if (!update) return player;
      return {
        ...player,
        displayName: update.ftdName,
        account: update.account,
        platform: normalizeWhitespace(player.platform || "oq") || "oq",
        editAudit: { ...editedAt },
      };
    });
    state.players.sort(comparePlayersForList);
    refreshCheckinUI();
    scheduleSave();

    const skipped = unmatched.length + ambiguous.length;
    showUndoSnackbar(
      `已刷写签到名单 ${updates.size} 人${skipped ? `，跳过 ${skipped} 人` : ""}`,
      () => {
        restoreUndoSnapshot(snapshot);
        showSnackbar("已撤销映射表刷写", 2200);
      },
      7500,
    );
  }

  function renderScoreHelper() {
    if (!stepScoreHelper) return;
    const helper = ensureScoreHelper();
    const activeRound = getActiveScoreRound();
    if (scoreHelperTitle)
      scoreHelperTitle.textContent = state.competitionName || "比分登记辅助";
    syncScoreRoundCountInput(
      scoreRoundCountInput,
      helper.preliminaryRoundCount,
      typeof document !== "undefined" ? document.activeElement : null,
    );
    if (scoreRoundStartInput) {
      const nextStartValue = scoreRoundStartToInputValue(activeRound && activeRound.roundStartAt);
      if (scoreRoundStartInput.value !== nextStartValue) {
        scoreRoundStartInput.value = nextStartValue;
      }
    }
    if (scoreFtdUrlInput && scoreFtdUrlInput.value !== (state.ui.ftdUrl || "")) {
      scoreFtdUrlInput.value = state.ui.ftdUrl || "";
    }
    if (scoreOqPollSecondsInput) {
      const nextOqPollSeconds = String(Math.max(5, Math.trunc(Number((state.ui && state.ui.oqPollSeconds) || 60) || 60)));
      if (scoreOqPollSecondsInput.value !== nextOqPollSeconds) {
        scoreOqPollSecondsInput.value = nextOqPollSeconds;
      }
    }
    updateOqScorePollButton();
    updateClearScoreFtdSearchButton();

    if (scoreRoundTabs) {
      scoreRoundTabs.innerHTML = helper.rounds
        .map((round) => {
          const pending = round.pending.length;
          const manualPending = Array.isArray(round.manualPending)
            ? round.manualPending.length
            : 0;
          const completed = round.completed.length;
          const ftdStats = scoreRoundFtdStats(round);
          const active = round.round === helper.activeRound;
          const label = ftdStats.total
            ? `${ftdStats.ready}/${ftdStats.completed}/${ftdStats.active}`
            : `${pending}+${manualPending}/${pending + manualPending + completed}`;
          return `<button class="seg-btn" type="button" role="tab" aria-selected="${active ? "true" : "false"}" data-round="${round.round}">${escapeHtml(scoreStageLabel(round))} <span>${label}</span></button>`;
        })
        .join("");
    }

    if (scoreHelperSummary) {
      scoreHelperSummary.textContent = "";
      scoreHelperSummary.hidden = true;
    }

    if (scoreFtdPairings) {
      scoreFtdPairings.innerHTML = renderFtdPairings(activeRound);
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
    if (!completeTopFtdReadyItem() && !completeFirstCleanScoreItem("pending")) {
      showSnackbar("当前轮没有待登记项", 1800);
    }
  }

  function ftdScoreText(item) {
    const blackScore = Number(item && item.blackScore);
    const whiteScore = Number(item && item.whiteScore);
    if (!Number.isFinite(blackScore) || !Number.isFinite(whiteScore)) return "";
    return `${item.black} ${Math.trunc(blackScore)} - ${Math.trunc(whiteScore)} ${item.white}`;
  }

  function ftdBatchItemKey(item) {
    return [
      Number(item && item.table) || 0,
      normalizeKey(item && item.black),
      normalizeKey(item && item.white),
      Number.isFinite(Number(item && item.blackScore))
        ? Math.trunc(Number(item.blackScore))
        : "",
      Number.isFinite(Number(item && item.whiteScore))
        ? Math.trunc(Number(item.whiteScore))
        : "",
    ].join("\n");
  }

  function ftdBatchTargetRounds(items, fallbackRound) {
    return Array.from(
      new Set(
        (Array.isArray(items) ? items : []).map((item) =>
          Number.isFinite(Number(item && item.ftdRound))
            ? Math.trunc(Number(item.ftdRound))
            : Math.trunc(Number(fallbackRound) || 1),
        ),
      ),
    ).sort((a, b) => a - b);
  }

  function getReadyFtdScoreBatch() {
    const helper = ensureScoreHelper();
    const round = getActiveScoreRound();
    const roundNumber =
      Number.isFinite(Number(round && round.round)) && Number(round.round) > 0
        ? Math.trunc(Number(round.round))
        : Math.trunc(Number(helper.activeRound) || 1);
    const pairings = Array.isArray(round && round.ftdPairings)
      ? round.ftdPairings
      : [];
    const items = pairings
      .filter((item) => {
        if (!item || item.status !== "ready" || isFtdByePairing(item)) return false;
        const blackScore = Number(item.blackScore);
        const whiteScore = Number(item.whiteScore);
        return (
          Number.isFinite(blackScore) &&
          Number.isFinite(whiteScore) &&
          Math.trunc(blackScore) + Math.trunc(whiteScore) === 64
        );
      })
      .map((item) => ({
        table: Math.trunc(Number(item.table) || 0),
        ftdStage: normalizeFtdStage(item.ftdStage),
        ftdRound: Number.isFinite(Number(item.ftdRound)) ? Math.trunc(Number(item.ftdRound)) : roundNumber,
        ftdTable: Number.isFinite(Number(item.ftdTable)) ? Math.trunc(Number(item.ftdTable)) : Math.trunc(Number(item.table) || 0),
        black: normalizeWhitespace(item.black),
        white: normalizeWhitespace(item.white),
        blackScore: Math.trunc(Number(item.blackScore)),
        whiteScore: Math.trunc(Number(item.whiteScore)),
      }))
      .sort((a, b) => Number(a.table) - Number(b.table));
    const allPairings = pairings
      .filter((item) => item && Number.isFinite(Number(item.table)))
      .map((item) => ({
        table: Math.trunc(Number(item.table)),
        ftdStage: normalizeFtdStage(item.ftdStage),
        ftdRound: Number.isFinite(Number(item.ftdRound)) ? Math.trunc(Number(item.ftdRound)) : roundNumber,
        ftdTable: Number.isFinite(Number(item.ftdTable)) ? Math.trunc(Number(item.ftdTable)) : Math.trunc(Number(item.table)),
        black: normalizeWhitespace(item.black),
        white: normalizeWhitespace(item.white),
        blackScore: Number.isFinite(Number(item.blackScore))
          ? Math.trunc(Number(item.blackScore))
          : null,
        whiteScore: Number.isFinite(Number(item.whiteScore))
          ? Math.trunc(Number(item.whiteScore))
          : null,
        resultKind: normalizeWhitespace(item.resultKind),
      }))
      .sort((a, b) => Number(a.table) - Number(b.table));
    return { round: roundNumber, items, pairings: allPairings };
  }

  function getFtdTournamentIdFromUrl() {
    const raw = normalizeWhitespace(
      (scoreFtdUrlInput && scoreFtdUrlInput.value) ||
        (state.ui && state.ui.ftdUrl) ||
        "",
    );
    const match = raw.match(/\/live\/(\d+)/i) || raw.match(/\b(\d{2,})\b/);
    return match ? match[1] : "";
  }

  function buildFtdScoreConsoleCode(batch) {
    const tournamentId = getFtdTournamentIdFromUrl();
    if (!tournamentId) throw new Error("缺少 FTD live 链接，无法取得 tournamentId");
    return `(async () => {
  const tournamentId = ${JSON.stringify(tournamentId)};
  const round = ${JSON.stringify(batch.round)};
  const results = ${JSON.stringify(batch.items, null, 2)};

  function norm(v) {
    return String(v || "").replace(/\\s+/g, " ").trim().toLowerCase();
  }
  function lastToken(v) {
    const parts = norm(v).split(" ").filter(Boolean);
    return parts[parts.length - 1] || "";
  }
  function nameMatches(ftdName, localName) {
    const a = norm(ftdName);
    const b = norm(localName);
    return a === b || a.endsWith(" " + b) || b.endsWith(" " + a) || lastToken(a) === lastToken(b);
  }
  function playerName(p) {
    return p?.name || p?.playerName || p?.fullName ||
      [p?.firstName, p?.lastName].filter(Boolean).join(" ") ||
      [p?.first_name, p?.last_name].filter(Boolean).join(" ") ||
      p?.username || "";
  }
  function findSocket() {
    function isSocket(x) {
      return x && typeof x.emit === "function" && typeof x.on === "function" && typeof x.off === "function";
    }
    const root = document.getElementById("root");
    const key = root && Object.keys(root).find(k => k.startsWith("__reactContainer$"));
    const start = key ? root[key] : null;
    const seen = new WeakSet();
    function scan(obj, depth = 0) {
      if (!obj || typeof obj !== "object" || seen.has(obj) || depth > 6) return null;
      seen.add(obj);
      if (isSocket(obj)) return obj;
      if (isSocket(obj.socket)) return obj.socket;
      if (isSocket(obj.value?.socket)) return obj.value.socket;
      for (const k of Object.keys(obj)) {
        if (k === "return" || k === "alternate" || k === "stateNode") continue;
        const found = scan(obj[k], depth + 1);
        if (found) return found;
      }
      return null;
    }
    function walk(fiber) {
      let f = fiber;
      while (f) {
        const found = scan(f.memoizedProps) || scan(f.pendingProps) || scan(f.memoizedState);
        if (found) return found;
        if (f.child) {
          const childFound = walk(f.child);
          if (childFound) return childFound;
        }
        f = f.sibling;
      }
      return null;
    }
    return walk(start);
  }

  const socket = findSocket();
  if (!socket) throw new Error("未找到 FTD socket，请确认页面已加载且已登录");

  const data = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("otb-get-round", handler);
      reject(new Error("读取轮次超时"));
    }, 8000);
    function handler(payload) {
      clearTimeout(timer);
      socket.off("otb-get-round", handler);
      resolve(payload);
    }
    socket.on("otb-get-round", handler);
    socket.emit("get-otb-rounds", tournamentId, round);
  });

  const byTable = new Map(
    (data.pairing || []).filter(Array.isArray).map((pair, i) => [
      Number(pair[0]?.gameNumber ?? i) + 1,
      pair,
    ])
  );

  for (const r of results) {
    const pair = byTable.get(Number(r.table));
    if (!pair) throw new Error(\`找不到第 \${r.table} 台\`);
    const ftdBlack = playerName(pair[0]);
    const ftdWhite = playerName(pair[1]);
    if (norm(ftdBlack) === "bye" || norm(ftdWhite) === "bye") {
      console.log(\`skip BYE table \${r.table}\`);
      continue;
    }
    if (!nameMatches(ftdBlack, r.black) || !nameMatches(ftdWhite, r.white)) {
      throw new Error(\`第 \${r.table} 台姓名不一致：FTD=\${ftdBlack} vs \${ftdWhite}\`);
    }
    socket.emit("score-otb", tournamentId, pair[0].gameId, r.blackScore);
    console.log(\`table \${r.table}: \${ftdBlack} \${r.blackScore}-\${64 - r.blackScore} \${ftdWhite}\`);
    await new Promise(res => setTimeout(res, 300));
  }

  console.log(\`done: wrote \${results.length} ready result(s)\`);
})();`;
  }

  async function buildFtdScoreConsoleCodeFromTemplate(batch, options = {}) {
    const tournamentId = getFtdTournamentIdFromUrl();
    if (!tournamentId) throw new Error("缺少 FTD live 链接，无法取得 tournamentId");
    const stamp = Date.now();
    const [response, rendererResponse] = await Promise.all([
      fetch(`./ftd-score-console.js?t=${stamp}`, { method: "GET", cache: "no-store" }),
      fetch(`./chrome-ftd-bridge/ftd-score-png-renderer.js?t=${stamp}`, { method: "GET", cache: "no-store" }),
    ]);
    let code = await response.text();
    const rendererSource = await rendererResponse.text();
    if (!response.ok || !code.trim()) throw new Error(`HTTP ${response.status}`);
    if (!rendererResponse.ok || !rendererSource.trim()) throw new Error(`PNG renderer HTTP ${rendererResponse.status}`);
    if (/127\.0\.0\.1|localhost|\/api\//i.test(code + rendererSource)) {
      throw new Error("登分脚本包含本地 API 访问，已拒绝复制");
    }
    return code
      .replace("__FTD_SCORE_PNG_RENDERER_SOURCE__", rendererSource)
      .replace("__FTD_SCORE_TOURNAMENT_ID__", JSON.stringify(tournamentId))
      .replace("__FTD_SCORE_ROUND__", JSON.stringify(batch.round))
      .replace("__FTD_SCORE_RESULTS__", JSON.stringify(batch.items, null, 2))
      .replace("__FTD_SCORE_PAIRINGS_ASSIGN__", `LOCAL_PAIRINGS = ${JSON.stringify(batch.pairings || [])};`)
      .replace("__FTD_SCORE_DOWNLOAD_PNG__", options.downloadPng ? "true" : "false");
  }

  function confirmFtdScorePngDownload() {
    return Promise.resolve(window.confirm("FTD 登分代码执行后是否下载最新比分 PNG？"));
  }

  async function copyFtdScoreConsoleCode() {
    try {
      const batch = getReadyFtdScoreBatch();
      if (!batch.items.length) {
        showSnackbar("当前轮没有可写入 FTD 的 ready 项", 2200);
        return;
      }
      const downloadPng = await confirmFtdScorePngDownload();
      const code = await buildFtdScoreConsoleCodeFromTemplate(batch, { downloadPng });
      const copiedBatch = {
        round: batch.round,
        copiedAt: now(),
        items: batch.items.map((item) => ({ ...item, key: ftdBatchItemKey(item) })),
      };
      const targetRounds = ftdBatchTargetRounds(batch.items, batch.round);
      const scoreLabel = targetRounds.length > 1
        ? `决赛阶段同步登分（FTD ${targetRounds.join("/")}）`
        : `FTD 第 ${targetRounds[0] || batch.round} 轮登分`;
      await copyTextWithFallback(code, {
        successToast: `已复制${scoreLabel}代码：${batch.items.length} 项 ready`,
      });
      lastCopiedFtdScoreBatch = copiedBatch;
      lastCopiedFtdConsoleAction = { kind: "score", ...copiedBatch };
    } catch (error) {
      const detail =
        error && error.message ? String(error.message) : String(error || "");
      showAlert("复制失败", `无法生成 FTD 登分代码。\n\n${detail}`);
    }
  }

  async function prepareCurrentRoundFtdTranscriptPacket(round, tournamentId) {
    if (!LOCAL_SYNC_ENABLED) throw new Error("棋谱准备功能需要本地同步服务器");
    const syncResult = await saveAndPushLocalSyncNow();
    if (!syncResult || syncResult.ok !== true) throw new Error("本地共享状态同步失败");
    const response = await fetch(LOCAL_SYNC_FTD_TRANSCRIPT_PREPARE_URL, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ round, tournamentId }),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result || result.ok !== true) {
      throw new Error((result && (result.detail || result.error)) || `HTTP ${response.status}`);
    }
    return result;
  }

  async function buildFtdTranscriptConsoleCodeFromTemplate(packet) {
    const tournamentId = getFtdTournamentIdFromUrl();
    if (!tournamentId) throw new Error("缺少 FTD live 链接，无法取得 tournamentId");
    const response = await fetch(
      `./ftd-transcript-console.js?v=${encodeURIComponent(APP_VERSION)}&t=${Date.now()}`,
      {
      method: "GET",
      cache: "no-store",
      },
    );
    let code = await response.text();
    if (!response.ok || !code.trim()) throw new Error(`HTTP ${response.status}`);
    if (/127\.0\.0\.1|localhost|\/api\//i.test(code)) {
      throw new Error("棋谱脚本包含本地 API 访问，已拒绝复制");
    }
    return code
      .replace("__FTD_TRANSCRIPT_TOURNAMENT_ID__", JSON.stringify(tournamentId))
      .replace("__FTD_TRANSCRIPT_ROUND__", JSON.stringify(packet.round))
      .replace("__FTD_TRANSCRIPT_GAMES__", JSON.stringify(packet.games, null, 2));
  }

  function formatFtdTranscriptNoEligibleMessage(roundNumber, skipped) {
    const items = Array.isArray(skipped) ? skipped : [];
    const counts = items.reduce((result, item) => {
      const code = normalizeWhitespace(item && item.code) || "other";
      result[code] = (result[code] || 0) + 1;
      return result;
    }, {});
    const details = [];
    if (counts["already-imported"]) details.push(`棋谱已导入 ${counts["already-imported"]} 局`);
    if (counts.bye) details.push(`BYE ${counts.bye} 项`);
    if (counts.absence) details.push(`缺席 ${counts.absence} 项`);
    if (counts["score-status"]) details.push(`比分状态不符合 ${counts["score-status"]} 局`);
    if (counts["missing-oq-game-id"]) details.push(`缺少 OQ game ID ${counts["missing-oq-game-id"]} 局`);
    if (counts["unsupported-start-position"]) details.push(`非标准起始局面 ${counts["unsupported-start-position"]} 局`);
    if (counts["oq-detail-fetch-failed"]) details.push(`OQ 明细获取失败 ${counts["oq-detail-fetch-failed"]} 局`);
    if (counts["invalid-position-moves"] || counts["no-coordinate-moves"] || counts["invalid-transcript"]) {
      details.push(
        `无有效坐标棋谱 ${(counts["invalid-position-moves"] || 0) + (counts["no-coordinate-moves"] || 0) + (counts["invalid-transcript"] || 0)} 局`,
      );
    }
    return [
      `第 ${roundNumber} 轮没有可复制的棋谱导入代码。`,
      details.length ? `跳过原因：${details.join("；")}。` : `共跳过 ${items.length} 项。`,
      "本次未修改剪贴板。剪贴板中可能仍是上一次的 FTD 登分代码或其他旧代码，请勿继续粘贴执行。",
    ].join("\n\n");
  }

  async function copyFtdTranscriptConsoleCode() {
    const originalText = btnCopyFtdTranscriptConsole && btnCopyFtdTranscriptConsole.textContent;
    try {
      const helper = ensureScoreHelper();
      const round = getActiveScoreRound();
      const roundNumber = Math.trunc(Number(round && round.round) || Number(helper.activeRound) || 1);
      const tournamentId = getFtdTournamentIdFromUrl();
      if (!tournamentId) throw new Error("请先填写匹配的 FTD /live/{id} 链接");
      if (btnCopyFtdTranscriptConsole) {
        btnCopyFtdTranscriptConsole.disabled = true;
        btnCopyFtdTranscriptConsole.textContent = "正在准备棋谱…";
      }
      const packet = await prepareCurrentRoundFtdTranscriptPacket(roundNumber, tournamentId);
      const games = Array.isArray(packet.games) ? packet.games : [];
      const skipped = Array.isArray(packet.skipped) ? packet.skipped : [];
      if (!games.length) {
        lastCopiedFtdConsoleAction = null;
        showAlert(
          "没有可导入棋谱",
          formatFtdTranscriptNoEligibleMessage(roundNumber, skipped),
        );
        return;
      }
      const ftdStages = Array.from(
        new Set(games.map((game) => normalizeFtdStage(game && game.ftdStage)).filter(Boolean)),
      );
      const consolePacket = {
        ...packet,
        round: roundNumber,
        games,
      };
      const code = await buildFtdTranscriptConsoleCodeFromTemplate(consolePacket);
      const targetRounds = ftdBatchTargetRounds(games, roundNumber);
      const transcriptLabel = ftdStages.length > 1
        ? `决赛与 3/4 决赛（FTD ${targetRounds.join("/")}）`
        : normalizeFtdStage(games[0] && games[0].ftdStage) || scoreStageLabel(round);
      await copyTextWithFallback(code, {
        successToast: `已复制${transcriptLabel}同步棋谱导入代码，共 ${games.length} 局。请在 FTD Console 执行，全部回读成功后返回并按 Shift+Enter 确认。${skipped.length ? ` 跳过 ${skipped.length} 局。` : ""}`,
      });
      lastCopiedFtdConsoleAction = {
        kind: "transcript",
        round: roundNumber,
        copiedAt: now(),
        items: games.map((game) => ({
          table: Math.trunc(Number(game.table) || 0),
          black: normalizeWhitespace(game.ftdBlack),
          white: normalizeWhitespace(game.ftdWhite),
          oqGameId: normalizeWhitespace(game.oqGameId),
        })),
      };
    } catch (error) {
      lastCopiedFtdConsoleAction = null;
      const detail = error && error.message ? String(error.message) : String(error || "");
      showAlert(
        "复制失败",
        `无法准备 FTD 棋谱导入代码。\n\n${detail}\n\n本次未修改剪贴板；请勿执行剪贴板中可能残留的旧代码。`,
      );
    } finally {
      if (btnCopyFtdTranscriptConsole) {
        btnCopyFtdTranscriptConsole.disabled = false;
        btnCopyFtdTranscriptConsole.textContent = originalText || "复制本轮棋谱导入代码";
      }
    }
  }

  async function fetchLatestLocalSyncStateForAction() {
    if (!LOCAL_SYNC_ENABLED) return state;
    const response = await fetch(`${LOCAL_SYNC_STATE_URL}?t=${Date.now()}`, {
      method: "GET",
      cache: "no-store",
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result || result.ok !== true) {
      throw new Error(
        (result && (result.detail || result.error)) || `HTTP ${response.status}`,
      );
    }
    const revisionValue = Number(result.revision);
    if (Number.isFinite(revisionValue)) localSyncLastRevision = revisionValue;
    return result.state || state;
  }

  function firstReadyFtdIndex(round) {
    const ready = orderedFtdPairingsForDisplay(round)
      .filter(({ item }) => item.status === "ready" && !isFtdByePairing(item));
    return ready.length ? ready[0].index : -1;
  }

  function completeFtdPairing(index) {
    const helper = ensureScoreHelper();
    const round = getActiveScoreRound();
    const pairings = Array.isArray(round && round.ftdPairings)
      ? round.ftdPairings
      : [];
    const idx = Math.trunc(Number(index));
    if (!Number.isFinite(idx) || idx < 0 || idx >= pairings.length) return false;
    const item = pairings[idx];
    if (isFtdByePairing(item)) return false;
    if (hasUserPendingForFtdPairing(round, item)) {
      showSnackbar("该桌处于 pending，请先取消 pending", 2200);
      return false;
    }
    if (item.status === "dirty") {
      showSnackbar("该桌仍是旧脏数据状态，请先删除结果或取消 pending", 2200);
      return false;
    }
    const snapshot = captureUndoSnapshot();
    const editedAt = now();
    item.status = "completed";
    item.completedAt = editedAt;
    item.updatedAt = editedAt;
    markFtdPairingEdited(item, "user", editedAt);
    markFtdPairingUserEditedFields(item, ["status", "completedAt"], editedAt);
    helper.updatedAt = now();
    renderScoreHelper();
    saveScoreUserEditNow();
    showUndoSnackbar(`已完成登记：第 ${item.table} 台`, () => {
      restoreUndoSnapshot(snapshot);
      showSnackbar("已撤销完成", 1800);
    });
    return true;
  }

  function completeTopFtdReadyItem() {
    const round = getActiveScoreRound();
    const index = firstReadyFtdIndex(round);
    return index >= 0 ? completeFtdPairing(index) : false;
  }

  function completeLastCopiedFtdScoreBatch(batchOverride = null) {
    const batch = batchOverride || lastCopiedFtdScoreBatch;
    if (!batch || !Array.isArray(batch.items) || !batch.items.length) {
      showSnackbar("还没有复制过 FTD 登分代码", 2200);
      return false;
    }
    const helper = ensureScoreHelper();
    const round = getActiveScoreRound();
    const roundNumber =
      Number.isFinite(Number(round && round.round)) && Number(round.round) > 0
        ? Math.trunc(Number(round.round))
        : Math.trunc(Number(helper.activeRound) || 1);
    if (roundNumber !== Number(batch.round)) {
      showSnackbar("最近复制的 FTD 登分代码不属于当前轮", 2600);
      return false;
    }
    const pairings = Array.isArray(round && round.ftdPairings)
      ? round.ftdPairings
      : [];
    const targetKeys = new Set(batch.items.map((item) => item.key || ftdBatchItemKey(item)));
    const snapshot = captureUndoSnapshot();
    const editedAt = now();
    let count = 0;
    for (const item of pairings) {
      if (!item || item.status !== "ready" || isFtdByePairing(item)) continue;
      if (!targetKeys.has(ftdBatchItemKey(item))) continue;
      item.status = "completed";
      item.completedAt = editedAt;
      item.updatedAt = editedAt;
      markFtdPairingEdited(item, "user", editedAt);
      markFtdPairingUserEditedFields(item, ["status", "completedAt"], editedAt);
      count += 1;
    }
    if (!count) {
      showSnackbar("最近复制的 ready 项已经不存在或已变化", 2600);
      return false;
    }
    helper.updatedAt = now();
    renderScoreHelper();
    saveScoreUserEditNow();
    showUndoSnackbar(`已批量完成最近复制的 FTD 登分项：${count} 项`, () => {
      restoreUndoSnapshot(snapshot);
      showSnackbar("已撤销批量完成", 1800);
    });
    return true;
  }

  async function confirmLastCopiedFtdTranscriptBatch(action) {
    if (!action || !Array.isArray(action.items) || !action.items.length) {
      showSnackbar("还没有复制过 FTD 棋谱导入代码", 2200);
      return false;
    }
    // Consume before the asynchronous refresh so repeated Shift+Enter cannot
    // confirm the same referee acknowledgement twice.
    if (lastCopiedFtdConsoleAction === action) lastCopiedFtdConsoleAction = null;
    try {
      await fetchLatestLocalSyncStateForAction();
      const helper = ensureScoreHelper();
      const round = getActiveScoreRound();
      const roundNumber = Math.trunc(Number(round && round.round) || Number(helper.activeRound) || 1);
      if (roundNumber !== Number(action.round)) {
        showSnackbar("最近复制的 FTD 棋谱代码不属于当前轮", 2600);
        return false;
      }
      const confirmedAt = now();
      const previousHelperUpdatedAt = helper.updatedAt;
      const previousImports = (round.ftdPairings || []).map((pairing) => (
        pairing && pairing.ftdTranscriptImport
          ? { ...pairing.ftdTranscriptImport }
          : null
      ));
      const result = FTD_TRANSCRIPT.confirmTranscriptBatchOnRound(round, action, confirmedAt);
      if (!result.count) {
        showSnackbar("复制批次中的配对或 OQ game ID 已变化，未标记棋谱", 3000);
        return false;
      }
      helper.updatedAt = confirmedAt;
      renderScoreHelper();
      localSaveDirty = true;
      state.savedAt = confirmedAt;
      lastLocalEditAt = confirmedAt;
      const syncResult = await saveAndPushLocalSyncNow();
      if (!syncResult || syncResult.ok !== true) {
        (round.ftdPairings || []).forEach((pairing, index) => {
          if (!pairing) return;
          if (previousImports[index]) pairing.ftdTranscriptImport = previousImports[index];
          else delete pairing.ftdTranscriptImport;
        });
        helper.updatedAt = previousHelperUpdatedAt;
        state.savedAt = now();
        renderScoreHelper();
        saveStateToLocalOnly();
        throw new Error("本地共享状态写入失败，已撤回本次棋谱标记");
      }
      showSnackbar(
        `已标记第 ${action.round} 轮 ${result.count} 局棋谱已导入${result.skipped ? `；跳过 ${result.skipped} 局已变化配对` : ""}`,
        3200,
      );
      return true;
    } catch (error) {
      const detail = error && error.message ? String(error.message) : String(error || "");
      showAlert("确认失败", `无法保存棋谱导入确认。\n\n${detail}`);
      return false;
    }
  }

  function confirmLastCopiedFtdConsoleAction() {
    const action = lastCopiedFtdConsoleAction;
    if (!action) {
      showSnackbar("还没有可确认的 FTD Console 批次", 2200);
      return false;
    }
    if (action.kind === "score") return completeLastCopiedFtdScoreBatch(action);
    if (action.kind === "transcript") {
      void confirmLastCopiedFtdTranscriptBatch(action);
      return true;
    }
    showSnackbar("最近的 FTD Console 批次类型无法识别", 2200);
    return false;
  }

  function deleteFtdResult(index) {
    const helper = ensureScoreHelper();
    const round = getActiveScoreRound();
    const pairings = Array.isArray(round && round.ftdPairings)
      ? round.ftdPairings
      : [];
    const idx = Math.trunc(Number(index));
    if (!Number.isFinite(idx) || idx < 0 || idx >= pairings.length) return;
    const snapshot = captureUndoSnapshot();
    const item = pairings[idx];
    if (isFtdByePairing(item)) return;
    const editedAt = now();
    item.status = "imported";
    item.reporter = "";
    item.opponent = "";
    item.blackScore = null;
    item.whiteScore = null;
    item.resultText = "";
    item.reason = "";
    item.imagePath = "";
    item.sourceMessageKey = "";
    item.resultKind = "";
    item.dirty = false;
    item.dirtySource = "";
    item.dirtyAt = null;
    item.completedAt = null;
    item.updatedAt = editedAt;
    markFtdPairingEdited(item, "user", editedAt);
    markFtdPairingUserEditedFields(
      item,
      [
        "status",
        "reporter",
        "opponent",
        "blackScore",
        "whiteScore",
        "resultText",
        "reason",
        "imagePath",
        "sourceMessageKey",
        "resultKind",
      ],
      editedAt,
    );
    helper.updatedAt = now();
    renderScoreHelper();
    saveScoreUserEditNow();
    showUndoSnackbar(`已删除结果：第 ${item.table} 台`, () => {
      restoreUndoSnapshot(snapshot);
      showSnackbar("已撤销删除", 1800);
    });
  }

  function ftdPairingTableKey(item) {
    return normalizeWhitespace(item && item.table);
  }

  function findUserPendingIndexForFtdPairing(round, item) {
    const table = ftdPairingTableKey(item);
    const pending = Array.isArray(round && round.pending) ? round.pending : [];
    if (!table) return -1;
    return pending.findIndex((entry) =>
      isUserPendingScoreItem(entry) &&
      normalizeWhitespace(entry.pendingTable || entry.table) === table
    );
  }

  function hasUserPendingForFtdPairing(round, item) {
    return findUserPendingIndexForFtdPairing(round, item) >= 0;
  }

  function findFtdPairingIndexByTable(round, table) {
    const tableKey = normalizeWhitespace(table);
    const pairings = Array.isArray(round && round.ftdPairings)
      ? round.ftdPairings
      : [];
    if (!tableKey) return -1;
    return pairings.findIndex((item) => normalizeWhitespace(item && item.table) === tableKey);
  }

  function showFtdPendingReasonDialog(item, onSubmit) {
    const content = document.createElement("div");
    content.className = "dialog-form";
    const label = document.createElement("label");
    label.className = "field";
    label.innerHTML = `
      <span>pending 原因</span>
      <textarea class="textarea" rows="4" placeholder="例如：截图账号不一致、疑似重赛、裁判手动核对中"></textarea>
    `;
    content.appendChild(label);
    const textarea = label.querySelector("textarea");
    showDialog({
      title: `第 ${item.table} 台 pending`,
      contentNode: content,
      buttons: [
        { label: "取消", className: "btn btn-outlined" },
        {
          label: "确认 pending",
          className: "btn btn-filled",
          onClick: () => {
            const reason = normalizeWhitespace(textarea && textarea.value);
            if (!reason) {
              showSnackbar("请填写 pending 原因", 1800);
              if (textarea && typeof textarea.focus === "function") textarea.focus();
              return false;
            }
            if (typeof onSubmit === "function") onSubmit(reason);
            return true;
          },
        },
      ],
    });
    window.setTimeout(() => {
      if (textarea && typeof textarea.focus === "function") textarea.focus();
    }, 0);
  }

  function makeUserPendingScoreItem(round, item, reason, editedAt) {
    const blackScore = Number.isFinite(Number(item.blackScore))
      ? Math.trunc(Number(item.blackScore))
      : null;
    const whiteScore = Number.isFinite(Number(item.whiteScore))
      ? Math.trunc(Number(item.whiteScore))
      : null;
    const originalScore =
      Number.isFinite(blackScore) && Number.isFinite(whiteScore)
        ? `${blackScore}:${whiteScore}`
        : "";
    return sanitizeScoreItem({
      id: `user-pending-ftd-${round.round}-${item.table}-${editedAt}`,
      round: round.round,
      sender: `第 ${item.table} 台 ${item.black} vs ${item.white}`,
      opponent: "",
      verdict: "user-pending",
      resultText: `用户pending：第 ${item.table} 台 ${item.black} vs ${item.white}`,
      reason,
      pendingKind: "user-pending",
      pendingTable: String(item.table || ""),
      table: String(item.table || ""),
      reviewAction: "裁判手动 pending；agent/OQ 自动更新不得覆盖该桌，除非裁判取消 pending。",
      accountMismatchText: "",
      sourceMessageKey: `user-pending-r${round.round}-t${item.table}`,
      confidence: "user",
      originalStatus: normalizeWhitespace(item.status || "imported"),
      originalBlack: normalizeWhitespace(item.black),
      originalWhite: normalizeWhitespace(item.white),
      originalBlackScore: blackScore,
      originalWhiteScore: whiteScore,
      originalScore,
      lastEditedBy: "user",
      lastEditedAt: editedAt,
    });
  }

  function clearFtdPairingToImportedForUserPending(item, editedAt) {
    item.status = "imported";
    item.reporter = "";
    item.opponent = "";
    item.blackScore = null;
    item.whiteScore = null;
    item.resultText = "";
    item.reason = "";
    item.imagePath = "";
    item.sourceMessageKey = "";
    item.resultKind = "";
    item.dirty = false;
    item.dirtySource = "";
    item.dirtyAt = null;
    item.completedAt = null;
    item.updatedAt = editedAt;
    markFtdPairingEdited(item, "user", editedAt);
    markFtdPairingUserEditedFields(
      item,
      [
        "status",
        "reporter",
        "opponent",
        "blackScore",
        "whiteScore",
        "resultText",
        "reason",
        "imagePath",
        "sourceMessageKey",
        "resultKind",
        "userPending",
      ],
      editedAt,
    );
  }

  function resetFtdResultToPending(index) {
    const helper = ensureScoreHelper();
    const round = getActiveScoreRound();
    const pairings = Array.isArray(round && round.ftdPairings)
      ? round.ftdPairings
      : [];
    const idx = Math.trunc(Number(index));
    if (!Number.isFinite(idx) || idx < 0 || idx >= pairings.length) return;
    const item = pairings[idx];
    if (isFtdByePairing(item)) return;
    showFtdPendingReasonDialog(item, (reason) => {
      const snapshot = captureUndoSnapshot();
      const editedAt = now();
      if (!Array.isArray(round.pending)) round.pending = [];
      const existingIndex = findUserPendingIndexForFtdPairing(round, item);
      if (existingIndex >= 0) round.pending.splice(existingIndex, 1);
      round.pending.unshift(makeUserPendingScoreItem(round, item, reason, editedAt));
      clearFtdPairingToImportedForUserPending(item, editedAt);
      helper.updatedAt = now();
      renderScoreHelper();
      saveScoreUserEditNow();
      showUndoSnackbar(`已设为 pending：第 ${item.table} 台`, () => {
        restoreUndoSnapshot(snapshot);
        showSnackbar("已撤销 pending", 1800);
      });
    });
  }

  function cancelFtdUserPending(index) {
    const helper = ensureScoreHelper();
    const round = getActiveScoreRound();
    const pairings = Array.isArray(round && round.ftdPairings)
      ? round.ftdPairings
      : [];
    const idx = Math.trunc(Number(index));
    if (!Number.isFinite(idx) || idx < 0 || idx >= pairings.length) return;
    const item = pairings[idx];
    const pendingIndex = findUserPendingIndexForFtdPairing(round, item);
    if (pendingIndex < 0) {
      showSnackbar("该桌没有用户 pending", 1800);
      return;
    }
    const snapshot = captureUndoSnapshot();
    round.pending.splice(pendingIndex, 1);
    const editedAt = now();
    if (item && typeof item === "object") {
      item.status = "imported";
      item.dirty = false;
      item.dirtySource = "";
      item.dirtyAt = null;
      item.updatedAt = editedAt;
      markFtdPairingEdited(item, "user", editedAt);
      markFtdPairingUserEditedFields(item, ["userPending"], editedAt);
    }
    helper.updatedAt = now();
    renderScoreHelper();
    saveScoreUserEditNow();
    showUndoSnackbar(`已取消 pending：第 ${item.table} 台`, () => {
      restoreUndoSnapshot(snapshot);
      showSnackbar("已撤销取消 pending", 1800);
    });
  }

  function setFtdPairingScore(index, side, rawValue, options = {}) {
    const helper = ensureScoreHelper();
    const round = getActiveScoreRound();
    const pairings = Array.isArray(round && round.ftdPairings)
      ? round.ftdPairings
      : [];
    const idx = Math.trunc(Number(index));
    if (!Number.isFinite(idx) || idx < 0 || idx >= pairings.length) return false;
    const item = pairings[idx];
    if (isFtdByePairing(item)) {
      renderScoreHelper();
      return false;
    }
    if (hasUserPendingForFtdPairing(round, item)) {
      showSnackbar("该桌处于 pending，请先取消 pending", 2200);
      renderScoreHelper();
      return false;
    }
    const score = Math.trunc(Number(rawValue));
    if (!Number.isFinite(score) || score < 0 || score > 64) {
      showSnackbar("比分必须在 0-64 之间", 2200);
      renderScoreHelper();
      return false;
    }
    if (side === "black") {
      item.blackScore = score;
      item.whiteScore = 64 - score;
    } else if (side === "white") {
      item.whiteScore = score;
      item.blackScore = 64 - score;
    } else {
      return false;
    }
    const editedAt = now();
    item.status = "ready";
    item.dirty = false;
    item.dirtySource = "";
    item.dirtyAt = null;
    item.reporter = options.reporter || item.reporter || "";
    item.opponent = options.opponent || item.opponent || "";
    item.resultText = "";
    item.reason = options.reason || "手动输入";
    item.resultKind = options.resultKind || "";
    item.resultTime = normalizeWhitespace(options.resultTime || item.resultTime || localResultTimeFromMs(editedAt));
    item.resultSortKey = scoreResultSortKey(item.resultTime) || editedAt;
    item.updatedAt = editedAt;
    item.completedAt = null;
    markFtdPairingEdited(item, options.editor || "user", editedAt);
    if ((options.editor || "user") !== "agent") {
      markFtdPairingUserEditedFields(
        item,
        [
          "status",
          "reporter",
          "opponent",
          "blackScore",
          "whiteScore",
          "resultText",
          "reason",
          "resultKind",
        ],
        editedAt,
      );
    }
    helper.updatedAt = now();
    renderScoreHelper();
    saveScoreUserEditNow();
    return true;
  }

  function markFtdAbsence(index, absentSide) {
    const helper = ensureScoreHelper();
    const round = getActiveScoreRound();
    const pairings = Array.isArray(round && round.ftdPairings)
      ? round.ftdPairings
      : [];
    const idx = Math.trunc(Number(index));
    if (!Number.isFinite(idx) || idx < 0 || idx >= pairings.length) return;
    const item = pairings[idx];
    if (isFtdByePairing(item)) return;
    const absentName = absentSide === "black" ? item.black : item.white;
    const presentName = absentSide === "black" ? item.white : item.black;
    const snapshot = captureUndoSnapshot();
    setFtdPairingScore(index, absentSide, 0, {
      reporter: presentName,
      opponent: absentName,
      reason: `${absentName} 缺席`,
      resultKind: "absence",
    });
    showUndoSnackbar(`已标记缺席：第 ${item.table} 台 ${absentName}`, () => {
      restoreUndoSnapshot(snapshot);
      showSnackbar("已撤销缺席", 1800);
    });
  }

  function handleFtdPairingAction(e) {
    const target = isElement(e.target) ? e.target : null;
    const btn = target && target.closest("button[data-ftd-action]");
    if (!btn) return;
    const action = btn.dataset.ftdAction || "";
    const index = Number(btn.dataset.ftdIndex);
    if (action === "complete") completeFtdPairing(index);
    else if (action === "pending") resetFtdResultToPending(index);
    else if (action === "cancel-pending") cancelFtdUserPending(index);
    else if (action === "absence") markFtdAbsence(index, btn.dataset.ftdSide || "");
    else if (action === "delete-result") deleteFtdResult(index);
  }

  function handleFtdScoreInput(e) {
    const target = isElement(e.target) ? e.target : null;
    const input = target && target.closest("input[data-ftd-score-side]");
    if (!input) return;
    const side = input.dataset.ftdScoreSide || "";
    const index = Number(input.dataset.ftdIndex);
    setFtdPairingScore(index, side, input.value, {
      reason: "手动输入",
    });
  }

  function scoreItemBucket(round, mode) {
    if (!round) return null;
    if (mode === "pending") return round.pending;
    if (mode === "manualPending") return round.manualPending;
    if (mode === "completed") return round.completed;
    return null;
  }

  function firstCleanScoreItemIndex(mode) {
    const round = getActiveScoreRound();
    const source = scoreItemBucket(round, mode);
    if (!Array.isArray(source)) return -1;
    return source.findIndex((item) => {
      if (item && item.dirty === true) return false;
      if (item && normalizeWhitespace(item.pendingKind).startsWith("agent-")) {
        return false;
      }
      return true;
    });
  }

  function completeFirstCleanScoreItem(mode) {
    const index = firstCleanScoreItemIndex(mode);
    return index >= 0 ? completeScoreItem(mode, index) : false;
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
    if (item && item.dirty === true && !isUserPendingScoreItem(item)) {
      source.splice(idx, 0, item);
      showSnackbar("旧脏数据已保留在队列中", 2200);
      return false;
    }
    const editedAt = now();
    item.registeredAt = editedAt;
    item.manualPendingAt = null;
    item.lastEditedBy = "user";
    item.lastEditedAt = editedAt;
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

  function resolvePendingScoreItem(index) {
    const helper = ensureScoreHelper();
    const round = getActiveScoreRound();
    const source = scoreItemBucket(round, "pending");
    const idx = Math.trunc(Number(index));
    if (!Array.isArray(source) || !Number.isFinite(idx) || idx < 0 || idx >= source.length) {
      showSnackbar("没有找到该 pending 项", 1800);
      return;
    }
    const snapshot = captureUndoSnapshot();
    const item = source[idx];
    item.resolvedByReferee = true;
    const editedAt = now();
    item.resolvedAt = editedAt;
    item.resolvedNote = "referee clicked resolved in frontend";
    item.lastEditedBy = "user";
    item.lastEditedAt = editedAt;
    helper.updatedAt = now();
    renderScoreHelper();
    scheduleSave();
    showUndoSnackbar(`已标记解决：${scoreItemSummary(item)}`, () => {
      restoreUndoSnapshot(snapshot);
      showSnackbar("已撤销解决标记", 1800);
    });
  }

  async function applyOqPendingCandidate(index, candidateIndex) {
    const helper = ensureScoreHelper();
    const round = getActiveScoreRound();
    const source = scoreItemBucket(round, "pending");
    const idx = Math.trunc(Number(index));
    const candIdx = Math.trunc(Number(candidateIndex));
    if (!Array.isArray(source) || !Number.isFinite(idx) || idx < 0 || idx >= source.length) {
      showSnackbar("没有找到该 OQ pending 项", 1800);
      return;
    }
    const item = source[idx];
    const candidates = scorePendingCandidates(item);
    if (!Number.isFinite(candIdx) || candIdx < 0 || candIdx >= candidates.length) {
      showSnackbar("没有找到该 OQ 候选对局", 1800);
      return;
    }
    const candidate = candidates[candIdx];
    if (!scoreCandidateCanApply(candidate)) {
      showSnackbar("该候选还没有可应用比分", 2200);
      return;
    }
    const table = normalizeWhitespace(
      (item.oqPendingDetail && item.oqPendingDetail.table) ||
        item.pendingTable ||
        item.table,
    );
    const pairingIndex = findFtdPairingIndexByTable(round, table);
    const pairings = Array.isArray(round && round.ftdPairings) ? round.ftdPairings : [];
    if (pairingIndex < 0 || !pairings[pairingIndex]) {
      showSnackbar("没有找到对应 FTD 台次", 2200);
      return;
    }
    const pairing = pairings[pairingIndex];
    if (isFtdByePairing(pairing)) {
      showSnackbar("BYE 台不能应用 OQ 候选", 2200);
      return;
    }
    if (hasUserPendingForFtdPairing(round, pairing) && !isUserPendingScoreItem(item)) {
      showSnackbar("该桌有用户 pending，请先取消用户 pending", 2200);
      return;
    }
    const blackScore = Math.trunc(Number(candidate.blackScore));
    const whiteScore = Math.trunc(Number(candidate.whiteScore));
    const editedAt = now();
    const resultTime = normalizeWhitespace(candidate.resultTime || candidate.createdLocal || candidate.createdAt || localResultTimeFromMs(editedAt));
    const sourceKey = `oq-auto:${normalizeWhitespace(candidate.candidateKey || candidate.gameId || `${round.round}-${table}-${candIdx}`)}`;
    const audit = {
      by: "user-applied-oq-pending",
      at: localResultTimeFromMs(editedAt),
      candidate: { ...candidate },
      game: { gameId: normalizeWhitespace(candidate.gameId || candidate.candidateKey) },
      ftdBlackAccount: normalizeWhitespace(candidate.ftdBlackAccount),
      ftdWhiteAccount: normalizeWhitespace(candidate.ftdWhiteAccount),
    };
    const competing = source.filter((entry, entryIndex) => {
      const sameTable = normalizeWhitespace(entry && (entry.pendingTable || entry.table)) === table;
      const oqPending = normalizeWhitespace(entry && entry.pendingKind).startsWith("oq-auto-");
      return (sameTable && oqPending) || (entryIndex === idx && !isUserPendingScoreItem(entry));
    });
    if (!pairing.entityId || competing.some((entry) => !entry.entityId)) {
      showSnackbar("同步实体身份尚未载入，请重新连接本地服务后再应用", 3000);
      return;
    }
    try {
      const response = await fetch(LOCAL_SYNC_COMMAND_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          commandId: `${LOCAL_SYNC_CLIENT_ID}-oq-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          type: "oq.resolveCandidate",
          actor: "user",
          target: { kind: "scoreRow", id: pairing.entityId },
          expectedRevision: pairing.entityRevision,
          preconditions: competing.map((entry) => ({
            target: { kind: "pending", id: entry.entityId },
            expectedRevision: entry.entityRevision,
          })),
          payload: {
            blackScore,
            whiteScore,
            sourceKey,
            resultTime,
            resultSortKey: scoreResultSortKey(resultTime) || editedAt,
            editedAt,
            audit,
          },
        }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result || result.ok !== true) {
        throw new Error((result && (result.error || result.detail)) || `HTTP ${response.status}`);
      }
      STATE_SYNC.applyChangedEntities(localSyncBaseState, result.changedEntities || []);
      STATE_SYNC.applyChangedEntities(state, result.changedEntities || []);
      localSyncLastRevision = Number(result.revision) || localSyncLastRevision;
      if (getActiveScoreRound() && getActiveScoreRound().entityId === round.entityId) renderScoreHelper();
      showSnackbar(`已应用 OQ 候选：第 ${table} 台 ${blackScore}-${whiteScore}`, 2600);
    } catch (error) {
      showAlert("OQ 候选应用失败", `${error && error.message ? error.message : error}\n\n当前草稿和裁判选择没有被覆盖，请刷新该行后重试。`);
    }
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
    const editedAt = now();
    item.registeredAt = null;
    item.manualPendingAt = editedAt;
    item.lastEditedBy = "user";
    item.lastEditedAt = editedAt;
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
    const editedAt = now();
    item.manualPendingAt = null;
    item.lastEditedBy = "user";
    item.lastEditedAt = editedAt;
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
    else if (action === "resolve-pending") resolvePendingScoreItem(index);
    else if (action === "apply-oq-candidate") void applyOqPendingCandidate(index, btn.dataset.candidateIndex);
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

  function drawRoundRectPath(ctx, x, y, width, height, radius) {
    const r = Math.max(0, Math.min(Number(radius) || 0, width / 2, height / 2));
    if (typeof ctx.roundRect === "function") {
      ctx.roundRect(x, y, width, height, r);
      return;
    }
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
  }

  function fillRoundRect(ctx, x, y, width, height, radius) {
    ctx.beginPath();
    drawRoundRectPath(ctx, x, y, width, height, radius);
    ctx.fill();
  }

  function strokeRoundRect(ctx, x, y, width, height, radius) {
    ctx.beginPath();
    drawRoundRectPath(ctx, x, y, width, height, radius);
    ctx.stroke();
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

  function buildFtdPlayerMapCanvasFromData(rows, options) {
    const opts = options || {};
    const safeIOS = Boolean(opts.safeIOS);
    const mappingRows = Array.isArray(rows) ? rows : [];
    const title = `${state.competitionName || "比赛签到表"} OQ映射表`;
    const mapped = mappingRows.filter((row) => normalizeWhitespace(row.account)).length;

    const width = safeIOS ? 1000 : 1280;
    const marginX = safeIOS ? 28 : 40;
    const marginY = safeIOS ? 24 : 30;
    const titleH = safeIOS ? 44 : 48;
    const statsH = safeIOS ? 28 : 28;
    const headerH = safeIOS ? 40 : 44;
    const rowH = safeIOS ? 38 : 42;
    const noteH = safeIOS ? 56 : 34;
    const bottomPad = safeIOS ? 22 : 26;
    const maxCanvasHeight = safeIOS ? 3600 : 32760;
    const tableY = marginY + titleH + statsH + 14;
    const reserved = headerH + bottomPad + noteH;
    const maxRows = Math.max(
      1,
      Math.floor((maxCanvasHeight - tableY - reserved) / rowH),
    );
    const visibleRows = mappingRows.slice(0, maxRows);
    const truncated = mappingRows.length > visibleRows.length;
    const noteRows = truncated ? 1 : 0;
    const height =
      tableY +
      headerH +
      visibleRows.length * rowH +
      noteRows * noteH +
      bottomPad;

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = Math.max(height, 240);

    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法获取 Canvas 2D 上下文");

    const fontFamily =
      '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif';

    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#1F2937";
    ctx.font = `${safeIOS ? "700 28px" : "700 30px"} ${fontFamily}`;
    ctx.fillText(title, width / 2, marginY + 20);

    ctx.textAlign = "left";
    ctx.fillStyle = "#4B5563";
    ctx.font = `${safeIOS ? "500 17px" : "500 18px"} ${fontFamily}`;
    ctx.fillText(
      `总人数：${mappingRows.length}  |  已登记：${mapped}  |  待登记：${mappingRows.length - mapped}`,
      marginX,
      marginY + titleH,
    );

    const tableX = marginX;
    const tableW = width - marginX * 2;
    const colIndexW = 88;
    const colAccountW = safeIOS ? 360 : 440;
    const colNameW = tableW - colIndexW - colAccountW;

    ctx.fillStyle = "#F3F4F6";
    ctx.fillRect(tableX, tableY, tableW, headerH);

    ctx.fillStyle = "#111827";
    ctx.font = `${safeIOS ? "700 17px" : "700 18px"} ${fontFamily}`;
    ctx.textAlign = "center";
    ctx.fillText("#", tableX + colIndexW / 2, tableY + headerH / 2);
    ctx.textAlign = "left";
    ctx.fillText("选手", tableX + colIndexW + 12, tableY + headerH / 2);
    ctx.fillText(
      "OQ账号",
      tableX + colIndexW + colNameW + 12,
      tableY + headerH / 2,
    );

    ctx.font = `${safeIOS ? "500 16px" : "500 17px"} ${fontFamily}`;
    for (let i = 0; i < visibleRows.length; i++) {
      const row = visibleRows[i];
      const y = tableY + headerH + i * rowH;
      ctx.fillStyle = i % 2 === 0 ? "#FFFFFF" : "#FAFAFA";
      ctx.fillRect(tableX, y, tableW, rowH);

      ctx.strokeStyle = "#E5E7EB";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(tableX, y + rowH);
      ctx.lineTo(tableX + tableW, y + rowH);
      ctx.stroke();

      const name = fitTextToWidth(ctx, row.ftdName || "", colNameW - 24);
      const account = fitTextToWidth(
        ctx,
        normalizeWhitespace(row.account) || "【裁判未登记】",
        colAccountW - 24,
      );

      ctx.fillStyle = "#111827";
      ctx.textAlign = "center";
      ctx.fillText(String(i + 1), tableX + colIndexW / 2, y + rowH / 2);
      ctx.textAlign = "left";
      ctx.fillText(name, tableX + colIndexW + 12, y + rowH / 2);
      ctx.fillStyle = normalizeWhitespace(row.account) ? "#111827" : "#B45309";
      ctx.fillText(
        account,
        tableX + colIndexW + colNameW + 12,
        y + rowH / 2,
      );
    }

    const rowsHeight = headerH + visibleRows.length * rowH;
    ctx.strokeStyle = "#D1D5DB";
    ctx.lineWidth = 1;
    ctx.strokeRect(tableX + 0.5, tableY + 0.5, tableW - 1, rowsHeight - 1);

    if (truncated) {
      const noteY = tableY + rowsHeight + Math.floor(noteH / 2);
      ctx.textAlign = "left";
      ctx.fillStyle = "#B45309";
      ctx.font = `${safeIOS ? "600 15px" : "600 16px"} ${fontFamily}`;
      const note = safeIOS
        ? `iOS 兼容模式：PNG 仅导出前 ${visibleRows.length} 人。`
        : `名单较长，PNG 仅导出前 ${visibleRows.length} 人。`;
      ctx.fillText(fitTextToWidth(ctx, note, tableW), tableX, noteY);
    }

    return canvas;
  }

  function getEgaTopPlayers() {
    const analysis = state && state.egaAnalysis && typeof state.egaAnalysis === "object"
      ? sanitizeEgaAnalysis(state.egaAnalysis)
      : sanitizeEgaAnalysis(null);
    return Array.isArray(analysis.topPlayers) ? analysis.topPlayers.slice(0, 10) : [];
  }

  function getEgaAnalysisPlayers() {
    const analysis = state && state.egaAnalysis && typeof state.egaAnalysis === "object"
      ? sanitizeEgaAnalysis(state.egaAnalysis)
      : sanitizeEgaAnalysis(null);
    return Array.isArray(analysis.topPlayers) ? analysis.topPlayers.slice() : [];
  }

  function egaPlayerAverageGameLoss(player) {
    const direct = Number(player && player.averageGameLoss);
    if (Number.isFinite(direct)) return direct;
    const games = Array.isArray(player && player.games) ? player.games : [];
    const values = games
      .filter((game) => game && game.offlineFilled !== true && Number(game.nodeCount) > 0)
      .map((game) => Number(game.totalLoss))
      .filter((value) => Number.isFinite(value) && value >= 0);
    if (!values.length) return Number.POSITIVE_INFINITY;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  function getEgaTopPlayersForReport() {
    return getEgaAnalysisPlayers()
      .sort((a, b) => {
        const avgA = egaPlayerAverageGameLoss(a);
        const avgB = egaPlayerAverageGameLoss(b);
        if (avgA !== avgB) return avgA - avgB;
        const moveA = Number(a && a.averageLoss);
        const moveB = Number(b && b.averageLoss);
        if (Number.isFinite(moveA) && Number.isFinite(moveB) && moveA !== moveB) {
          return moveA - moveB;
        }
        return egaPlayerLabel(a).localeCompare(egaPlayerLabel(b), "zh-Hans-CN");
      })
      .slice(0, 10);
  }

  function egaPlayerLabel(player) {
    const name = normalizeWhitespace(player && player.name) || "未命名选手";
    const account = normalizeWhitespace(player && player.account);
    return account ? `${name} (${account})` : name;
  }

  function buildEgaCurveReportCanvas(options) {
    const opts = options || {};
    const safeIOS = Boolean(opts.safeIOS);
    const players = getEgaTopPlayersForReport();
    if (!players.length) throw new Error("没有可导出的 Egaroucid 子损分析摘要");

    const width = safeIOS ? 1200 : 1500;
    const marginX = safeIOS ? 48 : 64;
    const marginTop = safeIOS ? 36 : 42;
    const panelGap = safeIOS ? 20 : 24;
    const panelRows = Math.ceil(players.length / 3);
    const panelW = width - marginX * 2;
    const panelH = safeIOS ? 236 : 256;
    const height = marginTop + 86 + panelRows * panelH + Math.max(0, panelRows - 1) * panelGap + 42;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法获取 Canvas 2D 上下文");
    const fontFamily = '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif';
    const palette = ["#0F766E", "#2563EB", "#B45309", "#7C3AED", "#DC2626", "#0891B2", "#4D7C0F", "#C026D3", "#EA580C", "#475569"];

    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#111827";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.font = `${safeIOS ? "700 30px" : "700 34px"} ${fontFamily}`;
    ctx.fillText(`${state.competitionName || "比赛"} 场均子损前10名表现报告`, marginX, 36);
    ctx.fillStyle = "#4B5563";
    ctx.font = `${safeIOS ? "500 16px" : "500 17px"} ${fontFamily}`;
    ctx.fillText("按场均子损从小到大排序 · 每张小图最多 3 人 · ply 1-60 按两手一组统计平均子损", marginX, 72);

    const values = [];
    players.forEach((player) => {
      for (let group = 1; group <= 30; group += 1) {
        const item = player.plyGroups && player.plyGroups[String(group)];
        const value = item && Number.isFinite(Number(item.averageLoss)) ? Number(item.averageLoss) : null;
        if (value !== null) values.push(value);
      }
    });
    const maxY = Math.max(1, Math.ceil((Math.max(...values, 1) + 1) / 5) * 5);

    for (let panelIndex = 0; panelIndex < panelRows; panelIndex += 1) {
      const panelPlayers = players.slice(panelIndex * 3, panelIndex * 3 + 3);
      const panelX = marginX;
      const panelY = marginTop + 94 + panelIndex * (panelH + panelGap);
      ctx.fillStyle = "#F8FAFC";
      fillRoundRect(ctx, panelX, panelY, panelW, panelH, 8);
      ctx.strokeStyle = "#E5E7EB";
      ctx.lineWidth = 1;
      strokeRoundRect(ctx, panelX + 0.5, panelY + 0.5, panelW - 1, panelH - 1, 8);

      const plotX = panelX + (safeIOS ? 54 : 64);
      const plotY = panelY + 36;
      const legendW = safeIOS ? 282 : 330;
      const plotW = panelW - (plotX - panelX) - legendW - 28;
      const plotH = panelH - 74;
      const yScale = (value) => plotY + plotH - (Math.max(0, Math.min(maxY, value)) / maxY) * plotH;
      const xScale = (group) => plotX + ((group - 1) / 29) * plotW;

      ctx.fillStyle = "#111827";
      ctx.font = `${safeIOS ? "700 16px" : "700 18px"} ${fontFamily}`;
      ctx.textAlign = "left";
      ctx.fillText(`第 ${panelIndex * 3 + 1}-${panelIndex * 3 + panelPlayers.length} 名`, panelX + 20, panelY + 20);

      ctx.strokeStyle = "#D1D5DB";
      ctx.lineWidth = 1;
      ctx.strokeRect(plotX + 0.5, plotY + 0.5, plotW, plotH);
      ctx.font = `${safeIOS ? "500 12px" : "500 13px"} ${fontFamily}`;
      ctx.fillStyle = "#6B7280";
      ctx.textAlign = "right";
      for (let tick = 0; tick <= 4; tick += 1) {
        const value = (maxY / 4) * tick;
        const y = yScale(value);
        ctx.strokeStyle = tick === 0 ? "#9CA3AF" : "#E5E7EB";
        ctx.beginPath();
        ctx.moveTo(plotX, y);
        ctx.lineTo(plotX + plotW, y);
        ctx.stroke();
        ctx.fillText(String(Math.round(value)), plotX - 8, y);
      }
      ctx.textAlign = "center";
      for (let group = 1; group <= 30; group += 5) {
        const x = xScale(group);
        ctx.fillText(String(group * 2 - 1), x, plotY + plotH + 18);
      }
      ctx.fillStyle = "#374151";
      ctx.fillText("ply", plotX + plotW + 24, plotY + plotH + 18);

      panelPlayers.forEach((player, localIdx) => {
        const idx = panelIndex * 3 + localIdx;
        const points = [];
        for (let group = 1; group <= 30; group += 1) {
          const item = player.plyGroups && player.plyGroups[String(group)];
          const value = item && Number.isFinite(Number(item.averageLoss)) ? Number(item.averageLoss) : null;
          if (value !== null) points.push({ x: xScale(group), y: yScale(value), value });
        }
        if (points.length < 2) return;
        ctx.strokeStyle = palette[idx % palette.length];
        ctx.lineWidth = 3;
        ctx.beginPath();
        points.forEach((point, pointIdx) => {
          if (pointIdx === 0) ctx.moveTo(point.x, point.y);
          else {
            const prev = points[pointIdx - 1];
            const midX = (prev.x + point.x) / 2;
            ctx.bezierCurveTo(midX, prev.y, midX, point.y, point.x, point.y);
          }
        });
        ctx.stroke();
      });

      const legendX = plotX + plotW + 26;
      let legendY = plotY + 10;
      ctx.textAlign = "left";
      panelPlayers.forEach((player, localIdx) => {
        const idx = panelIndex * 3 + localIdx;
        ctx.fillStyle = palette[idx % palette.length];
        fillRoundRect(ctx, legendX, legendY - 8, 18, 18, 4);
        ctx.fillStyle = "#111827";
        ctx.font = `${safeIOS ? "700 13px" : "700 14px"} ${fontFamily}`;
        ctx.fillText(fitTextToWidth(ctx, egaPlayerLabel(player), legendW - 34), legendX + 28, legendY);
        ctx.fillStyle = "#6B7280";
        ctx.font = `${safeIOS ? "500 12px" : "500 13px"} ${fontFamily}`;
        const gameAvg = Number.isFinite(Number(player.averageGameLoss))
          ? Number(player.averageGameLoss).toFixed(1)
          : "N/A";
        const moveAvg = Number.isFinite(Number(player.averageLoss))
          ? Number(player.averageLoss).toFixed(2)
          : "N/A";
        ctx.fillText(`场均 ${gameAvg} · 手均 ${moveAvg}`, legendX + 28, legendY + 18);
        legendY += 54;
      });
    }
    return canvas;
  }

  function buildEgaRoundGridReportCanvas(options) {
    const opts = options || {};
    const safeIOS = Boolean(opts.safeIOS);
    const players = getEgaTopPlayersForReport();
    if (!players.length) throw new Error("没有可导出的 Egaroucid 子损分析摘要");
    const roundLimit = Math.max(
      1,
      ...players.flatMap((player) =>
        Array.isArray(player.games) ? player.games.map((game) => Number(game.round) || 0) : [0],
      ),
    );
    const width = safeIOS ? 1180 : 1500;
    const rowH = safeIOS ? 78 : 86;
    const headerY = safeIOS ? 150 : 158;
    const firstRowY = headerY + 54;
    const height = firstRowY + Math.max(0, players.length - 1) * rowH + 84;
    const marginX = safeIOS ? 44 : 58;
    const nameW = safeIOS ? 300 : 370;
    const valueW = safeIOS ? 118 : 140;
    const barX = marginX + nameW;
    const barW = width - marginX * 2 - nameW - valueW;
    const barH = safeIOS ? 34 : 38;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法获取 Canvas 2D 上下文");
    const fontFamily = '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif';
    const roundColors = ["#14B8A6", "#22D3EE", "#2563EB", "#7C3AED", "#F97316", "#DC2626", "#84CC16", "#C026D3", "#0F766E"];

    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#111827";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.font = `${safeIOS ? "700 30px" : "700 34px"} ${fontFamily}`;
    ctx.fillText(`${state.competitionName || "比赛"} 场均子损前10名表现报告`, marginX, 38);
    ctx.fillStyle = "#4B5563";
    ctx.font = `${safeIOS ? "500 16px" : "500 17px"} ${fontFamily}`;
    ctx.fillText("按场均子损从小到大排序 · X轴为总子损 · 条内每段为对应轮次单局子损", marginX, 76);

    const playerBars = players.map((player) => {
      const games = (Array.isArray(player.games) ? player.games : [])
        .map((game) => {
          const round = Math.trunc(Number(game && game.round) || 0);
          const value = Number(game && game.totalLoss);
          const hasReal =
            round > 0 &&
            Number.isFinite(value) &&
            value >= 0 &&
            Number(game && game.nodeCount) > 0 &&
            game.offlineFilled !== true;
          return hasReal ? { round, value } : null;
        })
        .filter(Boolean)
        .sort((a, b) => a.round - b.round);
      const totalLoss = Number.isFinite(Number(player.totalLoss))
        ? Number(player.totalLoss)
        : games.reduce((sum, game) => sum + game.value, 0);
      const gameAvg = Number.isFinite(Number(player.averageGameLoss))
        ? Number(player.averageGameLoss)
        : games.length
          ? games.reduce((sum, game) => sum + game.value, 0) / games.length
          : 0;
      return { player, games, gameAvg, totalLoss };
    });
    const maxTotalLoss = Math.max(
      1,
      ...playerBars.map((item) => (Number.isFinite(item.totalLoss) ? item.totalLoss : 0)),
    );
    const tickStep = maxTotalLoss <= 120 ? 20 : maxTotalLoss <= 300 ? 50 : 100;
    const maxScale = Math.ceil(maxTotalLoss / tickStep) * tickStep;

    ctx.fillStyle = "#6B7280";
    ctx.font = `${safeIOS ? "600 13px" : "600 14px"} ${fontFamily}`;
    ctx.fillText("选手", marginX, headerY);

    ctx.textAlign = "left";
    ctx.fillText("总子损", barX, headerY);
    ctx.strokeStyle = "#CBD5E1";
    ctx.lineWidth = 1;
    ctx.font = `${safeIOS ? "600 20px" : "600 24px"} ${fontFamily}`;
    ctx.fillStyle = "#6B7280";
    for (let tick = 0; tick <= maxScale; tick += tickStep) {
      const x = barX + (tick / maxScale) * barW;
      ctx.beginPath();
      ctx.moveTo(x, headerY + 20);
      ctx.lineTo(x, height - 48);
      ctx.stroke();
      ctx.fillText(String(tick), x + 6, headerY - 30);
    }

    ctx.textAlign = "right";
    ctx.font = `${safeIOS ? "600 13px" : "600 14px"} ${fontFamily}`;
    ctx.fillText("总子损", width - marginX, headerY);

    const legendY = height - 34;
    ctx.textAlign = "left";
    ctx.font = `${safeIOS ? "600 12px" : "600 13px"} ${fontFamily}`;
    for (let round = 1; round <= roundLimit; round += 1) {
      const x = marginX + (round - 1) * (safeIOS ? 74 : 84);
      ctx.fillStyle = roundColors[(round - 1) % roundColors.length];
      fillRoundRect(ctx, x, legendY - 8, 16, 16, 4);
      ctx.fillStyle = "#475569";
      ctx.fillText(`R${round}`, x + 22, legendY);
    }

    playerBars.forEach((item, idx) => {
      const player = item.player;
      const y = firstRowY + idx * rowH;
      ctx.fillStyle = idx % 2 === 0 ? "#FFFFFF" : "#F9FAFB";
      ctx.fillRect(marginX - 12, y - 32, width - marginX * 2 + 24, rowH);
      ctx.fillStyle = "#111827";
      ctx.font = `${safeIOS ? "600 15px" : "600 16px"} ${fontFamily}`;
      ctx.textAlign = "left";
      ctx.fillText(fitTextToWidth(ctx, egaPlayerLabel(player), nameW - 18), marginX, y - 10);
      ctx.fillStyle = "#6B7280";
      ctx.font = `${safeIOS ? "500 12px" : "500 13px"} ${fontFamily}`;
      const gameAvgText = Number.isFinite(item.gameAvg) ? item.gameAvg.toFixed(1) : "N/A";
      const moveAvg = Number.isFinite(Number(player.averageLoss))
        ? Number(player.averageLoss).toFixed(2)
        : "N/A";
      ctx.fillText(`场均子损 ${gameAvgText} · 手均 ${moveAvg}`, marginX, y + 14);

      ctx.fillStyle = "#E5E7EB";
      fillRoundRect(ctx, barX, y - barH / 2, barW, barH, barH / 2);
      const fullW = Number.isFinite(item.totalLoss)
        ? Math.max(4, Math.round((Math.min(item.totalLoss, maxScale) / maxScale) * barW))
        : 0;
      const segmentTotal = item.games.reduce((sum, game) => sum + game.value, 0);
      let cursorX = barX;
      ctx.save();
      if (fullW > 0) {
        ctx.beginPath();
        drawRoundRectPath(ctx, barX, y - barH / 2, fullW, barH, barH / 2);
        ctx.clip();
      }
      item.games.forEach((game, gameIdx) => {
        const isLast = gameIdx === item.games.length - 1;
        const segmentW = isLast
          ? Math.max(0, barX + fullW - cursorX)
          : Math.max(2, Math.round(fullW * (game.value / Math.max(1, segmentTotal))));
        if (segmentW <= 0) return;
        ctx.fillStyle = roundColors[(game.round - 1) % roundColors.length];
        ctx.fillRect(cursorX, y - barH / 2, segmentW, barH);
        cursorX += segmentW;
        if (!isLast) {
          ctx.strokeStyle = "rgba(255,255,255,0.72)";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(cursorX, y - barH / 2 + 3);
          ctx.lineTo(cursorX, y + barH / 2 - 3);
          ctx.stroke();
        }
      });
      ctx.restore();
      ctx.strokeStyle = "#FFFFFF";
      ctx.lineWidth = 2;
      strokeRoundRect(ctx, barX, y - barH / 2, Math.max(fullW, 4), barH, barH / 2);
      if (!item.games.length) {
        ctx.fillStyle = "#94A3B8";
        fillRoundRect(ctx, barX, y - barH / 2, fullW, barH, barH / 2);
      }

      ctx.fillStyle = "#111827";
      ctx.font = `${safeIOS ? "700 24px" : "700 30px"} ${fontFamily}`;
      ctx.textAlign = "right";
      const total = Number.isFinite(item.totalLoss) ? Math.round(item.totalLoss) : "N/A";
      ctx.fillText(String(total), width - marginX, y - 2);
      ctx.fillStyle = "#6B7280";
      ctx.font = `${safeIOS ? "500 12px" : "500 13px"} ${fontFamily}`;
      ctx.fillText(`场均 ${gameAvgText}`, width - marginX, y + 22);
    });
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

  async function exportEgaReportPNGs() {
    setBtnBusy(btnExportEgaReportPng, true, "导出中…", "导出选手表现 PNG");
    const safeIOS = isIOS();
    let previewWindow = null;
    try {
      try {
        const latest = await fetchLatestLocalSyncStateForAction();
        if (latest && latest.egaAnalysis) {
          state.egaAnalysis = sanitizeEgaAnalysis(latest.egaAnalysis);
        }
      } catch (error) {
        throw new Error(`无法读取最新 Egaroucid 分析数据：${error && error.message ? error.message : error}`);
      }
      const players = getEgaTopPlayers();
      if (!players.length) {
        throw new Error("还没有 Egaroucid 子损分析摘要，请先运行独立分析脚本");
      }
      const base = makeSafeFilename(state.competitionName || "比赛");
      if (shouldOpenPNGPreviewWindow()) previewWindow = openPNGPreviewWindow();
      const curve = buildEgaCurveReportCanvas({ safeIOS });
      const mode1 = await saveCanvasAsPNG(curve, `${base}_低子损曲线.png`, previewWindow);
      const grid = buildEgaRoundGridReportCanvas({ safeIOS });
      const mode2 = await saveCanvasAsPNG(grid, `${base}_低子损轮次.png`, null);
      notifyPNGResult(mode2 || mode1);
    } catch (e) {
      closePNGPreviewWindow(previewWindow);
      console.error("导出选手表现 PNG 失败：", e);
      showSnackbar(`导出失败：${e && e.message ? e.message : e}`, 3600);
    } finally {
      setBtnBusy(btnExportEgaReportPng, false, "导出中…", "导出选手表现 PNG");
    }
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

  async function buildPNGCanvasForExport(settings, viewPlayers, options = {}) {
    const exportMode = options.mode || getCurrentPngExportMode();
    if (exportMode === "mapping") {
      return {
        canvas: buildFtdPlayerMapCanvasFromData(getFtdPlayerMapExportRows(), {
          safeIOS: isIOS(),
        }),
        compatMode: isIOS(),
        iosSafeMode: isIOS(),
      };
    }

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
    if (getCurrentPngExportMode() === "mapping") {
      if (!sanitizeFtdPlayerAccountMapping(state.ftdPlayerAccountMapping)) {
        showAlert("无法生成映射表", "当前没有 FTD Player/OQ 映射表，请先导出 player 表并生成映射。");
        return false;
      }
      populateExportGroupOptions();
      renderExportPreview();
      return true;
    }

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
    const previewWindow = shouldOpenPNGPreviewWindow()
      ? openPNGPreviewWindow()
      : null;

    try {
      if (LOCAL_SYNC_ENABLED) {
        await saveAndPushLocalSyncNow();
        await fetchLatestLocalSyncStateForAction();
      }
      const exportMode = opts.mode || getCurrentPngExportMode();
      if (!prepareExportPreview()) {
        closePNGPreviewWindow(previewWindow);
        return;
      }
      const settings = getExportSettings();
      const filename = `${makeSafeFilename(state.competitionName)}_${exportMode === "mapping" ? "映射表" : "签到表"}.png`;
      const viewPlayers = getExportViewPlayers(settings);
      let canvas = null;
      let compatMode = false;
      if (exportMode === "mapping") {
        canvas = buildFtdPlayerMapCanvasFromData(getFtdPlayerMapExportRows(), {
          safeIOS: isIOS(),
        });
        compatMode = isIOS();
      } else if (opts.forceDataCanvas) {
        const iosSafeMode = isIOS();
        canvas = buildExportCanvasFromData(viewPlayers, settings, {
          safeIOS: iosSafeMode,
        });
        compatMode = iosSafeMode;
      } else {
        const built = await buildPNGCanvasForExport(settings, viewPlayers, {
          mode: exportMode,
        });
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

  async function exportFtdPlayerMapAsPNG() {
    if (!sanitizeFtdPlayerAccountMapping(state.ftdPlayerAccountMapping)) {
      showAlert("无法生成映射表", "当前没有 FTD Player/OQ 映射表，请先导入映射 JSON 或生成映射。");
      return;
    }
    await exportPNG({
      mode: "mapping",
      triggerButton: btnExportFtdMapPng,
      idleLabel: "导出映射 PNG",
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

  function promptCurrentDateText() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function promptRosterStats(srcState = state) {
    const players = Array.isArray(srcState && srcState.players) ? srcState.players : [];
    const total = players.length;
    const checked = players.filter((p) => p && p.checkedIn).length;
    const missingAccounts = players.filter((p) => p && normalizeKey(p.platform || "oq") === "oq" && !normalizeWhitespace(p.account)).length;
    const likelyRounds = preliminaryRoundCountForPlayerCount(total);
    return { total, checked, waiting: total - checked, missingAccounts, likelyRounds };
  }

  function promptMappingStats(srcState = state) {
    const mapping = sanitizeFtdPlayerAccountMapping(srcState && srcState.ftdPlayerAccountMapping);
    if (!mapping) return "No FTD Player/OQ mapping table is present in the shared state.";
    const validation = mapping.oqValidation && mapping.oqValidation.checkedAt
      ? `OQ validation checkedAt ${mapping.oqValidation.checkedAt}`
      : "OQ validation checkedAt is missing";
    return [
      `rows ${mapping.playerCount || 0}`,
      `complete ${mapping.matchedCount || 0}`,
      `incomplete ${mapping.unmatchedCount || 0}`,
      `invalid accounts ${mapping.invalidAccountCount || 0}`,
      validation,
    ].join("; ");
  }

  function promptScoreRoundStats(srcState = state) {
    const helper = sanitizeScoreHelper(srcState && srcState.scoreHelper ? srcState.scoreHelper : state.scoreHelper);
    const activeRound =
      Number.isFinite(Number(helper.activeRound)) && Number(helper.activeRound) > 0
        ? Math.trunc(Number(helper.activeRound))
        : 1;
    const round = helper.rounds[activeRound - 1] || helper.rounds[0] || emptyScoreRound(activeRound);
    const stats = scoreRoundFtdStats(round);
    return {
      roundNo: activeRound,
      roundCount: helper.roundCount,
      preliminaryRoundCount: helper.preliminaryRoundCount,
      roundLabel: scoreStageLabel(round),
      stage: normalizeWhitespace(round && round.stage),
      pending: Array.isArray(round.pending) ? round.pending.length : 0,
      manualPending: Array.isArray(round.manualPending) ? round.manualPending.length : 0,
      completedQueue: Array.isArray(round.completed) ? round.completed.length : 0,
      ftd: stats,
    };
  }

  function promptBaseLines(title, srcState = state) {
    const competition = normalizeWhitespace(srcState && srcState.competitionName) || "Unnamed tournament";
    return [
      "AUXILIARY PROMPT",
      "This prompt was generated by the local tournament frontend to help the next AI enter the correct workflow quickly.",
      "If this prompt conflicts with current local files, trust the current local files and report the mismatch briefly.",
      "",
      title,
      "",
      "Workspace: C:\\Users\\MeroAF\\Desktop\\比赛编排",
      "Local page: http://127.0.0.1:4174/",
      "Shared state API: http://127.0.0.1:4174/api/state",
      "Shared state file: tournament_arrangement\\recovered\\data\\checkin-state.json",
      `Tournament name: ${competition}`,
      `Prompt generated date: ${promptCurrentDateText()}`,
      "",
      "Global instructions:",
      "- Run commands from C:\\Users\\MeroAF\\Desktop\\比赛编排 unless you have a concrete reason not to.",
      "- Use the unified helper entrypoint as .\\wechat-decrypt\\agent_tournament_helper.cmd.",
      "- Do not open all of the long AGENTS.md or the full checkin-state.json by default. Use rg -n to find the relevant section, then open only narrow line ranges or read only the listed state fields.",
      "- Do not paste or restate the whole shared JSON. Use /api/state or a small local query to inspect only fields needed for this stage.",
      "- When the local server is available, write entity commands through http://127.0.0.1:4174/api/state/commands instead of posting snapshots or writing JSON directly.",
      "- Do not deploy Cloudflare Pages. Do not automate WeChat. Only use the local helper to read already-decrypted or cached local data.",
    ];
  }

  function buildRosterReviewPrompt(srcState = state) {
    const stats = promptRosterStats(srcState);
    return [
      ...promptBaseLines("Task: initial check-in roster review.", srcState),
      "",
      "Find the rules first, without scanning the whole repo:",
      'rg -n "Before check-in|roster|初步审查|missing accounts|duplicate|round count|签到名单" AGENTS.md wechat-decrypt\\AGENT_CHECKIN_BRIDGE.md',
      "",
      "Read only these shared-state fields for the first pass:",
      "- players[]: displayName/name, account, platform, group, checkedIn, isNew, parse/source/editAudit.",
      "- ui.checkinView, ui.group, ui.callMode: check whether a filtered UI view is making data look missing.",
      "- competitionName, updatedAt/version: check whether the state looks stale.",
      "- Suggested query: $s=(Invoke-RestMethod http://127.0.0.1:4174/api/state).state; $s.players | Select-Object displayName,name,account,platform,group,checkedIn,isNew",
      "",
      "Current frontend summary:",
      `- Roster size: ${stats.total}`,
      `- Checked in: ${stats.checked}; waiting: ${stats.waiting}`,
      `- Missing OQ accounts: ${stats.missingAccounts}`,
      `- Likely preliminary round count from current roster size: ${stats.likelyRounds}`,
      "",
      "What to do:",
      "- Check for parse errors, duplicates or suspicious near-duplicates, missing accounts, account/name column mistakes, wrong groups, stale state, and obvious name/account split mistakes.",
      "- If the count is near 31/32 or 63/64, remind the referee that one extra checked-in player can change the required round count.",
      "- Report only correctness risks that matter. Do not edit shared state based on a guess.",
      "- If an edit is required, state the evidence first, then write only affected entities through /api/state/commands when deterministic.",
    ].join("\n");
  }

  function buildCheckinPollPrompt(srcState = state) {
    const stats = promptRosterStats(srcState);
    return [
      ...promptBaseLines("Task: assisted check-in polling.", srcState),
      "",
      "Find the rules first, without scanning the whole repo:",
      'rg -n "Assisted Check-In Flow|Refresh Rule|history --start|19:27|19:57|reviewItems|unmapped sender" wechat-decrypt\\AGENT_CHECKIN_BRIDGE.md AGENTS.md',
      "",
      "Entrypoint:",
      ".\\wechat-decrypt\\agent_tournament_helper.cmd",
      "Narrow reference file when needed: wechat-decrypt\\AGENT_CHECKIN_BRIDGE.md",
      "",
      "Read only these shared-state fields for the first pass:",
      "- players[]: displayName/name, account, group, checkedIn, checkedInAt, isNew.",
      "- ui.checkinView, ui.group, ui.callMode: avoid mistaking filtered UI state for missing roster data.",
      "- wechatGroupNicks or helper output summary: only to judge whether the nickname cache is fresh enough.",
      "- Suggested query: $s=(Invoke-RestMethod http://127.0.0.1:4174/api/state).state; $s.players | Select-Object displayName,account,group,checkedIn,checkedInAt,isNew",
      "",
      "Current frontend summary:",
      `- Roster size: ${stats.total}`,
      `- Checked in: ${stats.checked}; waiting: ${stats.waiting}`,
      "",
      "Execution requirements:",
      "- First verify the local 4174 server is available. If unavailable, use the root launcher 打开比赛签到程序.cmd to start/verify it.",
      "- Start with: .\\wechat-decrypt\\agent_tournament_helper.cmd status. Run refresh-map only when the nickname cache needs refresh.",
      "- Do not poll check-in messages before the user has explicitly said check-in started.",
      "- Keep the history start fixed at match-day 19:27, then review two-minute windows through 19:57.",
      "- History command skeleton: .\\wechat-decrypt\\agent_tournament_helper.cmd history --start \"<match date> 19:27\" --end \"<match date> HH:mm\" --limit 1000 --output agent_cache\\checkin_history_<window>.json",
      "- Mark only deterministic sign-ins. If a valid-looking number appears near leave/withdraw/forfeit/non-participation wording, treat it as blocking and ask the user.",
      "- If a sender is unmapped, roster matching is ambiguous, or a write fails, stop that sub-action and report it.",
      "- Write only the affected player entities through /api/state/commands so the frontend receives the same revision.",
    ].join("\n");
  }

  function buildFtdMapPrompt(srcState = state) {
    return [
      ...promptBaseLines("Task: build the FTD Player / OQ mapping table.", srcState),
      "",
      "Find the rules first, without scanning the whole repo:",
      'rg -n "Current FTD Player/OQ Mapping Flow|build-ftd-map-draft|agentReviewPacket|patch-ftd-map|validate-and-publish-ftd-map" AGENTS.md wechat-decrypt\\AGENT_MATCH_IMAGE_HELPER.md',
      "",
      "Entrypoint:",
      ".\\wechat-decrypt\\agent_tournament_helper.cmd",
      "",
      "Current mapping summary:",
      `- ${promptMappingStats(srcState)}`,
      "",
      "Read only these shared-state fields for the first pass:",
      "- ftdPlayerAccountMapping: players, matchedCount, unmatchedCount, invalidAccountCount, oqValidation.",
      "- wechatGroupNicks.groupNicks: only for this agentReviewPacket cross-check.",
      "- players[]: displayName/name, account, group, only as local roster/OQ hints.",
      "- Suggested query: $s=(Invoke-RestMethod http://127.0.0.1:4174/api/state).state; $s.ftdPlayerAccountMapping | Select-Object playerCount,matchedCount,unmatchedCount,invalidAccountCount,oqValidation",
      "",
      "Required flow:",
      "1. Wait for the user to provide or point to the ftd-players JSON downloaded from the frontend's 导出player表 flow.",
      "2. Run: .\\wechat-decrypt\\agent_tournament_helper.cmd build-ftd-map-draft --ftd-players \"<ftd-players JSON>\"",
      "3. Agent review is mandatory. Read the printed agentReviewPacket, incomplete rows, current group nickname list, and local roster/OQ hints. Add only deterministic entries.",
      "4. If deterministic additions exist, run: .\\wechat-decrypt\\agent_tournament_helper.cmd patch-ftd-map --patch-file \"<agent reviewed patch JSON>\"",
      "5. If no deterministic additions exist, still run: .\\wechat-decrypt\\agent_tournament_helper.cmd patch-ftd-map --no-changes-reviewed",
      "6. Run: .\\wechat-decrypt\\agent_tournament_helper.cmd validate-and-publish-ftd-map",
      "7. The final command must do OQ validation, write affected mapping entities through /api/state/commands, publish the online collaboration table, and verify statistics.",
      "",
      "Review rules:",
      "- Group nicknames usually put the player's name on the left and the OQ account on the right, separated by a space, hyphen, underscore, slash, or similar punctuation. Split only when clear.",
      "- Shared mapping rows must stay minimal: FTD name, OQ account, group nickname, plus required validation metadata.",
      "- Do not write reason, long explanations, or candidate blocks into the shared mapping table.",
    ].join("\n");
  }

  function buildFtdPlayerReviewPrompt(srcState = state) {
    const players = Array.isArray(srcState && srcState.players) ? srcState.players : [];
    return [
      ...promptBaseLines("Task: Agent review and resolution of check-in roster names against the FTD Player library.", srcState),
      "",
      `Current shared revision seen by the frontend: ${Number.isFinite(localSyncLastRevision) ? localSyncLastRevision : "unknown"}`,
      `Current roster size: ${players.length}`,
      "",
      "Mandatory two-step command flow:",
      "1. Run without confirmation: .\\wechat-decrypt\\agent_tournament_helper.cmd resolve-ftd-players",
      "2. The command must not query or write yet. It prints the complete name-review packet for every roster row.",
      "3. Agent manual review is mandatory: inspect every row in that packet and compare the original roster name, proposed Surname Givenname, account/group context, historical FTD mapping, and all currently known information. Confirm that every roster name was entered normally according to the known facts. Do not merely trust the script's split.",
      "4. If any name is wrong or has multiple reasonable readings, report it to the referee and do not run the confirmed command until corrected or explicitly resolved.",
      "5. Only after manually reviewing the entire list, run: .\\wechat-decrypt\\agent_tournament_helper.cmd resolve-ftd-players --names-reviewed",
      "6. Do not add --names-reviewed before completing the all-row manual review.",
      "",
      "Name normalization rules:",
      "- Apply explicit entries from .\\wechat-decrypt\\ftd_player_name_overrides.json before historical FTD hints. This is a manually maintained exception table; do not infer or auto-add reversed names.",
      "- Normalize leading/trailing spaces, repeated spaces, full-width spaces, underscores, hyphens, slashes, clear case boundaries, and uniquely splittable joined pinyin.",
      "- Use current Chinese/pinyin/history fields and deterministic prior FTD mapping hints when present.",
      "- The query name must be Surname Givenname with exactly one ASCII space.",
      "- FTD records may store surname+name or name+surname; exact candidate comparison must accept both orders.",
      "- If more than one split remains reasonable, mark name-parse-unresolved and do not query or create a newcomer.",
      "",
      "FTD query and choice rules:",
      "- Use Socket.IO get-wof-players(normalizedName, 0); the third argument 0 is mandatory.",
      "- Deduplicate repeated wof-players-list packets by packet content and Player ID.",
      "- No result => unmatched only; never auto-mark referee-new and never call register-new-wof.",
      "- One exact result => matched-single.",
      "- Multiple exact results => numeric rating outranks null; select the highest numeric rating. If the top rating ties, randomly select one. If all ratings are null, randomly select one.",
      "- For a random tie save the selected internal Player ID, selection rule, all tied Player IDs, and resolver batch/time.",
      "- Write results only through http://127.0.0.1:4174/api/state/commands. If the API is unavailable, stop and do not write checkin-state.json directly.",
      "- Print a compact count summary and list every unmatched or name-parse-unresolved row for referee handling.",
    ].join("\n");
  }

  function buildScoreRoundPrompt(srcState = state) {
    const roundInfo = promptScoreRoundStats(srcState);
    const ftd = roundInfo.ftd;
    return [
      ...promptBaseLines(`Task: assisted score registration for ${roundInfo.roundLabel}.`, srcState),
      "",
      "Find the rules first, without scanning the whole repo:",
      'rg -n "Score Scan|score-anchor|pngPaths|push-batch-scores|blockingScoreChecks|all-ready-or-completed|FTD 黑白" wechat-decrypt\\AGENT_MATCH_IMAGE_HELPER.md AGENTS.md',
      "",
      "Entrypoint:",
      ".\\wechat-decrypt\\agent_tournament_helper.cmd",
      "",
      "The round number in this prompt comes from the currently selected frontend score-helper round. Do not infer the round or table count from check-in roster size.",
      `Current score-helper stage: ${roundInfo.roundLabel} (internal round ${roundInfo.roundNo} of ${roundInfo.roundCount}; preliminary rounds ${roundInfo.preliminaryRoundCount})`,
      `Current FTD pairings: total ${ftd.total}, active ${ftd.active}, ready ${ftd.ready}, completed ${ftd.completed}, imported-or-dirty ${ftd.imported}, dirty ${ftd.dirty}`,
      `Current pending: agent ${roundInfo.pending}, manual ${roundInfo.manualPending}, completed queue ${roundInfo.completedQueue}`,
      "",
      "Read only these shared-state fields for the first pass:",
      `- scoreHelper.activeRound and scoreHelper.rounds[${roundInfo.roundNo - 1}], especially ftdPairings, pending, manualPending, completed.`,
      "- ftdPlayerAccountMapping.players: only for current-round player to OQ/groupNick mapping.",
      "- players[]: only as supplemental account/name hints. Do not use the check-in roster to infer the current-round table count.",
      `- Suggested query: $s=(Invoke-RestMethod http://127.0.0.1:4174/api/state).state; $s.scoreHelper.rounds[${roundInfo.roundNo - 1}] | Select-Object round,roundStartAt,roundStartSource,ftdPairings,pending,manualPending,completed`,
      "",
      "Before polling:",
      "- Do not use a subagent. The current AI in this conversation handles this round directly.",
      `- Verify round ${roundInfo.roundNo} ftdPairings were imported by the user through the frontend 导入本轮 JSON flow. If not present, stop and ask the user to import the current-round JSON.`,
      "- If roundStartAt is already set by the frontend, do not run score-anchor or manually search for the start time; score-scan will use the frontend time when --start is omitted.",
      "- Use score-anchor only when roundStartAt is empty and the agent must determine the round start from chat history.",
      `- Anchor example when needed: .\\wechat-decrypt\\agent_tournament_helper.cmd score-anchor --round ${roundInfo.roundNo} --date <match date>`,
      `- Scan skeleton with frontend time: .\\wechat-decrypt\\agent_tournament_helper.cmd score-scan --round ${roundInfo.roundNo} --round-count ${roundInfo.roundCount} --end "<match date> HH:mm:ss" --output agent_cache\\score_scan_r${roundInfo.roundNo}_<window>.json`,
      `- If the agent must set the time, pass --start once; score-scan will sync it to frontend roundStartAt unless the frontend already has a time.`,
      "",
      "Score-processing hard rules:",
      "- Do not use OCR/PaddleOCR. score-scan only downloads/converts images and provides matching hints. Codex must open every player screenshot in pngPaths and manually inspect it.",
      "- Run score-scan once per polling window. If full JSON is needed, write it with --output; do not paste the full report into chat.",
      "- Ignore bot/referee summary tables, pairing charts, ranking tables, and other non-player-score images. Do not write pending for those images.",
      "- Before writing ready, compare visible OQ IDs in the screenshot against the two expected OQ accounts for that table. Sender matching is not enough.",
      "- Abnormal, unreadable, loser-side, account-mismatch, or sender/table-ambiguous screenshots must become compact pending items in the same polling window; then continue polling unless the user stops or local sync/write fails.",
      "- Clear scores are written only as yellow ready. Green completed can only be set by the frontend user.",
      "- For normal completed OQ games, do not calculate from margin alone. Use the upper/opponent displayed stone count as opponent score, then sender/self score = 64 - opponent score.",
      `- For multiple reviewed ready/pending items in one window, prepare a batch file and run: .\\wechat-decrypt\\agent_tournament_helper.cmd push-batch-scores --round ${roundInfo.roundNo} --round-count ${roundInfo.roundCount} --batch-file agent_cache\\score_batch_r${roundInfo.roundNo}_<window>.json`,
      "- Use push-ready-score or push-pending-score only for one emergency correction.",
      "- After every push-ready-score or push-batch-scores write, re-read /api/state and verify the target row is yellow ready or the compact pending item is visible.",
      "- Stop automatically only when stopPollingCode is all-ready-or-completed, roundCompletion.missing_count is 0, and resultEditorAudit.ok is true. Other stop hints are advisory.",
    ].join("\n");
  }

  async function copyAiPrompt(kind) {
    try {
      flushSave();
      const latestState = await fetchLatestLocalSyncStateForAction().catch(() => state);
      const srcState = latestState && typeof latestState === "object" ? latestState : state;
      const builders = {
        roster: buildRosterReviewPrompt,
        checkin: buildCheckinPollPrompt,
        mapping: buildFtdMapPrompt,
        playerResolution: buildFtdPlayerReviewPrompt,
        score: buildScoreRoundPrompt,
      };
      const prompt = builders[kind] ? builders[kind](srcState) : "";
      if (!prompt) throw new Error("unknown prompt kind");
      const label =
        kind === "score"
          ? `${promptScoreRoundStats(srcState).roundLabel}比分 Prompt`
          : kind === "playerResolution"
            ? "Agent 姓名核对 Prompt"
            : kind === "mapping"
            ? "映射表 Prompt"
            : kind === "checkin"
              ? "签到轮询 Prompt"
              : "名单审查 Prompt";
      await copyTextWithFallback(prompt, {
        successToast: `已复制${label}`,
      });
    } catch (error) {
      const detail = error && error.message ? String(error.message) : String(error || "");
      showAlert("复制 Prompt 失败", detail);
    }
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

  async function copyFtdConsoleDownloadCode() {
    try {
      flushSave();
      const latestState = await fetchLatestLocalSyncStateForAction();
      const stamp = Date.now();
      const [response, rendererResponse] = await Promise.all([
        fetch(`./ftd-download-console.js?t=${stamp}`, { method: "GET", cache: "no-store" }),
        fetch(`./chrome-ftd-bridge/ftd-pairing-png-renderer.js?t=${stamp}`, { method: "GET", cache: "no-store" }),
      ]);
      let code = await response.text();
      const rendererSource = await rendererResponse.text();
      if (!response.ok || !code.trim()) {
        throw new Error(`HTTP ${response.status}`);
      }
      if (!rendererResponse.ok || !rendererSource.trim()) {
        throw new Error(`PNG renderer HTTP ${rendererResponse.status}`);
      }
      if (/127\.0\.0\.1|localhost|\/api\/ftd-round/i.test(code + rendererSource)) {
        throw new Error("脚本包含本地 POST/API 访问，已拒绝复制");
      }
      const helper = sanitizeScoreHelper(latestState.scoreHelper || state.scoreHelper);
      const targetRound =
        Number.isFinite(Number(helper.activeRound)) && Number(helper.activeRound) > 0
          ? Math.trunc(Number(helper.activeRound))
          : 1;
      const targetRoundItem = helper.rounds[targetRound - 1] || helper.rounds[0];
      const targetStage = normalizeWhitespace(targetRoundItem && targetRoundItem.stage);
      const targetLabel = scoreStageLabel(targetRoundItem);
      const ftdUrl = normalizeWhitespace(
        (scoreFtdUrlInput && scoreFtdUrlInput.value) ||
          (latestState.ui && latestState.ui.ftdUrl) ||
          "",
      );
      const localMapping = sanitizeFtdPlayerAccountMapping(state.ftdPlayerAccountMapping);
      const remoteMapping = sanitizeFtdPlayerAccountMapping(latestState.ftdPlayerAccountMapping);
      const accountMapping =
        localMapping && mappingUpdatedAt(localMapping) >= mappingUpdatedAt(remoteMapping)
          ? localMapping
          : remoteMapping;
      code = code
        .replace("__FTD_PAIRING_PNG_RENDERER_SOURCE__", rendererSource)
        .replace("__FTD_TARGET_ROUND__", JSON.stringify(targetRound))
        .replace("__FTD_TARGET_STAGE__", JSON.stringify(targetStage))
        .replace("__FTD_TOURNAMENT_URL__", JSON.stringify(ftdUrl))
        .replace("__FTD_PLAYER_ACCOUNT_MAPPING__", JSON.stringify(accountMapping || { accountIndex: {} }));
      await copyTextWithFallback(code, {
        successToast:
          targetStage === SCORE_STAGE_FINALS
            ? "已复制 FTD 决赛阶段导出代码：执行后下载一个合并 JSON 和两张配对 PNG"
            : `已复制 FTD ${targetLabel}导出代码：到 FTD 页面 Console 粘贴执行`,
      });
    } catch (error) {
      const detail =
        error && error.message ? String(error.message) : String(error || "");
      showAlert(
        "复制失败",
        `无法读取 FTD 导出代码。请确认本地页面通过 http://127.0.0.1:4174/ 打开。\n\n${detail}`,
      );
    }
  }

  async function copyFtdPlayerConsoleCode() {
    try {
      const latestState = await fetchLatestLocalSyncStateForAction();
      const response = await fetch(`./ftd-player-console.js?t=${Date.now()}`, {
        method: "GET",
        cache: "no-store",
      });
      let code = await response.text();
      if (!response.ok || !code.trim()) {
        throw new Error(`HTTP ${response.status}`);
      }
      if (/127\.0\.0\.1|localhost/i.test(code)) {
        throw new Error("脚本包含本地地址访问，已拒绝复制");
      }
      const ftdUrl = normalizeWhitespace(
        (scoreFtdUrlInput && scoreFtdUrlInput.value) ||
          (latestState.ui && latestState.ui.ftdUrl) ||
          "",
      );
      code = code.replace("__FTD_TOURNAMENT_URL__", JSON.stringify(ftdUrl));
      await copyTextWithFallback(code, {
        successToast: "已复制导出player表代码：到 FTD 页面 Console 粘贴执行",
      });
    } catch (error) {
      const detail =
        error && error.message ? String(error.message) : String(error || "");
      showAlert(
        "复制失败",
        `无法读取导出player表代码。请确认本地页面通过 http://127.0.0.1:4174/ 打开。\n\n${detail}`,
      );
    }
  }

  async function refreshWechatGroupNicks() {
    try {
      const response = await fetch(LOCAL_SYNC_WECHAT_MEMBER_MAP_REFRESH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result || result.ok !== true) {
        throw new Error((result && (result.detail || result.error)) || `HTTP ${response.status}`);
      }
      const next = sanitizeWechatGroupNicks({
        groupName: result.groupName,
        refreshedAt: result.refreshedAt,
        groupNicks: result.groupNicks,
      });
      if (!next || !next.groupNicks.length) {
        throw new Error("刷新结果里没有可用群昵称");
      }
      state.wechatGroupNicks = next;
      const removed = pruneMissingFtdPlayerMapGroupNicks(next.groupNicks, new Date().toISOString());
      state.ui.checkinView = "mapping";
      viewStepOverride = null;
      refreshCheckinUI();
      await saveAndPushLocalSyncNow();
      showSnackbar(`已刷新群昵称 ${next.groupNicks.length} 个${removed ? `，清空失效 ${removed} 项` : ""}`, 2600);
    } catch (error) {
      const detail = error && error.message ? String(error.message) : String(error || "");
      showAlert(
        "刷新失败",
        `无法刷新微信群昵称列表。请确认本地程序已启动，且 wechat-decrypt 可以读取当前群。\n\n${detail}`,
      );
    }
  }

  async function syncOnlineFtdPlayerMap() {
    if (!LOCAL_SYNC_ENABLED) {
      showAlert("无法同步", "请通过本地同步页面 http://127.0.0.1:4174/ 打开后再更新线上映射表。");
      return;
    }
    setBtnBusy(btnSyncOnlineFtdMap, true, "同步中…", "更新线上映射表");
    try {
      const response = await fetch(LOCAL_SYNC_MAP_COLLAB_SYNC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result || result.ok !== true) {
        throw new Error((result && (result.detail || result.error)) || `HTTP ${response.status}`);
      }
      state.ui.checkinView = "mapping";
      viewStepOverride = null;
      refreshCheckinUI();
      saveBrowserPreferences();
      const summary = result.summary || {};
      const matched = Number(summary.matchedCount) || 0;
      const total = Number(summary.playerCount) || 0;
      const invalid = Number(summary.invalidAccountCount) || 0;
      const missing = Number(summary.unmatchedCount) || 0;
      const remoteText = summary.remoteRevision ? `，远端 r${summary.remoteRevision}` : "";
      showSnackbar(`已同步线上映射表：${matched}/${total}，未完成 ${missing}，异常 ${invalid}${remoteText}`, 3200);
    } catch (error) {
      const detail = error && error.message ? String(error.message) : String(error || "");
      showAlert(
        "同步失败",
        `无法更新线上映射表。此按钮会先推送本地群昵称池，再从线上拉取映射表并直接覆写本地映射表。\n\n${detail}`,
      );
    } finally {
      setBtnBusy(btnSyncOnlineFtdMap, false, "同步中…", "更新线上映射表");
    }
  }

  async function validateOqAccountsForMapping() {
    const mapping = sanitizeFtdPlayerAccountMapping(state.ftdPlayerAccountMapping);
    if (!mapping || !Array.isArray(mapping.players) || !mapping.players.length) {
      showAlert("无法校验", "当前没有 FTD Player/OQ 映射表。");
      return;
    }
    if (!LOCAL_SYNC_ENABLED) {
      showAlert("无法校验", "请通过本地同步页面 http://127.0.0.1:4174/ 打开后再校验 OQ 账号。");
      return;
    }
    const accounts = mapping.players
      .filter((row) => !isDeletedFtdPlayerMapRow(row))
      .map((row) => normalizeWhitespace(row.account))
      .filter(Boolean);
    if (!accounts.length) {
      showAlert("无法校验", "当前映射表里没有可校验的 OQ 账号。");
      return;
    }
    await saveAndPushLocalSyncNow();
    setBtnBusy(btnValidateOqAccounts, true, "校验中…", "校验OQ账号");
    try {
      const response = await fetch(LOCAL_SYNC_OQ_ACCOUNTS_VALIDATE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "5min", concurrency: 8 }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result || result.ok !== true) {
        throw new Error((result && (result.detail || result.error)) || `HTTP ${response.status}`);
      }
      const latest = await fetchLatestLocalSyncStateForAction();
      if (latest && latest.ftdPlayerAccountMapping) {
        state.ftdPlayerAccountMapping = sanitizeFtdPlayerAccountMapping(latest.ftdPlayerAccountMapping);
      }
      state.ui.checkinView = "mapping";
      viewStepOverride = null;
      refreshCheckinUI();
      saveStateToLocalOnly();
      showSnackbar(`OQ账号校验完成：本次 ${result.checkedCount || 0}，有效 ${result.okCount || 0}，异常 ${result.invalidCount || 0}，跳过 ${result.skippedCount || 0}；当前异常 ${result.totalInvalidAccountCount || 0}`, 3000);
    } catch (error) {
      const detail = error && error.message ? String(error.message) : String(error || "");
      showAlert(
        "校验失败",
        `无法校验 OQ 账号。请确认本地程序已启动，且网络能访问 Othello Quest。\n\n${detail}`,
      );
    } finally {
      setBtnBusy(btnValidateOqAccounts, false, "校验中…", "校验OQ账号");
    }
  }

  function selectedScoreRoundInfo() {
    const helper = ensureScoreHelper();
    const round = getActiveScoreRound();
    const roundNo =
      Number.isFinite(Number(round && round.round)) && Number(round.round) > 0
        ? Math.trunc(Number(round.round))
        : Math.trunc(Number(helper.activeRound) || 1);
    return { helper, round, roundNo };
  }

  function oqScorePollSeconds() {
    const value = scoreOqPollSecondsInput ? scoreOqPollSecondsInput.value : state.ui && state.ui.oqPollSeconds;
    return Math.max(5, Math.trunc(Number(value || 60) || 60));
  }

  function updateOqScorePollButton() {
    if (!btnToggleOqScorePoll) return;
    btnToggleOqScorePoll.classList.toggle("btn-tonal", !oqScorePollEnabled);
    btnToggleOqScorePoll.classList.toggle("btn-filled", oqScorePollEnabled);
    btnToggleOqScorePoll.setAttribute("aria-pressed", oqScorePollEnabled ? "true" : "false");
    btnToggleOqScorePoll.textContent = oqScorePollEnabled ? "停止OQ轮询" : "OQ轮询";
  }

  async function fetchOqRoundScoreUpdateStatus() {
    const response = await fetch(`${LOCAL_SYNC_OQ_ROUND_SCORES_STATUS_URL}?t=${Date.now()}`);
    const result = await response.json().catch(() => null);
    if (!response.ok || !result || result.ok !== true) {
      throw new Error((result && (result.detail || result.error)) || `HTTP ${response.status}`);
    }
    return result;
  }

  async function shouldSkipScheduledOqPoll(scheduledAt, roundNo) {
    try {
      const status = await fetchOqRoundScoreUpdateStatus();
      const lastStartedAt = Number(status.lastStartedAtMs || 0);
      const lastRound = Math.trunc(Number(status.lastRound || 0));
      return (
        lastRound === Math.trunc(Number(roundNo) || 0) &&
        lastStartedAt >= scheduledAt - 5000 &&
        lastStartedAt <= scheduledAt
      );
    } catch (_) {
      return false;
    }
  }

  const FTD_AUTOPILOT_TERMINAL_PHASES = new Set(["done", "stopped", "failed"]);

  function readFtdAutopilotControl() {
    try {
      const value = JSON.parse(sessionStorage.getItem(FTD_AUTOPILOT_CONTROL_KEY) || "null");
      return value && value.sessionId && value.token ? value : null;
    } catch (_) {
      return null;
    }
  }

  function writeFtdAutopilotControl(value) {
    try {
      if (value && value.sessionId && value.token) sessionStorage.setItem(FTD_AUTOPILOT_CONTROL_KEY, JSON.stringify(value));
      else sessionStorage.removeItem(FTD_AUTOPILOT_CONTROL_KEY);
    } catch (_) {}
  }

  function isFtdAutopilotActive() {
    const session = ftdAutopilotStatus && ftdAutopilotStatus.session;
    return Boolean(session && !FTD_AUTOPILOT_TERMINAL_PHASES.has(session.phase));
  }

  function ftdAutopilotPhaseText(phase) {
    const labels = {
      idle: "空闲", armed: "已锁定", preflight: "预检", "reading-ftd": "读取 FTD",
      "importing-round": "导入配对", "polling-oq": "轮询 OQ", "writing-scores": "写入比分",
      "verifying-scores": "回读比分", "preparing-transcripts": "准备棋谱", "writing-transcripts": "写入棋谱",
      "verifying-transcripts": "回读棋谱", "generating-image": "生成总分图", "downloading-image": "确认下载",
      paused: "已暂停", stopping: "正在安全停止", stopped: "已停止", done: "已完成", failed: "失败",
    };
    return labels[phase] || phase || "空闲";
  }

  function renderFtdAutopilotStatus() {
    const status = ftdAutopilotStatus || {};
    const session = status.session;
    const bridge = status.bridge || {};
    const active = isFtdAutopilotActive();
    const control = readFtdAutopilotControl();
    const canControl = Boolean(session && control && control.sessionId === session.sessionId);
    if (ftdAutopilotStatusEl) {
      const phase = session ? session.phase : "idle";
      const reason = session && session.pauseReason && session.pauseReason.message ? `；${session.pauseReason.message}` : "";
      const scope = session && session.scope ? `；${scoreStageLabel({ round: session.scope.localRound, stage: session.scope.localStage })}` : "";
      const images = session && session.images && typeof session.images === "object" ? session.images : {};
      const imageMark = (item) => item && item.receipt ? "✓" : item && item.requestIssued ? "处理中" : "待";
      const imageProgress = session ? `；PNG 配对${imageMark(images.pairing)} / 半程${imageMark(images.halfway)} / 最终${imageMark(images.final)}` : "";
      ftdAutopilotStatusEl.dataset.active = active ? "true" : "false";
      ftdAutopilotStatusEl.dataset.phase = phase;
      ftdAutopilotStatusEl.innerHTML = `<strong>AP：</strong><span>${escapeHtml(ftdAutopilotPhaseText(phase))}${escapeHtml(scope)}${escapeHtml(reason)}${escapeHtml(imageProgress)}；Chrome 桥${bridge.connected ? "已连接" : "未连接"}${session && !canControl && active ? "；操作时将接管控制" : ""}</span>`;
    }
    if (btnFtdAutopilotStart) btnFtdAutopilotStart.disabled = active || !bridge.connected;
    if (btnFtdAutopilotProbe) btnFtdAutopilotProbe.disabled = !bridge.connected;
    if (btnFtdAutopilotPause) btnFtdAutopilotPause.disabled = !active || session.phase === "paused" || session.phase === "stopping";
    if (btnFtdAutopilotResume) btnFtdAutopilotResume.disabled = !active || session.phase !== "paused";
    if (btnFtdAutopilotStop) btnFtdAutopilotStop.disabled = !active || session.phase === "stopping";
  }

  async function fetchFtdAutopilotJson(url, options = {}) {
    const response = await fetch(url, {
      cache: "no-store",
      ...options,
      headers: { "Content-Type": "application/json; charset=utf-8", ...(options.headers || {}) },
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result || result.ok !== true) throw new Error((result && (result.error || result.code)) || `HTTP ${response.status}`);
    return result;
  }

  async function refreshFtdAutopilotStatus({ silent = true } = {}) {
    if (!LOCAL_SYNC_ENABLED) return null;
    try {
      ftdAutopilotStatus = await fetchFtdAutopilotJson(`${LOCAL_SYNC_AUTOMATION_STATUS_URL}?t=${Date.now()}`, { method: "GET" });
      renderFtdAutopilotStatus();
      return ftdAutopilotStatus;
    } catch (error) {
      ftdAutopilotStatus = null;
      renderFtdAutopilotStatus();
      if (!silent) showAlert("AP 不可用", error.message);
      return null;
    }
  }

  function currentFtdAutopilotScopeRequest() {
    const { round, roundNo } = selectedScoreRoundInfo();
    const ftdUrl = normalizeWhitespace((scoreFtdUrlInput && scoreFtdUrlInput.value) || (state.ui && state.ui.ftdUrl) || "");
    const match = ftdUrl.match(/^https:\/\/(?:www\.)?flipthedisc\.com\/live\/(\d+)(?:[/?#]|$)/i);
    if (!round || !match) throw new Error("请先选择本轮并填写有效的 FTD live 链接");
    return {
      tournamentId: match[1],
      localRound: roundNo,
      localStage: normalizeWhitespace(round.stage),
      ftdUrl,
    };
  }

  async function probeFtdAutopilot() {
    if (!LOCAL_SYNC_ENABLED) { showAlert("无法探测", "请从 http://127.0.0.1:4174/ 打开本地页面。"); return; }
    setBtnBusy(btnFtdAutopilotProbe, true, "探测中…", "FTD 只读探测");
    try {
      syncActiveScoreRoundStartFromInput();
      await saveAndPushLocalSyncNow();
      const result = await fetchFtdAutopilotJson(LOCAL_SYNC_AUTOMATION_PROBE_URL, { method: "POST", body: JSON.stringify(currentFtdAutopilotScopeRequest()) });
      showAlert("只读探测通过", `已证明登录、TD 权限与第二条 Socket 共存。赛事 ${result.tournamentId}，未执行任何写入。`);
      await refreshFtdAutopilotStatus();
    } catch (error) {
      showAlert("只读探测未通过", `${error.message}\n\n在探测通过前，比分与棋谱自动写入保持禁用。`);
    } finally {
      setBtnBusy(btnFtdAutopilotProbe, false, "探测中…", "FTD 只读探测");
    }
  }

  async function startFtdAutopilot() {
    if (!LOCAL_SYNC_ENABLED) { showAlert("无法启动", "请从 http://127.0.0.1:4174/ 打开本地页面。"); return; }
    setBtnBusy(btnFtdAutopilotStart, true, "启动中…", "AP");
    try {
      syncActiveScoreRoundStartFromInput();
      const saved = await saveAndPushLocalSyncNow();
      if (!saved || saved.ok !== true) throw new Error("本地共享状态同步失败");
      stopOqScorePolling({ quiet: true });
      const result = await fetchFtdAutopilotJson(LOCAL_SYNC_AUTOMATION_START_URL, { method: "POST", body: JSON.stringify(currentFtdAutopilotScopeRequest()) });
      writeFtdAutopilotControl({ sessionId: result.sessionId, token: result.token, tokenExpiresAt: result.tokenExpiresAt });
      ftdAutopilotStatus = { ok: true, bridge: (ftdAutopilotStatus && ftdAutopilotStatus.bridge) || {}, session: result.session };
      renderFtdAutopilotStatus();
      showAlert("AP 已启动", "已锁定当前赛事与轮次。请保持 FTD 标签页打开；自动化运行期间不要同时在 Console 手动写分或写棋谱。异常只暂停受影响的桌。 ");
    } catch (error) {
      showAlert("启动失败", error.message);
    } finally {
      setBtnBusy(btnFtdAutopilotStart, false, "启动中…", "AP");
      await refreshFtdAutopilotStatus();
    }
  }

  async function controlFtdAutopilot(action) {
    const session = ftdAutopilotStatus && ftdAutopilotStatus.session;
    let control = readFtdAutopilotControl();
    if (!session || FTD_AUTOPILOT_TERMINAL_PHASES.has(session.phase)) { showAlert("无法控制", "当前没有活动 AP 会话。"); return false; }
    const url = action === "pause" ? LOCAL_SYNC_AUTOMATION_PAUSE_URL : action === "resume" ? LOCAL_SYNC_AUTOMATION_RESUME_URL : LOCAL_SYNC_AUTOMATION_STOP_URL;
    try {
      if (!control || control.sessionId !== session.sessionId) {
        const claimed = await fetchFtdAutopilotJson(LOCAL_SYNC_AUTOMATION_CLAIM_URL, {
          method: "POST",
          body: JSON.stringify({ sessionId: session.sessionId }),
        });
        control = { sessionId: claimed.sessionId, token: claimed.token, tokenExpiresAt: claimed.tokenExpiresAt };
        writeFtdAutopilotControl(control);
      }
      await fetchFtdAutopilotJson(url, { method: "POST", body: JSON.stringify({ sessionId: control.sessionId, token: control.token }) });
      await refreshFtdAutopilotStatus();
      if (action === "stop") showSnackbar("已请求安全停止；不会回滚已经验证写入的内容", 3200);
      return true;
    } catch (error) {
      showAlert("控制失败", error.message);
      return false;
    }
  }

  function runManualFtdAction(action, label) {
    if (!isFtdAutopilotActive()) { void action(); return; }
    const control = readFtdAutopilotControl();
    if (!control || !ftdAutopilotStatus.session || control.sessionId !== ftdAutopilotStatus.session.sessionId) {
      showAlert("AP 正在运行", `${label} 可能与自动写入冲突。请先使用“暂停”或“紧急停止”，再走手动流程。`);
      return;
    }
    showConfirm(
      "先暂停 AP",
      `${label} 可能与自动写入冲突。可先暂停后继续准备手动代码；也可取消并使用“紧急停止”。`,
      async () => { if (await controlFtdAutopilot("pause")) await action(); },
      "暂停后继续",
    );
  }

  async function updateRoundScoresFromOq(options = {}) {
    const { helper, round, roundNo } = selectedScoreRoundInfo();
    if (!round || !Array.isArray(round.ftdPairings) || !round.ftdPairings.length) {
      if (!options.silent) showAlert("无法更新", "当前选中轮还没有导入 FTD 配对表。");
      return;
    }
    const selectedStage = normalizeWhitespace(round.stage);
    if (selectedStage === SCORE_STAGE_SEMIFINAL && round.ftdPairings.length !== 2) {
      if (!options.silent) showAlert("半决赛配对不完整", "请先导入包含 2 台配对的 FTD SF JSON。");
      return;
    }
    if (
      selectedStage === SCORE_STAGE_FINALS &&
      (round.ftdPairings.length !== 2 ||
        !round.ftdPairings.some((item) => normalizeFtdStage(item && item.ftdStage) === "F") ||
        !round.ftdPairings.some((item) => normalizeFtdStage(item && item.ftdStage) === "3/4"))
    ) {
      if (!options.silent) showAlert("决赛阶段配对不完整", "请先分别导入 FTD 的 F 与 3/4 JSON，再开始同时更新比分。");
      return;
    }
    if (!LOCAL_SYNC_ENABLED) {
      if (!options.silent) showAlert("无法更新", "请通过本地同步页面 http://127.0.0.1:4174/ 打开后再从 OQ 更新比分。");
      return;
    }
    const roundStart = syncActiveScoreRoundStartFromInput() || normalizeWhitespace(round.roundStartAt || "");
    if (!isValidScoreRoundStart(roundStart)) {
      if (!options.silent) {
        showAlert(
          "缺少本轮开始时间",
          "请先在比分登记辅助顶部填写当前选中轮的实际开始时间，再从 OQ 更新本轮比分。不要使用点击按钮的时间作为查询起点。",
        );
      }
      renderScoreHelper();
      return;
    }
    await saveAndPushLocalSyncNow();
    if (!options.silent) setBtnBusy(btnUpdateRoundOqScores, true, "更新中…", "从 OQ 更新本轮比分");
    try {
      const response = await fetch(LOCAL_SYNC_OQ_ROUND_SCORES_UPDATE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          round: roundNo,
          roundId: round.entityId,
          expectedRoundRevision: round.entityRevision,
          scoreRows: round.ftdPairings.map((item) => ({ id: item.entityId, revision: item.entityRevision })),
          roundCount: helper.roundCount,
          roundStart,
          source: options.source || "frontend-manual",
          mode: "5min",
          concurrency: 8,
        }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result || result.ok !== true) {
        throw new Error((result && (result.detail || result.error)) || `HTTP ${response.status}`);
      }
      const applied = Number(result.appliedCount || 0);
      const gameAvailable = Number(result.gameAvailableCount || 0);
      const pending = Number(result.pendingCount || 0);
      const skipped = Number(result.skippedCount || 0);
      const queryMs = Number(result.queryWallMs || 0);
      const detailMs = Number(result.detailFetchWallMs || 0);
      const querySeconds = queryMs > 0 ? `，列表 ${(queryMs / 1000).toFixed(1)}s` : "";
      const detailCount = Number(result.detailFetchCount || 0);
      const detailHits = Number(result.detailCacheHitCount || 0);
      const detailText =
        detailCount || detailHits || detailMs
          ? `，详情 ${detailCount} 次/缓存 ${detailHits} 次`
          : "";
      if (!options.silent || applied || pending) {
        showSnackbar(
          `OQ 第 ${roundNo} 轮更新完成：ready ${applied}，棋谱可用 ${gameAvailable}，pending ${pending}，跳过 ${skipped}${querySeconds}${detailText}`,
          4200,
        );
      }
    } catch (error) {
      const detail = error && error.message ? String(error.message) : String(error || "");
      if (options.silent) {
        showSnackbar(`OQ 轮询失败：${detail}`, 3000);
      } else {
        showAlert(
          "更新失败",
          `无法从 OQ 更新当前选中轮比分。请确认本轮配对和 OQ 映射齐全，且网络能访问 Othello Quest。\n\n${detail}`,
        );
      }
    } finally {
      if (!options.silent) setBtnBusy(btnUpdateRoundOqScores, false, "更新中…", "从 OQ 更新本轮比分");
    }
  }

  function stopOqScorePolling({ quiet = false } = {}) {
    oqScorePollEnabled = false;
    if (oqScorePollTimer) {
      clearTimeout(oqScorePollTimer);
      oqScorePollTimer = null;
    }
    oqScorePollNextAt = 0;
    updateOqScorePollButton();
    if (!quiet) showSnackbar("已停止 OQ 轮询", 1800);
  }

  function scheduleNextOqScorePoll(scheduledAt) {
    if (!oqScorePollEnabled) return;
    const intervalMs = oqScorePollSeconds() * 1000;
    let nextAt = Number(scheduledAt || 0) > 0 ? Number(scheduledAt) + intervalMs : Date.now() + intervalMs;
    const nowMs = Date.now();
    while (nextAt <= nowMs) nextAt += intervalMs;
    oqScorePollNextAt = nextAt;
    if (oqScorePollTimer) clearTimeout(oqScorePollTimer);
    oqScorePollTimer = setTimeout(() => {
      runScheduledOqScorePoll(nextAt);
    }, Math.max(0, nextAt - Date.now()));
  }

  async function runScheduledOqScorePoll(scheduledAt) {
    if (!oqScorePollEnabled || oqScorePollInFlight) {
      scheduleNextOqScorePoll(scheduledAt);
      return;
    }
    oqScorePollInFlight = true;
    const { roundNo } = selectedScoreRoundInfo();
    try {
      const coveredByRecentRequest = await shouldSkipScheduledOqPoll(scheduledAt, roundNo);
      if (!coveredByRecentRequest) {
        await updateRoundScoresFromOq({
          silent: true,
          source: "frontend-poll",
          scheduledAt,
        });
      }
    } finally {
      oqScorePollInFlight = false;
      scheduleNextOqScorePoll(scheduledAt);
    }
  }

  function startOqScorePolling() {
    if (!LOCAL_SYNC_ENABLED) {
      showAlert("无法轮询", "请通过本地同步页面 http://127.0.0.1:4174/ 打开后再启动 OQ 轮询。");
      return;
    }
    const seconds = oqScorePollSeconds();
    if (scoreOqPollSecondsInput) scoreOqPollSecondsInput.value = String(seconds);
    if (!state.ui) state.ui = {};
    state.ui.oqPollSeconds = seconds;
    flushSave();
    oqScorePollEnabled = true;
    updateOqScorePollButton();
    scheduleNextOqScorePoll(Date.now());
    showSnackbar(`已启动 OQ 轮询：${seconds}s`, 2000);
  }

  function toggleOqScorePolling() {
    if (oqScorePollEnabled) {
      stopOqScorePolling();
      return;
    }
    startOqScorePolling();
  }

  function selfCheckStatusText(overall) {
    if (overall === "pass") return "通过";
    if (overall === "warn") return "警告";
    if (overall === "fail") return "失败";
    if (overall === "running") return "检查中";
    return "未运行";
  }

  function setSelfCheckStatus(overall, text) {
    if (!selfCheckStatus) return;
    const status = overall || "idle";
    selfCheckStatus.className = `self-check-status self-check-status--${escapeHtml(status)}`;
    selfCheckStatus.textContent = text || selfCheckStatusText(status);
  }

  function renderSelfCheckPaths(report) {
    if (!selfCheckPaths) return;
    const paths = report && report.paths && typeof report.paths === "object" ? report.paths : {};
    const entries = [
      ["state", "共享 state"],
      ["frontendApi", "前端 API"],
      ["helper", "统一 helper"],
      ["egEngine", "EG engine"],
      ["egCache", "EG cache"],
      ["runtimeLock", "运行锁"],
      ["report", "自检报告"],
    ].filter(([key]) => paths[key]);
    selfCheckPaths.innerHTML = entries.length
      ? entries
          .map(
            ([key, label]) => `
              <div class="self-check-path">
                <strong>${escapeHtml(label)}</strong>
                <code>${escapeHtml(paths[key])}</code>
              </div>
            `,
          )
          .join("")
      : "";
  }

  function compactSelfCheckDetail(item) {
    const parts = [];
    if (item.actualPath || item.expectedPath) {
      parts.push(
        `<div class="self-check-item__detail"><strong>路径</strong> ${escapeHtml(item.actualPath || item.actual || "")}${item.expectedPath && item.expectedPath !== item.actualPath ? ` / 期望 ${escapeHtml(item.expectedPath)}` : ""}</div>`,
      );
    } else if (item.actual || item.expected) {
      parts.push(
        `<div class="self-check-item__detail"><strong>实际</strong> ${escapeHtml(item.actual || "")}${item.expected ? ` / 期望 ${escapeHtml(item.expected)}` : ""}</div>`,
      );
    }
    if (item.reason) {
      parts.push(`<div class="self-check-item__detail"><strong>原因</strong> ${escapeHtml(item.reason)}</div>`);
    }
    if (item.suggestion) {
      parts.push(`<div class="self-check-item__detail"><strong>建议</strong> ${escapeHtml(item.suggestion)}</div>`);
    }
    if (item.details) {
      let detailText = "";
      try {
        detailText = JSON.stringify(item.details).slice(0, 500);
      } catch (_) {
        detailText = String(item.details || "").slice(0, 500);
      }
      if (detailText) {
        parts.push(`<div class="self-check-item__detail"><strong>详情</strong> ${escapeHtml(detailText)}</div>`);
      }
    }
    return parts.join("");
  }

  function renderSelfCheckReport(report) {
    if (!selfCheckSummary || !selfCheckResults) return;
    if (!report) {
      setSelfCheckStatus("idle", "未运行");
      selfCheckSummary.textContent = "尚未运行签到前自检。正式比赛开始签到前应先运行完整自检。";
      renderSelfCheckPaths(null);
      selfCheckResults.innerHTML = "";
      return;
    }
    const summary = report.summary || {};
    const overall = report.overall || (summary.fail ? "fail" : summary.warn ? "warn" : "pass");
    setSelfCheckStatus(overall, selfCheckStatusText(overall));
    const lockText = report.runtimeLock && report.runtimeLock.written
      ? "运行锁已写入"
      : "运行锁未写入";
    selfCheckSummary.textContent =
      `模式 ${report.mode || "basic"} · pass ${summary.pass || 0} / warn ${summary.warn || 0} / fail ${summary.fail || 0} · ${lockText}`;
    renderSelfCheckPaths(report);
    const items = Array.isArray(report.items) ? report.items : [];
    const ordered = items
      .slice()
      .sort((a, b) => {
        const rank = { fail: 0, warn: 1, pass: 2 };
        return (rank[a.status] ?? 3) - (rank[b.status] ?? 3);
      });
    selfCheckResults.innerHTML = ordered.length
      ? ordered
          .map(
            (item) => `
              <div class="self-check-item self-check-item--${escapeHtml(item.status || "warn")}">
                <span class="self-check-item__badge">${escapeHtml(item.status || "")}</span>
                <div class="self-check-item__main">
                  <div class="self-check-item__title">${escapeHtml(item.component || "self-check")} · ${escapeHtml(item.name || "")}</div>
                  ${compactSelfCheckDetail(item)}
                </div>
              </div>
            `,
          )
          .join("")
      : `<div class="empty-state empty-state--compact"><div><div class="empty-state__title">没有自检项</div><div class="empty-state__text">请重新运行完整自检。</div></div></div>`;
  }

  async function refreshSelfCheckReport({ silent = true } = {}) {
    if (!LOCAL_SYNC_ENABLED || !selfCheckResults) return null;
    try {
      const response = await fetch(`${LOCAL_SYNC_SELF_CHECK_URL}?t=${Date.now()}`, {
        cache: "no-store",
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result || result.ok !== true) {
        throw new Error((result && (result.detail || result.error)) || `HTTP ${response.status}`);
      }
      renderSelfCheckReport(result.latest || null);
      return result.latest || null;
    } catch (error) {
      if (!silent) showSnackbar("无法读取自检报告", 2200);
      setSelfCheckStatus("fail", "读取失败");
      if (selfCheckSummary) selfCheckSummary.textContent = error && error.message ? String(error.message) : String(error || "");
      return null;
    }
  }

  async function runSelfCheck(mode) {
    if (!LOCAL_SYNC_ENABLED) {
      showAlert("无法自检", "请通过正式本地前端 http://127.0.0.1:4174/ 打开后再运行自检。");
      return;
    }
    const isFull = mode === "full";
    const btn = isFull ? btnSelfCheckFull : btnSelfCheckCheckin;
    setSelfCheckStatus("running", "检查中");
    if (selfCheckSummary) selfCheckSummary.textContent = "正在运行签到前自检，期间不会写入比赛 state。";
    setBtnBusy(btn, true, "检查中", btn ? btn.textContent : "自检");
    try {
      const response = await fetch(LOCAL_SYNC_SELF_CHECK_RUN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          event: "open",
          full: isFull,
          checkinReady: mode === "checkin-ready",
          writeLock: true,
        }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result) {
        throw new Error((result && (result.detail || result.error)) || `HTTP ${response.status}`);
      }
      renderSelfCheckReport(result);
      if (result.summary && result.summary.fail > 0) {
        showSnackbar("自检失败：有 fail 项，不能进入签到", 3600);
      } else if (result.summary && result.summary.warn > 0) {
        showSnackbar("自检完成：存在 warn 项，请确认风险", 3200);
      } else {
        showSnackbar("自检通过，运行锁已写入", 2600);
      }
    } catch (error) {
      setSelfCheckStatus("fail", "运行失败");
      if (selfCheckSummary) selfCheckSummary.textContent = error && error.message ? String(error.message) : String(error || "");
      showAlert("自检运行失败", error && error.message ? String(error.message) : String(error || ""));
    } finally {
      setBtnBusy(btn, false, "检查中", isFull ? "完整自检" : "签到前自检");
    }
  }

  function enterSelfCheckPage() {
    const current = getCurrentStep();
    selfCheckReturnStep =
      current === "self-check" ? selfCheckReturnStep : current || "checkin";
    viewStepOverride = "self-check";
    applyStepUI();
    refreshSelfCheckReport({ silent: true });
  }

  function returnFromSelfCheckPage() {
    const target =
      selfCheckReturnStep === "import" ||
      selfCheckReturnStep === "checkin" ||
      selfCheckReturnStep === "score-helper"
        ? selfCheckReturnStep
        : "checkin";
    viewStepOverride = state.step === target ? null : target;
    applyStateToUI();
  }

  function setEgAnalysisButtonStatus(status) {
    if (!btnToggleEgAnalysis) return;
    const running = Boolean(status && status.running);
    const pending = Boolean(status && status.stopping);
    btnToggleEgAnalysis.classList.toggle("btn-eg-analysis--on", running && !pending);
    btnToggleEgAnalysis.classList.toggle("btn-eg-analysis--off", !running && !pending);
    btnToggleEgAnalysis.classList.toggle("btn-eg-analysis--pending", pending);
    btnToggleEgAnalysis.setAttribute("aria-pressed", running ? "true" : "false");
    btnToggleEgAnalysis.disabled = running || pending;
    btnToggleEgAnalysis.textContent = running || pending ? "EG分析中" : "EG分析";
    const detail = status && (status.lastError || status.lastOutput);
    btnToggleEgAnalysis.title = detail ? String(detail).slice(-300) : "启动一次 Egaroucid 子损批量分析";
  }

  async function refreshEgAnalysisStatus({ silent = true } = {}) {
    if (!btnToggleEgAnalysis || !LOCAL_SYNC_ENABLED) return null;
    try {
      const response = await fetch(`${LOCAL_SYNC_EGA_STATUS_URL}?t=${Date.now()}`);
      const result = await response.json().catch(() => null);
      if (!response.ok || !result || result.ok !== true) {
        throw new Error((result && (result.detail || result.error)) || `HTTP ${response.status}`);
      }
      setEgAnalysisButtonStatus(result);
      return result;
    } catch (error) {
      setEgAnalysisButtonStatus({ running: false, lastError: error && error.message ? error.message : String(error || "") });
      if (!silent) showSnackbar("无法读取 EG 分析状态", 2200);
      return null;
    }
  }

  async function toggleEgAnalysis() {
    if (!LOCAL_SYNC_ENABLED) {
      showAlert("无法启动", "请通过本地同步页面 http://127.0.0.1:4174/ 打开后再启动 EG 分析。");
      return;
    }
    const current = await refreshEgAnalysisStatus({ silent: true });
    const running = Boolean(current && current.running);
    if (running) {
      showSnackbar("EG 分析正在运行", 1800);
      return;
    }
    setBtnBusy(btnToggleEgAnalysis, true, "EG分析中", btnToggleEgAnalysis.textContent || "EG分析");
    try {
      const helper = ensureScoreHelper();
      const response = await fetch(LOCAL_SYNC_EGA_START_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          roundLimit: Math.max(1, Math.min(9, Math.trunc(Number(helper.roundCount || 7)))),
          interval: 12,
          nodeRestart: 1000,
          level: 22,
        }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result || result.ok !== true) {
        throw new Error((result && (result.detail || result.error)) || `HTTP ${response.status}`);
      }
      setEgAnalysisButtonStatus(result);
      showSnackbar("EG 分析已启动", 2200);
    } catch (error) {
      const detail = error && error.message ? String(error.message) : String(error || "");
      showAlert("EG 分析启动失败", detail);
    } finally {
      await refreshEgAnalysisStatus({ silent: true });
    }
  }

  async function postFtdRoundToLocalSync(payload) {
    const response = await fetch(LOCAL_SYNC_FTD_ROUND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result || result.ok !== true) {
      throw new Error(
        (result && (result.detail || result.error)) || `HTTP ${response.status}`,
      );
    }
    return result;
  }

  function extractFtdRoundPayloads(parsed) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("FTD JSON 根节点必须是对象");
    }
    if (Object.prototype.hasOwnProperty.call(parsed, "ftdRounds")) {
      if (!Array.isArray(parsed.ftdRounds) || parsed.ftdRounds.length !== 2) {
        throw new Error("决赛阶段合并 JSON 必须同时包含 F 和 3/4 两个阶段");
      }
      const payloads = parsed.ftdRounds.map((item) =>
        item && typeof item === "object" && !Array.isArray(item) ? item : null,
      );
      if (payloads.some((item) => !item)) {
        throw new Error("决赛阶段合并 JSON 中的阶段数据必须是对象");
      }
      const stages = new Set(payloads.map((item) => ftdPayloadStage(item)));
      if (stages.size !== 2 || !stages.has("F") || !stages.has("3/4")) {
        throw new Error("决赛阶段合并 JSON 必须各包含一个 F 和 3/4 阶段");
      }
      return payloads;
    }
    const wrappedFtdRound =
      parsed.ftdRound &&
      typeof parsed.ftdRound === "object" &&
      !Array.isArray(parsed.ftdRound)
        ? parsed.ftdRound
        : null;
    return [wrappedFtdRound || parsed];
  }

  function importFtdRoundFromJSONFile(file) {
    if (!file) return;

    if (!LOCAL_SYNC_ENABLED) {
      showAlert(
        "导入失败",
        "请通过本地同步页面 http://127.0.0.1:4174/ 打开后再导入 FTD JSON。",
      );
      if (ftdRoundJsonInput) ftdRoundJsonInput.value = "";
      return;
    }

    const maxBytes = 5 * 1024 * 1024; // 5MB
    if (Number(file.size) > maxBytes) {
      showAlert(
        "导入失败",
        "FTD JSON 文件过大（超过 5MB），请确认选择的是本轮导出的配对 JSON。",
      );
      if (ftdRoundJsonInput) ftdRoundJsonInput.value = "";
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => {
      console.error("读取 FTD JSON 文件失败：", reader.error);
      showAlert(
        "导入失败",
        "读取 FTD JSON 文件失败，请检查文件是否损坏或编码异常。",
      );
      if (ftdRoundJsonInput) ftdRoundJsonInput.value = "";
    };

    reader.onload = async () => {
      try {
        const text = String(reader.result || "")
          .replace(/^\uFEFF/, "")
          .trim();
        if (!text) throw new Error("文件内容为空");

        const parsed = JSON.parse(text);
        const ftdRounds = extractFtdRoundPayloads(parsed);

        localSyncIgnoreNextFtdEventUntil = Date.now() + 5000;
        const mergedRounds = [];
        for (const ftdRound of ftdRounds) {
          const result = await postFtdRoundToLocalSync({
            ...ftdRound,
            source: ftdRound.source || "frontend-file-import",
          });
          mergedRounds.push(
            await mergeFtdRoundIntoScoreHelper(result.ftdRound, {
              sourceFile: file.name || "",
              currentFile: result.currentFile || result.file || "",
            }),
          );
        }
        flushSave();
        if (mergedRounds.length > 1) {
          const total = mergedRounds[mergedRounds.length - 1].pairingCount;
          showSnackbar(`已一次导入并同步决赛和 3/4 决赛；决赛阶段共 ${total} 台`, 4200);
        } else {
          const merged = mergedRounds[0];
          showSnackbar(
            merged.importedStage
              ? `已导入并同步 FTD ${merged.importedStage}：${merged.importedPairingCount} 台；${merged.label}共 ${merged.pairingCount} 台`
              : `已导入并同步 FTD ${merged.label}配对：${merged.pairingCount} 台`,
            3600,
          );
        }
      } catch (error) {
        localSyncIgnoreNextFtdEventUntil = 0;
        const detail =
          error && error.message ? String(error.message) : String(error || "");
        showAlert(
          "导入失败",
          `无法导入本轮 FTD JSON。请确认选择的是“复制 FTD 导出代码”生成的 ftd-*.json。\n\n${detail}`,
        );
      } finally {
        if (ftdRoundJsonInput) ftdRoundJsonInput.value = "";
      }
    };

    reader.readAsText(file, "utf-8");
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
      ftdRound: sanitizeFtdRoundMeta(state.ftdRound),
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
        ftdRound: parsed.ftdRound,
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
    on(btnOpenSelfCheck, "click", enterSelfCheckPage);
    on(btnSelfCheckBack, "click", returnFromSelfCheckPage);
    on(btnSelfCheckFull, "click", () => runSelfCheck("full"));
    on(btnSelfCheckCheckin, "click", () => runSelfCheck("checkin-ready"));
    on(btnSelfCheckRefresh, "click", () => refreshSelfCheckReport({ silent: false }));
    on(btnScoreBackCheckin, "click", returnToCheckinFromScoreHelper);
    on(btnScoreApplyRounds, "click", () => {
      void applyScoreRoundSettings();
    });
    on(scoreRoundCountInput, "keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      void applyScoreRoundSettings();
    });
    on(btnScoreApplyCurrentTime, "click", () => {
      if (!scoreRoundStartInput) return;
      const snapshot = captureUndoSnapshot();
      scoreRoundStartInput.value = scoreRoundStartInputValueFromDate(new Date());
      syncActiveScoreRoundStartFromInput();
      renderScoreHelper();
      saveAndPushLocalSyncNow();
      showUndoSnackbar("已应用当前时间", () => {
        restoreUndoSnapshot(snapshot);
        saveAndPushLocalSyncNow();
        showSnackbar("已撤销当前时间", 1800);
      });
    });
    on(btnCopyAiRosterReviewPrompt, "click", () => copyAiPrompt("roster"));
    on(btnCopyAiCheckinPollPrompt, "click", () => copyAiPrompt("checkin"));
    on(btnCopyAiFtdMapPrompt, "click", () => copyAiPrompt("mapping"));
    on(btnCopyAiFtdPlayerReviewPrompt, "click", () => copyAiPrompt("playerResolution"));
    on(btnCopyFtdPlayerImportConsole, "click", copyFtdPlayerImportConsoleCode);
    on(btnCopyAiScoreRoundPrompt, "click", () => copyAiPrompt("score"));
    on(btnCopyFtdConsole, "click", () => runManualFtdAction(copyFtdConsoleDownloadCode, "复制 FTD 导出代码"));
    on(btnCopyFtdPlayerConsole, "click", copyFtdPlayerConsoleCode);
    on(btnImportFtdMapJson, "click", () => {
      if (ftdPlayerMapJsonInput) ftdPlayerMapJsonInput.click();
    });
    on(btnRefreshWechatNicks, "click", refreshWechatGroupNicks);
    on(btnSyncOnlineFtdMap, "click", syncOnlineFtdPlayerMap);
    on(btnValidateOqAccounts, "click", validateOqAccountsForMapping);
    on(ftdPlayerMapJsonInput, "change", () => {
      const file = ftdPlayerMapJsonInput.files && ftdPlayerMapJsonInput.files[0];
      importFtdPlayerMapFromJSONFile(file);
    });
    on(btnExportFtdMapPng, "click", exportFtdPlayerMapAsPNG);
    on(btnApplyFtdMapToRoster, "click", () => {
      showConfirm(
        "刷写签到名单",
        "会用映射表中最可靠匹配的 FTD 姓名和 OQ 账号覆盖签到表对应选手。此操作可撤销，确定继续吗？",
        applyFtdPlayerMapToRoster,
        "刷写",
      );
    });
    on(btnClearFtdMap, "click", () => {
      showConfirm(
        "清除映射表",
        "会删除当前映射表里的全部名单和账号映射状态。此操作可撤销，确定继续吗？",
        clearFtdPlayerMapState,
        "清除",
      );
    });
    on(btnCopyFtdScoreConsole, "click", () => runManualFtdAction(copyFtdScoreConsoleCode, "复制 FTD 登分代码"));
    on(btnCopyFtdTranscriptConsole, "click", () => runManualFtdAction(copyFtdTranscriptConsoleCode, "复制本轮棋谱导入代码"));
    on(btnUpdateRoundOqScores, "click", () => {
      if (isFtdAutopilotActive()) showAlert("AP 正在轮询 OQ", "调度由本地协调器负责；请先暂停或停止 AP 再手动更新。");
      else void updateRoundScoresFromOq();
    });
    on(btnToggleOqScorePoll, "click", () => {
      if (isFtdAutopilotActive()) showAlert("AP 正在轮询 OQ", "前端 OQ 轮询已让位给本地协调器；请先暂停或停止 AP。");
      else toggleOqScorePolling();
    });
    on(btnFtdAutopilotProbe, "click", probeFtdAutopilot);
    on(btnFtdAutopilotStart, "click", startFtdAutopilot);
    on(btnFtdAutopilotPause, "click", () => controlFtdAutopilot("pause"));
    on(btnFtdAutopilotResume, "click", () => controlFtdAutopilot("resume"));
    on(btnFtdAutopilotStop, "click", () => controlFtdAutopilot("stop"));
    on(btnToggleEgAnalysis, "click", toggleEgAnalysis);
    on(btnExportEgaReportPng, "click", exportEgaReportPNGs);
    on(btnClearScoreRounds, "click", clearScoreRoundsByPrompt);
    on(scoreFtdUrlInput, "change", () => {
      state.ui.ftdUrl = String((scoreFtdUrlInput && scoreFtdUrlInput.value) || "").trim();
      scheduleSave();
    });
    on(scoreFtdUrlInput, "blur", () => {
      state.ui.ftdUrl = String((scoreFtdUrlInput && scoreFtdUrlInput.value) || "").trim();
      scheduleSave();
    });
    on(scoreOqPollSecondsInput, "change", () => {
      const seconds = oqScorePollSeconds();
      scoreOqPollSecondsInput.value = String(seconds);
      if (!state.ui) state.ui = {};
      state.ui.oqPollSeconds = seconds;
      flushSave();
      if (oqScorePollEnabled) scheduleNextOqScorePoll(Date.now());
    });
    on(scoreOqPollSecondsInput, "blur", () => {
      const seconds = oqScorePollSeconds();
      scoreOqPollSecondsInput.value = String(seconds);
      if (!state.ui) state.ui = {};
      state.ui.oqPollSeconds = seconds;
      flushSave();
      if (oqScorePollEnabled) scheduleNextOqScorePoll(Date.now());
    });
    on(ftdRoundJsonInput, "change", () => {
      const file = ftdRoundJsonInput.files && ftdRoundJsonInput.files[0];
      if (isFtdAutopilotActive()) {
        ftdRoundJsonInput.value = "";
        runManualFtdAction(() => { if (file) importFtdRoundFromJSONFile(file); }, "手动导入本轮 JSON");
      } else {
        importFtdRoundFromJSONFile(file);
      }
    });
    on(scoreRoundTabs, "click", (e) => {
      const target = isElement(e.target) ? e.target : null;
      const btn = target && target.closest("button[data-round]");
      if (!btn) return;
      if (isFtdAutopilotActive()) {
        showAlert("轮次已锁定", "AP 只控制启动时选中的轮次。请先暂停或紧急停止，再切换本地轮次。");
        return;
      }
      const round = Number(btn.dataset.round);
      const helper = ensureScoreHelper();
      if (!Number.isFinite(round) || round < 1 || round > helper.roundCount) return;
      helper.activeRound = Math.trunc(round);
      renderScoreHelper();
      scheduleSave();
    });
    on(scoreFtdPairings, "click", handleFtdPairingAction);
    on(scoreFtdPairings, "change", handleFtdScoreInput);
    on(checkinViewTabs, "click", (e) => {
      const target = isElement(e.target) ? e.target : null;
      const btn = target && target.closest("button[data-checkin-view]");
      if (!btn) return;
      state.ui.checkinView = btn.dataset.checkinView === "mapping" || btn.dataset.checkinView === "ftd-players"
        ? btn.dataset.checkinView
        : "players";
      refreshCheckinUI();
      scheduleSave();
    });
    on(checkinFtdPlayerRegistrationView, "click", (e) => {
      const target = isElement(e.target) ? e.target : null;
      const btn = target && target.closest("button[data-ftd-player-action]");
      if (!btn) return;
      const rowId = String(btn.dataset.rowId || "");
      if (btn.dataset.ftdPlayerAction === "review") showFtdPlayerRefereeDialog(rowId);
      if (btn.dataset.ftdPlayerAction === "reset") {
        showConfirm(
          "重新待核对",
          "会清除该行当前的 Agent/裁判匹配决定，恢复为待 Agent 核对。确定继续吗？",
          () => resetFtdPlayerRegistrationRow(rowId),
          "重置",
        );
      }
    });
    on(checkinFtdPlayerMapView, "change", (e) => {
      const target = isElement(e.target) ? e.target : null;
      if (!target || !target.matches("input[data-ftd-map-name]")) return;
      const cleaned = normalizeOqAccountInput(target.value || "");
      if (target.value !== cleaned) target.value = cleaned;
      if (setFtdPlayerMapAccount(target.dataset.ftdMapName || "", cleaned)) {
        showSnackbar("\u5df2\u66f4\u65b0\u6620\u5c04\u8868\u8d26\u53f7", 1600);
      }
    });
    on(checkinFtdPlayerMapView, "input", (e) => {
      const target = isElement(e.target) ? e.target : null;
      if (target && target.matches("input.score-ftd-map__account[data-ftd-map-name]")) {
        const cleaned = normalizeOqAccountInput(target.value || "");
        if (target.value !== cleaned) target.value = cleaned;
        return;
      }
      if (!target || !target.matches("input[data-ftd-map-nick-search]")) return;
      const box = target.closest(".score-ftd-map__nick-options");
      if (!box) return;
      const q = normalizeKey(target.value || "");
      let shown = 0;
      box.querySelectorAll(".score-ftd-map__nick-option[data-nick-key]").forEach((btn) => {
        const matched = !q || String(btn.dataset.nickKey || "").includes(q);
        btn.hidden = !matched || shown >= 40;
        if (matched && shown < 40) shown += 1;
      });
    });
    on(scoreRoundStartInput, "change", () => {
      syncActiveScoreRoundStartFromInput();
      renderScoreHelper();
      saveAndPushLocalSyncNow();
    });
    on(scoreRoundStartInput, "blur", () => {
      syncActiveScoreRoundStartFromInput();
      saveAndPushLocalSyncNow();
    });
    on(checkinFtdPlayerMapView, "click", (e) => {
      const target = isElement(e.target) ? e.target : null;
      const summary = target && target.closest(".score-ftd-map__nick summary");
      if (summary) {
        e.stopPropagation();
        const details = summary.parentElement;
        if (details && details.tagName === "DETAILS") {
          e.preventDefault();
          details.open = !details.open;
        }
        return;
      }
      const btn = target && target.closest("button[data-ftd-map-action]");
      if (!btn) return;
      const action = btn.dataset.ftdMapAction || "";
      const name = btn.dataset.ftdMapName || "";
      if (action === "delete") {
        setFtdPlayerMapDeleted(name, true);
        showSnackbar("已删除映射行", 1600);
      } else if (action === "restore") {
        setFtdPlayerMapDeleted(name, false);
        showSnackbar("已恢复映射行", 1600);
      } else if (action === "set-nick") {
        setFtdPlayerMapGroupNick(name, btn.dataset.groupNick || "");
        showSnackbar("已选择群昵称", 1600);
      } else if (action === "clear-nick") {
        setFtdPlayerMapGroupNick(name, "");
        showSnackbar("已清除群昵称", 1600);
      } else if (action === "force-oq") {
        if (forceFtdPlayerMapOqValidation(name)) {
          showSnackbar("\u5df2\u5f3a\u5236\u901a\u8fc7 OQ \u6821\u9a8c", 1600);
        }
      }
    });
    on(
      scoreFtdSearchBox,
      "input",
      debounce(() => {
        updateClearScoreFtdSearchButton();
        renderScoreHelper();
      }, 120),
    );
    if (btnClearScoreFtdSearch) {
      on(btnClearScoreFtdSearch, "click", () => {
        if (scoreFtdSearchBox) {
          scoreFtdSearchBox.value = "";
          btnClearScoreFtdSearch.hidden = true;
          renderScoreHelper();
          scoreFtdSearchBox.focus();
        }
      });
    }
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
        if (getCheckinView() === "mapping") {
          renderCheckinFtdPlayerMap();
        } else {
          const visiblePlayers = getVisiblePlayers();
          updateStats(visiblePlayers);
          renderPlayerList(visiblePlayers);
        }
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
        if (e.shiftKey) confirmLastCopiedFtdConsoleAction();
        else completeTopScoreItem();
        return;
      }

      if (
        e.key === "Enter" &&
        e.shiftKey &&
        getCurrentStep() === "checkin" &&
        !(e.target && /input|textarea|select/i.test(e.target.tagName || ""))
      ) {
        const registration = FTD_PLAYER_REGISTRATION.sanitizeRegistration(state.ftdPlayerRegistration);
        if (registration.pendingBatch && registration.pendingBatch.status === "pending") {
          e.preventDefault();
          void applyFtdPlayerConsoleResultFromClipboard();
          return;
        }
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
    updateClearScoreFtdSearchButton();
    updateAutosaveChip(state.savedAt);
    renderGroupRulesEditor();

    if (competitionTitleEl)
      competitionTitleEl.textContent = state.competitionName || "比赛签到表";
    if (competitionNameInput)
      competitionNameInput.value = state.competitionName || "";
    if (scoreFtdUrlInput)
      scoreFtdUrlInput.value = (state.ui && state.ui.ftdUrl) || "";

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
    } else if (step === "self-check") {
      refreshSelfCheckReport({ silent: true });
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
    setupFtdPlayerMapSwipeGestures();

    // Mainland CN: many users open this in in-app browsers (WeChat/QQ/Weibo...).
    // These webviews may restrict downloads & PWA installation; show a one-time tip.
    maybeShowInAppBrowserTipOnce();

    const preferences = loadBrowserPreferences();
    if (preferences && preferences.ui && typeof preferences.ui === "object") {
      state.ui = { ...(state.ui || {}), ...preferences.ui };
    }
    if (preferences && Number(preferences.viewedRound) > 0 && state.scoreHelper) {
      state.scoreHelper.activeRound = Math.trunc(Number(preferences.viewedRound));
    }
    if (preferences && ["import", "checkin", "score-helper"].includes(preferences.viewedStep)) {
      state.step = preferences.viewedStep;
    }
    applyStateToUI(true);

    startLocalSync();
    if (LOCAL_SYNC_ENABLED) {
      void refreshFtdAutopilotStatus();
      ftdAutopilotStatusTimer = window.setInterval(() => {
        void refreshFtdAutopilotStatus();
      }, 2000);
    }
    refreshSelfCheckReport({ silent: true });
    refreshEgAnalysisStatus({ silent: true });
    if (LOCAL_SYNC_ENABLED && btnToggleEgAnalysis) {
      window.setInterval(() => {
        refreshEgAnalysisStatus({ silent: true });
      }, 5000);
    }
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
      // Score-helper rendering regressions
      sanitizeLoadedState,
      sanitizeScoreHelper,
      getActiveScoreRound,
      extractFtdRoundPayloads,
      ftdBatchTargetRounds,
      syncScoreRoundCountInput,
      normalizeFtdStage,
      scoreStageLabel,
      isAgentPendingScoreItem,
      isUserPendingScoreItem,
      renderScoreItem,
      renderFtdTranscriptImportTag,
      renderFtdPairingStatusMetadata,
      ftdPairingRowStatusClass,
      ftdBatchItemKey,
      formatFtdTranscriptNoEligibleMessage,
    };
    return;
  }

  init();
})();
