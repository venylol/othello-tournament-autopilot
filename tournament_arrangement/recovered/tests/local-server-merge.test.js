"use strict";

const assert = require("assert");
const {
  normalizeFtdRoundPayload,
  rebuildFtdPlayerAccountMappingCounts,
  mappingRowNeedsManualOqValidation,
  mergeFtdPlayerAccountMappingForAnyPost,
  mergeStateForApiPost,
  mergeScoreHelperFtdPairingsForFrontendPost,
} = require("../local-server.js");

function makeState(pendingItem) {
  return {
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
          pending: [pendingItem],
          manualPending: [],
          completed: [],
          ftdPairings: [
            {
              table: 1,
              black: "Black Player",
              white: "White Player",
              status: "imported",
            },
          ],
        },
      ],
    },
  };
}

{
  const current = makeState({
    id: "agent-score-1",
    round: 1,
    sender: "Black Player",
    wechatSender: "Black Player group",
    verdict: "account-mismatch",
    accountMismatchText: "图上id: wrong / 注册id: right / 姓名: Black Player",
    pendingKind: "agent-abnormality",
    pendingTable: "1",
    table: "1",
    reviewAction: "review in frontend",
    sourceMessageKey: "msg-1",
  });
  const incoming = makeState({
    id: "agent-score-1",
    round: 1,
    sender: "Black Player",
    wechatSender: "",
    verdict: "account-mismatch",
    accountMismatchText: "",
    pendingKind: "",
    pendingTable: "1",
    table: "1",
    reviewAction: "",
    sourceMessageKey: "msg-1",
  });

  const result = mergeScoreHelperFtdPairingsForFrontendPost(incoming, current);
  const item = result.state.scoreHelper.rounds[0].pending[0];
  assert.strictEqual(item.accountMismatchText, current.scoreHelper.rounds[0].pending[0].accountMismatchText);
  assert.strictEqual(item.pendingKind, "agent-abnormality");
  assert.strictEqual(item.reviewAction, "review in frontend");
  assert.strictEqual(item.wechatSender, "Black Player group");
  assert.strictEqual(result.preservedPending.length, 1);
}

{
  const current = makeState({
    id: "agent-score-2",
    round: 1,
    sender: "Black Player",
    wechatSender: "Old group",
    verdict: "account-mismatch",
    accountMismatchText: "old text",
    pendingKind: "agent-abnormality",
    pendingTable: "1",
    table: "1",
    reviewAction: "old action",
    sourceMessageKey: "msg-2",
  });
  const incoming = makeState({
    id: "agent-score-2",
    round: 1,
    sender: "Black Player",
    wechatSender: "New group",
    verdict: "account-mismatch",
    accountMismatchText: "new text",
    pendingKind: "agent-referee-edited",
    pendingTable: "1",
    table: "1",
    reviewAction: "new action",
    sourceMessageKey: "msg-2",
  });

  const result = mergeScoreHelperFtdPairingsForFrontendPost(incoming, current);
  const item = result.state.scoreHelper.rounds[0].pending[0];
  assert.strictEqual(item.accountMismatchText, "new text");
  assert.strictEqual(item.pendingKind, "agent-referee-edited");
  assert.strictEqual(item.reviewAction, "new action");
  assert.strictEqual(item.wechatSender, "New group");
  assert.strictEqual(result.preservedPending.length, 0);
}

{
  const current = makeState({
    id: "agent-score-missing",
    round: 1,
    sender: "Black Player",
    wechatSender: "Black Player group",
    verdict: "account-mismatch",
    accountMismatchText: "visible id / registered id / Black Player",
    pendingKind: "agent-abnormality",
    pendingTable: "1",
    table: "1",
    reviewAction: "review in frontend",
    sourceMessageKey: "msg-missing",
  });
  const incoming = makeState({
    id: "other-pending",
    round: 1,
    sender: "White Player",
    pendingKind: "user-pending",
    pendingTable: "1",
    table: "1",
    sourceMessageKey: "user-pending",
  });

  const result = mergeScoreHelperFtdPairingsForFrontendPost(incoming, current);
  const pending = result.state.scoreHelper.rounds[0].pending;
  assert.strictEqual(pending.length, 2);
  assert.strictEqual(pending[0].sourceMessageKey, "msg-missing");
  assert.strictEqual(pending[0].accountMismatchText, "visible id / registered id / Black Player");
  assert.strictEqual(result.preservedPending.length, 1);
  assert.strictEqual(result.preservedPending[0].preservedMissingAgentPending, true);
}

{
  const current = makeState({
    id: "resolved-agent-score",
    round: 1,
    sender: "Black Player",
    wechatSender: "Black Player group",
    verdict: "account-mismatch",
    accountMismatchText: "old mismatch",
    pendingKind: "agent-abnormality",
    pendingTable: "1",
    table: "1",
    sourceMessageKey: "resolved-msg",
    resolvedByReferee: true,
  });
  const incoming = makeState({
    id: "other-pending",
    round: 1,
    sender: "White Player",
    pendingKind: "user-pending",
    pendingTable: "1",
    table: "1",
    sourceMessageKey: "user-pending",
  });

  const result = mergeScoreHelperFtdPairingsForFrontendPost(incoming, current);
  const pending = result.state.scoreHelper.rounds[0].pending;
  assert.strictEqual(pending.length, 1);
  assert.strictEqual(pending[0].sourceMessageKey, "user-pending");
  assert.strictEqual(result.preservedPending.length, 0);
}

{
  const current = makeState({
    id: "agent-score-3",
    round: 1,
    sender: "Black Player",
    pendingTable: "1",
  });
  current.ftdPlayerAccountMapping = {
    updatedAt: Date.now(),
    players: [
      {
        ftdName: "Black Player",
        account: "black_oq",
        status: "matched",
        editAudit: { by: "agent", at: new Date().toISOString() },
      },
    ],
  };
  const incoming = makeState({
    id: "agent-score-3",
    round: 1,
    sender: "Black Player",
    pendingTable: "1",
  });
  incoming.ftdPlayerAccountMapping = null;

  const result = mergeScoreHelperFtdPairingsForFrontendPost(incoming, current);
  assert.strictEqual(result.preservedFtdPlayerAccountMapping, true);
  assert.strictEqual(result.state.ftdPlayerAccountMapping.players[0].account, "black_oq");
}

{
  const current = makeState({
    id: "agent-score-4",
    round: 1,
    sender: "Black Player",
    pendingTable: "1",
  });
  current.ftdPlayerAccountMapping = {
    updatedAt: Date.now(),
    players: [
      {
        ftdName: "Black Player",
        account: "old_agent",
        status: "matched",
        editAudit: { by: "agent", at: "2026-06-08T10:00:00.000Z" },
      },
      {
        ftdName: "White Player",
        account: "white_user",
        status: "matched",
        editAudit: { by: "user", at: "2026-06-08T10:01:00.000Z" },
      },
    ],
  };
  const incoming = makeState({
    id: "agent-score-4",
    round: 1,
    sender: "Black Player",
    pendingTable: "1",
  });
  incoming.ftdPlayerAccountMapping = {
    updatedAt: Date.now(),
    players: [
      {
        ftdName: "Black Player",
        account: "new_user",
        status: "matched",
        editAudit: { by: "user", at: "2026-06-08T10:05:00.000Z" },
      },
      {
        ftdName: "White Player",
        account: "stale_browser",
        status: "matched",
        editAudit: { by: "user", at: "2026-06-08T09:59:00.000Z" },
      },
    ],
  };

  const result = mergeScoreHelperFtdPairingsForFrontendPost(incoming, current);
  const rows = new Map(result.state.ftdPlayerAccountMapping.players.map((row) => [row.ftdName, row]));
  assert.strictEqual(rows.get("Black Player").account, "new_user");
  assert.strictEqual(rows.get("White Player").account, "white_user");
  assert.strictEqual(result.preservedFtdPlayerAccountMapping, true);
}

{
  const current = makeState({
    id: "agent-score-5",
    round: 1,
    sender: "Black Player",
    pendingTable: "1",
  });
  current.ftdPlayerAccountMapping = {
    updatedAt: Date.now(),
    players: [
      {
        ftdName: "Black Player",
        account: "black_oq",
        status: "matched",
        editAudit: { by: "agent", at: "2026-06-08T10:00:00.000Z" },
      },
    ],
  };
  const incoming = makeState({
    id: "agent-score-5",
    round: 1,
    sender: "Black Player",
    pendingTable: "1",
  });
  incoming.ftdPlayerAccountMapping = {
    type: "ftd-player-oq-account-map-clear",
    cleared: true,
    clearedAt: "2026-06-08T10:10:00.000Z",
  };

  const result = mergeScoreHelperFtdPairingsForFrontendPost(incoming, current);
  assert.strictEqual(result.state.ftdPlayerAccountMapping, null);
  assert.strictEqual(result.preservedFtdPlayerAccountMapping, undefined);
}

{
  const current = makeState({
    id: "agent-score-6",
    round: 1,
    sender: "Black Player",
    pendingTable: "1",
  });
  current.ftdPlayerAccountMapping = {
    updatedAt: Date.now(),
    players: [
      {
        ftdName: "Black Player",
        account: "fresh_user",
        status: "matched",
        editAudit: { by: "user", at: "2026-06-08T10:20:00.000Z" },
      },
    ],
  };
  const incoming = makeState({
    id: "agent-score-6",
    round: 1,
    sender: "Black Player",
    pendingTable: "1",
  });
  incoming.ftdPlayerAccountMapping = {
    updatedAt: Date.now(),
    players: [
      {
        ftdName: "Black Player",
        account: "stale_agent_read",
        status: "matched",
        editAudit: { by: "agent", at: "2026-06-08T10:10:00.000Z" },
      },
    ],
  };

  const result = mergeFtdPlayerAccountMappingForAnyPost(incoming, current);
  assert.strictEqual(result.state.ftdPlayerAccountMapping.players[0].account, "fresh_user");
  assert.strictEqual(result.preservedFtdPlayerAccountMapping, true);
}

{
  const current = makeState({
    id: "agent-score-7",
    round: 1,
    sender: "Black Player",
    pendingTable: "1",
  });
  current.ftdPlayerAccountMapping = {
    updatedAt: Date.now(),
    players: [
      {
        ftdName: "Black Player",
        account: "black_oq",
        groupNick: "",
        status: "matched",
        editAudit: { by: "agent", at: "2026-06-08T10:20:00.000Z" },
      },
      {
        ftdName: "White Player",
        account: "white_oq",
        groupNick: "White Player white_oq",
        oqCheck: { status: "ok", checkedAt: "2026-06-08T10:20:00.000Z" },
        status: "matched",
        editAudit: { by: "agent", at: "2026-06-08T10:20:00.000Z" },
      },
    ],
  };
  const incoming = makeState({
    id: "agent-score-7",
    round: 1,
    sender: "Black Player",
    pendingTable: "1",
  });
  incoming.ftdPlayerAccountMapping = current.ftdPlayerAccountMapping;

  const result = mergeFtdPlayerAccountMappingForAnyPost(incoming, current);
  const mapping = result.state.ftdPlayerAccountMapping;
  assert.strictEqual(mapping.matchedCount, 1);
  assert.strictEqual(mapping.unmatchedCount, 1);
  assert.strictEqual(Object.keys(mapping.accountIndex).length, 1);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(mapping.players[0], "status"), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(mapping.players[1], "status"), false);
}

{
  const mapping = rebuildFtdPlayerAccountMappingCounts({
    players: [
      {
        ftdName: "ZHANG Yize",
        account: "hughug0831qinqin1226",
        groupNick: "zhangyize (hughug0831qinqin1226",
        status: "matched",
        oqCheck: {
          account: "hughug0831",
          status: "ok",
          checkedAt: "2026-06-08T19:30:44+08:00",
          totalGames: 18,
        },
      },
    ],
  });
  assert.strictEqual(mapping.matchedCount, 0);
  assert.strictEqual(mapping.unmatchedCount, 1);
  assert.strictEqual(mapping.invalidAccountCount, 0);
  assert.strictEqual(Object.keys(mapping.accountIndex).length, 0);
  assert.strictEqual(mapping.players[0].oqCheck, null);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(mapping.players[0], "status"), false);
}

{
  assert.strictEqual(
    mappingRowNeedsManualOqValidation({
      ftdName: "Done Player",
      account: "done_oq",
      groupNick: "Done done_oq",
      oqCheck: {
        account: "done_oq",
        status: "ok",
        checkedAt: "2026-06-08T10:00:00.000Z",
      },
      editAudit: { by: "user", at: "2026-06-08T10:05:00.000Z" },
    }),
    false,
  );
  assert.strictEqual(
    mappingRowNeedsManualOqValidation({
      ftdName: "Failed Player",
      account: "failed_oq",
      groupNick: "Failed failed_oq",
      oqCheck: {
        account: "failed_oq",
        status: "invalid",
        checkedAt: "2026-06-08T10:00:00.000Z",
      },
    }),
    true,
  );
  assert.strictEqual(
    mappingRowNeedsManualOqValidation({
      ftdName: "Changed Player",
      account: "new_oq",
      groupNick: "Changed new_oq",
      oqCheck: {
        account: "old_oq",
        status: "ok",
        checkedAt: "2026-06-08T10:00:00.000Z",
      },
    }),
    true,
  );
  assert.strictEqual(
    mappingRowNeedsManualOqValidation({
      ftdName: "No Check Player",
      account: "needs_oq",
      groupNick: "Needs needs_oq",
      editAudit: { by: "user", at: "2026-06-08T10:05:00.000Z" },
    }),
    true,
  );
}

{
  const mapping = rebuildFtdPlayerAccountMappingCounts({
    players: [
      {
        ftdName: "Deleted Player",
        account: "old_oq",
        groupNick: "Deleted Player old_oq",
        status: "deleted",
      },
      {
        ftdName: "Invalid Player",
        account: "bad_oq",
        groupNick: "Invalid Player bad_oq",
        status: "matched",
        oqCheck: {
          account: "bad_oq",
          status: "invalid",
        },
      },
      {
        ftdName: "Good Player",
        account: "good_oq",
        groupNick: "Good Player good_oq",
        status: "unmatched",
        oqCheck: {
          account: "good_oq",
          status: "ok",
        },
      },
    ],
  });
  assert.strictEqual(mapping.players[0].deleted, true);
  assert.strictEqual(mapping.players.some((row) => Object.prototype.hasOwnProperty.call(row, "status")), false);
  assert.strictEqual(mapping.playerCount, 3);
  assert.strictEqual(mapping.matchedCount, 1);
  assert.strictEqual(mapping.invalidAccountCount, 1);
  assert.strictEqual(mapping.unmatchedCount, 0);
}

{
  const current = makeState({
    id: "agent-score-8",
    round: 1,
    sender: "Black Player",
    pendingTable: "1",
  });
  current.scoreHelper.rounds[0].ftdPairings[0] = {
    table: 1,
    black: "Black Player",
    white: "White Player",
    status: "ready",
    blackScore: 40,
    whiteScore: 24,
    lastEditedBy: "user",
    lastEditedAt: 1000,
    userEditedFields: { blackScore: 1000, whiteScore: 1000, status: 1000 },
  };
  const incoming = makeState({
    id: "agent-score-8",
    round: 1,
    sender: "Black Player",
    pendingTable: "1",
  });
  incoming.scoreHelper.rounds[0].ftdPairings[0] = {
    table: 1,
    black: "Black Player",
    white: "White Player",
    status: "ready",
    blackScore: 50,
    whiteScore: 14,
    lastEditedBy: "agent",
    updatedAt: 2000,
  };

  const result = mergeFtdPlayerAccountMappingForAnyPost(incoming, current);
  const row = result.state.scoreHelper.rounds[0].ftdPairings[0];
  assert.strictEqual(row.blackScore, 40);
  assert.strictEqual(row.whiteScore, 24);
  assert.strictEqual(row.lastEditedBy, "user");
  assert.strictEqual(result.preserved.length, 1);
}

{
  const current = makeState(null);
  current.scoreHelper.rounds[0].pending = [];
  current.scoreHelper.rounds[0].ftdPairings[0] = {
    table: 1,
    black: "Black Player",
    white: "White Player",
    status: "completed",
    blackScore: 0,
    whiteScore: 64,
    resultKind: "absence",
    reason: "Black Player 缺席",
    lastEditedBy: "user",
    lastEditedAt: 1000,
    updatedAt: 1000,
    userEditedFields: {
      status: 1000,
      blackScore: 1000,
      whiteScore: 1000,
      resultKind: 1000,
    },
  };
  const incoming = makeState(null);
  incoming.scoreHelper.rounds[0].pending = [];
  incoming.scoreHelper.rounds[0].ftdPairings[0] = {
    table: 1,
    black: "Black Player",
    white: "White Player",
    status: "ready",
    blackScore: 38,
    whiteScore: 26,
    resultKind: "oq-auto",
    sourceMessageKey: "oq-auto:id:newer",
    lastEditedBy: "agent",
    updatedAt: 5000,
  };

  const result = mergeFtdPlayerAccountMappingForAnyPost(incoming, current);
  const row = result.state.scoreHelper.rounds[0].ftdPairings[0];
  assert.strictEqual(row.status, "completed");
  assert.strictEqual(row.resultKind, "absence");
  assert.strictEqual(row.blackScore, 0);
  assert.strictEqual(row.whiteScore, 64);
  assert.strictEqual(row.lastEditedBy, "user");
  assert.strictEqual(result.preserved.length, 1);
}

{
  const current = makeState({
    id: "agent-score-9",
    round: 1,
    sender: "Black Player",
    pendingTable: "1",
  });
  current.scoreHelper.roundCount = 6;
  current.scoreHelper.activeRound = 6;
  current.scoreHelper.rounds = Array.from({ length: 6 }, (_, index) => ({
    round: index + 1,
    pending: [],
    manualPending: [],
    completed: [],
    ftdPairings: index === 5
      ? [
          {
            table: 1,
            black: "Round Six Black",
            white: "Round Six White",
            status: "imported",
          },
        ]
      : [],
  }));
  const incoming = makeState({
    id: "agent-score-9",
    round: 1,
    sender: "Black Player",
    pendingTable: "1",
  });
  incoming.scoreHelper.roundCount = 1;
  incoming.scoreHelper.activeRound = 1;

  const result = mergeFtdPlayerAccountMappingForAnyPost(incoming, current);
  assert.strictEqual(result.state.scoreHelper.roundCount, 1);
  assert.strictEqual(result.state.scoreHelper.rounds.length, 1);
}

{
  const current = makeState({
    id: "agent-score-9b",
    round: 1,
    sender: "Black Player",
    pendingTable: "1",
  });
  current.scoreHelper.roundCount = 5;
  current.scoreHelper.rounds = Array.from({ length: 5 }, (_, index) => ({
    round: index + 1,
    pending: [],
    manualPending: [],
    completed: [],
    ftdPairings: [],
  }));
  const incoming = makeState({
    id: "agent-score-9b",
    round: 1,
    sender: "Black Player",
    pendingTable: "1",
  });
  incoming.scoreHelper.roundCount = 4;
  incoming.scoreHelper.roundCountSource = "manual";
  incoming.scoreHelper.rounds = current.scoreHelper.rounds;

  const result = mergeFtdPlayerAccountMappingForAnyPost(incoming, current);
  assert.strictEqual(result.state.scoreHelper.roundCount, 4);
  assert.strictEqual(result.state.scoreHelper.rounds.length, 4);
}

{
  const current = makeState({
    id: "agent-score-9c",
    round: 1,
    sender: "Black Player",
    pendingTable: "1",
  });
  current.scoreHelper.roundCount = 5;
  current.scoreHelper.rounds = Array.from({ length: 5 }, (_, index) => ({
    round: index + 1,
    pending: [],
    manualPending: [],
    completed: [],
    ftdPairings: [],
  }));
  const incoming = makeState({
    id: "agent-score-9c",
    round: 1,
    sender: "Black Player",
    pendingTable: "1",
  });
  incoming.scoreHelper.roundCount = 4;
  incoming.scoreHelper.roundCountSource = "default";
  incoming.scoreHelper.rounds = current.scoreHelper.rounds;

  const result = mergeStateForApiPost(incoming, current, {
    source: "frontend",
    baseRevision: 1,
    currentRevision: 1,
  });
  assert.strictEqual(result.state.scoreHelper.roundCount, 4);
  assert.strictEqual(result.state.scoreHelper.rounds.length, 4);
}

{
  const current = makeState({
    id: "agent-score-10",
    round: 1,
    sender: "Black Player",
    pendingTable: "1",
  });
  current.scoreHelper.rounds[0].ftdPairings[0] = {
    table: 1,
    black: "Black Player",
    white: "White Player",
    status: "ready",
    blackScore: 37,
    whiteScore: 27,
    resultText: "first correct game",
    sourceMessageKey: "oq-auto:id:first",
    lastEditedBy: "script",
    updatedAt: 1000,
  };
  const incoming = makeState({
    id: "agent-score-10",
    round: 1,
    sender: "Black Player",
    pendingTable: "1",
  });
  incoming.scoreHelper.rounds[0].pending = [
    {
      id: "oq-auto-pending-r1-t1",
      round: 1,
      sender: "OQ自动查询 第1台",
      wechatSender: "OQ自动查询 第1台",
      verdict: "oq-auto-followup",
      pendingKind: "oq-auto-followup",
      pendingTable: "1",
      table: "1",
      sourceMessageKey: "oq-followup-r1-t1",
    },
  ];
  incoming.scoreHelper.rounds[0].ftdPairings[0] = {
    table: 1,
    black: "Black Player",
    white: "White Player",
    status: "dirty",
    dirty: true,
    dirtySource: "oq-auto-followup",
    blackScore: null,
    whiteScore: null,
    lastEditedBy: "script",
    updatedAt: 2000,
  };

  const result = mergeFtdPlayerAccountMappingForAnyPost(incoming, current);
  const row = result.state.scoreHelper.rounds[0].ftdPairings[0];
  assert.strictEqual(row.status, "ready");
  assert.strictEqual(row.blackScore, 37);
  assert.strictEqual(row.whiteScore, 27);
  assert.strictEqual(row.sourceMessageKey, "oq-auto:id:first");
  assert.strictEqual(result.state.scoreHelper.rounds[0].pending.length, 1);
  assert.strictEqual(result.preserved.length, 1);
}

{
  const current = makeState(null);
  current.scoreHelper.rounds[0].pending = [];
  current.scoreHelper.rounds[0].ftdPairings[0] = {
    table: 1,
    black: "Black Player",
    white: "White Player",
    status: "ready",
    blackScore: 37,
    whiteScore: 27,
    sourceMessageKey: "oq-auto:id:first",
    lastEditedBy: "script",
    updatedAt: 1000,
  };
  const incoming = makeState(null);
  incoming.scoreHelper.rounds[0].pending = [];
  incoming.scoreHelper.rounds[0].ftdPairings[0] = {
    table: 1,
    black: "Black Player",
    white: "White Player",
    status: "imported",
    blackScore: null,
    whiteScore: null,
    sourceMessageKey: "",
    lastEditedBy: "user",
    updatedAt: 2000,
  };

  const staleResult = mergeScoreHelperFtdPairingsForFrontendPost(incoming, current);
  assert.strictEqual(staleResult.state.scoreHelper.rounds[0].ftdPairings[0].status, "ready");
  assert.strictEqual(staleResult.preserved.length, 1);

  const userIntentResult = mergeScoreHelperFtdPairingsForFrontendPost(incoming, current, {
    preferIncomingUserIntent: true,
  });
  assert.strictEqual(userIntentResult.state.scoreHelper.rounds[0].ftdPairings[0].status, "ready");
  assert.strictEqual(userIntentResult.preserved.length, 1);

  const currentRevisionResult = mergeScoreHelperFtdPairingsForFrontendPost(incoming, current, {
    preserveCurrent: false,
  });
  assert.strictEqual(currentRevisionResult.state.scoreHelper.rounds[0].ftdPairings[0].status, "imported");
  assert.strictEqual(currentRevisionResult.state.scoreHelper.rounds[0].ftdPairings[0].lastEditedBy, "user");
  assert.strictEqual(currentRevisionResult.preserved.length, 0);
}

{
  const current = makeState(null);
  current.scoreHelper.rounds[0].pending = [];
  current.scoreHelper.rounds[0].ftdPairings[0] = {
    table: 1,
    black: "Black Player",
    white: "White Player",
    status: "ready",
    blackScore: 37,
    whiteScore: 27,
    sourceMessageKey: "oq-auto:id:first",
    lastEditedBy: "script",
    updatedAt: 2000,
  };
  const incoming = makeState(null);
  incoming.scoreHelper.rounds[0].pending = [];
  incoming.scoreHelper.rounds[0].ftdPairings[0] = {
    table: 1,
    black: "Black Player",
    white: "White Player",
    status: "imported",
    blackScore: 0,
    whiteScore: 0,
    sourceMessageKey: "",
    lastEditedBy: "user",
    updatedAt: 3000,
  };

  const result = mergeScoreHelperFtdPairingsForFrontendPost(incoming, current, {
    preferIncomingUserIntent: true,
  });
  const row = result.state.scoreHelper.rounds[0].ftdPairings[0];
  assert.strictEqual(row.status, "ready");
  assert.strictEqual(row.blackScore, 37);
  assert.strictEqual(row.whiteScore, 27);
  assert.strictEqual(row.sourceMessageKey, "oq-auto:id:first");
  assert.strictEqual(result.preserved.length, 1);
}

{
  const current = makeState(null);
  current.scoreHelper.rounds[0].pending = [];
  current.scoreHelper.rounds[0].ftdPairings[0] = {
    table: 1,
    black: "Black Player",
    white: "White Player",
    status: "ready",
    blackScore: 37,
    whiteScore: 27,
    sourceMessageKey: "oq-auto:id:first",
    lastEditedBy: "script",
    updatedAt: 1000,
  };
  const incoming = makeState(null);
  incoming.scoreHelper.rounds[0].pending = [];
  incoming.scoreHelper.rounds[0].ftdPairings[0] = {
    table: 1,
    black: "Black Player",
    white: "White Player",
    status: "completed",
    blackScore: 37,
    whiteScore: 27,
    sourceMessageKey: "oq-auto:id:first",
    lastEditedBy: "user",
    updatedAt: 3000,
    completedAt: 3000,
  };

  const result = mergeScoreHelperFtdPairingsForFrontendPost(incoming, current, {
    preferIncomingUserIntent: true,
  });
  const row = result.state.scoreHelper.rounds[0].ftdPairings[0];
  assert.strictEqual(row.status, "completed");
  assert.strictEqual(row.lastEditedBy, "user");
  assert.strictEqual(result.preserved.length, 0);
}

{
  const current = makeState(null);
  current.ftdPlayerAccountMapping = {
    players: [
      {
        ftdName: "Remote Source",
        account: "old_account",
        groupNick: "old nick",
        updatedAt: 5000,
      },
    ],
    updatedAt: 5000,
  };
  const incoming = makeState(null);
  incoming.ftdPlayerAccountMapping = {
    players: [
      {
        ftdName: "Remote Source",
        account: "remote_account",
        groupNick: "remote nick",
        updatedAt: 1000,
      },
    ],
    updatedAt: 1000,
  };
  const protectedResult = mergeStateForApiPost(incoming, current, {
    source: "map-collab-auto-pull",
    baseRevision: 10,
    currentRevision: 10,
  });
  assert.strictEqual(protectedResult.state.ftdPlayerAccountMapping.players[0].account, "old_account");
  assert.strictEqual(protectedResult.preservedFtdPlayerAccountMapping, true);

  const overwriteResult = mergeStateForApiPost(incoming, current, {
    source: "map-collab-overwrite-local",
    baseRevision: 10,
    currentRevision: 10,
  });
  assert.strictEqual(overwriteResult.state.ftdPlayerAccountMapping.players[0].account, "remote_account");
  assert.strictEqual(overwriteResult.preservedFtdPlayerAccountMapping, undefined);
}

{
  const semifinal = normalizeFtdRoundPayload({
    round: 110,
    stage: "SF",
    pairings: [
      { table: 1, black: "A", white: "D" },
      { table: 2, black: "B", white: "C" },
    ],
  });
  assert.strictEqual(semifinal.stage, "SF");
  assert.strictEqual(semifinal.ftdRound, 110);
  assert.strictEqual(semifinal.pairings.length, 2);

  const thirdPlace = normalizeFtdRoundPayload({
    round: 120,
    roundName: "Match for 3rd Place",
    pairings: [{ table: 1, black: "SF loser 1", white: "SF loser 2" }],
  });
  assert.strictEqual(thirdPlace.stage, "3/4");
  assert.strictEqual(thirdPlace.roundName, "3/4");
}

console.log("local-server merge tests passed");
