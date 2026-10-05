# Cycle Records Directory (`records/`)

This directory contains offline, write-through cycle event ledgers, MTM tapes, and materialised summary snapshots written by `src/records/cycleRecordWriter.ts`.

## Contents per cycle (`YYYY-MM-DD` expiry):
- `<YYYY-MM-DD>.jsonl`: Append-only chronological cycle events (`CYCLE_START`, `ORDER_PLACED`, `ORDER_FILLED`, `STOPS_ARMED`, `TARGET_ARMED`, `MTM_CHECKPOINT`, `LEG_SL_HIT`, `LEG_CLOSED`, `TARGET_HIT`, `EXPIRY_SETTLEMENT`, `CYCLE_CLOSED`, `ANOMALY`).
- `<YYYY-MM-DD>.mtm.jsonl`: Dedicated per-cycle MTM tape samples.
- `<YYYY-MM-DD>.summary.json`: Materialised summary snapshot written atomically via temp file and rename.

## Publication & Retention
Per repo rules, cycle record files are gitignored on `main` and published along with daily trade reports directly to the isolated `reports` git branch via git plumbing (`src/reports/reportPublisher.ts`).
