#!/usr/bin/env python3
"""Render fixed-theme PNG diagnostics from TCN node predictions."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from sklearn.metrics import average_precision_score, roc_auc_score


COLORS = {
    "0": "#3B82C4",
    "1–3": "#E58B3D",
    "4–9": "#4BAA72",
    "≥10": "#D6679A",
}
TREND_GROUPS = (
    ("0", 0, 0, 0.0),
    ("1", 1, 1, 1.0),
    ("2", 2, 2, 2.0),
    ("3", 3, 3, 3.0),
    ("4–5", 4, 5, 4.5),
    ("6–7", 6, 7, 6.5),
    ("8–9", 8, 9, 8.5),
    ("10–12", 10, 12, 11.0),
    ("13–15", 13, 15, 14.0),
    ("16–19", 16, 19, 17.5),
    ("20+", 20, np.inf, 20.0),
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--predictions", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--split", choices=("train", "validation", "test"), default="test")
    parser.add_argument("--sample-size", type=int, default=8000)
    parser.add_argument("--dpi", type=int, default=170)
    return parser.parse_args()


def calibration(frame: pd.DataFrame, probability: str, actual: str) -> pd.DataFrame:
    values = frame[[probability, actual]].dropna().copy()
    values["bin"] = np.minimum((values[probability] * 10).astype(int), 9)
    return values.groupby("bin", observed=True).agg(
        predicted=(probability, "mean"),
        observed=(actual, "mean"),
        count=(actual, "size"),
    ).reset_index()


def grouped_trend(frame: pd.DataFrame) -> pd.DataFrame:
    loss = pd.to_numeric(frame["actual_disc_loss"], errors="raise")
    probability = pd.to_numeric(frame["probability_loss_ge4"], errors="raise")
    rows = []
    for label, lower, upper, position in TREND_GROUPS:
        selected = loss.ge(lower) if np.isinf(upper) else loss.between(lower, upper, inclusive="both")
        values = probability.loc[selected]
        if values.empty:
            continue
        standard_error = float(values.std(ddof=1) / np.sqrt(len(values))) if len(values) > 1 else 0.0
        rows.append({
            "label": label,
            "position": position,
            "mean": float(values.mean()),
            "lower": max(0.0, float(values.mean()) - 1.96 * standard_error),
            "upper": min(1.0, float(values.mean()) + 1.96 * standard_error),
            "count": int(len(values)),
        })
    return pd.DataFrame(rows)


def main() -> int:
    args = parse_args()
    frame = pd.read_csv(args.predictions, low_memory=False, encoding="utf-8")
    selected_frame = frame.loc[frame["split"].eq(args.split)].copy()
    if selected_frame.empty:
        raise ValueError(f"predictions contain no {args.split} rows")
    sample = selected_frame.sample(n=min(args.sample_size, len(selected_frame)), random_state=42).copy()
    rng = np.random.default_rng(42)
    actual_loss = pd.to_numeric(sample["actual_disc_loss"], errors="raise").to_numpy(float)
    category = np.select(
        [actual_loss == 0, actual_loss <= 3, actual_loss <= 9],
        ["0", "1–3", "4–9"],
        default="≥10",
    )
    x = np.minimum(actual_loss, 20) + rng.uniform(-0.24, 0.24, len(sample))
    y = sample["probability_loss_ge4"].to_numpy(float)

    plt.rcParams.update({
        "font.family": "sans-serif",
        "font.sans-serif": ["Microsoft YaHei", "Segoe UI", "SimHei", "DejaVu Sans"],
        "font.size": 10.5,
        "axes.unicode_minus": False,
        "figure.facecolor": "white",
        "axes.facecolor": "white",
        "savefig.facecolor": "white",
        "text.color": "#202832",
        "axes.labelcolor": "#202832",
        "axes.edgecolor": "#B5BEC8",
        "axes.titlecolor": "#17202A",
        "xtick.color": "#536171",
        "ytick.color": "#536171",
        "grid.color": "#E2E7EC",
    })
    fig = plt.figure(figsize=(15.5, 11.2))
    grid = fig.add_gridspec(
        2, 3, height_ratios=[1.62, 1.0],
        left=0.065, right=0.985, top=0.885, bottom=0.075,
        hspace=0.39, wspace=0.27,
    )
    scatter_ax = fig.add_subplot(grid[0, :])
    calibration_axes = [fig.add_subplot(grid[1, index]) for index in range(3)]
    for ax in (scatter_ax, *calibration_axes):
        ax.set_facecolor("#FAFBFC")

    for label in ("0", "1–3", "4–9", "≥10"):
        selected = category == label
        scatter_ax.scatter(
            x[selected], y[selected], s=10, alpha=0.18,
            c=COLORS[label], edgecolors="none", label=label, rasterized=True,
        )
    trend = grouped_trend(selected_frame)
    scatter_ax.fill_between(
        trend["position"], trend["lower"], trend["upper"],
        color="#263849", alpha=0.12, linewidth=0, zorder=4,
    )
    scatter_ax.plot(
        trend["position"], trend["mean"], color="#263849", linewidth=2.35,
        marker="o", markersize=4.8, markerfacecolor="white", markeredgewidth=1.35,
        label="分组平均预测（阴影为 95% 均值区间）", zorder=5,
    )
    scatter_ax.set_title("实际子损与模型预测的 ≥4 子损概率", fontsize=16, fontweight="medium", loc="left", pad=13)
    scatter_ax.set_xlabel("实际子损（20+ 合并显示）", fontsize=11.5, labelpad=8)
    scatter_ax.set_ylabel("预测概率 P(子损≥4)", fontsize=11.5, labelpad=8)
    scatter_ax.set_xlim(-0.7, 20.7)
    scatter_ax.set_ylim(-0.02, 1.02)
    scatter_ax.set_xticks([0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20],
                          ["0", "2", "4", "6", "8", "10", "12", "14", "16", "18", "20+"])
    scatter_ax.set_yticks(np.arange(0, 1.01, 0.2))
    scatter_ax.grid(True, linewidth=0.75, alpha=0.82)
    scatter_ax.spines[["top", "right"]].set_visible(False)
    scatter_ax.tick_params(labelsize=10.5)
    scatter_ax.legend(
        loc="upper left", ncols=5, frameon=False, fontsize=10.2,
        handletextpad=0.45, columnspacing=1.25, borderaxespad=0.7,
    )
    scatter_ax.text(
        1.0, 1.025, f"散点抽样 {len(sample):,} / {len(selected_frame):,} 个节点",
        transform=scatter_ax.transAxes, ha="right", va="bottom", fontsize=9.5, color="#687686",
    )

    tasks = [
        ("零子损", "probability_loss_zero", "actual_loss_zero", COLORS["1–3"]),
        ("子损≥4", "probability_loss_ge4", "actual_loss_ge4", COLORS["4–9"]),
        ("子损≥10", "probability_loss_ge10", "actual_loss_ge10", COLORS["≥10"]),
    ]
    for index, (ax, (label, probability, actual, color)) in enumerate(zip(calibration_axes, tasks)):
        points = calibration(selected_frame, probability, actual)
        sizes = 42 + 135 * np.sqrt(points["count"] / points["count"].max())
        actual_values = selected_frame[actual].astype(int).to_numpy()
        predicted_values = selected_frame[probability].astype(float).to_numpy()
        roc_auc = roc_auc_score(actual_values, predicted_values)
        pr_auc = average_precision_score(actual_values, predicted_values)
        ax.plot([0, 1], [0, 1], color="#738295", linewidth=1.25, linestyle=(0, (4, 3)), label="理想校准")
        ax.plot(points["predicted"], points["observed"], color=color, linewidth=2.35)
        ax.scatter(points["predicted"], points["observed"], s=sizes, color=color,
                   alpha=0.88, edgecolors="white", linewidths=0.9, zorder=3)
        ax.set_title(f"{label}\nROC-AUC {roc_auc:.3f}  ·  PR-AUC {pr_auc:.3f}",
                     loc="left", fontsize=12.6, fontweight="medium", pad=9)
        ax.set_xlim(-0.02, 1.02)
        ax.set_ylim(-0.02, 1.02)
        ax.set_aspect("equal", adjustable="box")
        ax.set_xticks([0, 0.25, 0.5, 0.75, 1.0])
        ax.set_yticks([0, 0.25, 0.5, 0.75, 1.0])
        ax.grid(True, linewidth=0.7, alpha=0.8)
        ax.spines[["top", "right"]].set_visible(False)
        ax.tick_params(labelsize=9.5)
        ax.set_xlabel("平均预测概率", fontsize=10.5, labelpad=6)
        ax.set_ylabel("实际发生率", fontsize=10.5, labelpad=6)
        if index == 0:
            ax.legend(loc="lower right", frameon=False, fontsize=9.2)

    fig.suptitle(
        "TCN 子损模型｜节点级诊断",
        fontsize=20, fontweight="medium", y=0.972,
    )
    split_label = {"train": "训练集", "validation": "验证集", "test": "独立测试集"}[args.split]
    game_count = selected_frame["game_id"].nunique()
    fig.text(
        0.5, 0.936, f"{split_label} · {game_count:,} 局 · {len(selected_frame):,} 个带标签节点",
        ha="center", va="center", fontsize=11.2, color="#647283",
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(args.output, dpi=args.dpi, bbox_inches="tight")
    plt.close(fig)
    print(json.dumps({
        "ok": True,
        "output": str(args.output.resolve()),
        "split": args.split,
        "games": int(game_count),
        "rows": int(len(selected_frame)),
        "scatterSample": int(len(sample)),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
