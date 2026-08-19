import type { AccountPolicy, AssetClass, Position, TickerMapEntry } from "./types";
import { canonicalSymbol } from "./parsePositions";

export const CASH_CLASS_ID = "cash";

export const DEFAULT_ASSET_CLASSES: AssetClass[] = [
  { id: "us_equity", name: "US Equity", color: "#1f4e46" },
  { id: "international", name: "International", color: "#3d6b8a" },
  { id: "gold", name: "Gold", color: "#b45309" },
  { id: "treasuries", name: "Treasuries", color: "#6b5b95" },
  { id: CASH_CLASS_ID, name: "Cash", color: "#5b6b78" },
  { id: "other", name: "Other", color: "#8a6a4a" },
];

/** Seed a clean, editable policy — not a copy of today's drift. */
export const DEFAULT_TARGET_PERCENTS: Record<string, number> = {
  us_equity: 40,
  international: 25,
  gold: 10,
  treasuries: 15,
  cash: 10,
  other: 0,
};

/**
 * Ticker → class is product design, not something the brokerage sends.
 * Cash is identified by ticker/description, never by the export's Type column
 * (that column is Cash vs Margin holding type; IRA index funds are Type=Cash).
 */
const KNOWN_TICKERS: TickerMapEntry[] = [
  { symbol: "FZFXX", classId: CASH_CLASS_ID, isCash: true },
  { symbol: "SPAXX", classId: CASH_CLASS_ID, isCash: true },
  { symbol: "FCASH", classId: CASH_CLASS_ID, isCash: true },
  { symbol: "FRGXX", classId: CASH_CLASS_ID, isCash: true },
  { symbol: "FDRXX", classId: CASH_CLASS_ID, isCash: true },
  { symbol: "SPRXX", classId: CASH_CLASS_ID, isCash: true },
  { symbol: "BIL", classId: "treasuries", isCash: false },
  { symbol: "SGOV", classId: "treasuries", isCash: false },
  { symbol: "SHV", classId: "treasuries", isCash: false },
  { symbol: "FNILX", classId: "us_equity", isCash: false },
  { symbol: "FZROX", classId: "us_equity", isCash: false },
  { symbol: "VTI", classId: "us_equity", isCash: false },
  { symbol: "ITOT", classId: "us_equity", isCash: false },
  { symbol: "NUKZ", classId: "us_equity", isCash: false },
  { symbol: "SHLD", classId: "us_equity", isCash: false },
  { symbol: "FZILX", classId: "international", isCash: false },
  { symbol: "VXUS", classId: "international", isCash: false },
  { symbol: "IXUS", classId: "international", isCash: false },
  { symbol: "VGK", classId: "international", isCash: false },
  { symbol: "IAU", classId: "gold", isCash: false },
  { symbol: "GLD", classId: "gold", isCash: false },
  { symbol: "GLDM", classId: "gold", isCash: false },
];

const CASH_DESCRIPTION =
  /money market|held in (fcash|cash)|government portfolio|treasury only|core position/i;

export function looksLikeCash(position: Pick<Position, "symbol" | "description">): boolean {
  if (KNOWN_TICKERS.find((t) => t.symbol === position.symbol)?.isCash) return true;
  return CASH_DESCRIPTION.test(position.description);
}

export function defaultMappingForPositions(positions: Position[]): TickerMapEntry[] {
  const bySymbol = new Map<string, Position>();
  for (const p of positions) {
    if (!bySymbol.has(p.symbol)) bySymbol.set(p.symbol, p);
  }

  const known = new Map(KNOWN_TICKERS.map((t) => [t.symbol, t]));
  const entries: TickerMapEntry[] = [];

  for (const [symbol, position] of bySymbol) {
    const preset = known.get(symbol);
    if (preset) {
      entries.push({ ...preset });
      continue;
    }
    if (looksLikeCash(position)) {
      entries.push({ symbol, classId: CASH_CLASS_ID, isCash: true });
      continue;
    }
    entries.push({ symbol, classId: "other", isCash: false });
  }

  entries.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return entries;
}

export function mappingBySymbol(
  entries: TickerMapEntry[],
): Map<string, TickerMapEntry> {
  return new Map(entries.map((e) => [canonicalSymbol(e.symbol), e]));
}

/**
 * Liquidity defaults generalize past this household:
 * retirement wrappers stay invested; taxable brokerage can warehouse cash.
 */
export function defaultLiquidity(accountName: string): number {
  const n = accountName.toLowerCase();
  if (/\b(ira|roth|401k|403b|sep|simple|pension)\b/.test(n)) return 20;
  if (/\bold\b/.test(n)) return 75;
  if (/\b(joint|brokerage|individual|taxable|wros|tod)\b/.test(n)) return 100;
  return 50;
}

export function defaultAccountPolicies(positions: Position[]): AccountPolicy[] {
  const seen = new Map<string, string>();
  for (const p of positions) {
    if (!seen.has(p.accountNumber)) seen.set(p.accountNumber, p.accountName);
  }
  return [...seen.entries()].map(([accountNumber, accountName]) => ({
    accountNumber,
    accountName,
    liquidity: defaultLiquidity(accountName),
  }));
}
