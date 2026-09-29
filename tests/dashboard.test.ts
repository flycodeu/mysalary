import { describe, expect, it } from "vitest";
import { annualDashboard, type MonthValue } from "../src/domain/overview";

const source = (id: string, month: string | null, gross: number | null, net: number | null, createdAt = "2026-09-29T10:00:00Z"): MonthValue => ({ id, month, gross, net, createdAt });

describe("annual salary dashboard", () => {
  it("summarizes only the selected year and never fills missing months", () => {
    const result = annualDashboard([
      source("old-year", "2025-12", 500000, 400000),
      source("january", "2026-01", 300000, 250000),
      source("march", "2026-03", 200000, 180000),
    ], "2026");
    expect(result).toMatchObject({ months: 2, gross: 500000, net: 430000, deduction: 70000 });
    expect(result.trend).toHaveLength(12);
    expect(result.trend[1]).toEqual({ month: "2026-02", sourceId: null, gross: null, net: null, deduction: null });
    expect(result.trend[2]).toEqual({ month: "2026-03", sourceId: "march", gross: 200000, net: 180000, deduction: 20000 });
  });

  it("uses the same latest monthly source for totals, chart and detail links", () => {
    const result = annualDashboard([
      source("older", "2026-01", 100000, 90000, "2026-01-30T12:00:00Z"),
      source("amended", "2026-01", 120000, 110000),
    ], "2026");
    expect(result).toMatchObject({ months: 1, gross: 120000, net: 110000, deduction: 10000, hasVersions: true });
    expect(result.trend[0]?.sourceId).toBe("amended");
  });

  it("preserves unknown source totals without manufacturing an annual deduction", () => {
    const result = annualDashboard([
      source("known", "2026-01", 100000, 90000),
      source("missing", "2026-02", null, 80000),
    ], "2026");
    expect(result).toMatchObject({ months: 2, gross: null, net: 170000, deduction: null });
    expect(result.trend[1]).toMatchObject({ gross: null, net: 80000, deduction: null });
  });

  it("keeps signed amounts and explicit zeroes while guarding subtraction overflow", () => {
    const result = annualDashboard([
      source("refund", "2026-01", 10000, 12000),
      source("zero", "2026-02", 0, 0),
    ], "2026");
    expect(result.deduction).toBe(-2000);
    expect(result.trend[1]).toMatchObject({ gross: 0, net: 0, deduction: 0 });
    expect(annualDashboard([source("overflow", "2026-01", Number.MAX_SAFE_INTEGER, -1)], "2026").deduction).toBeNull();
  });

  it("omits invalid calendar months and keeps an empty year unknown", () => {
    expect(annualDashboard([source("broken", "2026-13", 1, 1)], "2026"))
      .toMatchObject({ months: 0, gross: null, net: null, deduction: null, hasVersions: false });
    expect(annualDashboard([], "2026").trend.every((month) => month.sourceId === null && month.net === null)).toBe(true);
  });
});
