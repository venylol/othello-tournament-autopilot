"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const transcript = require("../ftd-transcript-shared.js");
const {
  prepareFtdTranscriptPacket,
} = require("../local-server.js");
const COMMANDS = require("../state-commands.js");
const {
  sanitizeLoadedState,
  renderFtdTranscriptImportTag,
  renderFtdPairingStatusMetadata,
  ftdPairingRowStatusClass,
  ftdBatchItemKey,
  formatFtdTranscriptNoEligibleMessage,
} = require("../app.js");

function gameIdFields(gameId) {
  return { oqAutoAudit: { game: { gameId } } };
}

function makePairing(table, status, gameId, extra = {}) {
  return {
    table,
    black: `Black Player ${table}`,
    white: `White Player ${table}`,
    status,
    blackScore: 40,
    whiteScore: 24,
    ...gameIdFields(gameId),
    ...extra,
  };
}

function makeState(pairings) {
  return {
    version: 2,
    step: "score-helper",
    players: [],
    scoreHelper: {
      version: 1,
      roundCount: 1,
      activeRound: 1,
      rounds: [{ round: 1, pending: [], manualPending: [], completed: [], ftdPairings: pairings }],
    },
  };
}

async function run() {
  {
    const extracted = transcript.extractTranscriptFromOqDetail({
      position: {
        startPos: "",
        moves: [
          { m: "F5" },
          { m: "-" },
          { status: "terminal-only" },
          { m: "D6", status: "SCORE:12" },
        ],
      },
    });
    assert.strictEqual(extracted.ok, true);
    assert.strictEqual(extracted.transcript, "f5d6");
    assert.strictEqual(extracted.moveCount, 2);
    assert.strictEqual(extracted.endingStatus, "SCORE:12");
    assert.ok(!extracted.transcript.includes("-"));
    assert.strictEqual(
      transcript.extractTranscriptFromOqDetail({ position: { moves: [{ status: "TIMEOUT" }] } }).code,
      "no-coordinate-moves",
    );
    assert.strictEqual(
      transcript.extractTranscriptFromOqDetail({ position: { moves: "f5" } }).code,
      "invalid-position-moves",
    );
    assert.strictEqual(
      transcript.extractOqGameId({ oqGameAvailableAudit: { game: { gameId: "available-id" } } }),
      "available-id",
    );
    assert.strictEqual(
      transcript.extractOqGameId({ sourceMessageKey: "oq-auto:id:source-id" }),
      "source-id",
    );
  }

  {
    const sameImport = {
      status: "imported",
      oqGameId: "same-game",
      confirmedAt: 1000,
      confirmedBy: "user",
    };
    const pairings = [
      makePairing(1, "ready", "aligned"),
      makePairing(2, "completed", "swapped"),
      { table: 3, black: "BYE", white: "Player", status: "completed", ...gameIdFields("bye") },
      makePairing(4, "completed", "absence", { resultKind: "absence" }),
      makePairing(5, "ready", "", { oqAutoAudit: null }),
      makePairing(6, "completed", "custom-start"),
      makePairing(7, "ready", "same-game", { ftdTranscriptImport: sameImport }),
      makePairing(8, "ready", "new-game", {
        ftdTranscriptImport: { ...sameImport, oqGameId: "old-game" },
      }),
      makePairing(9, "dirty", "dirty-game"),
      makePairing(10, "ready", "fetch-fail"),
    ];
    const details = {
      aligned: {
        blackName: "black_account",
        whiteName: "white_account",
        position: { startPos: "", moves: [{ m: "f5" }, { m: "d6" }] },
      },
      swapped: {
        // OQ in-game color is intentionally opposite the FTD pairing side.
        blackName: "white_account",
        whiteName: "black_account",
        position: { startPos: "", moves: [{ m: "C4" }, { m: "c3" }] },
      },
      "custom-start": { position: { startPos: "d3c4", moves: [{ m: "f5" }] } },
      "new-game": { position: { startPos: "", moves: [{ m: "e6" }] } },
    };
    const sourceState = makeState(pairings);
    const beforePreparation = JSON.stringify(sourceState);
    const packet = await prepareFtdTranscriptPacket(sourceState, { round: 1, tournamentId: "593" }, {
      concurrency: 2,
      fetchGameDetail: async (gameId) => {
        if (gameId === "fetch-fail") throw new Error("fixture failure");
        return details[gameId];
      },
    });
    assert.deepStrictEqual(packet.games.map((item) => item.table), [1, 2, 8]);
    assert.strictEqual(packet.games.find((item) => item.table === 1).transcript, "f5d6");
    assert.strictEqual(packet.games.find((item) => item.table === 2).transcript, "c4c3");
    const skipCodes = new Map(packet.skipped.map((item) => [item.table, item.code]));
    assert.strictEqual(skipCodes.get(3), "bye");
    assert.strictEqual(skipCodes.get(4), "absence");
    assert.strictEqual(skipCodes.get(5), "missing-oq-game-id");
    assert.strictEqual(skipCodes.get(6), "unsupported-start-position");
    assert.strictEqual(skipCodes.get(7), "already-imported");
    assert.strictEqual(skipCodes.get(9), "score-status");
    assert.strictEqual(skipCodes.get(10), "oq-detail-fetch-failed");
    assert.strictEqual(JSON.stringify(sourceState), beforePreparation);
  }

  {
    const ready = makePairing(1, "ready", "ready-game", {
      blackScore: 38,
      whiteScore: 26,
      completedAt: null,
      lastEditedBy: "agent",
      lastEditedAt: 100,
    });
    const completed = makePairing(2, "completed", "completed-game", {
      blackScore: 33,
      whiteScore: 31,
      completedAt: 200,
      lastEditedBy: "user",
      lastEditedAt: 201,
    });
    const addedAfterCopy = makePairing(3, "ready", "later-game");
    const round = { round: 1, ftdPairings: [ready, completed, addedAfterCopy] };
    const before = round.ftdPairings.map((item) => ({
      status: item.status,
      blackScore: item.blackScore,
      whiteScore: item.whiteScore,
      completedAt: item.completedAt,
      lastEditedBy: item.lastEditedBy,
      lastEditedAt: item.lastEditedAt,
    }));
    const batch = {
      kind: "transcript",
      round: 1,
      items: [
        { table: 1, black: ready.black, white: ready.white, oqGameId: "ready-game" },
        { table: 2, black: completed.black, white: completed.white, oqGameId: "completed-game" },
      ],
    };
    const result = transcript.confirmTranscriptBatchOnRound(round, batch, 5000);
    assert.strictEqual(result.count, 2);
    assert.deepStrictEqual(
      round.ftdPairings.map((item) => ({
        status: item.status,
        blackScore: item.blackScore,
        whiteScore: item.whiteScore,
        completedAt: item.completedAt,
        lastEditedBy: item.lastEditedBy,
        lastEditedAt: item.lastEditedAt,
      })),
      before,
    );
    assert.strictEqual(round.ftdPairings[0].ftdTranscriptImport.oqGameId, "ready-game");
    assert.strictEqual(round.ftdPairings[1].ftdTranscriptImport.oqGameId, "completed-game");
    assert.strictEqual(round.ftdPairings[2].ftdTranscriptImport, undefined);

    const staleRow = makePairing(4, "ready", "replacement-game");
    const staleResult = transcript.confirmTranscriptBatchOnRound(
      { round: 1, ftdPairings: [staleRow] },
      { round: 1, items: [{ table: 4, black: staleRow.black, white: staleRow.white, oqGameId: "old-game" }] },
      6000,
    );
    assert.strictEqual(staleResult.count, 0);
    assert.strictEqual(staleRow.ftdTranscriptImport, undefined);
  }

  {
    const imported = makePairing(1, "ready", "persist-game", {
      lastEditedBy: "user",
      ftdTranscriptImport: {
        status: "imported",
        oqGameId: "persist-game",
        confirmedAt: 7000,
        confirmedBy: "user",
      },
    });
    const loaded = sanitizeLoadedState(makeState([imported]));
    const loadedRow = loaded.scoreHelper.rounds[0].ftdPairings[0];
    assert.deepStrictEqual(loadedRow.ftdTranscriptImport, imported.ftdTranscriptImport);
    assert.ok(renderFtdTranscriptImportTag(loadedRow).includes("棋谱已导入"));
    const metadata = renderFtdPairingStatusMetadata(loadedRow);
    assert.ok(metadata.includes("待确认"));
    assert.ok(metadata.includes("用户修改"));
    assert.ok(metadata.includes("棋谱已导入"));
    assert.strictEqual(ftdPairingRowStatusClass(loadedRow), "ready");
    loadedRow.status = "completed";
    assert.strictEqual(ftdPairingRowStatusClass(loadedRow), "completed");
    assert.ok(renderFtdTranscriptImportTag(loadedRow).includes("棋谱已导入"));
    loadedRow.oqAutoAudit.game.gameId = "rematch-game";
    assert.strictEqual(renderFtdTranscriptImportTag(loadedRow), "");
  }

  {
    const current = makeState([makePairing(1, "ready", "merge-game", {
      lastEditedBy: "user",
      lastEditedAt: 9000,
      ftdTranscriptImport: {
        status: "imported",
        oqGameId: "merge-game",
        confirmedAt: 8000,
        confirmedBy: "user",
      },
    })]);
    const migrated = COMMANDS.migrateState(current);
    const row = migrated.scoreHelper.rounds[0].ftdPairings[0];
    const edited = COMMANDS.applyCommand(migrated, {
      commandId: "transcript-score-edit",
      type: "entities.mutate",
      actor: "user",
      payload: { mutations: [{
        op: "patch",
        target: { kind: "scoreRow", id: row.entityId },
        expectedRevision: row.entityRevision,
        set: { blackScore: 41, whiteScore: 23, lastEditedBy: "user", lastEditedAt: 9001 },
      }] },
    });
    const merged = edited.state.scoreHelper.rounds[0].ftdPairings[0];
    assert.strictEqual(merged.ftdTranscriptImport.oqGameId, "merge-game");

    const transcriptPatch = {
      status: "imported",
      oqGameId: "merge-game",
      confirmedAt: 10000,
      confirmedBy: "user",
    };
    assert.throws(
      () => COMMANDS.applyCommand(edited.state, {
        commandId: "stale-transcript-import",
        type: "entities.mutate",
        actor: "automation",
        payload: { mutations: [{
          op: "patch",
          target: { kind: "scoreRow", id: row.entityId },
          expectedRevision: row.entityRevision,
          set: { ftdTranscriptImport: transcriptPatch },
        }] },
      }),
      (error) => error.code === "entity-conflict",
    );
    const imported = COMMANDS.applyCommand(edited.state, {
      commandId: "fresh-transcript-import",
      type: "entities.mutate",
      actor: "automation",
      payload: { mutations: [{
        op: "patch",
        target: { kind: "scoreRow", id: row.entityId },
        expectedRevision: merged.entityRevision,
        set: { ftdTranscriptImport: transcriptPatch },
      }] },
    });
    const protectedMerged = imported.state.scoreHelper.rounds[0].ftdPairings[0];
    assert.strictEqual(protectedMerged.status, "ready");
    assert.strictEqual(protectedMerged.ftdTranscriptImport.confirmedAt, 10000);
  }

  {
    const message = formatFtdTranscriptNoEligibleMessage(2, [
      { code: "already-imported" },
      { code: "already-imported" },
      { code: "bye" },
    ]);
    assert.ok(message.includes("第 2 轮没有可复制的棋谱导入代码"));
    assert.ok(message.includes("棋谱已导入 2 局"));
    assert.ok(message.includes("BYE 1 项"));
    assert.ok(message.includes("本次未修改剪贴板"));
    assert.ok(message.includes("FTD 登分代码"));
  }

  {
    assert.strictEqual(ftdBatchItemKey({ table: 1, black: "A", white: "B", blackScore: 40, whiteScore: 24 }), "1\na\nb\n40\n24");
    const root = path.resolve(__dirname, "..");
    const template = fs.readFileSync(path.join(root, "ftd-transcript-console.js"), "utf8");
    assert.ok(template.includes('"otb-paste-transcript"'));
    assert.ok(template.includes('"get-otb-rounds"'));
    assert.ok(template.includes('"otb-get-round"'));
    assert.ok(template.includes("existing === intended.transcript"));
    assert.ok(template.includes("conflicts.length"));
    assert.ok(!/127\.0\.0\.1|localhost|\/api\//i.test(template));
    assert.ok(!template.includes("unlock-game"));
    const generated = template
      .replace("__FTD_TRANSCRIPT_TOURNAMENT_ID__", '"593"')
      .replace("__FTD_TRANSCRIPT_ROUND__", "1")
      .replace("__FTD_TRANSCRIPT_GAMES__", JSON.stringify([{ table: 1, ftdBlack: "A", ftdWhite: "B", oqGameId: "g", transcript: "f5d6" }]));
    assert.ok(!/127\.0\.0\.1|localhost|\/api\//i.test(generated));
    assert.doesNotThrow(() => new Function(generated));

    const appSource = fs.readFileSync(path.join(root, "app.js"), "utf8");
    assert.ok(appSource.includes('lastCopiedFtdConsoleAction = { kind: "score"'));
    assert.ok(appSource.includes('kind: "transcript"'));
    assert.ok(appSource.includes('if (action.kind === "score") return completeLastCopiedFtdScoreBatch(action)'));
    assert.ok(appSource.includes('if (e.shiftKey) confirmLastCopiedFtdConsoleAction()'));
    assert.ok(appSource.includes('lastCopiedFtdConsoleAction = null;'));
  }

  {
    const julyRoundTwoNames = [
      ["LIU Yikai", "JIA Baolong"],
      ["LIN Feng", "Zhang qiang"],
      ["ZENG Yanbo", "WANG Wanli"],
      ["du xue", "Li ducheng"],
      ["Chen Junhang", "Wang Zhuorui"],
      ["chen jianshi", "LV Zimo"],
      ["wang sitian", "wu zimeng"],
      ["LV Le", "luo wei"],
      ["WANG Gang", "DAI Haochen"],
      ["WU Jianxiang", "Hao Yuanchuan"],
      ["niu hongli", "geng yihua"],
      ["lu wenting", "Yao Pingting"],
      ["xiao yunmeng", "ZHONG Wei"],
      ["Han Yi", "GUO Nianxin"],
    ];
    const toLivePlayer = (fullName, table, side) => {
      const parts = fullName.split(" ");
      return {
        surname: parts[0],
        name: parts.slice(1).join(" "),
        gameNumber: table - 1,
        gameId: side === 0 ? `ftd-${table}` : undefined,
        transcript: "",
      };
    };
    const livePairings = julyRoundTwoNames.map(([black, white], index) => [
      toLivePlayer(black, index + 1, 0),
      toLivePlayer(white, index + 1, 1),
    ]);
    const games = julyRoundTwoNames.map(([ftdBlack, ftdWhite], index) => ({
      table: index + 1,
      ftdBlack,
      ftdWhite,
      oqGameId: `oq-${index + 1}`,
      transcript: "f5d6",
    }));
    const handlers = new Map();
    const socket = {
      on(event, handler) { handlers.set(event, handler); },
      off(event) { handlers.delete(event); },
      emit(event) {
        if (event === "get-otb-rounds") {
          const handler = handlers.get("otb-get-round");
          if (handler) handler({ pairing: livePairings });
        }
      },
    };
    const rootNode = {};
    rootNode.__reactContainer$fixture = { memoizedProps: { socket }, child: null, sibling: null };
    const browserWindow = { confirm: () => false };
    const template = fs.readFileSync(path.resolve(__dirname, "..", "ftd-transcript-console.js"), "utf8");
    const generated = template
      .replace("__FTD_TRANSCRIPT_TOURNAMENT_ID__", '"593"')
      .replace("__FTD_TRANSCRIPT_ROUND__", "2")
      .replace("__FTD_TRANSCRIPT_GAMES__", JSON.stringify(games));
    await vm.runInNewContext(generated, {
      window: browserWindow,
      document: { getElementById: () => rootNode },
      console: { log() {}, error() {} },
      setTimeout,
      clearTimeout,
    });
    const result = browserWindow.__ftdTranscriptImportResult;
    assert.ok(result);
    assert.strictEqual(result.cancelled, true);
    assert.strictEqual(result.preflightErrors.length, 0);
    assert.strictEqual(result.conflicts.length, 0);
  }

  console.log("FTD transcript workflow tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
