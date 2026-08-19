# Household Portfolio Rebalancer

A local full-stack tool that turns a brokerage’s flat positions export into a household view of money: asset classes, an editable target allocation, and the exact per-account trades needed to get there.

## Setup

Requires Node.js 20.9+.

```bash
npm install
npm test
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The sample export in `data/` loads automatically. Upload a newer Acme/Fidelity Positions file (`.csv` or `.xlsx`) at any time.

No paid APIs, accounts, or hosted infrastructure.

## What the export actually is

The file we were given is `Portfolio_Positions_Jun-15-2026.xlsx`, not a CSV. Columns match the usual Fidelity/Acme Positions download:

`Account Number, Account Name, Symbol, Description, Quantity, Last Price, Last Price Change, Current Value, Today's Gain/Loss Dollar, Today's Gain/Loss Percent, Total Gain/Loss Dollar, Total Gain/Loss Percent, Percent Of Account, Cost Basis Total, Average Cost Basis, Type`

The parser ingests that layout as-is, including disclaimer footer rows. A CSV with the same headers is also accepted — that is the “fixed CSV format” the brokerage would send. We do not invent a different export.

Four accounts in the sample:

| Account | Role | Value |
|---|---|---|
| Joint WROS | Taxable brokerage | ~$62,364 |
| IRA (Alex) | Retirement | ~$375,481 |
| IRA (Jordan) | Retirement | ~$95,292 |
| Alex's old brokerage | Leftover cash | $0.21 |

Household total ≈ **$533,137**.

## Domain model (how the ticker soup becomes money)

The brokerage shows symbols. The household thinks in sleeves:

| Class | Default tickers |
|---|---|
| Cash | `FZFXX`, `SPAXX`, `FCASH`, `FRGXX` (money markets) |
| Treasuries | `BIL` (1–3 month T-bills) |
| US Equity | `FNILX`, plus satellite `NUKZ` / `SHLD` |
| International | `FZILX`, `VGK` |
| Gold | `IAU` |

That mapping is **product design**. It is not in the file. The UI can remap any ticker.

**Important:** the export `Type` column is Cash vs Margin *holding type*, not asset class. IRA index funds are `Type=Cash`. Treating that column as “this row is cash” would classify most of the retirement accounts as a money-market pile. We map by ticker and description instead.

## Rebalancing rules

1. **Each account is a closed cash box.** Buys in Joint WROS can only be funded by that account’s money-market sleeve (`FZFXX**`). IRA cash never pays for a brokerage trade.
2. **Money-market balances are the cash sleeve**, not orders. The trade blotter lists security buys and sells; SPAXX/FZFXX absorb the residual.
3. **Within a class**, sells are pro-rata across that account’s holdings. Buys add to existing lots; if the account has none, we buy the household’s largest ticker in that class.
4. **Tiny leftover accounts** (under $10) are shown and skipped.
5. **Buys are scaled** if an account cannot fund them from its own cash plus sell proceeds.

## Liquidity preference

A household cash target of 10% does **not** mean every account holds 10% cash. Retirement accounts are a poor place to warehouse spending money; a taxable brokerage is a better one. Cash also cannot be wired between these accounts as part of the rebalance.

Each account has a liquidity score (0–100). Defaults:

- Taxable / joint / brokerage → 100
- IRA / 401k / Roth → 20
- Name contains “old” → 75

The cash target for account *i* is:

```
cash_i = clamp(C* + tilt × (L_i − 0.5), 0, 0.9)
```

Non-cash classes keep the household’s *relative* mix and fill whatever is left. `tilt = 0` applies the same mix to every account. That formula works for any number of accounts, not just this household.

## Architecture

| Path | Role |
|---|---|
| `src/lib/parsePositions.ts` | Ingest CSV/XLSX as-is |
| `src/lib/mapping.ts` | Tickers → classes, default liquidity |
| `src/lib/rebalance.ts` | Pure per-account planner |
| `src/lib/rebalance.test.ts` | Isolation, tilt, mapping, skip rules |
| `src/components/RebalancerApp.tsx` | Working UI |

Next.js App Router, all local. Rebalancing is a pure function so it can be tested without the browser.

## Trade-offs

- **Household target, account-level execution.** A global optimizer that moved gold from Alex’s IRA into the joint account would need cash or in-kind transfers we are forbidden to assume.
- **Satellites live inside US Equity by default.** `NUKZ` and `SHLD` could be their own sleeve; putting them in US Equity keeps the target list to the classes a household actually names. Remap if you disagree.
- **Fractional shares, 3 decimals.** Matches the export (the brokerage already holds fractional ETFs).
- **No tax lot optimization.** Correctness of cash isolation beat a half-built tax engine in the time budget.

## AI collaboration (for the video)

One concrete redirection: a first-pass mapping used the export’s `Type` column as asset class. On this file that is wrong — `FNILX` in both IRAs is `Type=Cash` and is still a US stock fund. The mapping was rewritten to be ticker- and description-driven, and a test locks that in.

A second: the prompt asked for CSV, but the artifact is XLSX with the same columns. The tool reads both rather than forcing a hand conversion at runtime.
