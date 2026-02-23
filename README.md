# Master Control Center Budget + Cash Flow (Local-First)

A local-first budgeting and cashflow web app that replaces spreadsheet workflows with a deterministic finance engine + clean command center UI.

## Why this stack
I used **Option A: Vanilla HTML/CSS/JS (ES modules)** with a custom IndexedDB layer:
- zero backend required
- simple to run on Windows (double-click `index.html` or use a tiny static server)
- deterministic rendering and no framework overhead

## Features delivered
- Local IndexedDB persistence only.
- Left navigation + sticky month/scenario controls.
- Dashboard command center with:
  - planned total, actual spent, remaining, disposable after buffer
  - reconciliation inbox
  - upcoming projected running balance
  - alerts for missing planned bills, unmatched transactions, spike month
- Schedule page:
  - CRUD add/delete scheduled items
  - monthly grid Jan..Dec generated from scheduled rules
  - per-month override stored as override records
- Transactions page:
  - manual add
  - CSV import mapper (date/description/amount or debit-credit)
  - idempotent import option
  - split transaction tool
  - auto-match helper
- Calendar page:
  - line-by-line timeline + running projected balance
- Scenarios page:
  - create scenario from baseline
  - baseline vs selected scenario monthly and annual comparison
- Settings/Data:
  - account/category management
  - buffer amount
  - export/import single JSON backup
  - reset demo data
- Deterministic budget/matching engine unit tests.

## Run
### Option 1: No server
Open `index.html` directly in a browser (double-click on Windows works; runtime is embedded inline in `index.html`, so there is no external JS fetch/CORS issue under `file://`).

### Option 2: Tiny local server
```bash
python3 -m http.server 4173
```
Then open `http://localhost:4173`.

## Tests
```bash
npm test
```

## CSV import instructions
1. Go to **Transactions**.
2. Pick CSV file.
3. Select account.
4. Enter column indexes (0-based):
   - Date column
   - Description column
   - Amount column **or** Debit + Credit columns
5. Leave **Idempotent** checked to deduplicate by `(date, amount, description, account)`.
6. Submit Import CSV.

Supported date formats:
- `MM/DD/YYYY`
- `YYYY-MM-DD`

## Data model (IndexedDB stores)
- `accounts {id, name, type, startingBalance}`
- `categories {id, name}`
- `scheduledItems {id, name, type, categoryId, accountId, amount, recurrence, dueDay, dueMonth, dueDate, customMonths, notes}`
- `scheduledOverrides {id, scheduledItemId, yearMonth, amountOverride}`
- `transactions {id, date, description, amount, accountId, categoryId, status, matchedScheduledOccurrenceId, notes}`
- `matchRules {id, pattern, categoryId, accountId, amountTolerance, dateWindowDays}`
- `scenarios {id, name, baseScenarioId, createdAt}`
- `scenarioOverrides {id, scenarioId, targetType, targetId, yearMonth, overrideData}`
- `settings {id, bufferAmount, selectedMonth, selectedScenarioId}`
- `auditLog {id, ...}` (lightweight placeholder)

## Export / Import
- **Export JSON** downloads one file: full database payload.
- **Import JSON** restores all stores exactly (clears existing stores first).
- Use this for backups and machine migration.

## Demo data included
Seed includes:
- recurring bills (child support, rent, car payment, groceries)
- bi-monthly paydays
- annual one-offs (car tax, Amazon Prime)
- sinking fund contribution (vet)
- scenario overrides
- a spike month (November holiday trip)

## Future enhancements (not implemented)
- mobile-friendly layout and PWA install flow
- optional Tauri desktop packaging for Windows executable
- bank sync adapters (Plaid/Open Banking) with explicit opt-in
