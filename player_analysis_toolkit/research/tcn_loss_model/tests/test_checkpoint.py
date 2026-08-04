from __future__ import annotations

from pathlib import Path
import unittest

from src.checkpoint import verify_checkpoint

ROOT = Path(__file__).resolve().parents[1]
CHECKPOINT = ROOT / "checkpoints" / "base" / "tcn_board_cnn_time_model_best.pt"


class CheckpointTests(unittest.TestCase):
  @unittest.skipUnless(CHECKPOINT.is_file(), "download the tcn-base-checkpoint release asset")
  def test_official_checkpoint_strict_load(self):
    report = verify_checkpoint(
        CHECKPOINT,
        ROOT / "provenance" / "source_snapshot" / "preprocessing.json",
    )
    self.assertIs(report["compatible"], True)
    self.assertEqual(report["inputFeatures"], 362)
    self.assertEqual(report["boardCnnChannels"], 23)
    self.assertIs(report["strictBackboneLoad"], True)
    self.assertEqual(report["inputPolicy"], "uniform-no-current-player-loss-history-v1")
    self.assertEqual(report["lossHistoryInputFeatures"], 0)
    self.assertGreater(report["sourceMaxSequenceLength"], 60)
