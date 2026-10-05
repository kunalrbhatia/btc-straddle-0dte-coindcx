# Daily Trade Reports

Daily trade reports are automatically generated at contract expiry + 15 minutes (`REPORT_DELAY_MINUTES`, default 15m) and published to the dedicated, bot-owned `reports` branch.

## Branch Architecture

- Reports are committed exclusively to the orphan / isolated **`reports`** branch on GitHub.
- They are **never** committed to `main`.
- Reports are generated using git index plumbing that isolates changes so the active working tree, working branches, and untracked files are never modified or staged.
- The `reports/` folder in local working clones is gitignored.

## File Format

Each report is named `reports/<EXPIRY-date-IST>.md` (e.g. `reports/2026-10-05.md`) and covers the cycle's performance:
1. **Executive Summary**: Key cycle parameters, timestamps, total credit, target profit, and combined realised P&L in points, USDT, and INR.
2. **Leg-by-Leg Execution & P&L**: Individual PUT and CALL execution stats (PUT leg always listed first).
3. **MTM Run-up & Drawdown Analysis**: Observation counts, initial MTM, maximum run-up (peak), maximum drawdown (trough), and final MTM.
4. **Alerts & Operator Journal**: Chronological log of alerts emitted during both entry and expiry dates.
5. **Data Quality & Provenance**: USDT/INR exchange rate provenance, dynamic USDT per point multiplier, spot price, and exchange positions reconciliation.

## CLI Usage

To generate or inspect a report manually:

```bash
# Print report for a specific cycle to stdout without committing
npm run report -- --cycle 2026-10-05 --stdout

# Generate and commit to reports branch in dry-run mode
npm run report -- --cycle 2026-10-05 --dry-run

# Generate and publish live to reports branch
npm run report -- --cycle 2026-10-05
```
