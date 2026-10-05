# Cycle Records Directory (`records/`)

This directory contains offline, write-through cycle event ledgers, MTM tapes, and materialised summary snapshots written by `src/records/cycleRecordWriter.ts`.

## Contents per cycle (`YYYY-MM-DD` expiry):
- `<YYYY-MM-DD>.jsonl`: Append-only chronological cycle events (`CYCLE_START`, `ORDER_PLACED`, `ORDER_FILLED`, `STOPS_ARMED`, `TARGET_ARMED`, `MTM_CHECKPOINT`, `LEG_SL_HIT`, `LEG_CLOSED`, `TARGET_HIT`, `EXPIRY_SETTLEMENT`, `CYCLE_CLOSED`, `ANOMALY`).
- `<YYYY-MM-DD>.mtm.jsonl`: Dedicated per-cycle MTM tape samples.
- `<YYYY-MM-DD>.summary.json`: Materialised summary snapshot written atomically via temp file and rename.

## Publication & Retention
Per repo rules, cycle record files are gitignored on `main`. During daily report publishing via git plumbing (`src/reports/reportPublisher.ts`), `<YYYY-MM-DD>.jsonl` and `<YYYY-MM-DD>.summary.json` are committed and pushed to the isolated `reports` git branch alongside the markdown report. The high-frequency `<YYYY-MM-DD>.mtm.jsonl` tape is retained locally on the trading host to prevent repository bloat, while key MTM statistics (high, low, peak, trough, count) are permanently preserved in the summary and report.
