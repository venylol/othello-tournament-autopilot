from __future__ import annotations

import importlib.util
import math
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from player_analysis_toolkit import sentinel_elo as elo


def node(ply: int, color: str = "black", account: str | None = None, loss: float = 0.0) -> dict:
    return {
        "ply": ply,
        "playerColor": color,
        "playerAccount": account or color,
        "lossPositive": loss,
        "lossClipped": loss,
    }


def metrics(rate: float, *, phases: tuple[float, float, float, float] | None = None) -> dict:
    rates = phases or (rate, rate, rate, rate)
    return {
        "analysisStartPly": 1,
        "validLossNodeCount": 4,
        "phase1": {"validLossNodeCount": 1, "lossGe4Count": 0, "lossGe4Rate": rates[0]},
        "phase2": {"validLossNodeCount": 1, "lossGe4Count": 0, "lossGe4Rate": rates[1]},
        "phase3": {"validLossNodeCount": 1, "lossGe4Count": 0, "lossGe4Rate": rates[2]},
        "phase4": {"validLossNodeCount": 1, "lossGe4Count": 0, "lossGe4Rate": rates[3]},
        "completeFourPhase": True,
        "equalPhaseGameGe4Rate": rate,
        "scopeAvailable": True,
    }


def reference(
    game_id: str,
    rate: float,
    *,
    color: str = "black",
    target_elo: float = 1650,
    opponent_elo: float = 1750,
    target_id: str | None = None,
    opponent_id: str | None = None,
    scope: str = "full_game",
) -> dict:
    full = metrics(rate)
    post = metrics(rate)
    return {
        "schema": elo.SCHEMA_DIRECTED,
        "gameId": game_id,
        "created": "2026-08-01T00:00:00Z",
        "targetPlayerId": target_id or f"target-{game_id}",
        "opponentPlayerId": opponent_id or f"opponent-{game_id}",
        "targetColor": color,
        "targetOldR": target_elo,
        "targetNewR": target_elo + 1,
        "opponentOldR": opponent_elo,
        "opponentNewR": opponent_elo + 1,
        "formalReferenceEligible": True,
        "algorithmLabel": "offbook" if scope == "post_offbook_inclusive" else "no_offbook",
        "metrics": {"full_game": full, "post_offbook_inclusive": post},
    }


class SentinelEloTests(unittest.TestCase):
    def test_fixed_phase_boundaries_and_equal_phase_average(self) -> None:
        nodes = [
            node(1, loss=0), node(30, loss=4),
            node(31, loss=4), node(47, loss=0),
            node(48, loss=4), node(53, loss=0),
            node(54, loss=4), node(60, loss=0),
            node(2, "white", "white", loss=99),
        ]
        result = elo.phase_metrics_for_scope(nodes, "black", "black", "full_game", None)
        self.assertEqual([result[f"phase{i}"]["validLossNodeCount"] for i in range(1, 5)], [2, 2, 2, 2])
        self.assertEqual([result[f"phase{i}"]["lossGe4Count"] for i in range(1, 5)], [1, 1, 1, 1])
        self.assertEqual(result["equalPhaseGameGe4Rate"], 0.5)

    def test_anchor_is_inclusive_and_no_anchor_post_scope_is_unavailable(self) -> None:
        nodes = [node(30), node(31), node(48), node(54)]
        anchored = elo.phase_metrics_for_scope(nodes, "black", "black", "post_offbook_inclusive", 30)
        self.assertEqual(anchored["analysisStartPly"], 30)
        self.assertEqual(anchored["validLossNodeCount"], 4)
        unavailable = elo.phase_metrics_for_scope(nodes, "black", "black", "post_offbook_inclusive", None)
        self.assertFalse(unavailable["scopeAvailable"])
        self.assertEqual(unavailable["unavailableReason"], "no_offbook_anchor")

    def test_empty_phase_makes_whole_game_incomplete(self) -> None:
        nodes = [node(1), node(31), node(54)]
        result = elo.phase_metrics_for_scope(nodes, "black", "black", "full_game", None)
        self.assertFalse(result["completeFourPhase"])
        self.assertIsNone(result["equalPhaseGameGe4Rate"])

    def test_opponent_nodes_do_not_enter_target_metrics(self) -> None:
        nodes = [node(1), node(31), node(48), node(54)]
        nodes.extend([node(2, "white", "white", 4), node(32, "white", "white", 4)])
        result = elo.phase_metrics_for_scope(nodes, "black", "black", "full_game", None)
        self.assertEqual(result["validLossNodeCount"], 4)
        self.assertEqual(result["equalPhaseGameGe4Rate"], 0.0)

    def test_directed_record_contains_new_r_and_both_scopes(self) -> None:
        game = {"gameId": "g", "nodes": [node(1), node(31), node(48), node(54)]}
        detail = {
            "id": "g",
            "created": "2026-08-01T00:00:00Z",
            "players": [
                {"id": "black", "oldR": 1700, "newR": 1710},
                {"id": "white", "oldR": 1800, "newR": 1790},
            ],
        }
        record = elo.make_elo_directed_record(
            game, detail, "black", {"algorithmLabel": "offbook", "offBookPly": 1},
            Path("engine/game.json"), "a" * 64,
            in_main_matrix=True, partition_scope="test",
        )
        self.assertEqual(record["targetNewR"], 1710.0)
        self.assertEqual(set(record["metrics"]), {"full_game", "post_offbook_inclusive"})
        self.assertTrue(record["metrics"]["post_offbook_inclusive"]["completeFourPhase"])

    def test_neighbor_count_distance_weight_and_stable_tie_key(self) -> None:
        rows = [
            reference("b", 0.0, target_elo=1600, opponent_elo=1700),
            reference("a", 0.5, target_elo=1600, opponent_elo=1700),
            reference("c", 1.0, target_elo=1601, opponent_elo=1700),
            reference("d", 0.25, target_elo=1610, opponent_elo=1700),
        ]
        self.assertEqual(elo.neighbor_count(4), 3)
        result = elo.nearest_weighted_neighbors(rows, 1600, 1700)
        self.assertTrue(result["ok"])
        self.assertEqual([row["record"]["gameId"] for row in result["weighted"]], ["a", "b", "c"])
        self.assertEqual(result["boundaryDistance"], 10.0)
        self.assertAlmostEqual(result["weighted"][0]["referenceWeight"], 1.0)

    def test_target_display_elo_is_not_used_in_distance(self) -> None:
        rows = [reference(f"r{i}", i / 10, target_elo=1600 + i * 5) for i in range(8)]
        target_a = reference("target-a", 0.3, target_elo=1600, opponent_elo=1750, target_id="account")
        target_b = {**target_a, "targetOldR": 2495}
        result_a = elo.score_game_at_elo(target_a, rows, 1700)
        result_b = elo.score_game_at_elo(target_b, rows, 1700)
        self.assertTrue(result_a["ok"])
        self.assertEqual(result_a["gameZ"], result_b["gameZ"])

    def test_scope_color_and_complete_filters_and_account_leakage(self) -> None:
        target = reference("target", 0.2, scope="full_game", target_id="Account")
        safe = reference("safe", 0.3, scope="full_game", target_id="other")
        leaked_as_opponent = reference("leaked", 0.4, scope="full_game", opponent_id=" account ")
        wrong_color = reference("white", 0.5, scope="full_game", color="white")
        excluded = elo.excluded_reference_game_ids([target, safe, leaked_as_opponent, wrong_color], "ACCOUNT", ["target"])
        eligible = elo.eligible_reference_records(
            [target, safe, leaked_as_opponent, wrong_color], target,
            excluded_game_ids=excluded,
        )
        self.assertEqual([row["gameId"] for row in eligible], ["safe"])

    def test_score_curve_states_and_intervals(self) -> None:
        valid = elo.classify_curve({"points": [
            {"elo": 1600, "candidateZ": 1.0, "score": 1.0},
            {"elo": 1601, "candidateZ": -1.0, "score": 1.0},
        ]})
        self.assertEqual(valid["status"], "valid")
        above = elo.classify_curve({"points": [
            {"elo": 1600, "candidateZ": -2.0, "score": 2.0},
            {"elo": 1601, "candidateZ": -1.0, "score": 1.0},
        ]})
        self.assertEqual(above["status"], "above_reference_range")
        below = elo.classify_curve({"points": [
            {"elo": 1600, "candidateZ": 2.0, "score": 2.0},
            {"elo": 1601, "candidateZ": 1.0, "score": 1.0},
        ]})
        self.assertEqual(below["status"], "below_reference_range")
        multiple = elo.classify_curve({"points": [
            {"elo": 1600, "candidateZ": 1.0, "score": 1.0},
            {"elo": 1601, "candidateZ": -1.0, "score": 1.0},
            {"elo": 1602, "candidateZ": 1.0, "score": 1.0},
            {"elo": 1603, "candidateZ": -1.0, "score": 1.0},
        ]})
        self.assertEqual(multiple["status"], "multiple_crossings")
        intervals = elo.intervals_for_score_threshold([
            {"elo": 1600, "score": 2}, {"elo": 1601, "score": 0.5},
            {"elo": 1602, "score": 0.5}, {"elo": 1603, "score": 2},
        ], 1)
        self.assertEqual(intervals[0]["lower"], 1601)
        self.assertEqual(intervals[0]["upper"], 1602)

    def test_target_selection_records_fixed_exclusion_reasons(self) -> None:
        incomplete = reference("incomplete", 0.2)
        incomplete["metrics"]["full_game"]["completeFourPhase"] = False
        out_of_range = reference("out", 0.2, opponent_elo=2500)
        selected = elo.select_target_records([incomplete, out_of_range])
        self.assertEqual(selected["status"], "insufficient_target_games")
        self.assertEqual(
            {row["reason"] for row in selected["excluded"]},
            {"incomplete_phase_data", "opponent_out_of_reference_range"},
        )

    def test_latest_known_elo_uses_new_r_from_latest_detail(self) -> None:
        bundle = {
            "details": [
                {"id": "old", "created": "2026-08-01", "players": [{"id": "u", "newR": 1700}, {"id": "x"}]},
                {"id": "new", "created": "2026-08-02", "players": [{"id": "U", "newR": 1812}, {"id": "y"}]},
            ]
        }
        self.assertEqual(elo._latest_known_elos(bundle)["u"], 1812.0)

    def test_calibration_artifact_assembly_keeps_formal_bounds(self) -> None:
        artifact, cases = elo.calibrate_global_interval([], {"details": []})
        self.assertEqual(cases, [])
        self.assertEqual(artifact["formalEloMinimum"], 1600)
        self.assertEqual(artifact["formalEloMaximum"], 2495)
        self.assertEqual(artifact["status"], "calibration_unavailable")


if __name__ == "__main__":
    unittest.main()
