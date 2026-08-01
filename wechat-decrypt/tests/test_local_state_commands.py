import copy
import unittest

import local_state_commands as commands


class LocalStateCommandsTests(unittest.TestCase):
    def make_state(self):
        return {
            "version": 2,
            "players": [{
                "entityId": "player:1",
                "entityRevision": 3,
                "id": 1,
                "displayName": "Alpha",
            }],
            "scoreHelper": {
                "entityId": "score-helper:1",
                "entityRevision": 0,
                "rounds": [{
                    "entityId": "round:1",
                    "entityRevision": 4,
                    "round": 1,
                    "ftdPairings": [],
                    "pending": [],
                    "manualPending": [],
                    "completed": [],
                }],
            },
            "localSync": {"revision": 9, "domains": {}},
        }

    def test_patch_uses_captured_revision_without_identity_fields(self):
        base = self.make_state()
        working = copy.deepcopy(base)
        working["players"][0]["displayName"] = "Edited"
        mutations = commands.build_mutations(base, working)
        self.assertEqual(len(mutations), 1)
        self.assertEqual(mutations[0]["expectedRevision"], 3)
        self.assertNotIn("entityId", mutations[0]["set"])
        self.assertNotIn("entityRevision", mutations[0]["set"])

    def test_new_pending_carries_round_precondition(self):
        base = self.make_state()
        working = copy.deepcopy(base)
        working["scoreHelper"]["rounds"][0]["pending"].append({
            "entityId": "pending:new",
            "entityRevision": 0,
            "sourceMessageKey": "oq-auto:new",
        })
        mutations = commands.build_mutations(base, working)
        self.assertEqual(len(mutations), 1)
        self.assertEqual(mutations[0]["collection"], "pending")
        self.assertEqual(mutations[0]["parentId"], "round:1")
        self.assertEqual(mutations[0]["expectedParentRevision"], 4)

    def test_child_add_precedes_parent_patch_in_one_command(self):
        base = self.make_state()
        working = copy.deepcopy(base)
        round_state = working["scoreHelper"]["rounds"][0]
        round_state["roundStartAt"] = "2026-08-01T20:00:00+08:00"
        round_state["pending"].append({
            "entityId": "pending:new",
            "entityRevision": 0,
            "sourceMessageKey": "oq-auto:new",
        })
        mutations = commands.build_mutations(base, working)
        self.assertEqual([item["op"] for item in mutations], ["add", "patch"])
        self.assertEqual(mutations[0]["expectedParentRevision"], 4)
        self.assertEqual(mutations[1]["expectedRevision"], 4)


if __name__ == "__main__":
    unittest.main()
