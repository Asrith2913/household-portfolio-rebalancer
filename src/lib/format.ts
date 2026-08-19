export function usd(value: number, digits = 2): string {
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function pct(value: number, digits = 1): string {
  return `${value.toFixed(digits)}%`;
}

export function shares(value: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  });
}

export function maskAccount(accountNumber: string): string {
  if (accountNumber.length <= 4) return accountNumber;
  return `…${accountNumber.slice(-4)}`;
}
