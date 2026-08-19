import type { ParseResult, Position } from "./types";
import * as XLSX from "xlsx";

const REQUIRED = [
  "Account Number",
  "Account Name",
  "Symbol",
  "Description",
  "Quantity",
  "Last Price",
  "Current Value",
  "Type",
] as const;

function normalizeHeader(value: string): string {
  return value.replace(/^\uFEFF/, "").trim();
}

function isDisclaimer(value: string): boolean {
  const v = value.trim();
  return (
    v.startsWith("The data and information") ||
    v.startsWith("Brokerage services") ||
    v.startsWith("Date downloaded") ||
    v.length > 80
  );
}

export function parseNumber(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? raw : null;
  }
  const text = String(raw).trim();
  if (!text || text === "--" || text === "—") return null;
  const parenNeg = /^\(.*\)$/.test(text);
  const cleaned = text.replace(/[$,%\s]/g, "").replace(/[()]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return parenNeg ? -n : n;
}

export function canonicalSymbol(raw: string): string {
  return raw.replace(/\*+$/, "").trim().toUpperCase();
}

function rowToPosition(
  rec: Record<string, unknown>,
  warnings: string[],
): Position | null {
  const accountNumber = String(rec["Account Number"] ?? "").trim();
  const symbolRaw = String(rec["Symbol"] ?? "").trim();
  if (!accountNumber || !symbolRaw) return null;
  if (isDisclaimer(accountNumber) || isDisclaimer(symbolRaw)) return null;

  const currentValue = parseNumber(rec["Current Value"]);
  if (currentValue == null) {
    warnings.push(`Skipped ${accountNumber} ${symbolRaw}: missing Current Value`);
    return null;
  }

  return {
    accountNumber,
    accountName: String(rec["Account Name"] ?? "").trim() || accountNumber,
    symbol: canonicalSymbol(symbolRaw),
    rawSymbol: symbolRaw,
    description: String(rec["Description"] ?? "").trim(),
    quantity: parseNumber(rec["Quantity"]),
    lastPrice: parseNumber(rec["Last Price"]),
    currentValue,
    holdingType: String(rec["Type"] ?? "").trim(),
  };
}

function recordsFromAoA(rows: unknown[][]): Record<string, unknown>[] {
  if (!rows.length) return [];
  const headerRow = rows[0].map((h) => normalizeHeader(String(h ?? "")));
  const index: Record<string, number> = {};
  headerRow.forEach((h, i) => {
    if (h) index[h] = i;
  });
  const records: Record<string, unknown>[] = [];
  for (let r = 1; r < rows.length; r++) {
    const line = rows[r] ?? [];
    const rec: Record<string, unknown> = {};
    for (const [key, i] of Object.entries(index)) {
      rec[key] = line[i];
    }
    records.push(rec);
  }
  return records;
}

function parseWorkbook(workbook: XLSX.WorkBook): Record<string, unknown>[] {
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: true,
    defval: "",
    blankrows: false,
  }) as unknown[][];
  return recordsFromAoA(rows);
}

export function parsePositionsFromCsv(text: string): ParseResult {
  const workbook = XLSX.read(text, { type: "string", raw: true });
  return materialize(parseWorkbook(workbook), text);
}

export function parsePositionsFromArrayBuffer(
  buffer: ArrayBuffer,
  filename: string,
): ParseResult {
  const workbook = XLSX.read(buffer, { type: "array", raw: true });
  const asText = filename.toLowerCase().endsWith(".csv")
    ? new TextDecoder().decode(buffer)
    : "";
  return materialize(parseWorkbook(workbook), asText);
}

function materialize(
  records: Record<string, unknown>[],
  sourceText: string,
): ParseResult {
  const warnings: string[] = [];
  const missing = REQUIRED.filter(
    (col) => records[0] == null || !(col in records[0]),
  );
  if (missing.length && records.length) {
    warnings.push(
      `Export is missing expected columns: ${missing.join(", ")}. Parser will skip what it cannot read.`,
    );
  }

  const positions: Position[] = [];
  for (const rec of records) {
    const pos = rowToPosition(rec, warnings);
    if (pos) positions.push(pos);
  }

  const asOfMatch = sourceText.match(/Date downloaded\s+(.+)/i);
  return {
    asOf: asOfMatch ? asOfMatch[1].trim() : null,
    positions,
    warnings,
  };
}
