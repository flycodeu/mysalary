import { describe, expect, it } from "vitest";
import { reconcile } from "../src/domain/reconcile";
import type { SalaryDraft, SalaryLine } from "../src/domain/types";

const row = (
  id: string,
  amountMinor: number | null,
  extra: Partial<SalaryLine> = {},
): SalaryLine => ({
  id,
  label: id,
  rawAmountText: "",
  amountMinor,
  effect: "earning",
  rowRole: "detail",
  calculationMode: "self",
  parentLineId: null,
  issues: [],
  ...extra,
});
const draft = (lines: SalaryLine[]): SalaryDraft => ({
  payrollMonth: "2026-09",
  statedGrossMinor: 10000,
  statedNetMinor: 9000,
  reviewStatus: "draft",
  warnings: [],
  lines,
});

describe("explicit accounting semantics", () => {
  it("selects the subtotal or children exactly once", () => {
    const parent = row("bonus-total", 10000, { rowRole: "subtotal" });
    const child = row("bonus-detail", 10000, { parentLineId: parent.id });
    const tax = row("tax", 1000, { effect: "deduction" });
    expect(reconcile(draft([parent, child, tax])).status).toBe("consistent");
    parent.calculationMode = "children";
    expect(reconcile(draft([parent, child, tax])).calculatedGrossMinor).toBe(
      10000,
    );
    parent.calculationMode = "exclude";
    expect(reconcile(draft([parent, child, tax])).knownGrossMinor).toBe(0);
  });

  it("does not treat a missing amount or empty child group as zero", () => {
    const missing = reconcile(draft([row("salary", null)]));
    expect(missing.calculatedGrossMinor).toBeNull();
    expect(missing.status).toBe("unresolved");
    const noChildren = reconcile(
      draft([row("bonus", 10000, { calculationMode: "children" })]),
    );
    expect(noChildren.calculatedGrossMinor).toBeNull();
    expect(noChildren.unresolvedLineIds).toContain("bonus");
  });

  it("a negative deduction is a refund, not an earning inferred from its sign", () => {
    const input = draft([
      row("salary", 10000),
      row("refund", -1000, { effect: "deduction" }),
    ]);
    input.statedNetMinor = 11000;
    expect(reconcile(input).calculatedNetMinor).toBe(11000);
    expect(reconcile(input).status).toBe("consistent");
  });

  it("subtracts a printed negative tax exactly once and preserves a negative earning", () => {
    const input = draft([
      row("salary", 10000),
      row("adjustment", -1000),
      row("个税", -500, { effect: "deduction" }),
    ]);
    input.statedGrossMinor = 9000;
    input.statedNetMinor = 8500;
    expect(reconcile(input).status).toBe("consistent");
    expect(reconcile(input).calculatedDeductionsMinor).toBe(500);
  });

  it("rejects cycles, missing parents and duplicate IDs without recursion failure", () => {
    for (const rows of [
      [
        row("a", 100, { parentLineId: "b", calculationMode: "children" }),
        row("b", 100, { parentLineId: "a" }),
      ],
      [row("a", 100, { parentLineId: "missing" })],
      [row("same", 100), row("same", 100)],
    ]) {
      expect(reconcile(draft(rows)).status).toBe("unresolved");
      expect(reconcile(draft(rows)).unresolvedLineIds.length).toBeGreaterThan(
        0,
      );
    }
  });

  it("does not round or report zero when a sum exceeds the safe integer range", () => {
    const totals = reconcile(
      draft([row("a", Number.MAX_SAFE_INTEGER), row("b", 100)]),
    );
    expect(totals.knownGrossMinor).toBeNull();
    expect(totals.calculatedGrossMinor).toBeNull();
    expect(totals.status).toBe("unresolved");
  });

  it("empty OCR output never becomes a complete zero salary", () => {
    const empty = draft([]);
    empty.statedGrossMinor = 0;
    empty.statedNetMinor = 0;
    expect(reconcile(empty).status).toBe("unresolved");
  });
});
