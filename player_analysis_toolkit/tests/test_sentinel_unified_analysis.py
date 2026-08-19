from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "analysis" / "sentinel_unified_analysis.py"
SPEC = importlib.util.spec_from_file_location("sentinel_unified_analysis_test", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class UnifiedSentinelAnalysisTests(unittest.TestCase):
    def test_help_is_available_and_compatibility_commands_are_documented(self) -> None:
        self.assertEqual(MODULE.main(["--help"]), 0)

    def test_run_combines_legacy_summary_and_estimated_elo(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            reference = root / "reference"
            reference.mkdir()
            for name, value in {
                "per_game_reference_scores.json": {
                    "targetRecordCount": 3,
                    "calibratableGameCount": 3,
                    "excludedReferenceGameCount": 4,
                },
                "sentinel_scan_results.json": {
                    "classification": "normal",
                    "selectedK": 0,
                    "reportedGameIds": [],
                },
                "pseudo_scan_summary.json": {},
                "selection_manifest.json": {"modelReviewReady": False, "classification": "normal"},
                "model_review_groups.json": {},
            }.items():
                (root / name).write_text(json.dumps(value), encoding="utf-8", newline="\n")

            estimate = SimpleNamespace(
                payload={
                    "schema": "player-sentinel-estimated-elo-v1",
                    "status": "insufficient_target_games",
                    "estimatedElo": None,
                    "selectedGameCount": 3,
                    "gameDiagnostics": [],
                    "phaseDiagnostics": [],
                },
                curve={"points": []},
            )
            reference_payload = {
                "config": {},
                "configPath": root / "sentinel_elo_reference_config.json",
                "derived": reference,
                "recordsPath": reference / "directed_game_phase_records.jsonl",
                "manifestPath": reference / "reference_sha256_manifest.json",
                "calibrationPath": reference / "elo_calibration.json",
                "manifestSha256": "manifest-sha",
                "calibrationSha256": "calibration-sha",
                "calibration": {"status": "validated"},
            }
            args = SimpleNamespace(
                account="target",
                bundle=root / "bundle.json",
                engine_dir=root / "engine",
                offbook_records=root / "offbook.json",
                elo_reference_config=root / "elo.json",
                output_dir=root,
            )
            with patch.object(MODULE, "load_elo_reference", return_value=reference_payload), patch.object(
                MODULE.elo, "reference_records_from_directory", return_value=[]
            ), patch.object(MODULE.elo, "target_records_from_inputs", return_value=[]), patch.object(
                MODULE.elo, "estimate_database_calibrated_range", return_value=estimate
            ):
                self.assertEqual(MODULE.command_run(args), 0)

            unified = json.loads((root / "sentinel_unified_analysis.json").read_text(encoding="utf-8"))
            estimated = json.loads((root / "estimated_elo" / "estimated_elo.json").read_text(encoding="utf-8"))
            self.assertEqual(unified["schema"], MODULE.SCHEMA_UNIFIED)
            self.assertEqual(unified["legacySentinel"]["classification"], "normal")
            self.assertEqual(unified["estimatedElo"]["status"], "insufficient_target_games")
            self.assertEqual(estimated["status"], "insufficient_target_games")


if __name__ == "__main__":
    unittest.main()
