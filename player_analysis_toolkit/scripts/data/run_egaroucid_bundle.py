from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path


TOOLKIT_DIR = Path(__file__).resolve().parents[2]
SRC_ROOT = TOOLKIT_DIR / "src"
if str(SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(SRC_ROOT))

from player_analysis_toolkit.analysis_core import (
    engine_wld_totals_by_game_player,
    load_engine_games,
    write_csv,
    write_json,
)


PROJECT_ROOT = TOOLKIT_DIR.parent
DEFAULT_RUNNER = PROJECT_ROOT / "wechat-decrypt" / "agent_egaroucid_analysis.py"
DEFAULT_PYTHON = PROJECT_ROOT / "wechat-decrypt" / ".venv" / "Scripts" / "python.exe"
DEFAULT_ENGINE = (
    PROJECT_ROOT
    / "Egaroucid_for_Console_7_8_1_Windows_AVX512_AMD"
    / "Egaroucid_for_Console_7_8_1_AVX512_AMD.exe"
)


def existing_file(value: str, label: str) -> Path:
    path = Path(value).resolve()
    if not path.is_file():
        raise FileNotFoundError(f"{label} not found: {path}")
    return path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run the existing Egaroucid account-bundle analyzer in a new isolated output directory."
    )
    parser.add_argument("--bundle", required=True)
    parser.add_argument("--tournament-bundle", default="")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--runner", default=str(DEFAULT_RUNNER))
    parser.add_argument("--python", default=str(DEFAULT_PYTHON))
    parser.add_argument("--engine", default=str(DEFAULT_ENGINE))
    parser.add_argument("--level", type=int, default=22)
    parser.add_argument("--threads", type=int, default=32)
    parser.add_argument("--hash", type=int, default=26)
    parser.add_argument("--book", default="")
    parser.add_argument("--node-restart", type=int, default=1000)
    parser.add_argument(
        "--wld-from-ply",
        type=int,
        choices=(39,),
        help="after engine completion, write per-game/player WLD totals from inclusive pass-free ply 39",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    bundle = existing_file(args.bundle, "account bundle")
    tournament = (
        existing_file(args.tournament_bundle, "tournament bundle")
        if args.tournament_bundle
        else None
    )
    runner = existing_file(args.runner, "Egaroucid analysis runner")
    python_exe = existing_file(args.python, "Python interpreter")
    engine = existing_file(args.engine, "Egaroucid engine")
    output_dir = Path(args.output_dir).resolve()
    if output_dir.exists():
        raise FileExistsError(f"refusing to reuse or continue an existing output directory: {output_dir}")
    output_dir.parent.mkdir(parents=True, exist_ok=True)

    command = [
        str(python_exe),
        str(runner),
        "analyze-bundle",
        "--bundle",
        str(bundle),
        "--cache-dir",
        str(output_dir),
        "--engine",
        str(engine),
        "--level",
        str(args.level),
        "--threads",
        str(args.threads),
        "--hash",
        str(args.hash),
        "--node-restart",
        str(args.node_restart),
    ]
    if tournament is not None:
        command.extend(["--tournament-bundle", str(tournament)])
    if args.book:
        command.extend(["--book", str(existing_file(args.book, "Egaroucid book"))])

    environment = os.environ.copy()
    environment["PYTHONUTF8"] = "1"
    environment["PYTHONIOENCODING"] = "utf-8"
    completed = subprocess.run(command, env=environment, check=False)
    if completed.returncode == 0 and args.wld_from_ply is not None:
        totals = engine_wld_totals_by_game_player(
            load_engine_games(output_dir), args.wld_from_ply
        )
        write_json(output_dir / "engine_wld_loss_totals_from_ply39.json", totals)
        write_csv(
            output_dir / "engine_wld_loss_totals_by_game_player_from_ply39.csv",
            totals["gamePlayerTotals"],
        )
        write_csv(
            output_dir / "engine_wld_loss_totals_by_player_from_ply39.csv",
            totals["playerTotals"],
        )
        print(json.dumps(totals, ensure_ascii=False, indent=2))
    return int(completed.returncode)


if __name__ == "__main__":
    raise SystemExit(main())
