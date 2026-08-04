#!/usr/bin/env python3
"""CPU smoke gate proving profile arrays enter the train-profile model path."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import torch


ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.checkpoint import load_checkpoint_payload, load_transferred_profile_model  # noqa: E402
from src.data_contract import validate_model_ready_npz  # noqa: E402
from src.oq_profile_features import OQ_PROFILE_FEATURE_NAMES  # noqa: E402
from src.training import SequenceDataset, _model_output  # noqa: E402


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", required=True, type=Path)
    parser.add_argument("--base-checkpoint", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--split", default="train", choices=("train", "validation", "test"))
    parser.add_argument("--ablation", default="full-31")
    args = parser.parse_args()

    data_path = args.data.resolve()
    checkpoint_path = args.base_checkpoint.resolve()
    checkpoint = load_checkpoint_payload(checkpoint_path)
    validation = validate_model_ready_npz(
        data_path,
        expected_input_features=checkpoint["input_features"],
        expected_board_channels=checkpoint["board_encoding"]["cnn_channels"],
        expected_oq_profile_feature_names=OQ_PROFILE_FEATURE_NAMES,
        require_oq_profile=True,
    )
    dataset = SequenceDataset(data_path, args.split, require_oq_profile=True)
    required_keys = set(SequenceDataset.TENSOR_NAMES) | {"oq_profile_features", "oq_profile_missing"}
    sample = None
    for index in range(len(dataset)):
        candidate = dataset[index]
        valid = candidate["mask"].bool()
        if valid.any() and (~candidate["oq_profile_missing"][valid]).any():
            sample = {name: value.unsqueeze(0) for name, value in candidate.items()}
            break
    if sample is None or set(sample) != required_keys:
        raise ValueError("no profile-covered training sample or dataset key contract mismatch")

    model, _ = load_transferred_profile_model(checkpoint_path, args.ablation)
    model.train()
    output = _model_output(model, sample, use_oq_profile=True)
    valid = sample["mask"].bool()
    loss = output.severity_logits[valid].square().mean()
    loss.backward()
    gradient = model.profile_severity_film.weight.grad
    if gradient is None or not torch.isfinite(gradient).all() or not torch.any(gradient != 0):
        raise AssertionError("profile branch receives no first-step gradient")

    model.eval()
    with torch.no_grad():
        model.profile_severity_film.weight.fill_(0.001)
        real = _model_output(model, sample, use_oq_profile=True)
        perturbed = {name: value.clone() for name, value in sample.items()}
        present = ~perturbed["oq_profile_missing"]
        perturbed["oq_profile_features"][present] += 1.0
        changed = _model_output(model, perturbed, use_oq_profile=True)
    severity_changes = not torch.equal(real.severity_logits, changed.severity_logits)
    time_unchanged = torch.equal(real.pred_time_log_seconds, changed.pred_time_log_seconds)
    if not severity_changes or not time_unchanged:
        raise AssertionError("profile inputs do not have the expected severity-only activation path")

    report = {
        "schema": "oq-profile-training-activation-audit-v1", "ok": True,
        "formalTrainingStarted": False, "device": "cpu", "optimizationSteps": 0,
        "data": str(data_path), "dataSha256": sha256_file(data_path),
        "baseCheckpointSha256": sha256_file(checkpoint_path),
        "profileFeatureCount": 31, "profileFeatureOrder": list(OQ_PROFILE_FEATURE_NAMES),
        "sequenceDatasetLoadedProfileArrays": True,
        "trainProfileForwardConsumedArrays": True,
        "profileBranchFirstStepGradientNonzero": True,
        "profilePerturbationChangesSeverityLogits": True,
        "profilePerturbationLeavesThinkingTimeHeadUnchanged": True,
        "validation": validation,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
