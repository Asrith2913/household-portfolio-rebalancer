export type Side = "BUY" | "SELL";

export interface Position {
  accountNumber: string;
  accountName: string;
  symbol: string;
  rawSymbol: string;
  description: string;
  quantity: number | null;
  lastPrice: number | null;
  currentValue: number;
  holdingType: string;
}

export interface AssetClass {
  id: string;
  name: string;
  color: string;
}

export interface TickerMapEntry {
  symbol: string;
  classId: string;
  isCash: boolean;
}

export interface AccountPolicy {
  accountNumber: string;
  accountName: string;
  /** 0–100. Higher = more accessible; extra cash is preferred here. */
  liquidity: number;
}

export interface ClassTarget {
  classId: string;
  percent: number;
}

export interface Trade {
  accountNumber: string;
  accountName: string;
  side: Side;
  symbol: string;
  description: string;
  classId: string;
  className: string;
  shares: number | null;
  dollars: number;
  price: number | null;
  cashSleeve: string;
  note: string;
}

export interface AccountPlan {
  accountNumber: string;
  accountName: string;
  totalValue: number;
  liquidity: number;
  cashValue: number;
  cashAfter: number;
  targets: Record<string, number>;
  current: Record<string, number>;
  trades: Trade[];
  skipped: boolean;
  skipReason?: string;
  warnings: string[];
}

export interface RebalanceResult {
  householdTotal: number;
  householdCurrent: Record<string, number>;
  householdTarget: Record<string, number>;
  accounts: AccountPlan[];
  trades: Trade[];
}

export interface ParseResult {
  asOf: string | null;
  positions: Position[];
  warnings: string[];
}
