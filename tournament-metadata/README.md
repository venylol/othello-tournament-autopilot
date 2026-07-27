# Tournament Metadata Archive

This folder is the long-term archive for monthly tournament data. Treat it as important source data.

## Do Not Delete

- Do not delete this folder or any monthly archive unless the referee explicitly asks for that exact deletion.
- Do not overwrite a monthly archive with a different event.
- Do not keep duplicate metadata sets for the same month and division. One month of no-handicap data should have one canonical folder.
- If a correction is needed, update the canonical month folder and keep the audit files clear about what changed.

## Canonical Layout

Use this structure for the online no-handicap group:

```text
tournament-metadata/
  no-handicap/
    YYYY-MM.json
    YYYY-MM/
      match-metadata.json
      games-index.json
      absences.json
      analysis-audit.json
      games/
        game_<round>_<table>_<oqGameId>.json
  exports/
    no-handicap/
      YYYY-MM/
        no-handicap-YYYY-MM-summary.csv
        no-handicap-YYYY-MM-report.txt
```

## Required Contents

Each monthly archive should include:

- tournament metadata: tournament name, month, division, FTD index/URL, source files
- pairing metadata: round, table, player names, OQ accounts
- game records: OQ game id, actual colors, transcript, final score
- node analysis: every move node with evaluation and loss fields
- audit metadata: missing games, absence tables, excluded duplicate or mismatched files

Playable transcript strings must omit pass markers (`-`). Review software can infer pass moves automatically from the legal position. Raw per-node analysis files may still preserve original engine/OQ node data for auditability, but exported CSV/TXT transcripts should not include `-` moves.

For no-handicap monthly archives, use `no-handicap/YYYY-MM/` as the canonical folder. A month should not have multiple competing folders.

## Export

Generate monthly CSV/TXT reports with:

```powershell
node tournament-metadata\scripts\export_no_handicap_month.js 2026-06
```

The script reads `tournament-metadata/no-handicap/YYYY-MM/` and writes exports under `tournament-metadata/exports/no-handicap/YYYY-MM/`.

Export format notes:

- CSV/TXT reports are human-facing summaries and do not include internal OQ game ids or archive file names.
- TXT reports do not dump every node line. Per-node details stay in `games/*.json`.
- CSV/TXT reports append a Top 10 lowest average game loss section. For those players, all games and playable transcripts are listed.
