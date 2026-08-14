from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "analysis" / "detect_offbook.py"
SPEC = importlib.util.spec_from_file_location("detect_offbook", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def node(ply: int, time_ms: float, score: float, *, account: str = "target") -> dict:
    return {
        "ply": ply,
        "move": "d3",
        "playerAccount": account,
        "playerColor": "black" if account == "target" else "white",
        "thinkingTimeMs": time_ms,
        "bestEval": score,
    }


def game(target_nodes: list[dict]) -> dict:
    nodes = []
    by_ply = {item["ply"]: item for item in target_nodes}
    for ply in range(1, max(by_ply) + 1):
        nodes.append(by_ply.get(ply, node(ply, 100, 0, account="opponent")))
    return {"gameId": "g1", "nodes": nodes}


class DetectOffbookTests(unittest.TestCase):
    def test_time_anchor_uses_all_prior_target_times_before_clip(self) -> None:
        result = MODULE.detect_game(game([
            node(1, 100, 0), node(3, 100, 0), node(5, 176, 0), node(7, 100, 0),
        ]), "target")
        self.assertEqual(result["algorithmLabel"], "offbook")
        self.assertEqual(result["offBookPly"], 5)
        self.assertEqual(result["anchorSource"], "time_rule_without_evaluation_cutoff")

    def test_score_equal_to_positive_or_negative_six_does_not_trigger(self) -> None:
        for score in (6.0, -6.0):
            with self.subTest(score=score):
                result = MODULE.detect_game(game([
                    node(1, 100, 0), node(3, 100, 0), node(5, 100, score),
                ]), "target")
                self.assertEqual(result["algorithmLabel"], "no_offbook")
                self.assertIsNone(result["offBookPly"])

    def test_absolute_score_over_six_is_evaluation_anchor(self) -> None:
        result = MODULE.detect_game(game([
            node(1, 100, 0), node(3, 100, 0), node(5, 100, -7),
        ]), "target")
        self.assertEqual(result["offBookPly"], 5)
        self.assertEqual(result["anchorSource"], "absolute_evaluation_cutoff")

    def test_time_search_stops_strictly_before_evaluation_cutoff(self) -> None:
        result = MODULE.detect_game(game([
            node(1, 100, 0), node(3, 100, 0), node(5, 100, 0), node(7, 1000, 7),
        ]), "target")
        self.assertEqual(result["offBookPly"], 7)
        self.assertEqual(result["anchorSource"], "absolute_evaluation_cutoff")

    def test_time_anchor_before_cutoff_wins(self) -> None:
        result = MODULE.detect_game(game([
            node(1, 100, 0), node(3, 100, 0), node(5, 200, 0), node(7, 100, 7),
        ]), "target")
        self.assertEqual(result["offBookPly"], 5)
        self.assertEqual(result["anchorSource"], "time_rule_before_evaluation_cutoff")

    def test_cap_and_clip_are_inclusive(self) -> None:
        result = MODULE.detect_game(game([
            node(1, 100, 0), node(3, 100, 0), node(5, 100, 0), node(38, 180, 0),
        ]), "target")
        self.assertEqual(result["offBookPly"], 38)

    def test_game_with_no_target_placement_still_gets_no_offbook_label(self) -> None:
        source = {
            "gameId": "one-move",
            "black": {"account": "opponent"},
            "white": {"account": "target"},
            "nodes": [node(1, 1, 0, account="opponent")],
        }
        result = MODULE.detect_game(source, "target")
        self.assertEqual(result["targetColor"], "white")
        self.assertEqual(result["targetMoveCount"], 0)
        self.assertEqual(result["algorithmLabel"], "no_offbook")
        self.assertIsNone(result["offBookPly"])


if __name__ == "__main__":
    unittest.main()
