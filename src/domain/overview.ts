export interface MonthValue {
  id: string;
  month: string | null;
  createdAt: string;
  gross: number | null;
  net: number | null;
}
/** Select one latest source per month so importing an amended payslip does not double annual pay. */
export function monthlyOverview(values: MonthValue[]) {
  const months = new Map<string, MonthValue>();
  for (const value of [...values].sort(
    (a, b) =>
      Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
      b.id.localeCompare(a.id),
  )) {
    if (value.month && !months.has(value.month)) months.set(value.month, value);
  }
  const rows = [...months.values()];
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
    hasVersions: rows.length < values.filter((value) => value.month).length,
  };
}
