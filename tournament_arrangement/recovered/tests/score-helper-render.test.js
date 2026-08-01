"use strict";

const assert = require("assert");
const {
  isAgentPendingScoreItem,
  isUserPendingScoreItem,
  renderScoreItem,
  sanitizeLoadedState,
  sanitizeScoreHelper,
  syncScoreRoundCountInput,
  normalizeFtdStage,
  scoreStageLabel,
  emptyFtdPlayerRegistrationEntity,
} = require("../app.js");

const mismatchItem = {
  id: "agent-score-render-test",
  round: 5,
  sender: "ZHU Linyun",
  wechatSender: "zhulinyun",
  verdict: "account-mismatch",
  accountMismatchText:
    "图上id: hughug0831, 89555188 / 注册id: hughug0831, 当前第8桌Peng Xianlu账号未完整映射 / 姓名: ZHANG Yize, Peng Xianlu",
  pendingKind: "",
  pendingTable: "8",
  table: "8",
  reviewAction: "",
};

assert.strictEqual(isAgentPendingScoreItem(mismatchItem), true);

const html = renderScoreItem(mismatchItem, 0, "pending");
assert.ok(html.includes("第 8 桌 账号待核对"));
assert.ok(html.includes("状态 account-mismatch"));
assert.ok(html.includes("score-card__reason score-card__reason--mismatch"));
assert.ok(html.includes("<div>账号核对：</div>"));
assert.ok(html.includes("<div>图上id: hughug0831, 89555188</div>"));
assert.ok(
  html.includes("<div>注册id: hughug0831, 当前第8桌Peng Xianlu账号未完整映射</div>"),
);
assert.ok(html.includes("<div>姓名: ZHANG Yize, Peng Xianlu</div>"));
assert.ok(html.includes("发图者群昵称：zhulinyun"));

const normalItem = {
  sender: "Normal Player",
  loserStoneCount: 20,
  verdict: "board-result",
};

assert.strictEqual(isAgentPendingScoreItem(normalItem), false);
assert.ok(renderScoreItem(normalItem, 0, "pending").includes("选手：Normal Player"));

const userPendingItem = {
  sender: "第 3 台 A vs B",
  verdict: "user-pending",
  pendingKind: "user-pending",
  pendingTable: "3",
  table: "3",
  reason: "裁判手动核对",
  originalStatus: "ready",
  originalScore: "42:22",
  dirty: true,
};

assert.strictEqual(isUserPendingScoreItem(userPendingItem), true);
const userPendingHtml = renderScoreItem(userPendingItem, 1, "pending");
assert.ok(userPendingHtml.includes("第 3 桌 pending"));
assert.ok(userPendingHtml.includes("原因：裁判手动核对"));
assert.ok(userPendingHtml.includes("原比分 42:22"));
assert.ok(!userPendingHtml.includes(">脏<"));

const loaded = sanitizeLoadedState({
  version: 2,
  step: "score-helper",
  players: [],
  scoreHelper: {
    version: 1,
    roundCount: 1,
    activeRound: 1,
    rounds: [
      {
        round: 1,
        pending: [
          {
            id: "agent-score-sanitize-test",
            round: 1,
            sender: "luo wei",
            wechatSender: "luo wei",
            verdict: "account-mismatch",
            accountMismatchText: "图上id: wrong / 注册id: idsetbyuser3 / 姓名: luo wei",
            pendingKind: "agent-abnormality",
            pendingTable: "13",
            table: "13",
            resultTime: "2026-06-06 20:27:53",
            resultSortKey: 1780748873000,
            sourceMessageKey: "1780748873:2916:wxid_ckdgoynbwk0622",
          },
        ],
        manualPending: [],
        completed: [],
        ftdPairings: [],
      },
    ],
  },
});

assert.ok(loaded);
assert.strictEqual(loaded.scoreHelper.preliminaryRoundCount, 1);
assert.strictEqual(loaded.scoreHelper.roundCount, 3);
assert.deepStrictEqual(
  loaded.scoreHelper.rounds.map((round) => round.stage),
  ["preliminary", "semifinal", "finals"],
);
assert.strictEqual(loaded.scoreHelper.rounds[0].pending[0].sourceTime, "");
assert.strictEqual(loaded.scoreHelper.rounds[0].pending[0].resultTime, "2026-06-06 20:27:53");
assert.strictEqual(loaded.scoreHelper.rounds[0].pending[0].resultSortKey, 1780748873000);

assert.strictEqual(normalizeFtdStage("Semi-Finals"), "SF");
assert.strictEqual(normalizeFtdStage("Match for 3rd Place"), "3/4");
assert.strictEqual(normalizeFtdStage("Finals"), "F");

const stageAware = sanitizeScoreHelper({
  version: 2,
  preliminaryRoundCount: 5,
  roundCount: 7,
  activeRound: 7,
  rounds: [
    ...Array.from({ length: 5 }, (_, index) => ({ round: index + 1, stage: "preliminary" })),
    { round: 6, stage: "semifinal", ftdPairings: [{ table: 1, black: "A", white: "D" }, { table: 2, black: "B", white: "C" }] },
    { round: 7, stage: "finals", ftdPairings: [
      { table: 1, black: "A", white: "B", ftdStage: "F", ftdRound: 120, ftdTable: 1 },
      { table: 2, black: "C", white: "D", ftdStage: "3/4", ftdRound: 121, ftdTable: 1 },
    ] },
  ],
});
assert.strictEqual(stageAware.roundCount, 7);
assert.strictEqual(scoreStageLabel(stageAware.rounds[5]), "半决赛");
assert.strictEqual(scoreStageLabel(stageAware.rounds[6]), "决赛阶段");
assert.deepStrictEqual(stageAware.rounds[6].ftdPairings.map((item) => item.table), [1, 2]);
assert.deepStrictEqual(stageAware.rounds[6].ftdPairings.map((item) => item.ftdTable), [1, 1]);

const editingRoundCountInput = { value: "7" };
assert.strictEqual(syncScoreRoundCountInput(editingRoundCountInput, 6, editingRoundCountInput), false);
assert.strictEqual(editingRoundCountInput.value, "7");
assert.strictEqual(syncScoreRoundCountInput(editingRoundCountInput, 6, null), true);
assert.strictEqual(editingRoundCountInput.value, "6");
assert.strictEqual(syncScoreRoundCountInput(editingRoundCountInput, 6, null), false);

const clearedFtdPlayers = emptyFtdPlayerRegistrationEntity({
  entityId: "registration:metadata",
  entityRevision: 17,
  rows: [{ rowId: "player-1" }],
  pendingBatch: { batchId: "old-batch" },
});
assert.strictEqual(clearedFtdPlayers.entityId, "registration:metadata");
assert.strictEqual(clearedFtdPlayers.entityRevision, 17);
assert.deepStrictEqual(clearedFtdPlayers.rows, []);
assert.strictEqual(clearedFtdPlayers.pendingBatch, null);
assert.deepStrictEqual(clearedFtdPlayers.consumedBatchIds, []);

console.log("score-helper render tests passed");
