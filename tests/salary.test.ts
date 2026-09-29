import { describe, expect, it } from "vitest";
import { demoImageUrl, demoOcr } from "../src/domain/demo";
import { parseSalary } from "../src/domain/parseSalary";
import { reconcile } from "../src/domain/reconcile";
import { normalizeSalaryDraft, salaryGroups } from "../src/domain/salaryRules";
import type { OcrLine, OcrResult } from "../src/domain/types";

const text = (value: string, x: number, y: number, width = 170): OcrLine => ({
  text: value,
  box: { x, y, width, height: 20 },
});
const result = (lines: OcrLine[]): OcrResult => ({
  imageWidth: 390,
  imageHeight: 1500,
  engine: "synthetic",
  modelVersion: "test",
  elapsedMs: 0,
  lines,
});

describe("salary parsing from coordinates", () => {
  it("keeps the source amounts, skips the title-only month, and does not double-count subtotals", () => {
    const draft = parseSalary(demoOcr);
    const totals = reconcile(draft);
    expect(draft.payrollMonth).toBe("2026-09");
    expect(draft.statedGrossMinor).toBe(1413820);
    expect(draft.statedNetMinor).toBe(1214582);
    expect(draft.lines).toHaveLength(17);
    expect(draft.reviewStatus).toBe("draft");
    expect(draft.warnings).toContain("另有月份仅出现标题，未创建工资记录");
    expect(
      draft.lines.find((line) => line.label === "月度奖惩")?.parentLineId,
    ).toBe(draft.lines.find((line) => line.label === "奖金合计")?.id);
    expect(totals.knownGrossMinor).toBe(1413820);
    expect(totals.knownDeductionsMinor).toBe(198238);
    expect(totals.deductionDifferenceMinor).toBe(1000);
    expect(totals.calculatedGrossMinor).toBe(1413820);
    expect(totals.deductionComparisonComplete).toBe(true);
    expect(totals.status).toBe("difference");
    expect(
      draft.lines
        .filter((line) => line.calculationMode === "unresolved")
        .map((line) => line.label),
    ).toEqual([]);
    expect(demoImageUrl).toMatch(/^data:image\/svg\+xml/);
    expect(demoOcr.engine).toBe("synthetic");
  });

  it("automatically counts signed adjustments once and preserves the 10 yuan difference", () => {
    const draft = parseSalary(demoOcr);
    const totals = reconcile(draft);
    expect(totals.calculatedGrossMinor).toBe(1413820);
    expect(totals.calculatedDeductionsMinor).toBe(198238);
    expect(totals.calculatedNetMinor).toBe(1215582);
    expect(totals.deductionDifferenceMinor).toBe(1000);
    expect(totals.status).toBe("difference");
    const groups = salaryGroups(draft);
    expect(groups.earnings.map((row) => row.label)).toEqual([
      "岗位（基本）薪水",
      "津贴奖金合计",
      "嘉奖合计",
      "补发合计",
    ]);
    expect(groups.unresolved).toHaveLength(0);
    expect(
      groups.earnings.find((row) => row.label === "津贴奖金合计")?.amountMinor,
    ).toBe(354300);
  });

  it("handles same-box amounts, separate amount boxes and wrapped labels without keeping identity fields", () => {
    const draft = parseSalary(
      result([
        text("2026年9月", 120, 10),
        text("应发工资：7000.00", 20, 60, 340),
        text("实发工资：6800.00", 20, 110, 340),
        text("姓名 某测试人", 20, 160, 340),
        text("工号：", 20, 210),
        text("999999", 280, 210, 80),
        text("身份证号：", 20, 260),
        text("000000000000000000", 200, 260, 180),
        text("岗位（基本）", 20, 310),
        text("薪水：", 20, 335),
        text("7000", 280, 335, 80),
        text("个税：200", 20, 385, 340),
        text("新增项目：", 20, 435),
        text("-20.50", 280, 435, 80),
        text("其他待定：", 20, 485),
      ]),
    );
    expect(draft.lines.map((line) => line.label)).toEqual([
      "岗位（基本）薪水",
      "个税",
      "新增项目",
      "其他待定",
    ]);
    expect(draft.lines[0]?.amountMinor).toBe(700000);
    expect(draft.lines[2]?.amountMinor).toBe(-2050);
    expect(draft.lines[2]?.effect).toBe("unknown");
    expect(draft.lines[3]?.amountMinor).toBeNull();
    expect(JSON.stringify(draft)).not.toContain("000000000000000000");
  });

  it("does not merge equal amounts with unrelated labels", () => {
    const draft = parseSalary(
      result([
        text("2026-09", 120, 10),
        text("应发：1000", 20, 60),
        text("实发：1000", 20, 110),
        text("工龄津贴：500", 20, 160),
        text("高温津贴：500", 20, 210),
      ]),
    );
    expect(draft.lines).toHaveLength(2);
    expect(draft.lines.every((line) => line.parentLineId === null)).toBe(true);
    expect(reconcile(draft).calculatedGrossMinor).toBe(100000);
  });

  it("keeps malformed decimal candidates and new labels for manual review", () => {
    const draft = parseSalary(
      result([
        text("2026年09月", 120, 10),
        text("应发工资：1000", 20, 60),
        text("实发工资：900", 20, 110),
        text("基本工资：12.345", 20, 160),
        text("新项目：20", 20, 210),
        text("个税：221O", 20, 260),
      ]),
    );
    expect(draft.lines[0]?.rawAmountText).toBe("12.345");
    expect(draft.lines[0]?.amountMinor).toBeNull();
    expect(draft.lines[1]?.label).toBe("新项目");
    expect(draft.lines[1]?.effect).toBe("unknown");
    expect(draft.lines[2]?.rawAmountText).toBe("221O");
    expect(draft.lines[2]?.amountMinor).toBeNull();
  });

  it("keeps a separately detected minus sign and decimal point attached to the amount", () => {
    const draft = parseSalary(
      result([
        text("2026年09月", 120, 10),
        text("应发工资：1000", 20, 60),
        text("实发工资：900", 20, 110),
        text("补发合计：", 20, 160),
        text("−", 268, 162, 10),
        text("204", 282, 160, 34),
        text(".", 319, 159, 5),
        text("80", 327, 161, 22),
      ]),
    );
    expect(draft.lines[0]?.rawAmountText).toBe("-204.80");
    expect(draft.lines[0]?.amountMinor).toBe(-20480);
    expect(draft.lines[0]?.calculationMode).toBe("self");
  });

  it("keeps an unknown missing field even if no detail amount was recognized", () => {
    const draft = parseSalary(
      result([
        text("2026年09月", 120, 10),
        text("应发工资：1000", 20, 60),
        text("实发工资：900", 20, 110),
        text("新的补助：", 20, 160),
      ]),
    );
    expect(draft.lines[0]?.label).toBe("新的补助");
    expect(draft.lines[0]?.amountMinor).toBeNull();
  });

  it("never chooses a positive amount when overlapping OCR tiles disagree about a minus sign", () => {
    const source = result([
      text("2026年09月", 120, 10),
      text("应发工资：1000", 20, 60),
      text("实发工资：900", 20, 110),
      text("工龄津贴：", 20, 160),
      {
        ...text("204.80", 270, 160, 95),
        needsReview: true,
        alternatives: ["-204.80"],
      },
    ]);
    const draft = parseSalary(source);
    expect(draft.lines[0]?.amountMinor).toBeNull();
    expect(draft.lines[0]?.effect).toBe("unknown");
    expect(draft.lines[0]?.calculationMode).toBe("unresolved");
    expect(draft.lines[0]?.sourceBox).toEqual({
      x: 20,
      y: 160,
      width: 345,
      height: 20,
    });
    expect(
      draft.lines[0]?.issues.some((issue) => issue.includes("识别结果不一致")),
    ).toBe(true);
    expect(
      draft.warnings.some((warning) =>
        warning.includes("工龄津贴存在多个识别候选"),
      ),
    ).toBe(true);
    expect(reconcile(draft).calculatedGrossMinor).toBeNull();
    expect(source.lines.at(-1)?.alternatives).toEqual(["-204.80"]);
  });

  it("does not assign a known subtotal or a stated total from an ambiguous label", () => {
    const draft = parseSalary(
      result([
        text("2026年09月", 120, 10),
        {
          ...text("应发工资：1000", 20, 60),
          needsReview: true,
          alternatives: ["实发工资：1000"],
        },
        text("实发工资：900", 20, 110),
        text("月度奖金：1000", 20, 160),
        { ...text("奖金合计：", 20, 210), alternatives: ["扣款合计："] },
        text("1000", 270, 210, 95),
      ]),
    );
    expect(draft.statedGrossMinor).toBeNull();
    const subtotal = draft.lines.find((line) => line.label === "奖金合计")!;
    expect(subtotal.amountMinor).toBeNull();
    expect(subtotal.effect).toBe("unknown");
    expect(subtotal.calculationMode).toBe("unresolved");
    expect(
      draft.lines.find((line) => line.label === "月度奖金")?.parentLineId,
    ).toBeNull();
    expect(
      draft.warnings.some((warning) =>
        warning.includes("应发工资存在多个识别候选"),
      ),
    ).toBe(true);
  });

  it("retains an unpaired amount as an unknown row, without copying identifiers or dates into salary fields", () => {
    const source = result([
      text("2026年09月", 120, 10),
      text("应发工资：1000", 20, 60),
      text("实发工资：900", 20, 110),
      text("工号：", 20, 160),
      text("62469", 280, 160, 80),
      text("基本工资：1000", 20, 210),
      text("-204.80", 270, 260, 95),
      text("13800138000", 250, 310, 120),
      text("000000000000000000", 190, 360, 180),
      text("62469", 280, 410, 80),
      text("2026/09/27", 230, 460, 130),
      text("19:57", 280, 510, 80),
    ]);
    const draft = parseSalary(source);
    expect(draft.lines.map((line) => line.label)).toEqual([
      "基本工资",
      "未配对金额",
    ]);
    const unmatched = draft.lines[1]!;
    expect(unmatched.rawAmountText).toBe("-204.80");
    expect(unmatched.amountMinor).toBeNull();
    expect(unmatched.effect).toBe("unknown");
    expect(unmatched.calculationMode).toBe("unresolved");
    expect(unmatched.sourceBox).toEqual({
      x: 270,
      y: 260,
      width: 95,
      height: 20,
    });
    expect(unmatched.issues).toContain(
      "金额没有对应项目，请对照原图填写名称和金额",
    );
    expect(reconcile(draft).calculatedGrossMinor).toBeNull();
    expect(draft.warnings).toContain(
      "原图位置（280, 410）有未配对数字，请核对是否属于工资",
    );
    for (const privateText of [
      "62469",
      "13800138000",
      "000000000000000000",
      "2026/09/27",
      "19:57",
    ]) {
      expect(JSON.stringify(draft)).not.toContain(privateText);
      expect(source.lines.some((line) => line.text === privateText)).toBe(true);
    }
  });

  it("keeps coordinates rather than inventing a field from a number before the salary detail area", () => {
    const draft = parseSalary(
      result([
        text("2026年09月", 120, 10),
        text("应发工资：1000", 20, 60),
        text("实发工资：900", 20, 110),
        text("100.00", 280, 160, 80),
        text("基本工资：1000", 20, 210),
      ]),
    );
    expect(draft.lines.map((line) => line.label)).toEqual(["基本工资"]);
    expect(draft.warnings).toContain(
      "原图位置（280, 160）有未配对数字，请核对是否属于工资",
    );
  });

  it("leaves the payroll month unknown when the title has conflicting OCR alternatives", () => {
    const draft = parseSalary(
      result([
        {
          ...text("2026年09月", 120, 10),
          needsReview: true,
          alternatives: ["2026年08月"],
        },
        text("应发工资：1000", 20, 60),
        text("实发工资：900", 20, 110),
        text("基本工资：1000", 20, 160),
      ]),
    );
    expect(draft.payrollMonth).toBeNull();
    expect(draft.statedGrossMinor).toBe(100000);
    expect(draft.lines[0]?.amountMinor).toBe(100000);
    expect(draft.warnings).toContain("工资月份未识别，请填写");
    expect(draft.reviewStatus).toBe("draft");
  });

  it("selects the first region with totals and explicitly warns about other content", () => {
    const draft = parseSalary(
      result([
        text("2026年09月", 120, 10),
        text("应发工资：1000", 20, 60),
        text("实发工资：900", 20, 100),
        text("基本工资：1000", 20, 150),
        text("2026年08月", 120, 250),
        text("应发工资：2000", 20, 300),
        text("实发工资：1800", 20, 340),
        text("基本工资：2000", 20, 390),
      ]),
    );
    expect(draft.payrollMonth).toBe("2026-09");
    expect(draft.lines).toHaveLength(1);
    expect(draft.warnings.some((warning) => warning.includes("其他月份"))).toBe(
      true,
    );
  });

  it("leaves missing months and duplicate total anchors unresolved", () => {
    const draft = parseSalary(
      result([
        text("应发工资：1000", 20, 60),
        text("应发工资：1200", 20, 90),
        text("实发工资：900", 20, 130),
        text("基本工资：1000", 20, 180),
      ]),
    );
    expect(draft.payrollMonth).toBeNull();
    expect(draft.statedGrossMinor).toBeNull();
    expect(draft.warnings.some((warning) => warning.includes("多个候选"))).toBe(
      true,
    );
  });

  it("uses the explicit allowance subtotal and deduction signs without double-counting", () => {
    const draft = parseSalary(
      result([
        text("2026-09", 120, 10),
        text("应发：1500", 20, 60),
        text("实发：1400", 20, 100),
        text("基本薪水：1000", 20, 150),
        text("津贴奖金合计：700", 20, 200),
        text("工龄津贴：200", 20, 250),
        text("奖金合计：500", 20, 300),
        text("月度奖惩：500", 20, 350),
        text("补发合计：-200", 20, 400),
        text("社保津贴补差：-200", 20, 450),
        text("个税：-100", 20, 500),
      ]),
    );
    expect(reconcile(draft).status).toBe("consistent");
    expect(reconcile(draft).calculatedNetMinor).toBe(140000);
    expect(draft.lines.find((row) => row.label === "个税")?.amountMinor).toBe(
      -10000,
    );
    expect(salaryGroups(draft).earnings).toHaveLength(3);
  });

  it("uses known details when a subtotal amount is missing, and reports source mismatch", () => {
    const draft = parseSalary(
      result([
        text("2026-09", 120, 10),
        text("应发：500", 20, 60),
        text("实发：500", 20, 100),
        text("奖金合计：", 20, 150),
        text("月度奖惩：500", 20, 200),
      ]),
    );
    expect(reconcile(draft).status).toBe("consistent");
    const parent = draft.lines.find((row) => row.label === "奖金合计")!;
    expect(parent.amountMinor).toBeNull();
    expect(parent.calculationMode).toBe("children");
    parent.amountMinor = 60000;
    const next = normalizeSalaryDraft(draft);
    expect(reconcile(next).calculatedGrossMinor).toBe(60000);
    expect(reconcile(next).groupDifferences).toEqual([
      { lineId: parent.id, label: "奖金合计", differenceMinor: 10000 },
    ]);
  });

  it("upgrades old automatic drafts without mutating the input or overwriting manual choices", () => {
    const old = parseSalary(demoOcr);
    const parent = old.lines.find((row) => row.label === "补发合计")!;
    parent.effect = "unknown";
    parent.calculationMode = "unresolved";
    delete parent.accountingSource;
    parent.issues = ["补发与补差关系待确认"];
    const before = JSON.stringify(old);
    const normalized = normalizeSalaryDraft(old);
    expect(JSON.stringify(old)).toBe(before);
    expect(normalized.lines.find((row) => row.id === parent.id)?.effect).toBe(
      "earning",
    );
    expect(normalizeSalaryDraft(normalized)).toEqual(normalized);
    parent.effect = "deduction";
    parent.calculationMode = "self";
    parent.accountingSource = "manual";
    expect(
      normalizeSalaryDraft(old).lines.find((row) => row.id === parent.id)
        ?.effect,
    ).toBe("deduction");
  });

  it("keeps conflicting repeated subtotals unresolved without accumulating issues", () => {
    const draft = parseSalary(
      result([
        text("2026-09", 120, 10),
        text("应发：500", 20, 60),
        text("实发：500", 20, 100),
        text("奖金合计：500", 20, 150),
        text("奖金合计：600", 20, 200),
        text("月度奖惩：500", 20, 250),
      ]),
    );
    expect(reconcile(draft).status).toBe("unresolved");
    expect(normalizeSalaryDraft(draft)).toEqual(draft);
  });

  it("preserves a legacy selected detail calculation after a user changes a detail amount", () => {
    const old = parseSalary(demoOcr);
    const parent = old.lines.find((row) => row.label === "奖金合计")!;
    const child = old.lines.find((row) => row.label === "月度奖惩")!;
    delete parent.accountingSource;
    parent.calculationMode = "children";
    child.amountMinor = 320000;
    const before = reconcile(old).calculatedGrossMinor;
    const upgraded = normalizeSalaryDraft(old);
    expect(
      upgraded.lines.find((row) => row.id === parent.id)?.calculationMode,
    ).toBe("children");
    expect(
      upgraded.lines.find((row) => row.id === parent.id)?.accountingSource,
    ).toBe("manual");
    expect(reconcile(upgraded).calculatedGrossMinor).toBe(before);
    expect(reconcile(upgraded).groupDifferences).toContainEqual({
      lineId: parent.id,
      label: parent.label,
      differenceMinor: -6700,
    });
  });
});
