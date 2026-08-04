"""Explicit CUDA-only two-stage training for the one selected four-class model."""

from __future__ import annotations

import csv
import hashlib
import json
import os
import random
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import numpy as np
import torch
from sklearn.metrics import average_precision_score, brier_score_loss, log_loss, roc_auc_score
from torch.utils.data import DataLoader, Dataset

from .checkpoint import load_checkpoint_payload, load_transferred_model, load_transferred_profile_model, sha256_file
from .data_contract import validate_model_ready_npz
from .feature_policy import INPUT_POLICY
from .model import ProfileConditionedLossModel, SEVERITY_CLASS_NAMES, TimeConditionedLossModel, multitask_loss
from .oq_profile_features import (
    OQ_PROFILE_FEATURE_NAMES,
    profile_ablation_hash,
    profile_ablation_indices,
)
from .progress import atomic_write_json, write_progress

MODEL_NAME = "board-cnn-causal-tcn-time-conditioned-severe-loss"
BASELINE_MODEL_SCHEMA = "time-plus-four-class-severity-v2-uniform-loss-history-policy"
PROFILE_MODEL_SCHEMA = "time-plus-four-class-severity-oq-profile-v1"
MODEL_SCHEMA = BASELINE_MODEL_SCHEMA


@dataclass(frozen=True)
class TrainingConfig:
    head_epochs: int = 8
    fine_tune_epochs: int = 52
    batch_size: int = 32
    head_learning_rate: float = 1.0e-3
    fine_tune_learning_rate: float = 1.0e-4
    weight_decay: float = 1.0e-4
    time_task_weight: float = 0.25
    severity_classification_weight: float = 1.0
    severity_class_weights: tuple[float, float, float, float] = (1.0, 1.0, 1.0, 1.0)
    num_workers: int = 0
    seed: int = 42

    @classmethod
    def load(cls, path: Path) -> "TrainingConfig":
        document = json.loads(path.read_text(encoding="utf-8"))
        if document.get("input_policy") != INPUT_POLICY:
            raise ValueError(f"config input_policy must be {INPUT_POLICY!r}")
        payload = document["training"]
        payload["severity_class_weights"] = tuple(payload["severity_class_weights"])
        cfg = cls(**payload)
        if len(cfg.severity_class_weights) != 4 or any(not np.isfinite(x) or x <= 0 for x in cfg.severity_class_weights):
            raise ValueError("severity_class_weights must have four finite positive entries")
        return cfg


class SequenceDataset(Dataset):
    TENSOR_NAMES = (
        "X", "board_tokens", "board_move_tokens", "current_hint_tokens",
        "current_hint_values", "prev_own_hint_values", "actual_thinking_time_ms",
        "severity_class", "mask",
    )

    def __init__(self, path: Path, split: str, require_oq_profile: bool = False) -> None:
        with np.load(path, allow_pickle=False) as source:
            selected = np.flatnonzero(source["split"].astype(str) == split)
            if not len(selected):
                raise ValueError(f"model-ready data has no {split} games")
            names = list(self.TENSOR_NAMES)
            if require_oq_profile:
                names.extend(("oq_profile_features", "oq_profile_missing"))
            self.arrays = {name: torch.from_numpy(source[name][selected].copy()) for name in names}

    def __len__(self) -> int:
        return self.arrays["X"].shape[0]

    def __getitem__(self, index: int) -> dict[str, torch.Tensor]:
        return {name: value[index] for name, value in self.arrays.items()}


def _json_hash(payload: dict[str, Any]) -> str:
    body = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(body).hexdigest()


def _is_completed_epoch_extension(
    saved_config: dict[str, Any], current_config: dict[str, Any], saved_epoch: int
) -> bool:
    saved = json.loads(json.dumps(saved_config))
    current = json.loads(json.dumps(current_config))
    saved_training = saved.get("training", {})
    current_training = current.get("training", {})
    old_fine_tune_epochs = int(saved_training.get("fine_tune_epochs", -1))
    new_fine_tune_epochs = int(current_training.get("fine_tune_epochs", -1))
    old_head_epochs = int(saved_training.get("head_epochs", -1))
    if new_fine_tune_epochs <= old_fine_tune_epochs:
        return False
    if saved_epoch != old_head_epochs + old_fine_tune_epochs:
        return False
    current_training["fine_tune_epochs"] = old_fine_tune_epochs
    return saved == current


def _atomic_torch_save(path: Path, payload: dict[str, Any]) -> None:
    temp = path.with_name(path.name + f".{os.getpid()}.tmp")
    torch.save(payload, temp)
    os.replace(temp, path)


def _device_info() -> dict[str, Any]:
    if not torch.cuda.is_available():
        raise RuntimeError("formal training requires CUDA; torch.cuda.is_available() is false")
    device = torch.device("cuda:0")
    properties = torch.cuda.get_device_properties(device)
    return {
        "device": str(device), "gpu_name": torch.cuda.get_device_name(device),
        "gpu_count": torch.cuda.device_count(), "cuda_version": torch.version.cuda or "",
        "torch_version": torch.__version__, "gpu_total_memory_bytes": int(properties.total_memory),
    }


def _move(batch: dict[str, torch.Tensor], device: torch.device) -> dict[str, torch.Tensor]:
    return {key: value.to(device, non_blocking=True) for key, value in batch.items()}


def _model_output(model: TimeConditionedLossModel, batch: dict[str, torch.Tensor], use_oq_profile: bool = False):
    base_args = (
        batch["X"].float(), batch["board_tokens"], batch["board_move_tokens"],
        batch["current_hint_tokens"], batch["current_hint_values"].float(),
        batch["prev_own_hint_values"].float(), batch["actual_thinking_time_ms"].float(),
    )
    if use_oq_profile:
        if not isinstance(model, ProfileConditionedLossModel):
            raise TypeError("profile batch requires ProfileConditionedLossModel")
        return model(*base_args, batch["oq_profile_features"].float(), batch["oq_profile_missing"])
    return model(*base_args)


def _binary_metrics(labels: np.ndarray, probabilities: np.ndarray, bins: int = 10) -> dict[str, Any]:
    probabilities = np.clip(probabilities.astype(float), 1e-7, 1 - 1e-7)
    labels = labels.astype(int)
    calibration = []
    edges = np.linspace(0.0, 1.0, bins + 1)
    for index in range(bins):
        in_bin = (probabilities >= edges[index]) & (probabilities < edges[index + 1] if index < bins - 1 else probabilities <= edges[index + 1])
        calibration.append({
            "lower": float(edges[index]), "upper": float(edges[index + 1]),
            "count": int(in_bin.sum()),
            "actual_rate": float(labels[in_bin].mean()) if in_bin.any() else None,
            "mean_probability": float(probabilities[in_bin].mean()) if in_bin.any() else None,
        })
    both_classes = len(np.unique(labels)) == 2
    return {
        "log_loss": float(log_loss(labels, probabilities, labels=[0, 1])),
        "brier_score": float(brier_score_loss(labels, probabilities)),
        "pr_auc": float(average_precision_score(labels, probabilities)) if labels.any() else None,
        "roc_auc": float(roc_auc_score(labels, probabilities)) if both_classes else None,
        "actual_positive_rate": float(labels.mean()),
        "mean_predicted_probability": float(probabilities.mean()),
        "calibration": calibration,
    }


@torch.no_grad()
def evaluate(model: TimeConditionedLossModel, loader: DataLoader, device: torch.device,
             cfg: TrainingConfig, use_oq_profile: bool = False) -> dict[str, Any]:
    model.eval()
    loss_sums = {key: 0.0 for key in ("total", "thinking_time", "severity_classification")}
    targets, probabilities = [], []
    for batch in loader:
        batch = _move(batch, device)
        output = _model_output(model, batch, use_oq_profile)
        losses = multitask_loss(
            output, batch["actual_thinking_time_ms"].float(), batch["severity_class"].float(), batch["mask"],
            cfg.time_task_weight, cfg.severity_classification_weight, cfg.severity_class_weights,
        )
        for key in loss_sums:
            loss_sums[key] += float(losses[key].item())
        valid = batch["mask"].bool() & torch.isfinite(batch["severity_class"])
        targets.append(batch["severity_class"][valid].detach().cpu().numpy().astype(int))
        probabilities.append(output.severity_class_probabilities[valid].detach().cpu().numpy())
    losses = {key: value / len(loader) for key, value in loss_sums.items()}
    classes = np.concatenate(targets)
    class_probabilities = np.concatenate(probabilities)
    zero = classes == 0
    ge4 = classes >= 2
    ge10 = classes == 3
    zero_probability = class_probabilities[:, 0]
    ge4_probability = class_probabilities[:, 2] + class_probabilities[:, 3]
    ge10_probability = class_probabilities[:, 3]
    if np.any(ge10_probability > ge4_probability + 1e-6) or np.any(ge4_probability > 1 - zero_probability + 1e-6):
        raise AssertionError("derived severity probabilities violate monotonicity")
    return {
        **losses,
        "zero": _binary_metrics(zero, zero_probability),
        "ge4": _binary_metrics(ge4, ge4_probability),
        "ge10": _binary_metrics(ge10, ge10_probability),
        "class_actual_rates": {name: float((classes == index).mean()) for index, name in enumerate(SEVERITY_CLASS_NAMES)},
        "class_mean_probabilities": {name: float(class_probabilities[:, index].mean()) for index, name in enumerate(SEVERITY_CLASS_NAMES)},
    }


def train_cuda(data_path: Path, base_checkpoint: Path, config_path: Path, output_dir: Path,
               run_name: str, context_metadata: Path | None = None, resume: Path | None = None,
               evaluate_test: bool = True, use_oq_profile: bool = False,
               initial_profile_checkpoint: Path | None = None) -> None:
    device_info = _device_info()
    cfg = TrainingConfig.load(config_path)
    random.seed(cfg.seed)
    np.random.seed(cfg.seed)
    torch.manual_seed(cfg.seed)
    torch.cuda.manual_seed_all(cfg.seed)
    config_document = json.loads(config_path.read_text(encoding="utf-8"))
    model_variant = str(config_document.get("model_variant") or "baseline")
    profile_ablation = str(config_document.get("oq_profile_ablation") or "")
    if use_oq_profile:
        if model_variant != "oq-profile":
            raise ValueError("profile training requires config model_variant='oq-profile'")
        profile_ablation_indices(profile_ablation)
        model_schema = PROFILE_MODEL_SCHEMA
    else:
        if model_variant not in {"", "baseline"}:
            raise ValueError("baseline training refuses an OQ profile model config")
        profile_ablation = ""
        model_schema = BASELINE_MODEL_SCHEMA
    config_payload = {
        "training": asdict(cfg), "model_schema": model_schema,
        "input_policy": INPUT_POLICY,
        "model_variant": model_variant,
        "oq_profile_ablation": profile_ablation,
    }
    config_hash = _json_hash(config_payload)
    data_hash, base_hash = sha256_file(data_path), sha256_file(base_checkpoint)
    if initial_profile_checkpoint is not None and not use_oq_profile:
        raise ValueError("initial profile checkpoint requires profile training")
    warm_start_hash = sha256_file(initial_profile_checkpoint) if initial_profile_checkpoint else ""
    existing = [item for item in output_dir.iterdir()] if output_dir.exists() else []
    if [item for item in existing if item.name not in {"stdout.log", "stderr.log"}] and resume is None:
        raise FileExistsError(f"output directory is not empty: {output_dir}")
    output_dir.mkdir(parents=True, exist_ok=True)
    max_epochs = cfg.head_epochs + cfg.fine_tune_epochs
    write_progress(output_dir, status="validating-data", stage="validating-data", model_name=MODEL_NAME,
                   run_id=run_name, base_checkpoint=str(base_checkpoint.resolve()), max_epochs=max_epochs,
                   training_config=config_payload, **device_info)
    base_payload = load_checkpoint_payload(base_checkpoint)
    preprocessing_hash = _json_hash(base_payload["preprocessing"])
    validation = validate_model_ready_npz(
        data_path, expected_input_features=base_payload["input_features"],
        expected_board_channels=base_payload["board_encoding"]["cnn_channels"],
        expected_preprocessing_sha256=preprocessing_hash,
        require_oq_profile=use_oq_profile,
        expected_oq_profile_feature_names=OQ_PROFILE_FEATURE_NAMES if use_oq_profile else None,
    )
    write_progress(output_dir, status="preparing-features", stage="verifying-model-ready-features", data_manifest=validation)
    atomic_write_json(output_dir / "config.json", config_payload)
    manifest = {
        "schema": "tcn-loss-run-manifest-v1", "modelSchema": model_schema, "runName": run_name,
        "modelVariant": model_variant,
        "inputPolicy": INPUT_POLICY,
        "dataPath": str(data_path.resolve()), "dataSha256": data_hash,
        "contextMetadata": str(context_metadata.resolve()) if context_metadata else "",
        "baseCheckpoint": str(base_checkpoint.resolve()), "baseCheckpointSha256": base_hash,
        "testEvaluationPlanned": bool(evaluate_test),
        "warmStartCheckpoint": str(initial_profile_checkpoint.resolve()) if initial_profile_checkpoint else "",
        "warmStartCheckpointSha256": warm_start_hash,
        "configSha256": config_hash,
        "featureOrderSha256": hashlib.sha256("\n".join(base_payload["input_features"]).encode("utf-8")).hexdigest(),
        "boardChannelOrderSha256": hashlib.sha256("\n".join(base_payload["board_encoding"]["cnn_channels"]).encode("utf-8")).hexdigest(),
        "preprocessingSha256": preprocessing_hash, "dataset": validation, **device_info,
    }
    manifest.update({
        "oqProfileAblation": profile_ablation,
        "oqProfileAblationSha256": profile_ablation_hash(profile_ablation) if use_oq_profile else "",
        "oqProfileFeatureOrderSha256": (
            hashlib.sha256("\n".join(OQ_PROFILE_FEATURE_NAMES).encode("utf-8")).hexdigest()
            if use_oq_profile else ""
        ),
        "oqProfilePreprocessingSha256": validation["oqProfile"]["preprocessingSha256"] if use_oq_profile else "",
        "oqProfilePolicy": validation["oqProfile"]["policy"] if use_oq_profile else "",
        "oqProfileTemporalLeakageAuthorized": validation["oqProfile"]["temporalLeakageAuthorized"] if use_oq_profile else False,
    })
    atomic_write_json(output_dir / "run_manifest.json", manifest)
    write_progress(output_dir, status="loading-checkpoint", stage="loading-checkpoint", data_manifest=manifest)
    model, _ = (
        load_transferred_profile_model(base_checkpoint, profile_ablation)
        if use_oq_profile else load_transferred_model(base_checkpoint)
    )
    if initial_profile_checkpoint is not None:
        warm_start = torch.load(initial_profile_checkpoint, map_location="cpu", weights_only=False)
        if warm_start.get("schema") != "tcn-loss-profile-checkpoint-v1":
            raise ValueError("warm-start checkpoint is not a profile checkpoint")
        warm_manifest = warm_start["manifest"]
        required_warm_identity = {
            "modelSchema": PROFILE_MODEL_SCHEMA,
            "modelVariant": "oq-profile",
            "baseCheckpointSha256": base_hash,
            "oqProfileAblation": profile_ablation,
            "oqProfileAblationSha256": profile_ablation_hash(profile_ablation),
        }
        warm_mismatches = [key for key, value in required_warm_identity.items() if warm_manifest.get(key) != value]
        if warm_mismatches:
            raise ValueError(f"warm-start profile identity mismatch: {warm_mismatches}")
        model.load_state_dict(warm_start["modelStateDict"], strict=True)
        manifest["warmStartProfilePreprocessingSha256"] = warm_manifest.get("oqProfilePreprocessingSha256", "")
        atomic_write_json(output_dir / "run_manifest.json", manifest)
    device = torch.device(device_info["device"])
    model.to(device)
    loader_generator = torch.Generator()
    loader_generator.manual_seed(cfg.seed)
    train_loader = DataLoader(SequenceDataset(data_path, "train", use_oq_profile), batch_size=cfg.batch_size, shuffle=True,
                              num_workers=cfg.num_workers, pin_memory=True, generator=loader_generator)
    validation_loader = DataLoader(SequenceDataset(data_path, "validation", use_oq_profile), batch_size=cfg.batch_size,
                                   num_workers=cfg.num_workers, pin_memory=True)
    write_progress(output_dir, status="ready-to-train", stage="checkpoint-loaded", total_batches=len(train_loader))
    start_epoch, best_value, best_epoch, stage = 1, float("inf"), None, "training-heads"
    for parameter in model.backbone.parameters():
        parameter.requires_grad = False
    optimizer = torch.optim.AdamW((p for p in model.parameters() if p.requires_grad), lr=cfg.head_learning_rate,
                                  weight_decay=cfg.weight_decay)
    if resume:
        saved = torch.load(resume, map_location="cpu", weights_only=False)
        expected = {key: manifest[key] for key in (
            "modelSchema", "dataSha256", "baseCheckpointSha256", "configSha256",
            "featureOrderSha256", "boardChannelOrderSha256", "preprocessingSha256", "inputPolicy",
            "testEvaluationPlanned",
            "modelVariant", "oqProfileAblation", "oqProfileAblationSha256",
            "oqProfileFeatureOrderSha256", "oqProfilePreprocessingSha256", "oqProfilePolicy",
            "oqProfileTemporalLeakageAuthorized",
            "warmStartCheckpoint", "warmStartCheckpointSha256",
        )}
        mismatches = [key for key, value in expected.items() if saved["manifest"].get(key) != value]
        epoch_extension = set(mismatches) == {"configSha256"} and _is_completed_epoch_extension(
            saved["config"], config_payload, int(saved["epoch"])
        )
        if epoch_extension:
            mismatches = []
        if mismatches:
            raise ValueError(f"resume manifest mismatch: {mismatches}")
        if epoch_extension:
            manifest["epochExtension"] = {
                "resumedFromEpoch": int(saved["epoch"]),
                "previousConfigSha256": saved["manifest"]["configSha256"],
                "targetMaxEpochs": max_epochs,
            }
            atomic_write_json(output_dir / "run_manifest.json", manifest)
        model.load_state_dict(saved["modelStateDict"], strict=True)
        stage = saved["stage"]
        if stage == "fine-tuning":
            for parameter in model.backbone.parameters():
                parameter.requires_grad = True
            optimizer = torch.optim.AdamW(model.parameters(), lr=cfg.fine_tune_learning_rate, weight_decay=cfg.weight_decay)
        optimizer.load_state_dict(saved["optimizerStateDict"])
        random.setstate(saved["pythonRandomState"])
        np.random.set_state(saved["numpyRandomState"])
        torch.set_rng_state(saved["torchRandomState"])
        torch.cuda.set_rng_state_all(saved["cudaRandomStates"])
        loader_generator.set_state(saved["loaderGeneratorState"])
        start_epoch = int(saved["epoch"]) + 1
        best_value, best_epoch = float(saved["bestValidationLoss"]), saved["bestEpoch"]
    history_path, started = output_dir / "training_history.csv", time.time()
    for epoch in range(start_epoch, max_epochs + 1):
        if epoch == cfg.head_epochs + 1 and stage != "fine-tuning":
            stage = "fine-tuning"
            for parameter in model.backbone.parameters():
                parameter.requires_grad = True
            optimizer = torch.optim.AdamW(model.parameters(), lr=cfg.fine_tune_learning_rate, weight_decay=cfg.weight_decay)
            write_progress(output_dir, status="fine-tuning", stage=stage, epoch=epoch - 1)
        model.train()
        totals = {key: 0.0 for key in ("total", "thinking_time", "severity_classification")}
        for batch_index, batch in enumerate(train_loader, start=1):
            batch = _move(batch, device)
            optimizer.zero_grad(set_to_none=True)
            output = _model_output(model, batch, use_oq_profile)
            losses = multitask_loss(
                output, batch["actual_thinking_time_ms"].float(), batch["severity_class"].float(), batch["mask"],
                cfg.time_task_weight, cfg.severity_classification_weight, cfg.severity_class_weights,
            )
            losses["total"].backward()
            optimizer.step()
            for key in totals:
                totals[key] += float(losses[key].item())
        train_metrics = {key: value / len(train_loader) for key, value in totals.items()}
        validation_metrics = evaluate(model, validation_loader, device, cfg, use_oq_profile)
        improved = validation_metrics["total"] < best_value
        if improved:
            best_value, best_epoch = validation_metrics["total"], epoch
        checkpoint = {
            "schema": "tcn-loss-profile-checkpoint-v1" if use_oq_profile else "tcn-loss-checkpoint-v1",
            "modelStateDict": model.state_dict(),
            "optimizerStateDict": optimizer.state_dict(), "epoch": epoch, "stage": stage,
            "bestValidationLoss": best_value, "bestEpoch": best_epoch,
            "manifest": manifest, "config": config_payload,
            "pythonRandomState": random.getstate(),
            "numpyRandomState": np.random.get_state(),
            "torchRandomState": torch.get_rng_state(),
            "cudaRandomStates": torch.cuda.get_rng_state_all(),
            "loaderGeneratorState": loader_generator.get_state(),
        }
        _atomic_torch_save(output_dir / "latest.pt", checkpoint)
        if improved:
            _atomic_torch_save(output_dir / "best.pt", checkpoint)
        row = {
            "epoch": epoch, "stage": stage, "train_total_loss": train_metrics["total"],
            "train_thinking_time_loss": train_metrics["thinking_time"],
            "train_severity_classification_loss": train_metrics["severity_classification"],
            "validation_total_loss": validation_metrics["total"],
            "validation_thinking_time_loss": validation_metrics["thinking_time"],
            "validation_severity_classification_loss": validation_metrics["severity_classification"],
            "zero_log_loss": validation_metrics["zero"]["log_loss"],
            "ge4_log_loss": validation_metrics["ge4"]["log_loss"],
            "ge10_log_loss": validation_metrics["ge10"]["log_loss"],
            "learning_rate": optimizer.param_groups[0]["lr"],
        }
        with history_path.open("a", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=list(row))
            if not history_path.exists() or history_path.stat().st_size == 0:
                writer.writeheader()
            writer.writerow(row)
        elapsed = time.time() - started
        eta = elapsed / max(epoch - start_epoch + 1, 1) * (max_epochs - epoch)
        write_progress(
            output_dir, status=stage, stage=stage, epoch=epoch, batch=len(train_loader),
            total_batches=len(train_loader), train_total_loss=train_metrics["total"],
            validation_total_loss=validation_metrics["total"],
            thinking_time_loss=validation_metrics["thinking_time"],
            severity_classification_loss=validation_metrics["severity_classification"],
            zero_loss_log_loss=validation_metrics["zero"]["log_loss"],
            ge4_log_loss=validation_metrics["ge4"]["log_loss"], ge10_log_loss=validation_metrics["ge10"]["log_loss"],
            zero_loss_brier=validation_metrics["zero"]["brier_score"],
            ge4_brier=validation_metrics["ge4"]["brier_score"], ge10_brier=validation_metrics["ge10"]["brier_score"],
            zero_validation_metrics=validation_metrics["zero"], ge4_validation_metrics=validation_metrics["ge4"],
            ge10_validation_metrics=validation_metrics["ge10"],
            severity_class_actual_rates=validation_metrics["class_actual_rates"],
            severity_class_mean_probabilities=validation_metrics["class_mean_probabilities"],
            best_metric=best_value, best_epoch=best_epoch, learning_rate=optimizer.param_groups[0]["lr"],
            elapsed_seconds=elapsed, eta_seconds=eta,
        )
    if not evaluate_test:
        atomic_write_json(output_dir / "validation_only_completion.json", {
            "schema": "tcn-loss-validation-only-completion-v1",
            "ok": True,
            "testEvaluated": False,
            "selectionData": "validation-only",
            "bestValidationTotalLoss": best_value,
            "bestEpoch": best_epoch,
            "maxEpochs": max_epochs,
        })
        write_progress(
            output_dir, status="completed-validation-only", stage="completed-validation-only",
            epoch=max_epochs, validation_total_loss=best_value, best_metric=best_value,
            best_epoch=best_epoch, elapsed_seconds=time.time() - started, eta_seconds=0,
        )
        return
    write_progress(output_dir, status="evaluating", stage="evaluating", epoch=max_epochs)
    test_loader = DataLoader(SequenceDataset(data_path, "test", use_oq_profile), batch_size=cfg.batch_size,
                             num_workers=cfg.num_workers, pin_memory=True)
    best = torch.load(output_dir / "best.pt", map_location=device, weights_only=False)
    model.load_state_dict(best["modelStateDict"], strict=True)
    test_metrics = evaluate(model, test_loader, device, cfg, use_oq_profile)
    atomic_write_json(output_dir / "test_metrics.json", {"schema": "tcn-loss-test-metrics-v1", **test_metrics})
    write_progress(output_dir, status="completed", stage="completed", epoch=max_epochs,
                   validation_total_loss=best_value, best_metric=best_value, best_epoch=best_epoch,
                   elapsed_seconds=time.time() - started, eta_seconds=0)
