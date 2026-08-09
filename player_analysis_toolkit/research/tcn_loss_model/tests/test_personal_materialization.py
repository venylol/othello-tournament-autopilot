from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

import numpy as np


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "data" / "materialize_personal_oq_tcn_model_ready.py"
SPEC = importlib.util.spec_from_file_location("materialize_personal_oq_tcn_model_ready", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class PersonalAuditArrayTests(unittest.TestCase):
    def test_target_mask_also_limits_wld_availability(self) -> None:
        arrays = {
            "game_id": np.asarray(["g1"]),
            "mask": np.asarray([[True, True]]),
            "wld_label_available": np.asarray([[True, True]]),
            "player_id": np.asarray([["Target", "Opponent"]]),
            "move_index": np.asarray([[0, 1]], dtype=np.int16),
            "actual_thinking_time_ms": np.asarray([[1000.0, 2000.0]], dtype=np.float32),
        }
        normalized = {
            "details": [{
                "id": "g1",
                "source_time_limit_ms": 300000,
                "effective_time_limit_ms": 300000,
                "time_scale_factor": 1.0,
                "position": {"moves": [
                    {"m": "d3", "raw_thinking_time_ms": 1000},
                    {"m": "c3", "raw_thinking_time_ms": 2000},
                ]},
            }]
        }

        MODULE.add_personal_audit_arrays(arrays, normalized, "target", {"g1"})

        self.assertEqual(arrays["mask"].tolist(), [[True, False]])
        self.assertEqual(arrays["wld_label_available"].tolist(), [[True, False]])


if __name__ == "__main__":
    unittest.main()
