"use strict";

const fs = require("fs");
const path = require("path");
const {
  compactPinyinName,
  matchReasons,
  senderLeadAlias,
} = require("./agent_roster_matcher");

const [, , statePathArg, historyPathArg, windowLabelArg] = process.argv;

if (!statePathArg || !historyPathArg) {
  console.error(
    "Usage: node agent_apply_checkin_window.js <state-json> <history-json> [window-label]",
  );
  process.exit(2);
}

const statePath = path.resolve(statePathArg);
const historyPath = path.resolve(historyPathArg);
const windowLabel = String(windowLabelArg || path.basename(historyPath));
const DISPUTE_CONTEXT_MS = 3 * 60 * 1000;
const DISPUTE_RE = /请个假|请假|不参赛|不参加|退赛|弃权|不比|不能参赛|不下|退出/;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function messageMillis(message) {
  const ts = Number(message && message.timestamp);
  if (Number.isFinite(ts) && ts > 0) return ts * 1000;
  const parsed = Date.parse(String((message && message.time) || "").replace(" ", "T"));
  return Number.isFinite(parsed) ? parsed : 0;
}

function disputeContextFor(history, message) {
  const sender = String(message.sender || "");
  const currentMs = messageMillis(message);
  if (!sender || !currentMs) return [];
  return history.messages
    .filter((item) => String(item.sender || "") === sender)
    .filter((item) => item !== message)
    .map((item) => ({
      item,
      delta: Math.abs(messageMillis(item) - currentMs),
      content: String(item.content || "").trim(),
    }))
    .filter((x) => x.delta <= DISPUTE_CONTEXT_MS && DISPUTE_RE.test(x.content))
    .map((x) => ({
      time: x.item.time,
      sender: x.item.sender,
      content: x.content,
    }));
}

function applyWindow() {
  const state = readJson(statePath);
  const history = readJson(historyPath);
  if (!state || Number(state.version) !== 2 || !Array.isArray(state.players)) {
    throw new Error(`Invalid state file: ${statePath}`);
  }
  if (!history || !Array.isArray(history.messages)) {
    throw new Error(`Invalid history file: ${historyPath}`);
  }

  const ambiguities = [];
  const unmatched = [];
  const applied = [];
  const already = [];
  const ignored = [];
  const disputes = [];
  const reviewItems = [];
  const endMinute = (() => {
    const candidates = [
      windowLabel,
      history && history.range && history.range.end,
    ].filter(Boolean);
    for (const value of candidates) {
      const match = String(value).match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*$/);
      if (!match) continue;
      return Number(match[1]) * 60 + Number(match[2]);
    }
    return null;
  })();

  for (const message of history.messages) {
    const rawContent = String(message.content || "").trim();
    const repeatedOne = /^1{1,4}$/.test(rawContent);
    const repeatedTwo = /^2{1,4}$/.test(rawContent);
    const content = repeatedOne ? "1" : repeatedTwo ? "2" : rawContent;
    if (content !== "1" && content !== "2") {
      ignored.push({
        time: message.time,
        sender: message.sender,
        content: rawContent,
        reason: "not-checkin-code",
      });
      continue;
    }

    const sender = String(message.sender || "");
    const disputeContext = disputeContextFor(history, message);
    if (disputeContext.length) {
      const item = {
        time: message.time,
        sender,
        content,
        context: disputeContext,
        reason: "leave-or-nonparticipant-context",
      };
      disputes.push(item);
      reviewItems.push({
        time: message.time,
        sender,
        content,
        status: "dispute",
        matchedDisplayName: "",
        matchReasons: [],
        candidateDisplayNames: [],
        disputeContext: disputeContext.map((x) => ({
          time: x.time,
          content: x.content,
        })),
        reason: item.reason,
      });
      continue;
    }

    const candidates = state.players
      .map((player) => ({
        player,
        reasons: matchReasons(player, sender),
      }))
      .filter((x) => x.reasons.length);
    const accountCandidates = candidates.filter((x) =>
      x.reasons.includes("account"),
    );
    const lead = senderLeadAlias(sender);
    const leadCandidates = lead
      ? candidates.filter((x) => compactPinyinName(x.player.displayName).includes(lead))
      : [];
    const effectiveCandidates =
      leadCandidates.length === 1
        ? leadCandidates
        : accountCandidates.length === 1
          ? accountCandidates
          : candidates;

    if (effectiveCandidates.length !== 1) {
      const candidateDisplayNames = candidates.map((x) => x.player.displayName);
      const item = {
        time: message.time,
        sender,
        content,
        candidates: candidates.map((x) => ({
          displayName: x.player.displayName,
          account: x.player.account,
          reasons: x.reasons,
        })),
      };
      if (effectiveCandidates.length === 0) unmatched.push(item);
      else ambiguities.push(item);
      reviewItems.push({
        time: message.time,
        sender,
        content,
        status: effectiveCandidates.length === 0 ? "unmatched" : "ambiguous",
        matchedDisplayName: "",
        matchReasons: [],
        candidateDisplayNames,
      });
      continue;
    }

    const player = effectiveCandidates[0].player;
    const matchReasonsForPlayer = effectiveCandidates[0].reasons;
    const matchedDisplayName = player.displayName;
    const candidateDisplayNames = candidates.map((x) => x.player.displayName);
    const checkedInAt = Number(message.timestamp) * 1000;
    if (content === "2") player.isNew = true;

    if (player.checkedIn) {
      already.push({
        time: message.time,
        sender,
        player: player.displayName,
        content,
      });
      reviewItems.push({
        time: message.time,
        sender,
        content,
        status: "already",
        matchedDisplayName,
        matchReasons: matchReasonsForPlayer,
        candidateDisplayNames,
      });
      continue;
    }

    player.checkedIn = true;
    player.checkedInAt = Number.isFinite(checkedInAt) ? checkedInAt : Date.now();
    applied.push({
      time: message.time,
      sender,
      player: player.displayName,
      content,
      reasons: matchReasonsForPlayer,
    });
    reviewItems.push({
      time: message.time,
      sender,
      content,
      status: "matched",
      matchedDisplayName,
      matchReasons: matchReasonsForPlayer,
      candidateDisplayNames,
    });
  }

  if (ambiguities.length || unmatched.length || disputes.length) {
    return {
      ok: false,
      window: windowLabel,
      reviewItems,
      appliedPreview: applied,
      disputes,
      ambiguities,
      unmatched,
      waiting: state.players
        .filter((p) => !p.checkedIn)
        .map((p) => p.displayName),
      reviewReminder:
        endMinute !== null && endMinute >= 19 * 60 + 55
          ? "19:55+ review required: manually inspect waiting players against all chat messages and recheck possible false positives before finalizing."
          : undefined,
    };
  }

  state.savedAt = Date.now();
  state.localSync = {
    ...(state.localSync && typeof state.localSync === "object"
      ? state.localSync
      : {}),
    source: "agent-checkin-poll-sim",
    savedAt: state.savedAt,
    lastWindow: windowLabel,
  };
  writeJson(statePath, state);

  return {
    ok: true,
    window: windowLabel,
    reviewItems,
    applied,
    already,
    checked: state.players.filter((p) => p.checkedIn).length,
    total: state.players.length,
    waiting: state.players.filter((p) => !p.checkedIn).map((p) => p.displayName),
    newMarked: state.players.filter((p) => p.isNew).map((p) => p.displayName),
    reviewReminder:
      endMinute !== null && endMinute >= 19 * 60 + 55
        ? "19:55+ review required: manually inspect waiting players against all chat messages and recheck possible false positives before finalizing."
        : undefined,
  };
}

try {
  console.log(JSON.stringify(applyWindow(), null, 2));
} catch (error) {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
}
