export interface MonthValue {
  id: string;
  month: string | null;
  createdAt: string;
  gross: number | null;
  net: number | null;
}
/** Select one latest source per month so importing an amended payslip does not double annual pay. */
export function latestMonthlyValues(values: MonthValue[]): MonthValue[] {
  const months = new Map<string, MonthValue>();
  for (const value of [...values].sort(
    (a, b) =>
      Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
      b.id.localeCompare(a.id),
  )) {
    if (value.month && /^(?!0000)\d{4}-(?:0[1-9]|1[0-2])$/.test(value.month) && !months.has(value.month)) months.set(value.month, value);
  }
  return [...months.values()];
}

export function monthlyOverview(values: MonthValue[]) {
  const rows = latestMonthlyValues(values);
  function sum(field: "gross" | "net"): number | null {
    if (
      !rows.length ||
      rows.some(
        (row) => row[field] == null || !Number.isSafeInteger(row[field]),
      )
    )
      return null;
    const value = rows.reduce((sum, row) => sum + BigInt(row[field]!), 0n);
    return value > BigInt(Number.MAX_SAFE_INTEGER) ||
      value < BigInt(Number.MIN_SAFE_INTEGER)
      ? null
      : Number(value);
  }
  return {
    months: rows.length,
    gross: sum("gross"),
    net: sum("net"),
    hasVersions: rows.length < values.filter((value) => value.month && /^(?!0000)\d{4}-(?:0[1-9]|1[0-2])$/.test(value.month)).length,
  };
}

function difference(gross: number | null, net: number | null): number | null {
  if (gross === null || net === null || !Number.isSafeInteger(gross) || !Number.isSafeInteger(net)) return null;
  const value = BigInt(gross) - BigInt(net);
  return value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER) ? null : Number(value);
}

/** Missing months remain empty, and an unknown total is never treated as zero. */
export function annualDashboard(values: MonthValue[], year: string) {
  const selected = values.filter((value) => value.month?.startsWith(`${year}-`));
  const latest = latestMonthlyValues(selected);
  const summary = monthlyOverview(selected);
  const months = Array.from({ length: 12 }, (_, index) => {
    const month = `${year}-${String(index + 1).padStart(2, "0")}`;
    const source = latest.find((value) => value.month === month);
    return {
      month,
      sourceId: source?.id ?? null,
      gross: source && Number.isSafeInteger(source.gross) ? source.gross : null,
      net: source && Number.isSafeInteger(source.net) ? source.net : null,
      deduction: source ? difference(source.gross, source.net) : null,
    };
  });
  return {
    ...summary,
    deduction: difference(summary.gross, summary.net),
    trend: months,
  };
}
