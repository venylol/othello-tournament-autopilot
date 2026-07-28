import json
import tempfile
import unittest
from argparse import Namespace
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

from agent_match_image_helper import (
    apply_score_to_ftd_pairing,
    apply_cache_delay_to_scan_range,
    attach_agent_image_fields,
    collect_score_scan_png_paths,
    main,
    message_ready_source_role,
    next_round_password_stop_hint,
    next_score_stage_keywords,
    pairing_account_index,
    print_score_scan_console_summary,
    resolve_score_scan_timing,
    SCORE_REVIEW_REMINDER,
    score_write_followup,
    score_scan_stop_polling_decision,
    split_mapping_issues,
)


class ReadyWriteTests(unittest.TestCase):
    def test_cache_delay_shifts_live_score_scan_window_back(self):
        start, end, source, meta = apply_cache_delay_to_scan_range(
            "2026-06-13 21:24:00",
            "2026-06-13 21:25:00",
            "explicit",
            now=datetime(2026, 6, 13, 21, 25, 30),
        )

        self.assertEqual(start, "2026-06-13 21:23:30")
        self.assertEqual(end, "2026-06-13 21:24:30")
        self.assertEqual(source, "explicit-cache-delay-60s")
        self.assertTrue(meta["adjusted"])

    def test_cache_delay_keeps_historical_score_scan_window(self):
        start, end, source, meta = apply_cache_delay_to_scan_range(
            "2026-06-13 21:20:00",
            "2026-06-13 21:21:00",
            "explicit",
            now=datetime(2026, 6, 13, 21, 25, 30),
        )

        self.assertEqual(start, "2026-06-13 21:20:00")
        self.assertEqual(end, "2026-06-13 21:21:00")
        self.assertEqual(source, "explicit")
        self.assertFalse(meta["adjusted"])

    def test_score_scan_timing_uses_frontend_round_start_when_start_omitted(self):
        timing, should_write = resolve_score_scan_timing(
            Namespace(start="", end="2026-06-13 21:20:00", round_start=""),
            {"roundStartAt": "2026-06-13 21:14:00", "roundStartSource": "frontend"},
        )

        self.assertFalse(should_write)
        self.assertEqual(timing["start"], "2026-06-13 21:14:00")
        self.assertEqual(timing["startSource"], "frontend-roundStartAt")
        self.assertIn("do not need score-anchor", timing["instruction"])

    def test_score_scan_timing_syncs_agent_start_when_frontend_empty(self):
        round_item = {"roundStartAt": "", "roundStartSource": ""}

        timing, should_write = resolve_score_scan_timing(
            Namespace(start="2026-06-13 21:14:00", end="", round_start=""),
            round_item,
        )

        self.assertTrue(should_write)
        self.assertEqual(timing["start"], "2026-06-13 21:14:00")
        self.assertEqual(timing["startSource"], "argument-start")
        self.assertEqual(round_item["roundStartAt"], "2026-06-13 21:14:00")
        self.assertEqual(round_item["roundStartSource"], "agent-score-scan")

    def test_score_scan_stop_polling_detects_next_round_pairing_table(self):
        result = score_scan_stop_polling_decision(
            {
                "messages": [
                    {
                        "content": "第 2 轮配对表已发，请按新桌号开始",
                        "matches": ["round-transition"],
                    },
                ],
            }
        )

        self.assertTrue(result["stopPolling"])
        self.assertEqual(result["stopPollingCode"], "next-round-transition-visible")
        self.assertIn("next-round", result["stopPollingReason"])
        self.assertEqual(len(result["stopPollingMessages"]), 1)

    def test_score_scan_stop_polling_ignores_score_check_hint(self):
        result = score_scan_stop_polling_decision(
            {
                "messages": [
                    {
                        "content": "请大家核对比分，确认无误后进入下一轮",
                        "matches": ["score-check", "round-transition"],
                    },
                ],
            }
        )

        self.assertFalse(result["stopPolling"])
        self.assertEqual(result["stopPollingCode"], "")
        self.assertEqual(result["stopPollingMessages"], [])

    def test_last_prelim_next_stage_uses_semifinal_keywords_only(self):
        score_helper = {
            "preliminaryRoundCount": 6,
            "roundCount": 8,
            "rounds": [
                {
                    "round": index,
                    "stage": "preliminary" if index <= 6 else "semifinal" if index == 7 else "finals",
                    "ftdPairings": [{"table": 1}, {"table": 2}] if index <= 6 else [],
                }
                for index in range(1, 9)
            ],
        }

        result = next_score_stage_keywords(score_helper, 6, 12, 10)
        keywords = [item["keyword"] for item in result["keywords"]]

        self.assertEqual(result["stage"], "semifinal")
        self.assertEqual(result["round"], 7)
        self.assertIn("0701", keywords)
        self.assertIn("0702", keywords)
        self.assertNotIn("0901", keywords)
        self.assertNotIn("0902", keywords)

    def test_last_prelim_stop_hint_detects_semifinal_boundary_not_final(self):
        score_helper = {
            "preliminaryRoundCount": 6,
            "roundCount": 8,
            "rounds": [
                {
                    "round": index,
                    "stage": "preliminary" if index <= 6 else "semifinal" if index == 7 else "finals",
                    "ftdPairings": [{"table": 1}, {"table": 2}] if index <= 6 else [],
                }
                for index in range(1, 9)
            ],
        }

        semifinal_result = next_round_password_stop_hint(
            {"messages": [{"content": "半决赛配对 0701 0702"}]},
            6,
            12,
            10,
            score_helper,
        )
        final_result = next_round_password_stop_hint(
            {"messages": [{"content": "决赛配对 0901 0902"}]},
            6,
            12,
            10,
            score_helper,
        )

        self.assertTrue(semifinal_result["trigger"])
        self.assertEqual(semifinal_result["nextStage"]["stage"], "semifinal")
        self.assertFalse(final_result["trigger"])

    def test_referee_summary_image_has_no_png_output(self):
        item = {
            "time": "2026-06-06 21:31:00",
            "sender": "群bot",
            "image": {
                "previewPngPath": r"C:\tmp\summary_hidden.png",
                "previewPath": r"C:\tmp\summary_hidden.jpg",
                "path": r"C:\tmp\summary_hidden.jpg",
            },
        }

        result = attach_agent_image_fields(item)

        self.assertEqual(message_ready_source_role({"sender": "群bot"}), "referee-summary")
        self.assertEqual(result["sourceRole"], "referee-summary")
        self.assertFalse(result["allowedReadySource"])
        self.assertNotIn("pngPath", result)
        self.assertNotIn("previewPath", result)
        self.assertEqual(result["image"], {})
        self.assertEqual(collect_score_scan_png_paths([result]), [])

    def test_collect_png_paths_skips_referee_summary_items(self):
        result = collect_score_scan_png_paths(
            [
                {
                    "sourceRole": "referee-summary",
                    "allowedReadySource": False,
                    "pngPath": r"C:\tmp\summary_hidden.png",
                    "image": {"previewPngPath": r"C:\tmp\summary_hidden_preview.png"},
                },
                {"sourceRole": "player-screenshot", "pngPath": r"C:\tmp\player.png"},
            ]
        )

        self.assertEqual(result, [r"C:\tmp\player.png"])

    def test_score_scan_console_summary_includes_batch_write_next_steps(self):
        with patch("agent_match_image_helper.print_json") as print_json:
            print_score_scan_console_summary(
                {
                    "round": 1,
                    "range": {"start": "2026-06-06 20:23:00", "end": "2026-06-06 20:25:00"},
                    "review": [],
                    "pngPaths": [r"C:\tmp\player.png"],
                }
            )

        output = print_json.call_args.args[0]
        self.assertIn("agentNextSteps", output)
        self.assertTrue(any("pngPaths" in step for step in output["agentNextSteps"]))
        self.assertTrue(any("push-batch-scores" in step for step in output["agentNextSteps"]))

    def test_score_review_reminder_rejects_lower_self_stone_count_source(self):
        self.assertIn("不要把下方自己方显示子数作为正常完局计分来源", SCORE_REVIEW_REMINDER)

    def test_unresolved_mapping_split_suppresses_repeat_advisory(self):
        issues = [
            {"status": "missing-account", "table": 1, "side": "black", "ftdName": "A", "matchedDisplayName": "A"},
            {"status": "member-map-account-ambiguous", "table": 2, "side": "white", "ftdName": "B"},
        ]

        blocking, advisory, suppressed, seen = split_mapping_issues(issues, set())
        self.assertEqual(len(blocking), 1)
        self.assertEqual(blocking[0]["severity"], "blocking-account")
        self.assertEqual(len(advisory), 1)
        self.assertEqual(advisory[0]["severity"], "advisory-roster-gap")
        self.assertEqual(suppressed, 0)

        blocking2, advisory2, suppressed2, _ = split_mapping_issues(issues, seen)
        self.assertEqual(len(blocking2), 1)
        self.assertEqual(advisory2, [])
        self.assertEqual(suppressed2, 1)

    def test_pairing_account_index_lists_both_oq_accounts_per_table(self):
        round_item = {
            "ftdPairings": [
                {"table": 4, "black": "FTD Black", "white": "FTD White"},
            ],
        }
        contexts = {
            "account:blackid": {
                "table": 4,
                "side": "black",
                "reporterName": "Black Player",
                "reporterAccount": "black_id",
            },
            "account:whiteid": {
                "table": 4,
                "side": "white",
                "reporterName": "White Player",
                "reporterAccount": "white_id",
            },
        }

        result = pairing_account_index(round_item, contexts)

        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["table"], 4)
        self.assertEqual(result[0]["blackAccount"], "black_id")
        self.assertEqual(result[0]["whiteAccount"], "white_id")
        self.assertTrue(result[0]["fullyMapped"])

    def test_apply_score_to_ftd_pairing_writes_ready_by_table(self):
        round_item = {
            "round": 1,
            "pending": [],
            "manualPending": [],
            "completed": [],
            "ftdPairings": [
                {"table": 1, "black": "A Player", "white": "B Player", "status": "imported"},
            ],
        }

        result = apply_score_to_ftd_pairing(
            round_item,
            {
                "sender": "A Player",
                "blackScore": 38,
                "whiteScore": 26,
                "resultText": "manual review: A Player 38-26 B Player",
                "reason": "manual image review",
                "imagePath": "C:\\tmp\\score.png",
                "sourceMessageKey": "msg-1",
                "scoreInference": {"status": "manual", "reason": "manual image review"},
            },
            table=1,
        )

        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["blackScore"], 38)
        self.assertEqual(result["whiteScore"], 26)
        self.assertEqual(round_item["ftdPairings"][0]["status"], "ready")
        self.assertEqual(round_item["ftdPairings"][0]["sourceMessageKey"], "msg-1")
        self.assertNotIn("reason", round_item["ftdPairings"][0])
        self.assertNotIn("imagePath", round_item["ftdPairings"][0])
        self.assertEqual(round_item["pending"], [])

    def test_apply_score_to_ftd_pairing_overwrites_same_source_ready(self):
        round_item = {
            "round": 1,
            "pending": [],
            "manualPending": [],
            "completed": [],
            "ftdPairings": [
                {
                    "table": 1,
                    "black": "A Player",
                    "white": "B Player",
                    "status": "ready",
                    "blackScore": 38,
                    "whiteScore": 26,
                    "sourceMessageKey": "same-msg",
                    "lastEditedBy": "agent",
                },
            ],
        }

        result = apply_score_to_ftd_pairing(
            round_item,
            {
                "sender": "A Player",
                "blackScore": 40,
                "whiteScore": 24,
                "resultText": "manual correction: A Player 40-24 B Player",
                "sourceMessageKey": "same-msg",
                "scoreInference": {"status": "manual-correction"},
            },
            table=1,
        )

        self.assertFalse(result.get("duplicate"))
        self.assertTrue(result["updatedExistingReady"])
        self.assertFalse(result["forceUpdate"])
        self.assertEqual(round_item["ftdPairings"][0]["blackScore"], 40)
        self.assertEqual(round_item["ftdPairings"][0]["whiteScore"], 24)

    def test_apply_score_to_ftd_pairing_force_updates_different_source_ready(self):
        round_item = {
            "round": 1,
            "pending": [],
            "manualPending": [],
            "completed": [],
            "ftdPairings": [
                {
                    "table": 1,
                    "black": "A Player",
                    "white": "B Player",
                    "status": "ready",
                    "blackScore": 38,
                    "whiteScore": 26,
                    "sourceMessageKey": "old-msg",
                    "lastEditedBy": "agent",
                },
            ],
        }

        result = apply_score_to_ftd_pairing(
            round_item,
            {
                "sender": "A Player",
                "blackScore": 41,
                "whiteScore": 23,
                "resultText": "manual correction: A Player 41-23 B Player",
                "sourceMessageKey": "new-msg",
                "scoreInference": {"status": "manual-correction"},
            },
            table=1,
            force_update=True,
        )

        self.assertFalse(result.get("duplicate"))
        self.assertTrue(result["updatedExistingReady"])
        self.assertTrue(result["forceUpdate"])
        self.assertEqual(round_item["ftdPairings"][0]["sourceMessageKey"], "new-msg")
        self.assertEqual(round_item["ftdPairings"][0]["blackScore"], 41)

    def test_apply_score_to_ftd_pairing_uses_reporter_side_when_sender_name_differs(self):
        round_item = {
            "round": 1,
            "pending": [],
            "manualPending": [],
            "completed": [],
            "ftdPairings": [
                {"table": "3", "black": "FTD Black", "white": "FTD White", "status": "imported"},
            ],
        }

        result = apply_score_to_ftd_pairing(
            round_item,
            {
                "sender": "Roster Display Name",
                "senderScore": 64,
                "opponentScore": 0,
                "sourceMessageKey": "msg-2",
                "scoreInference": {"status": "winner-by-forfeit", "reason": "manual review"},
            },
            table="3",
            reporter_side="white",
        )

        self.assertEqual(result["blackScore"], 0)
        self.assertEqual(result["whiteScore"], 64)
        self.assertEqual(round_item["ftdPairings"][0]["opponent"], "FTD Black")
        self.assertEqual(round_item["ftdPairings"][0]["status"], "ready")

    def test_push_ready_score_command_writes_ftd_pairing_not_pending(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            state_path = Path(temp_dir) / "checkin-state.json"
            state_path.write_text(
                json.dumps(
                    {
                        "version": 2,
                        "scoreHelper": {
                            "version": 1,
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
                                            "table": 7,
                                            "black": "Black Player",
                                            "white": "White Player",
                                            "status": "imported",
                                        }
                                    ],
                                }
                            ],
                        },
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            with patch("agent_match_image_helper.print_json") as print_json:
                code = main(
                    [
                        "push-ready-score",
                        "--frontend-state",
                        str(state_path),
                        "--round",
                        "1",
                        "--round-count",
                        "1",
                        "--table",
                        "7",
                        "--sender",
                        "Black Player",
                        "--black-score",
                        "40",
                        "--white-score",
                        "24",
                        "--reason",
                        "manual image review",
                        "--source-message-key",
                        "cmd-msg-1",
                        "--direct-file",
                    ]
                )
                self.assertEqual(code, 0)
            output = print_json.call_args.args[0]
            self.assertTrue(output["stopPolling"])
            self.assertTrue(output["roundCompletion"]["all_pairings_have_results"])
            self.assertEqual(output["roundCompletion"]["ready_count"], 1)
            self.assertEqual(
                output["agentScope"],
                "agent and referee jointly maintain pending; agent maintains yellow ready only; referee/frontend may change ready to completed",
            )
            written = json.loads(state_path.read_text(encoding="utf-8"))
            round_item = written["scoreHelper"]["rounds"][0]
            self.assertEqual(round_item["pending"], [])
            pairing = round_item["ftdPairings"][0]
            self.assertEqual(pairing["status"], "ready")
            self.assertEqual(pairing["blackScore"], 40)
            self.assertEqual(pairing["whiteScore"], 24)
            self.assertEqual(pairing["sourceMessageKey"], "cmd-msg-1")
            self.assertNotIn("reason", pairing)
            self.assertNotIn("imagePath", pairing)

    def test_push_pending_score_records_abnormal_item(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            state_path = Path(temp_dir) / "checkin-state.json"
            state_path.write_text(
                json.dumps(
                    {
                        "version": 2,
                        "scoreHelper": {
                            "version": 1,
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
                                            "table": 7,
                                            "black": "Black Player",
                                            "white": "White Player",
                                            "status": "imported",
                                        }
                                    ],
                                }
                            ],
                        },
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            with patch("agent_match_image_helper.print_json") as print_json:
                code = main(
                    [
                        "push-pending-score",
                        "--frontend-state",
                        str(state_path),
                        "--round",
                        "1",
                        "--round-count",
                        "1",
                        "--table",
                        "7",
                        "--sender",
                        "Black Player",
                        "--wechat-sender",
                        "Black Player Group Nick",
                        "--verdict",
                        "account-mismatch",
                        "--source-message-key",
                        "pending-msg-1",
                        "--direct-file",
                    ]
                )
                self.assertEqual(code, 0)
            output = print_json.call_args.args[0]
            self.assertTrue(output["wechatSenderRequired"])
            self.assertFalse(output["stopPolling"])
            self.assertEqual(output["stopPollingCode"], "has-pending-but-round-can-stop")
            self.assertTrue(output["stopPollingRequiresMissingCheck"])
            written = json.loads(state_path.read_text(encoding="utf-8"))
            pending = written["scoreHelper"]["rounds"][0]["pending"]
            self.assertEqual(len(pending), 1)
            self.assertEqual(pending[0]["pendingKind"], "agent-abnormality")
            self.assertEqual(pending[0]["pendingTable"], "7")
            self.assertEqual(pending[0]["sender"], "Black Player")
            self.assertEqual(pending[0]["wechatSender"], "Black Player Group Nick")
            self.assertEqual(pending[0]["resultText"], "table 7 pending")
            self.assertNotIn("reason", pending[0])
            self.assertNotIn("imagePath", pending[0])
            self.assertNotIn("sourceTime", pending[0])
            self.assertEqual(written["scoreHelper"]["rounds"][0]["ftdPairings"][0]["status"], "imported")

    def test_push_pending_score_requires_sender_group_nickname(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            state_path = Path(temp_dir) / "checkin-state.json"
            state_path.write_text(
                json.dumps(
                    {
                        "version": 2,
                        "scoreHelper": {
                            "version": 1,
                            "roundCount": 1,
                            "activeRound": 1,
                            "rounds": [
                                {
                                    "round": 1,
                                    "pending": [],
                                    "manualPending": [],
                                    "completed": [],
                                    "ftdPairings": [],
                                }
                            ],
                        },
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            with self.assertRaises(SystemExit) as raised:
                main(
                    [
                        "push-pending-score",
                        "--frontend-state",
                        str(state_path),
                        "--round",
                        "1",
                        "--table",
                        "5",
                        "--reason",
                        "two visible OQ IDs do not uniquely match any table yet",
                        "--direct-file",
                    ]
                )

            self.assertEqual(raised.exception.code, 2)
            written = json.loads(state_path.read_text(encoding="utf-8"))
            self.assertEqual(written["scoreHelper"]["rounds"][0]["pending"], [])

    def test_frontend_agent_pending_displays_sender_group_nickname(self):
        app_js = Path(__file__).resolve().parents[1] / ".." / "tournament_arrangement" / "recovered" / "app.js"
        text = app_js.read_text(encoding="utf-8")
        self.assertIn("发图者群昵称", text)
        self.assertIn("MISSING wechatSender", text)

    def test_push_ready_score_clears_matching_pending_item(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            state_path = Path(temp_dir) / "checkin-state.json"
            state_path.write_text(
                json.dumps(
                    {
                        "version": 2,
                        "scoreHelper": {
                            "version": 1,
                            "roundCount": 1,
                            "activeRound": 1,
                            "rounds": [
                                {
                                    "round": 1,
                                    "pending": [
                                        {
                                            "id": "pending-1",
                                            "round": 1,
                                            "sender": "Black Player",
                                            "verdict": "account-mismatch",
                                            "reason": "old abnormality",
                                            "pendingKind": "agent-abnormality",
                                            "pendingTable": "7",
                                            "table": "7",
                                            "sourceMessageKey": "same-msg",
                                        }
                                    ],
                                    "manualPending": [],
                                    "completed": [],
                                    "ftdPairings": [
                                        {
                                            "table": 7,
                                            "black": "Black Player",
                                            "white": "White Player",
                                            "status": "imported",
                                        }
                                    ],
                                }
                            ],
                        },
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            code = main(
                [
                    "push-ready-score",
                    "--frontend-state",
                    str(state_path),
                    "--round",
                    "1",
                    "--round-count",
                    "1",
                    "--table",
                    "7",
                    "--sender",
                    "Black Player",
                    "--black-score",
                    "40",
                    "--white-score",
                    "24",
                    "--source-message-key",
                    "same-msg",
                    "--direct-file",
                ]
            )

            self.assertEqual(code, 0)
            written = json.loads(state_path.read_text(encoding="utf-8"))
            round_item = written["scoreHelper"]["rounds"][0]
            self.assertEqual(round_item["pending"], [])
            self.assertEqual(round_item["ftdPairings"][0]["status"], "ready")

    def test_push_ready_score_preserves_referee_resolved_pending_item(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            state_path = Path(temp_dir) / "checkin-state.json"
            state_path.write_text(
                json.dumps(
                    {
                        "scoreHelper": {
                            "roundCount": 1,
                            "activeRound": 1,
                            "rounds": [
                                {
                                    "round": 1,
                                    "pending": [
                                        {
                                            "id": "pending-resolved-1",
                                            "round": 1,
                                            "sender": "第 7 桌",
                                            "reason": "referee handled this manually",
                                            "pendingKind": "agent-abnormality",
                                            "pendingTable": "7",
                                            "table": "7",
                                            "resolvedByReferee": True,
                                            "resolvedAt": 1780840000000,
                                        }
                                    ],
                                    "manualPending": [],
                                    "completed": [],
                                    "ftdPairings": [
                                        {
                                            "table": 7,
                                            "black": "Black Player",
                                            "white": "White Player",
                                            "status": "imported",
                                        }
                                    ],
                                }
                            ],
                        },
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            with patch("agent_match_image_helper.print_json") as print_json:
                code = main(
                    [
                        "push-ready-score",
                        "--frontend-state",
                        str(state_path),
                        "--round",
                        "1",
                        "--table",
                        "7",
                        "--black-score",
                        "40",
                        "--white-score",
                        "24",
                        "--direct-file",
                    ]
                )

            self.assertEqual(code, 0)
            output = print_json.call_args.args[0]
            self.assertEqual(output["resolvedPendingCount"], 1)
            self.assertEqual(output["resolvedPending"][0]["id"], "pending-resolved-1")
            self.assertEqual(output["resolvedPending"][0]["table"], "7")
            written = json.loads(state_path.read_text(encoding="utf-8"))
            round_item = written["scoreHelper"]["rounds"][0]
            self.assertEqual(len(round_item["pending"]), 1)
            self.assertTrue(round_item["pending"][0]["resolvedByReferee"])
            self.assertEqual(round_item["ftdPairings"][0]["status"], "ready")

    def test_push_batch_scores_writes_pending_and_ready_once(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            state_path = Path(temp_dir) / "checkin-state.json"
            batch_path = Path(temp_dir) / "batch.json"
            state_path.write_text(
                json.dumps(
                    {
                        "version": 2,
                        "scoreHelper": {
                            "version": 1,
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
                                            "table": 3,
                                            "black": "Black Player",
                                            "white": "White Player",
                                            "status": "imported",
                                        },
                                        {
                                            "table": 4,
                                            "black": "Other Black",
                                            "white": "Other White",
                                            "status": "imported",
                                        },
                                    ],
                                }
                            ],
                        },
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            batch_path.write_text(
                json.dumps(
                    {
                        "pending": [
                            {
                                "table": "3",
                                "pendingTable": "3",
                                "sender": "Black Player",
                                "wechatSender": "Black Player Group Nick",
                                "verdict": "account-mismatch",
                                "reason": "old candidate from same table",
                                "sourceMessageKey": "same-msg",
                            },
                            {
                                "table": "4",
                                "pendingTable": "4",
                                "sender": "Other Black",
                                "wechatSender": "Other Black Group Nick",
                                "verdict": "unreadable",
                                "reason": "image still unreadable after rotation",
                                "sourceMessageKey": "pending-msg-4",
                            },
                        ],
                        "ready": [
                            {
                                "table": "3",
                                "sender": "Black Player",
                                "blackScore": 40,
                                "whiteScore": 24,
                                "sourceMessageKey": "same-msg",
                                "reason": "manual image review",
                            }
                        ],
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            with patch("agent_match_image_helper.print_json") as print_json:
                code = main(
                    [
                        "push-batch-scores",
                        "--frontend-state",
                        str(state_path),
                        "--round",
                        "1",
                        "--round-count",
                        "1",
                        "--batch-file",
                        str(batch_path),
                        "--direct-file",
                    ]
                )

            self.assertEqual(code, 0)
            output = print_json.call_args.args[0]
            self.assertFalse(output["stopPolling"])
            self.assertEqual(output["stopPollingCode"], "has-pending-but-round-can-stop")
            self.assertTrue(output["stopPollingRequiresMissingCheck"])
            self.assertEqual(output["roundCompletion"]["missing_count"], 1)
            self.assertEqual(output["roundCompletion"]["missing"][0]["table"], 4)
            written = json.loads(state_path.read_text(encoding="utf-8"))
            round_item = written["scoreHelper"]["rounds"][0]
            self.assertEqual(len(round_item["pending"]), 1)
            self.assertEqual(round_item["pending"][0]["pendingTable"], "4")
            self.assertEqual(round_item["pending"][0]["wechatSender"], "Other Black Group Nick")
            self.assertNotIn("reason", round_item["pending"][0])
            self.assertNotIn("imagePath", round_item["pending"][0])
            self.assertNotIn("sourceTime", round_item["pending"][0])
            self.assertEqual(round_item["ftdPairings"][0]["status"], "ready")
            self.assertEqual(round_item["ftdPairings"][0]["blackScore"], 40)
            self.assertEqual(round_item["ftdPairings"][0]["whiteScore"], 24)
            self.assertNotIn("reason", round_item["ftdPairings"][0])
            self.assertNotIn("imagePath", round_item["ftdPairings"][0])
            self.assertEqual(round_item["ftdPairings"][1]["status"], "imported")

    def test_push_batch_scores_does_not_stop_when_ready_editor_unknown(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            state_path = Path(temp_dir) / "checkin-state.json"
            batch_path = Path(temp_dir) / "batch.json"
            state_path.write_text(
                json.dumps(
                    {
                        "version": 2,
                        "scoreHelper": {
                            "version": 1,
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
                                        },
                                        {
                                            "table": 2,
                                            "black": "Already Ready",
                                            "white": "Opponent",
                                            "status": "ready",
                                        },
                                    ],
                                }
                            ],
                        },
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            batch_path.write_text(
                json.dumps(
                    {
                        "ready": [
                            {
                                "table": "1",
                                "sender": "Black Player",
                                "blackScore": 33,
                                "whiteScore": 31,
                                "sourceMessageKey": "final-msg",
                            }
                        ],
                        "pending": [],
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            with patch("agent_match_image_helper.print_json") as print_json:
                code = main(
                    [
                        "push-batch-scores",
                        "--frontend-state",
                        str(state_path),
                        "--round",
                        "1",
                        "--round-count",
                        "1",
                        "--batch-file",
                        str(batch_path),
                        "--direct-file",
                    ]
                )

            self.assertEqual(code, 0)
            output = print_json.call_args.args[0]
            self.assertFalse(output["stopPolling"])
            self.assertEqual(output["stopPollingCode"], "all-ready-or-completed-editor-unknown")
            self.assertEqual(output["roundCompletion"]["missing_count"], 0)
            self.assertEqual(output["resultEditorAudit"]["unclearCount"], 1)

    def test_push_batch_scores_tells_agent_to_stop_when_all_pairings_ready_and_editor_known(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            state_path = Path(temp_dir) / "checkin-state.json"
            batch_path = Path(temp_dir) / "batch.json"
            state_path.write_text(
                json.dumps(
                    {
                        "version": 2,
                        "scoreHelper": {
                            "version": 1,
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
                                        },
                                        {
                                            "table": 2,
                                            "black": "Already Ready",
                                            "white": "Opponent",
                                            "status": "ready",
                                            "lastEditedBy": "user",
                                        },
                                    ],
                                }
                            ],
                        },
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            batch_path.write_text(
                json.dumps(
                    {
                        "ready": [
                            {
                                "table": "1",
                                "sender": "Black Player",
                                "blackScore": 33,
                                "whiteScore": 31,
                                "sourceMessageKey": "final-msg",
                            }
                        ],
                        "pending": [],
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            with patch("agent_match_image_helper.print_json") as print_json:
                code = main(
                    [
                        "push-batch-scores",
                        "--frontend-state",
                        str(state_path),
                        "--round",
                        "1",
                        "--round-count",
                        "1",
                        "--batch-file",
                        str(batch_path),
                        "--direct-file",
                    ]
                )

            self.assertEqual(code, 0)
            output = print_json.call_args.args[0]
            self.assertTrue(output["stopPolling"])
            self.assertEqual(output["stopPollingCode"], "all-ready-or-completed")
            self.assertEqual(output["roundCompletion"]["missing_count"], 0)
            self.assertTrue(output["resultEditorAudit"]["ok"])

    def test_score_followup_treats_oq_auto_script_result_as_known_editor(self):
        round_item = {
            "round": 1,
            "pending": [],
            "manualPending": [],
            "completed": [],
            "ftdPairings": [
                {
                    "table": 1,
                    "black": "Black Player",
                    "white": "White Player",
                    "status": "ready",
                    "lastEditedBy": "script",
                    "resultKind": "oq-auto",
                    "sourceMessageKey": "oq-auto:id:g1",
                }
            ],
        }

        output = score_write_followup(round_item)

        self.assertTrue(output["stopPolling"])
        self.assertEqual(output["stopPollingCode"], "all-ready-or-completed")
        self.assertEqual(output["roundCompletion"]["missing_count"], 0)
        self.assertTrue(output["resultEditorAudit"]["ok"])
        self.assertEqual(output["resultEditorAudit"]["unclearCount"], 0)

    def test_score_followup_treats_ftd_automation_result_as_known_editor(self):
        round_item = {
            "round": 1,
            "pending": [],
            "manualPending": [],
            "completed": [],
            "ftdPairings": [
                {
                    "table": 1,
                    "black": "Black Player",
                    "white": "White Player",
                    "status": "completed",
                    "lastEditedBy": "automation",
                    "ftdScoreReceipt": {"verifiedAt": "2026-07-27T20:10:00Z"},
                }
            ],
        }

        output = score_write_followup(round_item)

        self.assertTrue(output["stopPolling"])
        self.assertEqual(output["stopPollingCode"], "all-ready-or-completed")
        self.assertTrue(output["resultEditorAudit"]["ok"])
        self.assertEqual(output["resultEditorAudit"]["unclearCount"], 0)

    def test_score_followup_keeps_non_oq_script_result_unknown(self):
        round_item = {
            "round": 1,
            "pending": [],
            "manualPending": [],
            "completed": [],
            "ftdPairings": [
                {
                    "table": 1,
                    "black": "Black Player",
                    "white": "White Player",
                    "status": "ready",
                    "lastEditedBy": "script",
                    "sourceMessageKey": "manual-script:id:g1",
                }
            ],
        }

        output = score_write_followup(round_item)

        self.assertFalse(output["stopPolling"])
        self.assertEqual(output["stopPollingCode"], "all-ready-or-completed-editor-unknown")
        self.assertEqual(output["roundCompletion"]["missing_count"], 0)
        self.assertFalse(output["resultEditorAudit"]["ok"])
        self.assertEqual(output["resultEditorAudit"]["unclearCount"], 1)


if __name__ == "__main__":
    unittest.main()
