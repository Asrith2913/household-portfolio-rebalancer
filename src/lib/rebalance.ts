import { CASH_CLASS_ID } from "./mapping";
import type {
  AccountPlan,
  AccountPolicy,
  AssetClass,
  Position,
  RebalanceResult,
  TickerMapEntry,
  Trade,
} from "./types";

const MIN_ACCOUNT_VALUE = 10;
const MIN_TRADE_DOLLARS = 1;
const SHARE_DECIMALS = 3;

export interface RebalanceInput {
  positions: Position[];
  classes: AssetClass[];
  mapping: TickerMapEntry[];
  targetsPercent: Record<string, number>;
  policies: AccountPolicy[];
  /** 0 = every account uses the same mix. 1 = max cash tilt toward liquid accounts. */
  liquidityTilt: number;
}

function roundShares(value: number): number {
  const f = 10 ** SHARE_DECIMALS;
  return Math.round(value * f) / f;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function className(classes: AssetClass[], id: string): string {
  return classes.find((c) => c.id === id)?.name ?? id;
}

function normalizePercents(targetsPercent: Record<string, number>): Record<string, number> {
  const entries = Object.entries(targetsPercent);
  const sum = entries.reduce((s, [, v]) => s + (Number.isFinite(v) ? v : 0), 0);
  if (sum <= 0) return { [CASH_CLASS_ID]: 1 };
  const out: Record<string, number> = {};
  for (const [k, v] of entries) out[k] = (Number.isFinite(v) ? v : 0) / sum;
  return out;
}

export function classifyPosition(
  position: Position,
  mapping: Map<string, TickerMapEntry>,
): TickerMapEntry {
  const hit = mapping.get(position.symbol);
  if (hit) return hit;
  return { symbol: position.symbol, classId: "other", isCash: false };
}

export function sumByClass(
  positions: Position[],
  mapping: Map<string, TickerMapEntry>,
): Record<string, number> {
  const sums: Record<string, number> = {};
  for (const p of positions) {
    const cls = classifyPosition(p, mapping).classId;
    sums[cls] = (sums[cls] ?? 0) + p.currentValue;
  }
  return sums;
}

/**
 * Cash target is tilted toward more-liquid accounts. Non-cash classes keep
 * the household's relative mix and fill whatever is left after cash.
 *
 * cash_i = clamp(C* + tilt * (L_i - 0.5), 0, 0.9)
 */
export function accountTargets(
  household: Record<string, number>,
  liquidity01: number,
  tilt: number,
): Record<string, number> {
  const cashStar = household[CASH_CLASS_ID] ?? 0;
  const cashI = clamp(cashStar + tilt * (liquidity01 - 0.5), 0, 0.9);
  const remaining = 1 - cashI;
  const nonCashWeight = 1 - cashStar;

  const out: Record<string, number> = { ...household, [CASH_CLASS_ID]: cashI };
  if (nonCashWeight <= 1e-9) {
    for (const key of Object.keys(out)) {
      out[key] = key === CASH_CLASS_ID ? 1 : 0;
    }
    return out;
  }
  for (const key of Object.keys(out)) {
    if (key === CASH_CLASS_ID) continue;
    out[key] = ((household[key] ?? 0) / nonCashWeight) * remaining;
  }
  return out;
}

function groupByAccount(positions: Position[]): Map<string, Position[]> {
  const map = new Map<string, Position[]>();
  for (const p of positions) {
    const list = map.get(p.accountNumber) ?? [];
    list.push(p);
    map.set(p.accountNumber, list);
  }
  return map;
}

function cashSleeveLabel(positions: Position[], mapping: Map<string, TickerMapEntry>): string {
  const cash = positions.filter((p) => classifyPosition(p, mapping).isCash);
  if (!cash.length) return "cash";
  const names = [...new Set(cash.map((p) => p.rawSymbol))];
  return names.join(" + ");
}

function primarySymbol(
  classId: string,
  accountPositions: Position[],
  householdPositions: Position[],
  mapping: Map<string, TickerMapEntry>,
): Position | null {
  const inAccount = accountPositions.filter(
    (p) => !classifyPosition(p, mapping).isCash && classifyPosition(p, mapping).classId === classId,
  );
  const pool = inAccount.length ? inAccount : householdPositions.filter(
    (p) => !classifyPosition(p, mapping).isCash && classifyPosition(p, mapping).classId === classId,
  );
  if (!pool.length) return null;
  return [...pool].sort((a, b) => b.currentValue - a.currentValue)[0];
}

function priceOf(position: Position): number | null {
  if (position.lastPrice && position.lastPrice > 0) return position.lastPrice;
  if (position.quantity && position.quantity > 0 && position.currentValue > 0) {
    return position.currentValue / position.quantity;
  }
  return null;
}

function sellTradesForClass(
  classId: string,
  dollars: number,
  accountPositions: Position[],
  mapping: Map<string, TickerMapEntry>,
  classes: AssetClass[],
  cashSleeve: string,
): Trade[] {
  const lots = accountPositions.filter(
    (p) => !classifyPosition(p, mapping).isCash && classifyPosition(p, mapping).classId === classId,
  );
  const total = lots.reduce((s, p) => s + p.currentValue, 0);
  if (total <= 0 || dollars <= 0) return [];

  const trades: Trade[] = [];
  for (const lot of lots) {
    const slice = dollars * (lot.currentValue / total);
    if (slice < MIN_TRADE_DOLLARS) continue;
    const px = priceOf(lot);
    let shares: number | null = null;
    let tradeDollars = slice;
    if (px && lot.quantity != null) {
      shares = roundShares(Math.min(lot.quantity, slice / px));
      tradeDollars = shares * px;
    }
    if (tradeDollars < MIN_TRADE_DOLLARS) continue;
    trades.push({
      accountNumber: lot.accountNumber,
      accountName: lot.accountName,
      side: "SELL",
      symbol: lot.rawSymbol,
      description: lot.description,
      classId,
      className: className(classes, classId),
      shares,
      dollars: tradeDollars,
      price: px,
      cashSleeve,
      note: "Trim overweight class, proceeds stay in this account's cash sleeve.",
    });
  }
  return trades;
}

function buyTradesForClass(
  classId: string,
  dollars: number,
  accountPositions: Position[],
  householdPositions: Position[],
  mapping: Map<string, TickerMapEntry>,
  classes: AssetClass[],
  cashSleeve: string,
): Trade[] {
  if (dollars < MIN_TRADE_DOLLARS) return [];
  const existing = accountPositions.filter(
    (p) => !classifyPosition(p, mapping).isCash && classifyPosition(p, mapping).classId === classId,
  );
  const lots = existing.length
    ? existing
    : (() => {
        const primary = primarySymbol(classId, accountPositions, householdPositions, mapping);
        return primary ? [primary] : [];
      })();

  if (!lots.length) return [];

  const total = lots.reduce((s, p) => s + Math.max(p.currentValue, 1), 0);
  const trades: Trade[] = [];
  const account = accountPositions[0];

  for (const lot of lots) {
    const slice = dollars * (Math.max(lot.currentValue, 1) / total);
    if (slice < MIN_TRADE_DOLLARS) continue;
    const px = priceOf(lot);
    const shares = px ? roundShares(slice / px) : null;
    const tradeDollars = shares && px ? shares * px : slice;
    const isNewToAccount = !existing.some((p) => p.symbol === lot.symbol);
    trades.push({
      accountNumber: account.accountNumber,
      accountName: account.accountName,
      side: "BUY",
      symbol: lot.rawSymbol,
      description: lot.description,
      classId,
      className: className(classes, classId),
      shares,
      dollars: tradeDollars,
      price: px,
      cashSleeve,
      note: isNewToAccount
        ? "This account has no holding in the class; buy the household's largest existing ticker."
        : "Add to existing holding. Funded only by this account's cash sleeve.",
    });
  }
  return trades;
}

function scaleBuys(trades: Trade[], factor: number): Trade[] {
  if (factor >= 0.999) return trades;
  return trades.map((t) => {
    if (t.side !== "BUY") return t;
    const dollars = t.dollars * factor;
    const shares =
      t.shares != null && t.price
        ? roundShares((dollars / t.price))
        : t.shares;
    return {
      ...t,
      dollars: shares && t.price ? shares * t.price : dollars,
      shares,
      note: `${t.note} Buys scaled to available cash in this account.`,
    };
  });
}

export function rebalance(input: RebalanceInput): RebalanceResult {
  const mapping = new Map(input.mapping.map((m) => [m.symbol, m]));
  const householdTarget = normalizePercents(input.targetsPercent);
  const householdCurrent = sumByClass(input.positions, mapping);
  const householdTotal = input.positions.reduce((s, p) => s + p.currentValue, 0);
  const byAccount = groupByAccount(input.positions);
  const policyById = new Map(input.policies.map((p) => [p.accountNumber, p]));
  const tilt = clamp(input.liquidityTilt, 0, 1);

  const accounts: AccountPlan[] = [];

  for (const [accountNumber, accountPositions] of byAccount) {
    const accountName = accountPositions[0].accountName;
    const policy = policyById.get(accountNumber);
    const liquidity = policy?.liquidity ?? 50;
    const totalValue = accountPositions.reduce((s, p) => s + p.currentValue, 0);
    const current = sumByClass(accountPositions, mapping);
    const cashValue = accountPositions
      .filter((p) => classifyPosition(p, mapping).isCash)
      .reduce((s, p) => s + p.currentValue, 0);
    const targets = accountTargets(householdTarget, liquidity / 100, tilt);
    const cashSleeve = cashSleeveLabel(accountPositions, mapping);

    if (totalValue < MIN_ACCOUNT_VALUE) {
      accounts.push({
        accountNumber,
        accountName,
        totalValue,
        liquidity,
        cashValue,
        cashAfter: cashValue,
        targets,
        current,
        trades: [],
        skipped: true,
        skipReason: `Account value ${totalValue.toFixed(2)} is below the $${MIN_ACCOUNT_VALUE} rebalance floor.`,
        warnings: [],
      });
      continue;
    }

    const warnings: string[] = [];
    let trades: Trade[] = [];

    const classIds = new Set([
      ...Object.keys(targets),
      ...Object.keys(current),
      ...input.classes.map((c) => c.id),
    ]);

    for (const classId of classIds) {
      if (classId === CASH_CLASS_ID) continue;
      const mappedAsCash = input.mapping.some(
        (m) => m.classId === classId && m.isCash,
      );
      if (mappedAsCash) continue;

      const delta = (targets[classId] ?? 0) * totalValue - (current[classId] ?? 0);
      if (delta < -MIN_TRADE_DOLLARS) {
        trades.push(
          ...sellTradesForClass(
            classId,
            -delta,
            accountPositions,
            mapping,
            input.classes,
            cashSleeve,
          ),
        );
      } else if (delta > MIN_TRADE_DOLLARS) {
        const buys = buyTradesForClass(
          classId,
          delta,
          accountPositions,
          input.positions,
          mapping,
          input.classes,
          cashSleeve,
        );
        if (!buys.length) {
          warnings.push(
            `Need to buy ${className(input.classes, classId)} but no ticker is mapped for that class.`,
          );
        }
        trades.push(...buys);
      }
    }

    const sellTotal = trades.filter((t) => t.side === "SELL").reduce((s, t) => s + t.dollars, 0);
    const buyTotal = trades.filter((t) => t.side === "BUY").reduce((s, t) => s + t.dollars, 0);
    const available = cashValue + sellTotal;
    if (buyTotal > available + 0.01) {
      const factor = available / buyTotal;
      trades = scaleBuys(trades, factor);
      warnings.push(
        "Buys were scaled down so this account never spends another account's cash.",
      );
    }

    const finalBuys = trades.filter((t) => t.side === "BUY").reduce((s, t) => s + t.dollars, 0);
    const finalSells = trades.filter((t) => t.side === "SELL").reduce((s, t) => s + t.dollars, 0);
    const cashAfter = cashValue + finalSells - finalBuys;

    trades.sort((a, b) => {
      if (a.side !== b.side) return a.side === "SELL" ? -1 : 1;
      return b.dollars - a.dollars;
    });

    accounts.push({
      accountNumber,
      accountName,
      totalValue,
      liquidity,
      cashValue,
      cashAfter: Math.max(0, cashAfter),
      targets,
      current,
      trades,
      skipped: false,
      warnings,
    });
  }

  accounts.sort((a, b) => b.totalValue - a.totalValue);

  return {
    householdTotal,
    householdCurrent,
    householdTarget,
    accounts,
    trades: accounts.flatMap((a) => a.trades),
  };
}
