import type { CellFormat } from "./types";

const currencyFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function formatCompactCurrency(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(1)}T`;
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

const numberFmt = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
});

export function formatValue(value: unknown, format: CellFormat): string {
  if (value == null) return "—";

  switch (format) {
    case "currency": {
      const n = Number(value);
      if (isNaN(n)) return String(value);
      if (n !== 0 && Math.abs(n) < 0.01) {
        return n.toLocaleString("en-US", {
          style: "currency",
          currency: "USD",
          minimumSignificantDigits: 2,
          maximumSignificantDigits: 4,
        });
      }
      return currencyFmt.format(n);
    }
    case "compact-currency": {
      const n = Number(value);
      return isNaN(n) ? String(value) : formatCompactCurrency(n);
    }
    case "percent": {
      const n = Number(value);
      if (isNaN(n)) return String(value);
      return `${n.toFixed(1)}%`;
    }
    case "number": {
      const n = Number(value);
      return isNaN(n) ? String(value) : numberFmt.format(n);
    }
    case "date": {
      const d = new Date(value as string | number);
      return isNaN(d.getTime()) ? String(value) : d.toLocaleDateString();
    }
    case "text":
    default:
      return String(value);
  }
}
