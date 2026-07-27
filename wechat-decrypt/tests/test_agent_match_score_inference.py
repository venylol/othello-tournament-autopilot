import unittest

from agent_match_image_helper import infer_loser_stones_from_ocr


class ScoreInferenceTests(unittest.TestCase):
    def test_chinese_victory_parenthesized_margin(self):
        result = infer_loser_stones_from_ocr("黑色的胜利(+24)")

        self.assertEqual(result["status"], "win-by-margin")
        self.assertEqual(result["loserStoneCount"], 20)
        self.assertEqual(result["margin"], 24)

    def test_chinese_full_width_parenthesized_margin(self):
        result = infer_loser_stones_from_ocr("白色的胜利（+10）")

        self.assertEqual(result["status"], "win-by-margin")
        self.assertEqual(result["loserStoneCount"], 27)

    def test_draw_stays_thirty_two(self):
        result = infer_loser_stones_from_ocr("平局")

        self.assertEqual(result["status"], "draw")
        self.assertEqual(result["loserStoneCount"], 32)

    def test_loss_is_rejected_before_margin(self):
        result = infer_loser_stones_from_ocr("you lose by 24")

        self.assertEqual(result["status"], "reject-loss")
        self.assertIsNone(result["loserStoneCount"])

    def test_keyword_inference_is_advisory_only_for_agents(self):
        result = infer_loser_stones_from_ocr("yangyanu 赢对手18子")

        self.assertIn("status", result)
        self.assertIn("loserStoneCount", result)
        # Normal tournament operation must still use manual agent review instead
        # of treating this helper output as authoritative.
        self.assertNotIn("authoritative", result)


if __name__ == "__main__":
    unittest.main()
