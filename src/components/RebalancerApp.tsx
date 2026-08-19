"use client";

import { useEffect, useMemo, useState } from "react";
import { usd, pct, shares, maskAccount } from "@/lib/format";
import {
  CASH_CLASS_ID,
  DEFAULT_ASSET_CLASSES,
  DEFAULT_TARGET_PERCENTS,
  defaultAccountPolicies,
  defaultMappingForPositions,
} from "@/lib/mapping";
import {
  parsePositionsFromArrayBuffer,
  parsePositionsFromCsv,
} from "@/lib/parsePositions";
import { rebalance } from "@/lib/rebalance";
import type {
  AccountPolicy,
  Position,
  TickerMapEntry,
} from "@/lib/types";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; fileLabel: string }
  | { status: "error"; message: string };

export function RebalancerApp() {
  const [positions, setPositions] = useState<Position[]>([]);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [parseWarnings, setParseWarnings] = useState<string[]>([]);
  const [mapping, setMapping] = useState<TickerMapEntry[]>([]);
  const [policies, setPolicies] = useState<AccountPolicy[]>([]);
  const [targets, setTargets] = useState<Record<string, number>>(DEFAULT_TARGET_PERCENTS);
  const [tilt, setTilt] = useState(0.35);
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [showMapping, setShowMapping] = useState(false);

  function applyPositions(
    next: Position[],
    fileLabel: string,
    warnings: string[],
    downloaded: string | null,
  ) {
    setPositions(next);
    setParseWarnings(warnings);
    setAsOf(downloaded);
    setMapping(defaultMappingForPositions(next));
    setPolicies(defaultAccountPolicies(next));
    setLoad({ status: "ready", fileLabel });
  }

  useEffect(() => {
    let cancelled = false;
    fetch("/data/positions.csv")
      .then((res) => {
        if (!res.ok) throw new Error("Could not load sample export");
        return res.text();
      })
      .then((text) => {
        if (cancelled) return;
        const parsed = parsePositionsFromCsv(text);
        applyPositions(
          parsed.positions,
          "positions.csv (sample export)",
          parsed.warnings,
          parsed.asOf,
        );
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoad({
          status: "error",
          message: err instanceof Error ? err.message : "Failed to load sample data",
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function onUpload(file: File) {
    const buffer = await file.arrayBuffer();
    const parsed = parsePositionsFromArrayBuffer(buffer, file.name);
    if (!parsed.positions.length) {
      setLoad({
        status: "error",
        message: "No positions found. Use the brokerage Positions export (CSV or XLSX).",
      });
      return;
    }
    applyPositions(parsed.positions, file.name, parsed.warnings, parsed.asOf);
  }

  const plan = useMemo(() => {
    if (!positions.length) return null;
    return rebalance({
      positions,
      classes: DEFAULT_ASSET_CLASSES,
      mapping,
      targetsPercent: targets,
      policies,
      liquidityTilt: tilt,
    });
  }, [positions, mapping, targets, policies, tilt]);

  const targetSum = Object.values(targets).reduce((s, n) => s + n, 0);
  const classes = DEFAULT_ASSET_CLASSES.filter((c) => c.id !== "other" || (targets.other ?? 0) > 0 || (plan?.householdCurrent.other ?? 0) > 0);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
      <header className="mb-8 flex flex-col gap-4 border-b border-line pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-medium tracking-[0.18em] text-forest uppercase">
            Household desk
          </p>
          <h1 className="mt-1 font-[family-name:var(--font-display)] text-4xl leading-tight text-ink sm:text-5xl">
            Portfolio rebalancer
          </h1>
          <p className="mt-2 max-w-xl text-ink-soft">
            Broker exports are a ticker list. This view is how the household
            actually thinks: asset classes, a target you can change, and trades
            that never move cash between accounts.
          </p>
        </div>
        <div className="rounded-2xl border border-line bg-surface px-4 py-3 shadow-[0_1px_0_rgba(28,25,20,0.04)]">
          <p className="text-xs text-slate">Household total</p>
          <p className="num text-2xl font-medium">{plan ? usd(plan.householdTotal) : "—"}</p>
          <p className="mt-1 text-xs text-ink-soft">
            {asOf ? `Export ${asOf}` : load.status === "ready" ? load.fileLabel : "Loading export…"}
          </p>
        </div>
      </header>

      <section className="mb-6 flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-medium">Positions export</p>
          <p className="text-sm text-ink-soft">
            Acme/Fidelity Positions file, CSV or XLSX, as the brokerage sent it.
          </p>
          {load.status === "error" && (
            <p className="mt-1 text-sm text-copper">{load.message}</p>
          )}
          {parseWarnings.slice(0, 2).map((w) => (
            <p key={w} className="mt-1 text-xs text-gold">
              {w}
            </p>
          ))}
        </div>
        <label className="inline-flex cursor-pointer items-center justify-center rounded-full bg-ink px-4 py-2 text-sm font-medium text-paper">
          Upload export
          <input
            type="file"
            accept=".csv,.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void onUpload(file);
            }}
          />
        </label>
      </section>

      {!plan ? (
        <p className="text-ink-soft">Reading the sample positions export…</p>
      ) : (
        <>
          <section className="mb-6 grid gap-4 lg:grid-cols-[1.3fr_0.7fr]">
            <div className="rounded-2xl border border-line bg-surface p-5">
              <div className="mb-4 flex items-baseline justify-between gap-3">
                <h2 className="font-[family-name:var(--font-display)] text-2xl">Allocation</h2>
                <p className="text-xs text-slate">Current vs target · household</p>
              </div>
              <div className="space-y-4">
                {classes.map((cls) => {
                  const currentDollars = plan.householdCurrent[cls.id] ?? 0;
                  const currentPct = plan.householdTotal
                    ? (currentDollars / plan.householdTotal) * 100
                    : 0;
                  const targetPct = targets[cls.id] ?? 0;
                  return (
                    <div key={cls.id}>
                      <div className="mb-1 flex items-baseline justify-between text-sm">
                        <span className="font-medium">{cls.name}</span>
                        <span className="num text-ink-soft">
                          {pct(currentPct)} now → {pct(targetPct)} target
                          <span className="ml-2 text-slate">{usd(currentDollars, 0)}</span>
                        </span>
                      </div>
                      <div className="relative h-2.5 overflow-hidden rounded-full bg-mist">
                        <div
                          className="absolute inset-y-0 left-0 rounded-full opacity-40"
                          style={{ width: `${Math.min(currentPct, 100)}%`, background: cls.color }}
                        />
                        <div
                          className="absolute inset-y-0 left-0 rounded-full"
                          style={{ width: `${Math.min(targetPct, 100)}%`, background: cls.color }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="rounded-2xl border border-line bg-surface p-5">
              <h2 className="font-[family-name:var(--font-display)] text-2xl">Target mix</h2>
              <p className="mt-1 mb-4 text-sm text-ink-soft">
                Edit percentages. Trades use these weights, normalized if they
                do not sum to 100.
              </p>
              <div className="space-y-3">
                {DEFAULT_ASSET_CLASSES.filter((c) => c.id !== "other").map((cls) => (
                  <label key={cls.id} className="flex items-center justify-between gap-3 text-sm">
                    <span>{cls.name}</span>
                    <span className="flex items-center gap-1">
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step={0.5}
                        value={targets[cls.id] ?? 0}
                        onChange={(e) =>
                          setTargets((prev) => ({
                            ...prev,
                            [cls.id]: Number(e.target.value),
                          }))
                        }
                        className="num w-20 rounded-lg border border-line bg-paper px-2 py-1 text-right"
                      />
                      <span className="text-slate">%</span>
                    </span>
                  </label>
                ))}
              </div>
              <p className={`mt-3 num text-sm ${Math.abs(targetSum - 100) < 0.05 ? "text-forest" : "text-copper"}`}>
                Sum {targetSum.toFixed(1)}%
              </p>
              <button
                type="button"
                className="mt-2 text-sm text-forest underline decoration-line underline-offset-4"
                onClick={() => {
                  if (targetSum <= 0) return;
                  const next: Record<string, number> = {};
                  for (const [k, v] of Object.entries(targets)) {
                    next[k] = Math.round((v / targetSum) * 1000) / 10;
                  }
                  setTargets(next);
                }}
              >
                Normalize to 100%
              </button>

              <div className="mt-6 border-t border-line pt-4">
                <div className="flex items-baseline justify-between">
                  <label htmlFor="tilt" className="text-sm font-medium">
                    Liquidity tilt
                  </label>
                  <span className="num text-sm text-ink-soft">{Math.round(tilt * 100)}</span>
                </div>
                <p className="mt-1 mb-2 text-xs text-ink-soft">
                  Higher values warehouse more cash in accessible accounts
                  (brokerage) and keep retirement accounts invested. Zero applies
                  the same mix to every account.
                </p>
                <input
                  id="tilt"
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={tilt}
                  onChange={(e) => setTilt(Number(e.target.value))}
                  className="w-full"
                />
              </div>
            </div>
          </section>

          <section className="mb-6">
            <h2 className="mb-3 font-[family-name:var(--font-display)] text-2xl">Accounts</h2>
            <div className="grid gap-4 md:grid-cols-2">
              {plan.accounts.map((account) => (
                <article
                  key={account.accountNumber}
                  className="rounded-2xl border border-line bg-surface p-5"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="text-lg font-medium">{account.accountName}</h3>
                      <p className="num text-xs text-slate">{maskAccount(account.accountNumber)}</p>
                    </div>
                    <p className="num text-lg">{usd(account.totalValue)}</p>
                  </div>
                  {account.skipped ? (
                    <p className="mt-3 text-sm text-gold">{account.skipReason}</p>
                  ) : (
                    <>
                      <label className="mt-4 block text-xs font-medium text-ink-soft">
                        Liquidity preference {account.liquidity}
                        <input
                          type="range"
                          min={0}
                          max={100}
                          step={5}
                          value={account.liquidity}
                          onChange={(e) =>
                            setPolicies((prev) =>
                              prev.map((p) =>
                                p.accountNumber === account.accountNumber
                                  ? { ...p, liquidity: Number(e.target.value) }
                                  : p,
                              ),
                            )
                          }
                          className="mt-1 w-full"
                        />
                      </label>
                      <p className="mt-2 text-sm text-ink-soft">
                        Cash now {usd(account.cashValue)} ({pct(account.totalValue ? (account.cashValue / account.totalValue) * 100 : 0)})
                        · target {pct((account.targets[CASH_CLASS_ID] ?? 0) * 100)}
                        · after trades {usd(account.cashAfter)}
                      </p>
                      <p className="mt-1 text-xs text-slate">
                        {account.trades.length} trade{account.trades.length === 1 ? "" : "s"} in this account only
                      </p>
                      {account.warnings.map((w) => (
                        <p key={w} className="mt-2 text-xs text-copper">
                          {w}
                        </p>
                      ))}
                    </>
                  )}
                </article>
              ))}
            </div>
          </section>

          <section className="mb-6 rounded-2xl border border-line bg-surface p-5">
            <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
              <div>
                <h2 className="font-[family-name:var(--font-display)] text-2xl">Trades</h2>
                <p className="text-sm text-ink-soft">
                  Sells first, then buys. Money-market balances are the cash sleeve — not separate tickers to trade.
                </p>
              </div>
              <p className="num text-sm text-slate">{plan.trades.length} orders</p>
            </div>
            {plan.trades.length === 0 ? (
              <p className="text-sm text-ink-soft">No trades needed for this target.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-sm">
                  <thead>
                    <tr className="border-b border-line text-xs tracking-wide text-slate uppercase">
                      <th className="py-2 pr-3 font-medium">Account</th>
                      <th className="py-2 pr-3 font-medium">Side</th>
                      <th className="py-2 pr-3 font-medium">Symbol</th>
                      <th className="py-2 pr-3 font-medium">Class</th>
                      <th className="py-2 pr-3 font-medium text-right">Shares</th>
                      <th className="py-2 pr-3 font-medium text-right">Amount</th>
                      <th className="py-2 font-medium">Cash sleeve</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.trades.map((t, i) => (
                      <tr key={`${t.accountNumber}-${t.symbol}-${t.side}-${i}`} className="border-b border-mist">
                        <td className="py-2.5 pr-3">
                          <div>{t.accountName}</div>
                          <div className="num text-xs text-slate">{maskAccount(t.accountNumber)}</div>
                        </td>
                        <td className="py-2.5 pr-3">
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                              t.side === "BUY"
                                ? "bg-forest-soft text-forest"
                                : "bg-copper-soft text-copper"
                            }`}
                          >
                            {t.side}
                          </span>
                        </td>
                        <td className="num py-2.5 pr-3 font-medium">{t.symbol}</td>
                        <td className="py-2.5 pr-3">{t.className}</td>
                        <td className="num py-2.5 pr-3 text-right">
                          {t.shares == null ? "—" : shares(t.shares)}
                        </td>
                        <td className="num py-2.5 pr-3 text-right">{usd(t.dollars)}</td>
                        <td className="py-2.5 text-xs text-ink-soft">{t.cashSleeve}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="rounded-2xl border border-line bg-surface p-5">
            <button
              type="button"
              className="flex w-full items-center justify-between text-left"
              onClick={() => setShowMapping((v) => !v)}
            >
              <div>
                <h2 className="font-[family-name:var(--font-display)] text-2xl">Ticker map</h2>
                <p className="text-sm text-ink-soft">
                  The brokerage does not send asset classes. Change a ticker here if the default is wrong.
                </p>
              </div>
              <span className="text-sm text-forest">{showMapping ? "Hide" : "Edit"}</span>
            </button>
            {showMapping && (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[520px] text-left text-sm">
                  <thead>
                    <tr className="border-b border-line text-xs tracking-wide text-slate uppercase">
                      <th className="py-2 pr-3 font-medium">Symbol</th>
                      <th className="py-2 pr-3 font-medium">Asset class</th>
                      <th className="py-2 font-medium">Cash sleeve</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mapping.map((entry) => (
                      <tr key={entry.symbol} className="border-b border-mist">
                        <td className="num py-2 pr-3 font-medium">{entry.symbol}</td>
                        <td className="py-2 pr-3">
                          <select
                            value={entry.classId}
                            onChange={(e) =>
                              setMapping((prev) =>
                                prev.map((m) =>
                                  m.symbol === entry.symbol
                                    ? {
                                        ...m,
                                        classId: e.target.value,
                                        isCash: e.target.value === CASH_CLASS_ID ? true : m.isCash,
                                      }
                                    : m,
                                ),
                              )
                            }
                            className="rounded-lg border border-line bg-paper px-2 py-1"
                          >
                            {DEFAULT_ASSET_CLASSES.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="py-2">
                          <label className="inline-flex items-center gap-2 text-xs text-ink-soft">
                            <input
                              type="checkbox"
                              checked={entry.isCash}
                              onChange={(e) =>
                                setMapping((prev) =>
                                  prev.map((m) =>
                                    m.symbol === entry.symbol
                                      ? { ...m, isCash: e.target.checked }
                                      : m,
                                  ),
                                )
                              }
                            />
                            Funding only, not a trade
                          </label>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
