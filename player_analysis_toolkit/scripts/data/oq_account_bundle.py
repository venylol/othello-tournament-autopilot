from __future__ import annotations

import argparse
import json
import re
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


MODE_ENDPOINTS = {
    "1min": "reversi1",
    "5min": "reversi",
    "xot": "reversix",
}


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"JSON root must be an object: {path}")
    return value


def write_new_json(path: Path, value: Any) -> None:
    if path.exists():
        raise FileExistsError(f"refusing to overwrite existing output: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=False) + "\n",
        encoding="utf-8",
    )


def get_json(base_url: str, path: str, timeout: int) -> Any:
    request = urllib.request.Request(
        f"{base_url.rstrip('/')}{path}",
        headers={"Accept": "application/json", "User-Agent": "player-analysis-toolkit/1.0"},
        method="GET",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def account_key(value: Any) -> str:
    return re.sub(r"[^0-9a-z]+", "", str(value or "").casefold())


def name_key(value: Any) -> str:
    return " ".join(re.findall(r"[0-9a-z]+", str(value or "").casefold()))


def public_games(base_url: str, account: str, mode: str, timeout: int) -> list[dict[str, Any]]:
    endpoint = MODE_ENDPOINTS[mode]
    account_path = urllib.parse.quote(account.strip().lower())
    payload = get_json(base_url, f"/games/{endpoint}/{account_path}.json", timeout)
    games = payload.get("games") if isinstance(payload, dict) else payload
    if not isinstance(games, list) or not all(isinstance(item, dict) for item in games):
        raise RuntimeError("OQ public account endpoint did not return a game list")
    ids = [str(item.get("id") or "").strip() for item in games]
    if not all(ids) or len(ids) != len(set(ids)):
        raise RuntimeError("OQ public account endpoint returned missing or duplicate game IDs")
    return games


def fetch_detail(base_url: str, game_id: str, timeout: int) -> dict[str, Any]:
    payload = get_json(base_url, f"/game/{urllib.parse.quote(game_id)}.json", timeout)
    if not isinstance(payload, dict) or payload.get("error"):
        raise RuntimeError(f"OQ game detail unavailable for {game_id}")
    if str(payload.get("id") or "").strip() != game_id:
        raise RuntimeError(f"OQ game detail ID mismatch for {game_id}")
    return payload


def fetch_details(
    base_url: str,
    games: list[dict[str, Any]],
    timeout: int,
    concurrency: int,
) -> list[dict[str, Any]]:
    ids = [str(item["id"]) for item in games]
    details_by_id: dict[str, dict[str, Any]] = {}
    with ThreadPoolExecutor(max_workers=max(1, concurrency)) as executor:
        futures = {
            executor.submit(fetch_detail, base_url, game_id, timeout): game_id
            for game_id in ids
        }
        for future in as_completed(futures):
            game_id = futures[future]
            details_by_id[game_id] = future.result()
    return [details_by_id[game_id] for game_id in ids]


def validate_account_participation(account: str, details: list[dict[str, Any]]) -> None:
    target = account_key(account)
    for detail in details:
        players = detail.get("players") if isinstance(detail.get("players"), list) else []
        keys = {
            account_key(player.get("id") or player.get("name"))
            for player in players
            if isinstance(player, dict)
        }
        if len(players) != 2 or target not in keys:
            raise RuntimeError(f"target account is not one of two players in game {detail.get('id')}")


def mapping_by_name(state: dict[str, Any]) -> dict[str, dict[str, Any]]:
    raw = state.get("ftdPlayerAccountMapping")
    if not isinstance(raw, dict):
        raise RuntimeError("shared state has no ftdPlayerAccountMapping object")
    account_index = raw.get("accountIndex")
    rows = account_index if isinstance(account_index, dict) else raw
    result: dict[str, dict[str, Any]] = {}
    for map_name, row in rows.items():
        if not isinstance(row, dict):
            continue
        for candidate in (map_name, row.get("ftdName"), row.get("displayName")):
            key = name_key(candidate)
            if key:
                result[key] = row
    return result


def pairing_game_id(row: dict[str, Any]) -> str:
    source_key = str(row.get("sourceMessageKey") or "")
    if source_key.startswith("oq-auto:id:"):
        return source_key.removeprefix("oq-auto:id:").strip()
    audit = row.get("oqAutoAudit") if isinstance(row.get("oqAutoAudit"), dict) else {}
    game = audit.get("game") if isinstance(audit.get("game"), dict) else {}
    return str(game.get("gameId") or row.get("oqGameId") or "").strip()


def tournament_games(
    state: dict[str, Any],
    account: str,
    available_ids: set[str],
    reported_opponents: set[str],
) -> list[dict[str, Any]]:
    score_helper = state.get("scoreHelper") if isinstance(state.get("scoreHelper"), dict) else {}
    rounds = score_helper.get("rounds") if isinstance(score_helper.get("rounds"), list) else []
    mappings = mapping_by_name(state)
    target = account_key(account)
    output: list[dict[str, Any]] = []
    for round_item in rounds:
        if not isinstance(round_item, dict):
            continue
        pairings = round_item.get("ftdPairings") if isinstance(round_item.get("ftdPairings"), list) else []
        for row in pairings:
            if not isinstance(row, dict):
                continue
            black_name = str(row.get("black") or "").strip()
            white_name = str(row.get("white") or "").strip()
            black_map = mappings.get(name_key(black_name), {})
            white_map = mappings.get(name_key(white_name), {})
            black_account = str(black_map.get("account") or "").strip()
            white_account = str(white_map.get("account") or "").strip()
            if target not in {account_key(black_account), account_key(white_account)}:
                continue
            if not black_account or not white_account:
                raise RuntimeError(
                    f"missing mapped OQ account for round {round_item.get('round')} table {row.get('table')}"
                )
            game_id = pairing_game_id(row)
            if not game_id:
                raise RuntimeError(
                    f"missing OQ game ID for round {round_item.get('round')} table {row.get('table')}"
                )
            if game_id not in available_ids:
                raise RuntimeError(f"tournament game {game_id} is absent from the fetched account bundle")
            opponent = white_account if account_key(black_account) == target else black_account
            output.append(
                {
                    "round": int(round_item.get("round") or 0),
                    "stage": str(round_item.get("stage") or ""),
                    "table": int(row.get("table") or 0),
                    "oqGameId": game_id,
                    "ftdBlack": black_name,
                    "ftdWhite": white_name,
                    "ftdBlackAccount": black_account,
                    "ftdWhiteAccount": white_account,
                    "ftdStage": str(row.get("ftdStage") or ""),
                    "ftdRound": row.get("ftdRound"),
                    "ftdTable": row.get("ftdTable"),
                    "reported": account_key(opponent) in reported_opponents,
                    "reportedOpponentAccount": opponent if account_key(opponent) in reported_opponents else "",
                }
            )
    ids = [item["oqGameId"] for item in output]
    if not output or len(ids) != len(set(ids)):
        raise RuntimeError("target tournament pairings are missing or contain duplicate OQ game IDs")
    output.sort(key=lambda item: (item["round"], item["table"]))
    return output


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Fetch a public OQ account bundle and optionally annotate local tournament pairings."
    )
    parser.add_argument("--account", required=True)
    parser.add_argument("--mode", choices=sorted(MODE_ENDPOINTS), default="5min")
    parser.add_argument("--output", required=True, help="New account bundle JSON path")
    parser.add_argument("--base-url", default="http://questgames.net")
    parser.add_argument("--timeout", type=int, default=20)
    parser.add_argument("--concurrency", type=int, default=8)
    parser.add_argument("--state", default="", help="Optional shared checkin-state.json")
    parser.add_argument("--tournament-output", default="", help="New tournament bundle JSON path")
    parser.add_argument("--reported-opponent", action="append", default=[])
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    output_path = Path(args.output).resolve()
    tournament_path = Path(args.tournament_output).resolve() if args.tournament_output else None
    if output_path.exists() or (tournament_path and tournament_path.exists()):
        raise FileExistsError("refusing to overwrite an existing requested output")
    games = public_games(args.base_url, args.account, args.mode, args.timeout)
    details = fetch_details(args.base_url, games, args.timeout, args.concurrency)
    validate_account_participation(args.account, details)
    fetched_at = datetime.now(timezone.utc).isoformat()
    bundle = {
        "schema": "oq-public-account-bundle-v1",
        "scope": "public-account-endpoint-exposed-games",
        "account": args.account,
        "mode": args.mode,
        "fetchedAt": fetched_at,
        "sourceUrl": (
            f"{args.base_url.rstrip('/')}/games/{MODE_ENDPOINTS[args.mode]}/"
            f"{urllib.parse.quote(args.account.strip().lower())}.json"
        ),
        "index": games,
        "details": details,
    }
    tournament_bundle = None
    if tournament_path:
        if not args.state:
            raise ValueError("--state is required with --tournament-output")
        state_path = Path(args.state).resolve()
        pairings = tournament_games(
            read_json(state_path),
            args.account,
            {str(item["id"]) for item in games},
            {account_key(value) for value in args.reported_opponent},
        )
        tournament_bundle = {
            "schema": "oq-local-tournament-account-games-v1",
            "account": args.account,
            "sourceState": str(state_path),
            "createdAt": fetched_at,
            "games": pairings,
        }
    write_new_json(output_path, bundle)
    if tournament_path and tournament_bundle is not None:
        write_new_json(tournament_path, tournament_bundle)
    print(
        json.dumps(
            {
                "ok": True,
                "account": args.account,
                "mode": args.mode,
                "gameCount": len(games),
                "bundle": str(output_path),
                "tournamentGameCount": len(tournament_bundle["games"]) if tournament_bundle else 0,
                "reportedGameCount": (
                    sum(bool(item["reported"]) for item in tournament_bundle["games"])
                    if tournament_bundle
                    else 0
                ),
                "tournamentBundle": str(tournament_path) if tournament_path else None,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
