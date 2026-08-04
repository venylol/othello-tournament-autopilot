import importlib.util
import unittest
from pathlib import Path

import numpy as np


SCRIPT = (
    Path(__file__).resolve().parents[1]
    / "scripts"
    / "modeling"
    / "evaluate_personal_tcn_ensemble.py"
)
SPEC = importlib.util.spec_from_file_location("evaluate_personal_tcn_ensemble", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class PersonalBootstrapTests(unittest.TestCase):
    def test_draws_are_deterministic_and_shared_shapes(self):
        members, games = MODULE.bootstrap_draws(100, 12, 2, 123)
        members_again, games_again = MODULE.bootstrap_draws(100, 12, 2, 123)
        np.testing.assert_array_equal(members, members_again)
        np.testing.assert_array_equal(games, games_again)
        self.assertEqual(members.shape, (100, 12))
        self.assertEqual(games.shape, (100, 2))

if __name__ == "__main__":
    unittest.main()
