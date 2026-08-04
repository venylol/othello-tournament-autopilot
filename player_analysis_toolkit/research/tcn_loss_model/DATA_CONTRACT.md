# Data contract

## Raw node table

Pass paths explicitly with `--data` and `--context-metadata`; no default dataset is
searched. Raw CSV/Parquet/JSONL requires at least:

- `game_id`, unique together with `move_index`;
- `player_id`, `side_to_move`, `actual_move`;
- source `ply` including explicit pass rows and `move_index`;
- `actual_thinking_time_ms`;
- 64-character `board` using X/O/empty;
- `hint6_1_score` and the remaining official hint/feature source columns;
- `time_limit_ms` or `tcb`, exactly 300000 for this dataset.

Context metadata retains the source merge key `(game_id, ply, move_index)`. The
validator merges it before model `ply` is remapped.

## Labels and leakage

For an actual placement and the next actual placement in the same game, with every
intervening source row retained and proven consecutive by both `move_index` and source
`ply` (intervening rows are explicit passes):

- normal turn change: `raw_loss = current_best + next_opponent_best`;
- same side after pass: `raw_loss = current_best - next_same_side_best`;
- training target: `disc_loss = max(0, raw_loss)`.

The sole severity target is the exact four-class mapping: 0 → `class_zero`, 1–3 →
`class_1_3`, 4–9 → `class_4_9`, and >=10 → `class_ge10`. Derived audit labels are
`label_zero`, `label_ge4`, and `label_ge10`. Loss must be integer-valued.

`raw_loss` remains for audit. Explicit pass rows are continuity evidence but not
evaluated child positions or decision nodes; their engine score may be absent.
Next-state fields, child scores, `raw_loss`, and `disc_loss` are prohibited
from model inputs.

The only allowed input policy is
`uniform-no-current-player-loss-history-v1`, identically applied to train,
validation, test, later control games, and reported games. No current-player prior
loss outcome, threshold indicator/rate/count, cumulative/mean/recent loss, loss
sequence, prior predicted loss probability, or residual may be constructed or passed
as a feature. Forbidden columns are omitted, not zero-filled and not accompanied by a
missing indicator. Label and audit columns may exist beside `X`, but only `X`, board
context, current actual thinking time, and the existing non-loss board/hint tensors
enter model forward. There is no alternate input mode.

## Model-ready NPZ

Formal training consumes a UTF-8-manifested NPZ produced after the new schema is
confirmed. Required arrays are:

- `X`: games × time × 362, in the exact checkpoint feature order;
- `board_tokens`: games × time × 3 × 64;
- `board_move_tokens`: games × time × 3;
- `current_hint_tokens`: games × time × 6;
- `current_hint_values`: games × time × 4;
- `prev_own_hint_values`: games × time × 2;
- `actual_thinking_time_ms`, `raw_loss`, `disc_loss`, `severity_class`,
  `label_zero`, `label_ge4`, `label_ge10`, `mask`, `global_placement_ply`;
- one-per-game `game_id` and `split`, plus games × time `player_id` and
  `side_to_move`.
- ordered `input_features` (362 names), ordered `board_cnn_channels` (23 names),
  and scalar `preprocessing_sha256`, all exactly matching the base checkpoint.
- scalar `input_policy`, exactly
  `uniform-no-current-player-loss-history-v1`; validation fails if it is missing or
  different.
- stable audit arrays `move_index`, `source_ply_including_pass`, `label_available`,
  `has_consecutive_child`, `child_continuity_ok`, and `same_side_after_move`.

`split` is one of `train`, `validation`, `test`; each game appears once. Report/output
rows retain game/player IDs, placement ply, side, actual/predicted thinking time,
actual loss, zero/ge4/ge10 labels and probabilities, all four raw class probabilities,
label quality, pass, and child continuity. No expected disc-loss regression is present.
These output/audit fields must never be fed back into a later node's `X`.
The fixed later bootstrap stages are 1–30, 31–47, 48–53, and 54–60.

## OQ Player context extension

The profile-conditioned model uses a separate schema,
`tcn-oq-player-context-v1`. It never appends fields to the official 362-feature
`X` tensor. It requires these additional arrays:

- `oq_profile_raw_features` and normalized `oq_profile_features`, both
  games × time × 31;
- `oq_profile_missing`, in the same fixed 31-field order;
- `oq_profile_feature_names`, `oq_profile_preprocessing_mean`,
  `oq_profile_preprocessing_std`, and `oq_profile_preprocessing_sha256`;
- `oq_profile_node_valid`, player/opponent snapshot timestamps and raw-response
  hashes, and one `oq_profile_game_created_utc` per game;
- scalar `oq_profile_schema`, `oq_profile_policy`, and
  `oq_profile_temporal_leakage_authorized`.

Only train-split, non-padded, non-missing values fit the profile mean and standard
deviation. Validation and test never influence those parameters. Missing fields and
padded nodes are zero after normalization and remain distinguishable through the
separate missing mask.

The fixed feature order is the 31 names defined in `src/oq_profile_features.py`.
They cover both players' overall and fixed-color records, five side-to-move-minus-
opponent differences, and only the side-to-move player's strong/weak records. Raw
Player response fields named `loss` are calculation inputs only and never model input
names.

Two temporal policies are recognized:

- `latest-profile-snapshot-not-after-game-created-v1` selects the closest snapshot
  satisfying `profile_fetched_at_utc <= game.created`.
- `retrospective-current-profile-trusted-temporal-leakage-v1` selects the newest
  available cumulative snapshot even when it follows the game. This policy is
  intentionally temporally leaky and is accepted only when the bundle also records
  explicit temporal-leakage authorization. It is used here by the user's explicit
  decision to trust a rough historical backfill. Metrics produced under this policy
  must retain that disclosure and must not be relabelled as leak-free evidence.

## Still awaiting the new-data Agent

Before materialization is finalized, confirm: exact raw file format; whether context
metadata remains separate; complete official feature source columns; split manifest
location; string encodings for board/side/move; and whether labels arrive precomputed
in addition to auditable child rows. Formal training is blocked until those items,
coverage, negative-raw-loss diagnostics, and game isolation pass validation.
