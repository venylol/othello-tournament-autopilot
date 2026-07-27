from __future__ import annotations

import sys
import unittest
from dataclasses import dataclass
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import agent_match_image_helper as helper  # noqa: E402


@dataclass
class FakeGame:
    game_id: str
    created_at: str
    black_name: str
    white_name: str
    black_score: int | None
    white_score: int | None
    status: str = "score"
    result: str = "win"
    user_color: str = "black"
    mode: str = "5min"
    user_name: str = "black_user"
    opponent_name: str = "white_user"
    user_score: int | None = None
    opponent_score: int | None = None
    length: int = 60
    comment: str = ""
    raw_metadata_json: str = "{}"


def make_state() -> dict:
    return {
        "version": 2,
        "players": [],
        "ftdPlayerAccountMapping": {
            "players": [
                {
                    "ftdName": "Black Player",
                    "account": "black_user",
                    "groupNick": "Black Player black_user",
                    "status": "matched",
                    "oqCheck": {"status": "ok"},
                },
                {
                    "ftdName": "White Player",
                    "account": "white_user",
                    "groupNick": "White Player white_user",
                    "status": "matched",
                    "oqCheck": {"status": "ok"},
                },
            ]
        },
        "scoreHelper": {
            "roundCount": 1,
            "activeRound": 1,
            "rounds": [
                {
                    "round": 1,
                    "pending": [],
                    "manualPending": [],
                    "completed": [],
                    "ftdPairings": [
                        {
                            "table": 1,
                            "black": "Black Player",
                            "white": "White Player",
                            "status": "imported",
                        }
                    ],
                }
            ],
        },
    }


TERMINAL_SAMPLE_MOVES = (
    "f5",
    "d6",
    "c5",
    "f4",
    "e3",
    "c6",
    "d3",
    "f6",
    "e6",
    "f3",
    "c4",
    "e7",
    "d7",
    "c8",
    "c7",
    "e2",
    "e8",
    "c3",
    "f8",
    "f7",
    "g8",
    "g7",
    "e1",
    "d2",
    "h8",
    "g6",
    "h5",
    "d1",
    "c1",
    "h6",
    "h7",
    "g5",
    "d8",
    "c2",
    "h4",
    "-",
    "g4",
    "g3",
    "f2",
    "g1",
    "b8",
    "g2",
    "f1",
    "b1",
    "h1",
    "h2",
    "h3",
    "-",
    "a1",
    "-",
    "b2",
    "b3",
    "a4",
    "a3",
    "a2",
    "b4",
)


def detail_with_terminal(turn_count: int, status: str) -> dict:
    moves = [{"m": move} for move in TERMINAL_SAMPLE_MOVES[:turn_count]]
    moves.append({"s": status})
    return {"position": {"moves": moves}}


class OqAutoScoreUpdateTests(unittest.TestCase):
    def test_oq_account_validation_rejects_concatenated_long_account(self):
        with mock.patch.object(helper, "load_oq_client_class") as load_client:
            result = helper.validate_one_oq_account(
                "hughug0831qinqin1226",
                "5min",
                None,
                None,
                "http://example.invalid",
                1,
            )
        load_client.assert_not_called()
        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], "invalid")
        self.assertIn("1-14", result["error"])

    def test_oq_account_validation_rejects_empty_game_history(self):
        class EmptyHistoryClient:
            def __init__(self, base_url: str, timeout: int):
                self.base_url = base_url
                self.timeout = timeout

            def fetch_games(self, account: str, mode: str, include_details: bool = False):
                return []

        with mock.patch.object(helper, "load_oq_client_class", return_value=EmptyHistoryClient):
            result = helper.validate_one_oq_account(
                "valid_user",
                "5min",
                None,
                None,
                "http://example.invalid",
                1,
            )
        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], "invalid")
        self.assertIn("5min: no game history", result["error"])
        self.assertIn("1min: no game history", result["error"])
        self.assertIn("xot: no game history", result["error"])

    def test_oq_account_validation_falls_back_to_next_mode(self):
        calls = []

        class FallbackHistoryClient:
            def __init__(self, base_url: str, timeout: int):
                self.base_url = base_url
                self.timeout = timeout

            def fetch_games(self, account: str, mode: str, include_details: bool = False):
                calls.append((account, mode, include_details))
                if mode == "1min":
                    return [type("Entry", (), {"created_at": "2026-06-06T12:00:00Z"})()]
                return []

        with mock.patch.object(helper, "load_oq_client_class", return_value=FallbackHistoryClient):
            result = helper.validate_one_oq_account(
                "Lyra27",
                "5min",
                None,
                None,
                "http://example.invalid",
                1,
            )
        self.assertTrue(result["ok"])
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["mode"], "1min")
        self.assertTrue(result["fallbackUsed"])
        self.assertEqual([call[1] for call in calls], ["5min", "1min"])

    def test_oq_auto_score_replays_detail_and_awards_empty_squares(self):
        moves = [
            {"m": move}
            for move in (
                "f5",
                "d6",
                "c5",
                "f4",
                "e3",
                "c6",
                "d3",
                "f6",
                "e6",
                "f3",
                "c4",
                "e7",
                "d7",
                "c8",
                "c7",
                "e2",
                "e8",
                "c3",
                "f8",
                "f7",
                "g8",
                "g7",
                "e1",
                "d2",
                "h8",
                "g6",
                "h5",
                "d1",
                "c1",
                "h6",
                "h7",
                "g5",
                "d8",
                "c2",
                "h4",
            )
        ]
        moves.extend(
            [
                {"m": "-"},
                {"m": "g4"},
                {"m": "g3"},
                {"m": "f2"},
                {"m": "g1"},
                {"m": "b8"},
                {"m": "g2"},
                {"m": "f1"},
                {"m": "b1"},
                {"m": "h1"},
                {"m": "h2"},
                {"m": "h3"},
                {"m": "-"},
                {"m": "a1"},
                {"m": "-"},
                {"m": "b2"},
                {"m": "b3"},
                {"m": "a4"},
                {"m": "a3"},
                {"m": "a2"},
                {"m": "b4"},
                {"m": "a5"},
                {"m": "-"},
                {"m": "b6"},
                {"m": "b7"},
                {"m": "a8"},
                {"m": "-"},
                {"m": "b5", "s": "SCORE:60"},
            ]
        )
        black_score, white_score, replay = helper.oq_replay_detail_final_scores({"position": {"moves": moves}})
        self.assertEqual((replay["blackDiscs"], replay["whiteDiscs"], replay["empty"]), (61, 1, 2))
        self.assertEqual((black_score, white_score), (63, 1))

    def test_oq_auto_score_uses_replayed_detail_not_score_diff_formula(self):
        detail = {
            "players": [
                {"id": "tiaotiao", "name": "tiaotiao"},
                {"id": "qiaoqiaomiao", "name": "Qiaoqiaomiao"},
            ],
            "position": {
                "moves": [
                    {"m": move}
                    for move in (
                        "f5",
                        "d6",
                        "c5",
                        "f4",
                        "e3",
                        "c6",
                        "d3",
                        "f6",
                        "e6",
                        "f3",
                        "c4",
                        "e7",
                        "d7",
                        "c8",
                        "c7",
                        "e2",
                        "e8",
                        "c3",
                        "f8",
                        "f7",
                        "g8",
                        "g7",
                        "e1",
                        "d2",
                        "h8",
                        "g6",
                        "h5",
                        "d1",
                        "c1",
                        "h6",
                        "h7",
                        "g5",
                        "d8",
                        "c2",
                        "h4",
                    )
                ]
                + [
                    {"m": "-"},
                    {"m": "g4"},
                    {"m": "g3"},
                    {"m": "f2"},
                    {"m": "g1"},
                    {"m": "b8"},
                    {"m": "g2"},
                    {"m": "f1"},
                    {"m": "b1"},
                    {"m": "h1"},
                    {"m": "h2"},
                    {"m": "h3"},
                    {"m": "-"},
                    {"m": "a1"},
                    {"m": "-"},
                    {"m": "b2"},
                    {"m": "b3"},
                    {"m": "a4"},
                    {"m": "a3"},
                    {"m": "a2"},
                    {"m": "b4"},
                    {"m": "a5"},
                    {"m": "-"},
                    {"m": "b6"},
                    {"m": "b7"},
                    {"m": "a8"},
                    {"m": "-"},
                    {"m": "b5", "s": "SCORE:60"},
                ]
            },
        }
        game = FakeGame(
            game_id="712r3xe0y71n",
            created_at="2026-06-08T12:05:00Z",
            black_name="tiaotiao",
            white_name="qiaoqiaomiao",
            black_score=62,
            white_score=2,
            raw_metadata_json=helper.json.dumps({"detail": detail}, ensure_ascii=False),
        )
        with mock.patch.object(
            helper,
            "fetch_oq_games_for_accounts",
            return_value={
                "accounts": ["tiaotiao", "qiaoqiaomiao"],
                "gamesByAccount": {"tiaotiao": [game], "qiaoqiaomiao": [game]},
                "errors": {},
                "wallMs": 1,
            },
        ):
            state = make_state()
            mapping = state["ftdPlayerAccountMapping"]["players"]
            mapping[0].update({"ftdName": "Black Player", "account": "qiaoqiaomiao"})
            mapping[1].update({"ftdName": "White Player", "account": "tiaotiao"})
            result = helper.update_round_oq_scores(
                state,
                1,
                1,
                helper.parse_local_time_required("2026-06-08 20:00", "start"),
                40,
                "5min",
                8,
                "http://example.invalid",
                1,
                True,
                False,
            )
        row = state["scoreHelper"]["rounds"][0]["ftdPairings"][0]
        self.assertEqual(result["appliedCount"], 1)
        self.assertEqual(row["status"], "ready")
        self.assertEqual(row["blackScore"], 1)
        self.assertEqual(row["whiteScore"], 63)
        self.assertEqual(row["oqAutoAudit"]["accountScores"], {"tiaotiao": 63, "qiaoqiaomiao": 1})
        self.assertIn("replayed OQ position.moves", row["reason"])
        self.assertTrue(result["stopPolling"])
        self.assertEqual(result["stopPollingCode"], "all-ready-or-completed")
        self.assertEqual(result["roundCompletion"]["missing_count"], 0)
        self.assertTrue(result["resultEditorAudit"]["ok"])

    def test_oq_auto_score_without_detail_goes_pending(self):
        game = FakeGame(
            game_id="g1",
            created_at="2026-06-08T12:05:00Z",
            black_name="black_user",
            white_name="white_user",
            black_score=36,
            white_score=22,
        )
        with mock.patch.object(
            helper,
            "fetch_oq_games_for_accounts",
            return_value={
                "accounts": ["black_user", "white_user"],
                "gamesByAccount": {"blackuser": [game], "whiteuser": [game]},
                "errors": {},
                "wallMs": 1,
            },
        ):
            state = make_state()
            result = helper.update_round_oq_scores(
                state,
                1,
                1,
                helper.parse_local_time_required("2026-06-08 20:00", "start"),
                40,
                "5min",
                8,
                "http://example.invalid",
                1,
                True,
                False,
            )
        row = state["scoreHelper"]["rounds"][0]["ftdPairings"][0]
        pending = state["scoreHelper"]["rounds"][0]["pending"]
        self.assertEqual(result["appliedCount"], 0)
        self.assertEqual(result["pendingCount"], 1)
        self.assertEqual(row["status"], "imported")
        self.assertTrue(pending)
        self.assertIn("position.moves", pending[0]["resultText"])
        round_item = state["scoreHelper"]["rounds"][0]
        self.assertEqual(round_item["roundStartAt"], "2026-06-08 20:00:00")
        self.assertEqual(round_item["roundStartSource"], "oq-script")

    def test_oq_auto_score_maps_oq_scores_back_by_account_not_color(self):
        detail = {
            "position": {
                "moves": [
                    {"m": move}
                    for move in (
                        "f5",
                        "d6",
                        "c5",
                        "f4",
                        "e3",
                        "c6",
                        "d3",
                        "f6",
                        "e6",
                        "f3",
                        "c4",
                        "e7",
                        "d7",
                        "c8",
                        "c7",
                        "e2",
                        "e8",
                        "c3",
                        "f8",
                        "f7",
                        "g8",
                        "g7",
                        "e1",
                        "d2",
                        "h8",
                        "g6",
                        "h5",
                        "d1",
                        "c1",
                        "h6",
                        "h7",
                        "g5",
                        "d8",
                        "c2",
                        "h4",
                    )
                ]
                + [
                    {"m": "-"},
                    {"m": "g4"},
                    {"m": "g3"},
                    {"m": "f2"},
                    {"m": "g1"},
                    {"m": "b8"},
                    {"m": "g2"},
                    {"m": "f1"},
                    {"m": "b1"},
                    {"m": "h1"},
                    {"m": "h2"},
                    {"m": "h3"},
                    {"m": "-"},
                    {"m": "a1"},
                    {"m": "-"},
                    {"m": "b2"},
                    {"m": "b3"},
                    {"m": "a4"},
                    {"m": "a3"},
                    {"m": "a2"},
                    {"m": "b4"},
                    {"m": "a5"},
                    {"m": "-"},
                    {"m": "b6"},
                    {"m": "b7"},
                    {"m": "a8"},
                    {"m": "-"},
                    {"m": "b5", "s": "SCORE:60"},
                ]
            }
        }
        game = FakeGame(
            game_id="g1",
            created_at="2026-06-08T12:05:00Z",
            black_name="white_user",
            white_name="black_user",
            black_score=62,
            white_score=2,
            raw_metadata_json=helper.json.dumps({"detail": detail}),
        )
        with mock.patch.object(
            helper,
            "fetch_oq_games_for_accounts",
            return_value={
                "accounts": ["black_user", "white_user"],
                "gamesByAccount": {"blackuser": [game], "whiteuser": [game]},
                "errors": {},
                "wallMs": 1,
            },
        ):
            state = make_state()
            result = helper.update_round_oq_scores(
                state,
                1,
                1,
                helper.parse_local_time_required("2026-06-08 20:00", "start"),
                40,
                "5min",
                8,
                "http://example.invalid",
                1,
                True,
                False,
            )
        row = state["scoreHelper"]["rounds"][0]["ftdPairings"][0]
        self.assertEqual(result["appliedCount"], 1)
        self.assertEqual(row["status"], "ready")
        self.assertEqual(row["blackScore"], 1)
        self.assertEqual(row["whiteScore"], 63)
        self.assertEqual(row["oqAutoAudit"]["accountScores"], {"whiteuser": 63, "blackuser": 1})
        self.assertIn("mapped by OQ account", row["reason"])

    def test_oq_auto_timeout_uses_replayed_terminal_side_not_result_summary(self):
        detail = detail_with_terminal(1, "LOSE:TIMEUP")
        game = FakeGame(
            game_id="g1",
            created_at="2026-06-08T12:05:00Z",
            black_name="white_user",
            white_name="black_user",
            black_score=None,
            white_score=None,
            status="timeout",
            result="win",
            user_color="white",
            raw_metadata_json=helper.json.dumps({"detail": detail}),
        )
        with mock.patch.object(
            helper,
            "fetch_oq_games_for_accounts",
            return_value={
                "accounts": ["black_user", "white_user"],
                "gamesByAccount": {"blackuser": [game], "whiteuser": [game]},
                "errors": {},
                "wallMs": 1,
            },
        ):
            state = make_state()
            result = helper.update_round_oq_scores(
                state,
                1,
                1,
                helper.parse_local_time_required("2026-06-08 20:00", "start"),
                40,
                "5min",
                8,
                "http://example.invalid",
                1,
                True,
                False,
            )
        row = state["scoreHelper"]["rounds"][0]["ftdPairings"][0]
        self.assertEqual(result["appliedCount"], 1)
        self.assertEqual(row["blackScore"], 0)
        self.assertEqual(row["whiteScore"], 64)
        self.assertEqual(row["oqAutoAudit"]["accountScores"], {"whiteuser": 64, "blackuser": 0})
        self.assertIn("mapped by OQ account", row["reason"])

    def test_oq_auto_timeout_replays_terminal_status_instead_of_result_summary(self):
        game = FakeGame(
            game_id="cuwc58yqmo0e",
            created_at="2026-06-06T12:32:03.842Z",
            black_name="a89555188",
            white_name="Neikos496",
            black_score=None,
            white_score=None,
            status="timeout",
            result="win",
            user_color="",
            user_name="Neikos496",
            opponent_name="a89555188",
            comment="terminal_status=LOSE:TIMEUP | detail_not_loaded",
        )
        detail = detail_with_terminal(50, "LOSE:TIMEUP")
        detail_calls = []

        class DetailClient:
            def __init__(self, base_url: str, timeout: int):
                self.base_url = base_url
                self.timeout = timeout

            def fetch_game_detail(self, game_id: str):
                detail_calls.append(game_id)
                return detail

        with mock.patch.object(
            helper,
            "fetch_oq_games_for_accounts",
            return_value={
                "accounts": ["Neikos496", "a89555188"],
                "gamesByAccount": {"neikos496": [game], "a89555188": [game]},
                "errors": {},
                "wallMs": 1,
            },
        ), mock.patch.object(helper, "load_oq_client_class", return_value=DetailClient):
            state = make_state()
            mapping = state["ftdPlayerAccountMapping"]["players"]
            mapping[0].update({"account": "Neikos496"})
            mapping[1].update({"account": "a89555188"})
            result = helper.update_round_oq_scores(
                state,
                1,
                1,
                helper.parse_local_time_required("2026-06-06 20:23", "start"),
                40,
                "5min",
                8,
                "http://example.invalid",
                1,
                True,
                False,
            )
        row = state["scoreHelper"]["rounds"][0]["ftdPairings"][0]
        self.assertEqual(result["appliedCount"], 1)
        self.assertEqual(row["blackScore"], 64)
        self.assertEqual(row["whiteScore"], 0)
        self.assertEqual(row["oqAutoAudit"]["accountScores"], {"a89555188": 0, "neikos496": 64})
        self.assertIn("replayed OQ terminal status", row["reason"])
        self.assertEqual(detail_calls, ["cuwc58yqmo0e"])

    def test_oq_auto_replays_resign_timeout_and_disconnect_terminal_statuses(self):
        cases = [
            ("resign-game", "resign", "LOSE:RESIGN", 39, {"blackuser": 64, "whiteuser": 0}),
            ("timeout-game", "timeout", "LOSE:TIMEUP", 50, {"blackuser": 0, "whiteuser": 64}),
            ("disconnect-game", "unknown", "LOSE:DISCONNECT", 30, {"blackuser": 0, "whiteuser": 64}),
        ]
        for game_id, status, terminal_status, turn_count, expected_scores in cases:
            with self.subTest(terminal_status=terminal_status):
                game = FakeGame(
                    game_id=game_id,
                    created_at="2026-06-08T12:05:00Z",
                    black_name="black_user",
                    white_name="white_user",
                    black_score=None,
                    white_score=None,
                    status=status,
                    result="unknown",
                    comment=f"terminal_status={terminal_status} | detail_not_loaded",
                )
                detail_calls = []

                class DetailClient:
                    def __init__(self, base_url: str, timeout: int):
                        self.base_url = base_url
                        self.timeout = timeout

                    def fetch_game_detail(self, requested_game_id: str):
                        detail_calls.append(requested_game_id)
                        return detail_with_terminal(turn_count, terminal_status)

                with mock.patch.object(
                    helper,
                    "fetch_oq_games_for_accounts",
                    return_value={
                        "accounts": ["black_user", "white_user"],
                        "gamesByAccount": {"blackuser": [game], "whiteuser": [game]},
                        "errors": {},
                        "wallMs": 1,
                    },
                ), mock.patch.object(helper, "load_oq_client_class", return_value=DetailClient):
                    state = make_state()
                    result = helper.update_round_oq_scores(
                        state,
                        1,
                        1,
                        helper.parse_local_time_required("2026-06-08 20:00", "start"),
                        40,
                        "5min",
                        8,
                        "http://example.invalid",
                        1,
                        True,
                        False,
                    )
                row = state["scoreHelper"]["rounds"][0]["ftdPairings"][0]
                self.assertEqual(result["appliedCount"], 1)
                self.assertEqual(row["oqAutoAudit"]["accountScores"], expected_scores)
                self.assertIn("replayed OQ terminal status", row["reason"])
                self.assertEqual(detail_calls, [game_id])

    def test_oq_detail_fetch_reuses_round_cache_by_game_id(self):
        detail = {"position": {"moves": [{"m": "f5"}]}}
        calls = []

        class DetailClient:
            def __init__(self, base_url: str, timeout: int):
                self.base_url = base_url
                self.timeout = timeout

            def fetch_game_detail(self, game_id: str):
                calls.append(game_id)
                return detail

        first = FakeGame("same-game", "2026-06-08T12:05:00Z", "black_user", "white_user", 0, 0)
        second = FakeGame("same-game", "2026-06-08T12:05:00Z", "black_user", "white_user", 0, 0)
        cache = {}
        with mock.patch.object(helper, "load_oq_client_class", return_value=DetailClient):
            first, first_fetched = helper.oq_entry_with_detail(first, "http://example.invalid", 1, cache)
            second, second_fetched = helper.oq_entry_with_detail(second, "http://example.invalid", 1, cache)
        self.assertTrue(first_fetched)
        self.assertFalse(second_fetched)
        self.assertEqual(calls, ["same-game"])
        self.assertEqual(len(cache), 1)
        self.assertEqual(helper.oq_extract_detail_from_entry(first), detail)
        self.assertEqual(helper.oq_extract_detail_from_entry(second), detail)

    def test_oq_auto_score_multiple_matches_go_pending(self):
        games = [
            FakeGame("g1", "2026-06-08T12:05:00Z", "black_user", "white_user", 36, 22),
            FakeGame("g2", "2026-06-08T12:15:00Z", "black_user", "white_user", 10, 54),
        ]
        with mock.patch.object(
            helper,
            "fetch_oq_games_for_accounts",
            return_value={
                "accounts": ["black_user", "white_user"],
                "gamesByAccount": {"blackuser": games, "whiteuser": games},
                "errors": {},
                "wallMs": 1,
            },
        ):
            state = make_state()
            result = helper.update_round_oq_scores(
                state,
                1,
                1,
                helper.parse_local_time_required("2026-06-08 20:00", "start"),
                40,
                "5min",
                8,
                "http://example.invalid",
                1,
                True,
                False,
            )
        row = state["scoreHelper"]["rounds"][0]["ftdPairings"][0]
        pending = state["scoreHelper"]["rounds"][0]["pending"]
        self.assertEqual(result["appliedCount"], 0)
        self.assertEqual(result["pendingCount"], 1)
        self.assertEqual(row["status"], "imported")
        self.assertTrue(pending)
        self.assertEqual(pending[0]["pendingKind"], "oq-auto-multiple-games")

    def test_oq_followup_pending_when_agent_ready_score_mismatches_single_game(self):
        game = FakeGame("g2", "2026-06-08T12:15:00Z", "black_user", "white_user", 10, 54)
        game.raw_metadata_json = helper.json.dumps({"detail": detail_with_terminal(12, "LOSE:RESIGN")})
        with mock.patch.object(
            helper,
            "fetch_oq_games_for_accounts",
            return_value={
                "accounts": ["black_user", "white_user"],
                "gamesByAccount": {"blackuser": [game], "whiteuser": [game]},
                "errors": {},
                "wallMs": 1,
            },
        ):
            state = make_state()
            row = state["scoreHelper"]["rounds"][0]["ftdPairings"][0]
            row.update(
                {
                    "status": "ready",
                    "blackScore": 10,
                    "whiteScore": 54,
                    "reason": "resign: white lost",
                    "sourceMessageKey": "oq-auto:id:g1",
                    "lastEditedBy": "agent",
                }
            )
            result = helper.update_round_oq_scores(
                state,
                1,
                1,
                helper.parse_local_time_required("2026-06-08 20:00", "start"),
                40,
                "5min",
                8,
                "http://example.invalid",
                1,
                True,
                False,
            )
        pending = state["scoreHelper"]["rounds"][0]["pending"]
        self.assertEqual(result["appliedCount"], 0)
        self.assertEqual(result["pendingCount"], 1)
        self.assertEqual(row["status"], "ready")
        self.assertEqual(row["blackScore"], 10)
        self.assertEqual(pending[0]["pendingKind"], "oq-auto-score-mismatch")
        self.assertTrue(pending[0]["oqScoreMismatch"])

    def test_oq_followup_ignores_script_ready_single_game(self):
        game = FakeGame("g2", "2026-06-08T12:15:00Z", "black_user", "white_user", 10, 54)
        game.raw_metadata_json = helper.json.dumps({"detail": detail_with_terminal(12, "LOSE:RESIGN")})
        with mock.patch.object(
            helper,
            "fetch_oq_games_for_accounts",
            return_value={
                "accounts": ["black_user", "white_user"],
                "gamesByAccount": {"blackuser": [game], "whiteuser": [game]},
                "errors": {},
                "wallMs": 1,
            },
        ):
            state = make_state()
            row = state["scoreHelper"]["rounds"][0]["ftdPairings"][0]
            row.update(
                {
                    "status": "ready",
                    "blackScore": 10,
                    "whiteScore": 54,
                    "reason": "script ready",
                    "sourceMessageKey": "oq-auto:id:g1",
                    "lastEditedBy": "script",
                    "resultKind": "oq-auto",
                }
            )
            result = helper.update_round_oq_scores(
                state,
                1,
                1,
                helper.parse_local_time_required("2026-06-08 20:00", "start"),
                40,
                "5min",
                8,
                "http://example.invalid",
                1,
                True,
                False,
            )
        pending = state["scoreHelper"]["rounds"][0]["pending"]
        self.assertEqual(result["appliedCount"], 0)
        self.assertEqual(result["pendingCount"], 0)
        self.assertEqual(pending, [])

    def test_oq_followup_pending_when_ready_already_exists_with_multiple_games(self):
        games = [
            FakeGame("g2", "2026-06-08T12:15:00Z", "black_user", "white_user", 10, 54),
            FakeGame("g3", "2026-06-08T12:25:00Z", "white_user", "black_user", 42, 22),
        ]
        with mock.patch.object(
            helper,
            "fetch_oq_games_for_accounts",
            return_value={
                "accounts": ["black_user", "white_user"],
                "gamesByAccount": {"blackuser": games, "whiteuser": games},
                "errors": {},
                "wallMs": 1,
            },
        ):
            state = make_state()
            row = state["scoreHelper"]["rounds"][0]["ftdPairings"][0]
            row.update(
                {
                    "status": "ready",
                    "blackScore": 64,
                    "whiteScore": 0,
                    "reason": "resign: white lost",
                    "sourceMessageKey": "oq-auto:id:g1",
                    "lastEditedBy": "agent",
                }
            )
            result = helper.update_round_oq_scores(
                state,
                1,
                1,
                helper.parse_local_time_required("2026-06-08 20:00", "start"),
                40,
                "5min",
                8,
                "http://example.invalid",
                1,
                True,
                False,
            )
        pending = state["scoreHelper"]["rounds"][0]["pending"]
        self.assertEqual(result["appliedCount"], 0)
        self.assertEqual(result["pendingCount"], 1)
        self.assertEqual(row["status"], "ready")
        self.assertEqual(row["blackScore"], 64)
        self.assertEqual(pending[0]["pendingKind"], "oq-auto-followup")
        self.assertTrue(pending[0]["oqFollowupDetected"])
        self.assertIn("readySnapshot", pending[0]["oqFollowup"])

    def test_oq_followup_updates_existing_user_pending(self):
        games = [
            FakeGame("g2", "2026-06-08T12:15:00Z", "black_user", "white_user", 10, 54),
            FakeGame("g3", "2026-06-08T12:25:00Z", "white_user", "black_user", 42, 22),
        ]
        with mock.patch.object(
            helper,
            "fetch_oq_games_for_accounts",
            return_value={
                "accounts": ["black_user", "white_user"],
                "gamesByAccount": {"blackuser": games, "whiteuser": games},
                "errors": {},
                "wallMs": 1,
            },
        ):
            state = make_state()
            state["scoreHelper"]["rounds"][0]["pending"].append(
                {
                    "id": "user-pending-ftd-1-1",
                    "round": 1,
                    "sender": "第 1 台 Black Player vs White Player",
                    "verdict": "user-pending",
                    "pendingKind": "user-pending",
                    "pendingTable": "1",
                    "table": "1",
                    "reason": "裁判手动核对",
                    "reviewAction": "裁判手动 pending",
                    "lastEditedBy": "user",
                }
            )
            result = helper.update_round_oq_scores(
                state,
                1,
                1,
                helper.parse_local_time_required("2026-06-08 20:00", "start"),
                40,
                "5min",
                8,
                "http://example.invalid",
                1,
                True,
                False,
            )
        pending = state["scoreHelper"]["rounds"][0]["pending"]
        self.assertEqual(result["appliedCount"], 0)
        self.assertEqual(result["pendingCount"], 1)
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]["pendingKind"], "user-pending")
        self.assertEqual(pending[0]["reason"], "裁判手动核对")
        self.assertTrue(pending[0]["oqFollowupDetected"])
        self.assertIn("OQ 自动查询发现", pending[0]["reviewAction"])


if __name__ == "__main__":
    unittest.main()
