import unittest

import agent_match_image_helper as helper


class ScoreInferenceTests(unittest.TestCase):
    def test_ocr_keyword_score_inference_is_not_exposed(self):
        self.assertFalse(hasattr(helper, "infer_loser_stones_from_ocr"))

    def test_score_images_require_manual_review(self):
        hint = helper.manual_score_review_hint({
            "image": {"sourceKind": "wechat-image", "resolution": {"width": 1080, "height": 1920}},
            "pairingContext": {"opponentName": "Opponent", "opponentAccount": "opponent_oq"},
        })
        self.assertTrue(hint["requiresManualReview"])
        self.assertIn("OCR is disabled", hint["note"])
        self.assertTrue(hint["blockingScoreChecks"])

    def test_only_an_exact_64_stone_pair_passes_ready_validation(self):
        helper.validate_score_pair(40, 24)
        with self.assertRaises(helper.HelperError):
            helper.validate_score_pair(40, 20)


if __name__ == "__main__":
    unittest.main()
