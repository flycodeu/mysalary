import { describe, expect, it } from "vitest";
import { monthlyOverview, type MonthValue } from "../src/domain/overview";

function value(id: string, month: string | null, gross = 100000, net = 90000, createdAt = "2026-09-28T10:00:00Z"): MonthValue {
  return { id, month, gross, net, createdAt };
}

describe("monthly salary overview", () => {
  it("selects one latest source per month rather than counting amended salaries twice", () => {
    const input = [
      value("old", "2026-09", 100000, 90000, "2026-09-01T10:00:00Z"),
      value("amended", "2026-09", 120000, 110000),
      value("august", "2026-08", 80000, 70000),
    ];
    expect(monthlyOverview(input)).toEqual({ months: 2, gross: 200000, net: 180000, hasVersions: true });
  });

  it("compares creation instants across timezones before selecting a month's source", () => {
    const input = [
      value("earlier", "2026-09", 100000, 90000, "2026-09-28T09:00:00+08:00"),
      value("later", "2026-09", 120000, 110000, "2026-09-28T08:00:00Z"),
    ];
    expect(monthlyOverview(input)).toEqual({ months: 1, gross: 120000, net: 110000, hasVersions: true });
  });

  it("uses a stable ID tiebreak for equal creation times regardless of input order", () => {
    const a = value("aaa", "2026-09", 100000, 90000);
    const b = value("bbb", "2026-09", 120000, 110000);
    expect(monthlyOverview([a, b])).toEqual(monthlyOverview([b, a]));
    expect(monthlyOverview([a, b]).net).toBe(110000);
  });

  it("keeps unknown totals null instead of substituting an older salary or zero", () => {
    const old = value("old", "2026-09", 100000, 90000, "2026-09-01T10:00:00Z");
    const newest = { ...value("new", "2026-09"), net: null };
    const august = value("august", "2026-08", 80000, 70000);
    expect(monthlyOverview([old, newest, august])).toEqual({ months: 2, gross: 180000, net: null, hasVersions: true });
  });

  it("ignores records without a month and returns unknown totals for an empty selection", () => {
    expect(monthlyOverview([])).toEqual({ months: 0, gross: null, net: null, hasVersions: false });
    expect(monthlyOverview([value("unknown", null)])).toEqual({ months: 0, gross: null, net: null, hasVersions: false });
    expect(monthlyOverview([value("unknown", null), value("september", "2026-09")]))
      .toEqual({ months: 1, gross: 100000, net: 90000, hasVersions: false });
  });

  it.each([0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects unsafe or fractional minor units %s without discarding valid independent totals",
    (gross) => {
      expect(monthlyOverview([value("invalid", "2026-09", gross, 90000)]))
        .toEqual({ months: 1, gross: null, net: 90000, hasVersions: false });
    },
  );

  it("keeps overflow unknown and uses exact integer arithmetic for safe cancellation", () => {
    const max = Number.MAX_SAFE_INTEGER;
    expect(monthlyOverview([value("a", "2026-09", max, max), value("b", "2026-08", 1, 1)]))
      .toEqual({ months: 2, gross: null, net: null, hasVersions: false });
    expect(monthlyOverview([value("a", "2026-09", -max, -max), value("b", "2026-08", -1, -1)]).gross).toBeNull();
    expect(monthlyOverview([value("a", "2026-09", max, max), value("b", "2026-08", -max, -max)]))
      .toEqual({ months: 2, gross: 0, net: 0, hasVersions: false });
  });

  it("retains explicitly sourced zero amounts", () => {
    expect(monthlyOverview([value("zero", "2026-09", 0, 0)]))
      .toEqual({ months: 1, gross: 0, net: 0, hasVersions: false });
  });

  it("summarizes only the year or month selection supplied by the caller", () => {
    const all = [value("last-year", "2025-12", 200000, 190000), value("january", "2026-01"), value("september", "2026-09")];
    expect(monthlyOverview(all.filter((row) => row.month?.startsWith("2026-"))))
      .toEqual({ months: 2, gross: 200000, net: 180000, hasVersions: false });
    expect(monthlyOverview(all.filter((row) => row.month === "2026-09")))
      .toEqual({ months: 1, gross: 100000, net: 90000, hasVersions: false });
    expect(monthlyOverview(all.filter((row) => row.month === "2026-08")))
      .toEqual({ months: 0, gross: null, net: null, hasVersions: false });
  });

  it("does not mutate the caller's rows or order", () => {
    const input = [value("older", "2026-08", 100000, 90000, "2026-08-01T10:00:00Z"), value("newer", "2026-09")];
    const before = JSON.stringify(input);
    monthlyOverview(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});
