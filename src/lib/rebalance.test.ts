import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { CASH_CLASS_ID, defaultAccountPolicies, defaultMappingForPositions } from "./mapping";
import { parsePositionsFromCsv } from "./parsePositions";
import {
  accountTargets,
  classifyPosition,
  rebalance,
  sumByClass,
} from "./rebalance";
import { DEFAULT_ASSET_CLASSES } from "./mapping";
import type { Position } from "./types";

const sampleCsv = readFileSync(
  new URL("../../data/positions.csv", import.meta.url),
  "utf8",
);

describe("parsePositions", () => {
  it("reads the Acme/Fidelity positions export and skips disclaimer rows", () => {
    const parsed = parsePositionsFromCsv(sampleCsv);
    assert.equal(parsed.positions.length, 26);
    assert.ok(parsed.positions.every((p) => p.accountNumber.length < 40));
  });

  it("keeps alphanumeric and numeric account numbers as strings", () => {
    const parsed = parsePositionsFromCsv(sampleCsv);
    const ids = new Set(parsed.positions.map((p) => p.accountNumber));
    assert.ok(ids.has("X483920176"));
    assert.ok(ids.has("8043672915"));
  });
});

describe("mapping", () => {
  it("does not treat the export Type column as asset class", () => {
    const parsed = parsePositionsFromCsv(sampleCsv);
    const mapping = new Map(defaultMappingForPositions(parsed.positions).map((m) => [m.symbol, m]));
    const fnilxIra = parsed.positions.find(
      (p) => p.symbol === "FNILX" && p.accountName.includes("Alex") && p.holdingType === "Cash",
    );
    assert.ok(fnilxIra);
    const cls = classifyPosition(fnilxIra, mapping);
    assert.equal(cls.classId, "us_equity");
    assert.equal(cls.isCash, false);
  });

  it("classifies money-market sleeves as cash, including FRGXX", () => {
    const parsed = parsePositionsFromCsv(sampleCsv);
    const mapping = new Map(defaultMappingForPositions(parsed.positions).map((m) => [m.symbol, m]));
    for (const symbol of ["FZFXX", "SPAXX", "FCASH", "FRGXX"]) {
      const row = parsed.positions.find((p) => p.symbol === symbol);
      assert.ok(row, symbol);
      assert.equal(classifyPosition(row, mapping).isCash, true);
    }
    const bil = parsed.positions.find((p) => p.symbol === "BIL");
    assert.ok(bil);
    assert.equal(classifyPosition(bil, mapping).isCash, false);
    assert.equal(classifyPosition(bil, mapping).classId, "treasuries");
  });
});

describe("rebalance", () => {
  const parsed = parsePositionsFromCsv(sampleCsv);
  const mapping = defaultMappingForPositions(parsed.positions);
  const policies = defaultAccountPolicies(parsed.positions);

  it("never funds a trade with another account's cash", () => {
    const plan = rebalance({
      positions: parsed.positions,
      classes: DEFAULT_ASSET_CLASSES,
      mapping,
      targetsPercent: {
        us_equity: 40,
        international: 25,
        gold: 10,
        treasuries: 15,
        cash: 10,
        other: 0,
      },
      policies,
      liquidityTilt: 0.4,
    });

    for (const trade of plan.trades) {
      assert.ok(
        trade.cashSleeve === "cash" ||
          parsed.positions.some(
            (p) =>
              p.accountNumber === trade.accountNumber &&
              trade.cashSleeve.includes(p.rawSymbol),
          ),
        `trade cash sleeve leaked across accounts: ${trade.accountNumber} ${trade.cashSleeve}`,
      );
    }

    const joint = plan.accounts.find((a) => a.accountName === "Joint WROS");
    const ira = plan.accounts.find((a) => a.accountName === "IRA (Alex)");
    assert.ok(joint && ira);
    for (const t of joint.trades) assert.equal(t.accountNumber, joint.accountNumber);
    for (const t of ira.trades) assert.equal(t.accountNumber, ira.accountNumber);
  });

  it("tilts extra cash into more liquid accounts", () => {
    const household = {
      us_equity: 0.4,
      international: 0.25,
      gold: 0.1,
      treasuries: 0.15,
      cash: 0.1,
      other: 0,
    };
    const brokerage = accountTargets(household, 1, 0.4);
    const ira = accountTargets(household, 0.2, 0.4);
    assert.ok(brokerage.cash > ira.cash);
    assert.ok(brokerage.cash > household.cash);
    assert.ok(ira.cash < household.cash);
    const sumB = Object.values(brokerage).reduce((s, n) => s + n, 0);
    const sumI = Object.values(ira).reduce((s, n) => s + n, 0);
    assert.ok(Math.abs(sumB - 1) < 1e-9);
    assert.ok(Math.abs(sumI - 1) < 1e-9);
  });

  it("uses the same mix in every account when tilt is zero", () => {
    const household = { us_equity: 0.5, cash: 0.5 };
    const a = accountTargets(household, 1, 0);
    const b = accountTargets(household, 0, 0);
    assert.equal(a.cash, 0.5);
    assert.equal(b.cash, 0.5);
    assert.equal(a.us_equity, 0.5);
    assert.equal(b.us_equity, 0.5);
  });

  it("skips leftover accounts below the floor", () => {
    const plan = rebalance({
      positions: parsed.positions,
      classes: DEFAULT_ASSET_CLASSES,
      mapping,
      targetsPercent: { us_equity: 40, international: 25, gold: 10, treasuries: 15, cash: 10, other: 0 },
      policies,
      liquidityTilt: 0.3,
    });
    const leftover = plan.accounts.find((a) => a.accountName.includes("old brokerage"));
    assert.ok(leftover);
    assert.equal(leftover.skipped, true);
    assert.equal(leftover.trades.length, 0);
  });

  it("never lets an account spend more than its own cash plus sell proceeds", () => {
    const plan = rebalance({
      positions: parsed.positions,
      classes: DEFAULT_ASSET_CLASSES,
      mapping,
      targetsPercent: {
        us_equity: 40,
        international: 25,
        gold: 10,
        treasuries: 15,
        cash: 10,
        other: 0,
      },
      policies,
      liquidityTilt: 0.5,
    });
    for (const account of plan.accounts) {
      const buySum = account.trades.filter((t) => t.side === "BUY").reduce((s, t) => s + t.dollars, 0);
      const sellSum = account.trades.filter((t) => t.side === "SELL").reduce((s, t) => s + t.dollars, 0);
      assert.ok(buySum <= account.cashValue + sellSum + 1.05);
      assert.ok(account.cashAfter >= -0.05);
    }
  });

  it("scales buys when overweight lots are too small to sell", () => {
    const tinyUs: Position[] = Array.from({ length: 16 }, (_, i) => ({
      accountNumber: "1",
      accountName: "Test IRA",
      symbol: `U${i}`,
      rawSymbol: `U${i}`,
      description: "micro lot",
      quantity: 1,
      lastPrice: 0.4,
      currentValue: 0.4,
      holdingType: "Cash",
    }));
    const positions: Position[] = [
      {
        accountNumber: "1",
        accountName: "Test IRA",
        symbol: "SPAXX",
        rawSymbol: "SPAXX**",
        description: "HELD IN MONEY MARKET",
        quantity: null,
        lastPrice: null,
        currentValue: 5,
        holdingType: "Cash",
      },
      {
        accountNumber: "1",
        accountName: "Test IRA",
        symbol: "IAU",
        rawSymbol: "IAU",
        description: "GOLD",
        quantity: 0.01,
        lastPrice: 100,
        currentValue: 1,
        holdingType: "Cash",
      },
      ...tinyUs,
    ];
    const plan = rebalance({
      positions,
      classes: DEFAULT_ASSET_CLASSES,
      mapping: [
        { symbol: "SPAXX", classId: CASH_CLASS_ID, isCash: true },
        { symbol: "IAU", classId: "gold", isCash: false },
        ...tinyUs.map((p) => ({ symbol: p.symbol, classId: "us_equity", isCash: false })),
      ],
      targetsPercent: { us_equity: 0, gold: 90, cash: 10, other: 0, international: 0, treasuries: 0 },
      policies: [{ accountNumber: "1", accountName: "Test IRA", liquidity: 20 }],
      liquidityTilt: 0,
    });
    const buySum = plan.trades.filter((t) => t.side === "BUY").reduce((s, t) => s + t.dollars, 0);
    const sellSum = plan.trades.filter((t) => t.side === "SELL").reduce((s, t) => s + t.dollars, 0);
    assert.ok(buySum <= 5 + sellSum + 1);
    assert.ok(plan.accounts[0].warnings.some((w) => /scaled/i.test(w)));
  });

  it("household current weights sum to 100%", () => {
    const map = new Map(mapping.map((m) => [m.symbol, m]));
    const sums = sumByClass(parsed.positions, map);
    const total = Object.values(sums).reduce((s, n) => s + n, 0);
    assert.ok(Math.abs(total - 533137.47) < 0.05);
  });
});
