import { describe, expect, it } from "vitest";
import {
  CAPTURE_MAX_BYTES,
  CAPTURE_PAGE,
  draftFromCapture,
  parseCapturePackage,
  type CapturePackage,
  type CaptureRecord,
} from "../src/domain/capture";
import { reconcile } from "../src/domain/reconcile";

function record(payrollMonth = "2026-09"): CaptureRecord {
  return {
    payrollMonth,
    fields: [
      { label: "应发工资", amountText: "9280" },
      { label: "实发工资", amountText: "8370" },
      { label: "岗位（基本）薪水", amountText: "6000" },
      { label: "工龄津贴", amountText: "100" },
      { label: "高温津贴", amountText: "80" },
      { label: "补发合计", amountText: "-100" },
      { label: "月度奖惩", amountText: "1200" },
      { label: "奖金合计", amountText: "1200" },
      { label: "信息工程类嘉奖", amountText: "2000" },
      { label: "嘉奖合计", amountText: "2000" },
      { label: "养老保险费", amountText: "300" },
      { label: "失业保险费", amountText: "50" },
      { label: "医疗保险费", amountText: "100" },
      { label: "公积金", amountText: "250" },
      { label: "养老金补扣", amountText: "100" },
      { label: "医疗保险补扣", amountText: "50" },
      { label: "失业保险补扣", amountText: "20" },
      { label: "社保津贴补差", amountText: "-100" },
      { label: "个得税（计算）", amountText: "30" },
    ],
  };
}

function capture(records = [record()]): CapturePackage {
  return {
    format: "salary-capture",
    version: 1,
    source: {
      kind: "feishu-text",
      page: CAPTURE_PAGE,
      capturedAt: "2026-09-28T12:00:00.000+08:00",
    },
    records,
  };
}

describe("salary capture file validation", () => {
  it("preserves source text and supports BOM and .NET timestamp precision", () => {
    const input = capture();
    input.source.capturedAt = "2026-09-28T04:00:00.1234567Z";
    input.records[0]!.fields[0]!.amountText = "￥9,280.00";
    expect(parseCapturePackage(`\uFEFF${JSON.stringify(input)}`)).toEqual(input);
  });

  it("keeps each month separate, including when a file is out of chronological order", () => {
    const older = record("2026-08");
    older.fields[0]!.amountText = "9000";
    const parsed = parseCapturePackage(JSON.stringify(capture([record(), older])));
    const drafts = parsed.records.map(draftFromCapture);
    expect(drafts.map((draft) => draft.payrollMonth)).toEqual(["2026-09", "2026-08"]);
    expect(drafts.map((draft) => draft.statedGrossMinor)).toEqual([928000, 900000]);
  });

  it("rejects duplicate months rather than combining their salary rows", () => {
    expect(() => parseCapturePackage(JSON.stringify(capture([record(), record()]))))
      .toThrow("同一月份存在重复记录");
  });

  it("rejects duplicate total aliases and duplicate detail labels", () => {
    for (const label of ["应发合计", "实发总额", "高温津贴："]) {
      const input = capture();
      input.records[0]!.fields.push({ label, amountText: "100" });
      expect(() => parseCapturePackage(JSON.stringify(input))).toThrow("重复");
    }
  });

  it("requires both totals and at least one detail for every included month", () => {
    const onlyTotals = record();
    onlyTotals.fields = onlyTotals.fields.slice(0, 2);
    const missingNet = record();
    missingNet.fields = missingNet.fields.filter((field) => field.label !== "实发工资");
    for (const invalid of [onlyTotals, missingNet]) {
      expect(() => parseCapturePackage(JSON.stringify(capture([invalid])))).toThrow();
    }
  });

  it.each(["2026-00", "2026-13", "2026-9", "2026-09-01", "0000-09", "2026/09"])(
    "rejects an invalid payroll month %s",
    (month) => {
      expect(() => parseCapturePackage(JSON.stringify(capture([record(month)])))).toThrow("月份");
    },
  );

  it.each([
    "2026-09-28T12:00:00",
    "2026-02-29T12:00:00Z",
    "2026-04-31T12:00:00Z",
    "2026-09-28T24:00:00Z",
    "2026-09-28T12:00:00+14:01",
    "2026-09-28T12:00:00+08:60",
    "0000-09-28T12:00:00Z",
    "not-a-date",
  ])("rejects an invalid capture time %s", (capturedAt) => {
    const input = capture();
    input.source.capturedAt = capturedAt;
    expect(() => parseCapturePackage(JSON.stringify(input))).toThrow("采集时间");
  });

  it("accepts actual leap dates and zero amounts as known values", () => {
    const input = capture();
    input.source.capturedAt = "2024-02-29T12:00:00Z";
    input.records[0]!.fields = [
      { label: "应发工资", amountText: "0" },
      { label: "实发工资", amountText: "0.00" },
      { label: "基本工资", amountText: "0" },
    ];
    const result = draftFromCapture(parseCapturePackage(JSON.stringify(input)).records[0]!);
    expect(result.statedNetMinor).toBe(0);
    expect(result.lines[0]!.amountMinor).toBe(0);
  });

  it.each([null, 100, "", "—", "1O0", "Infinity", "NaN", "1e3", "0.001", "9,28.00", "90071992547409.92"])(
    "rejects an unknown, ambiguous or unsafe amount %s instead of filling in zero",
    (amountText) => {
      const input = capture();
      Object.assign(input.records[0]!.fields[2]!, { amountText });
      expect(() => parseCapturePackage(JSON.stringify(input))).toThrow("金额");
    },
  );

  it.each(["姓名", "工号", "人员编号", "身份证号", "银行卡号", "开户行", "发薪日期", "薪资发放公司", "所属公司", "部门", "所属部门", "岗位", "职务", "手机", "电话", "工资详细", "token"])(
    "rejects metadata %s without disclosing its value in the error",
    (label) => {
      const input = capture();
      const privateValue = "12345678";
      input.records[0]!.fields.push({ label, amountText: privateValue });
      try {
        parseCapturePackage(JSON.stringify(input));
        expect.fail("metadata must not be imported");
      } catch (error) {
        expect(String(error)).toContain("身份信息或非工资项目");
        expect(String(error)).not.toContain(privateValue);
      }
    },
  );

  it.each(["", " ： ", "x\u0000y", "x\u202ey", "x".repeat(101)])(
    "rejects an invalid or unsafe field label",
    (label) => {
      const input = capture();
      input.records[0]!.fields[2]!.label = label;
      expect(() => parseCapturePackage(JSON.stringify(input))).toThrow("项目名称");
    },
  );

  it("requires the exact source page without credentials or unapproved hosts", () => {
    for (const page of [
      "http://hr.hmifo.com/test/#/wages",
      "https://hr.hmifo.com.evil.example/test/#/wages",
      `${CAPTURE_PAGE}?token=secret`,
      "https://hr.hmifo.com/test/?token=secret#/wages",
      "https://user:password@hr.hmifo.com/test/#/wages",
    ]) {
      const input = capture();
      Object.assign(input.source, { page });
      expect(() => parseCapturePackage(JSON.stringify(input))).toThrow("来源");
    }
  });

  it("rejects unexpected properties and unsupported versions at every level", () => {
    const mutations: Array<(input: CapturePackage) => void> = [
      (input) => Object.assign(input, { version: 2 }),
      (input) => Object.assign(input, { format: "other" }),
      (input) => Object.assign(input, { token: "secret" }),
      (input) => Object.assign(input.source, { kind: "ocr" }),
      (input) => Object.assign(input.source, { cookie: "secret" }),
      (input) => Object.assign(input.records[0]!, { employeeId: "secret" }),
      (input) => Object.assign(input.records[0]!.fields[0]!, { amountMinor: 0 }),
    ];
    for (const mutate of mutations) {
      const input = capture();
      mutate(input);
      expect(() => parseCapturePackage(JSON.stringify(input))).toThrow("工资文件无效");
    }
    for (const input of ["{", "null", "[]", "123", '{"__proto__":{}}'])
      expect(() => parseCapturePackage(input)).toThrow("工资文件无效");
  });

  it("enforces UTF-8 bytes, record count and field count limits", () => {
    const input = JSON.stringify(capture());
    expect(() => parseCapturePackage(input.padEnd(CAPTURE_MAX_BYTES + 1))).toThrow("1 MiB");
    const multibyte = `{"padding":"${"薪".repeat(CAPTURE_MAX_BYTES / 2)}"}`;
    expect(multibyte.length).toBeLessThan(CAPTURE_MAX_BYTES);
    expect(() => parseCapturePackage(multibyte)).toThrow("1 MiB");
    expect(() => parseCapturePackage(JSON.stringify(capture([])))).toThrow("120");
    expect(() => parseCapturePackage(JSON.stringify(capture(Array.from({ length: 121 }, () => record())))))
      .toThrow("120");
    const excessiveFields = record();
    excessiveFields.fields = Array.from({ length: 257 }, () => ({ label: "基本工资", amountText: "1" }));
    expect(() => parseCapturePackage(JSON.stringify(capture([excessiveFields])))).toThrow("256");
  });
});

describe("salary text capture accounting", () => {
  it("groups subtotals, preserves negative supplemental pay and leaves the real 10 yuan gap", () => {
    const input = record();
    const original = JSON.stringify(input);
    const draft = draftFromCapture(input);
    const result = reconcile(draft);
    expect(result.calculatedGrossMinor).toBe(928000);
    expect(result.calculatedDeductionsMinor).toBe(90000);
    expect(result.calculatedNetMinor).toBe(838000);
    expect(result.deductionDifferenceMinor).toBe(1000);
    expect(result.status).toBe("difference");
    expect(result.groupDifferences).toEqual([]);
    expect(draft.statedNetMinor).toBe(837000);
    const supplement = draft.lines.find((line) => line.label === "补发合计")!;
    const adjustment = draft.lines.find((line) => line.label === "社保津贴补差")!;
    expect(adjustment.parentLineId).toBe(supplement.id);
    expect(adjustment.effect).toBe("earning");
    expect(adjustment.amountMinor).toBe(-10000);
    expect(draft.lines.every((line) => line.sourceBox === undefined)).toBe(true);
    expect(draft.reviewStatus).toBe("draft");
    expect(JSON.stringify(input)).toBe(original);
  });

  it("keeps unfamiliar salary fields and source totals while reporting incomplete accounting", () => {
    const input = record();
    input.fields.push({ label: "专项激励", amountText: "66.60" });
    const parsed = parseCapturePackage(JSON.stringify(capture([input])));
    const draft = draftFromCapture(parsed.records[0]!);
    expect(draft.statedGrossMinor).toBe(928000);
    expect(draft.statedNetMinor).toBe(837000);
    expect(draft.lines.at(-1)).toMatchObject({
      label: "专项激励",
      amountMinor: 6660,
      effect: "unknown",
      calculationMode: "unresolved",
    });
    const result = reconcile(draft);
    expect(result.status).toBe("unresolved");
    expect(result.calculatedGrossMinor).toBeNull();
    expect(result.calculatedNetMinor).toBeNull();
  });

  it("subtracts signed deductions once and keeps Unicode minus signs in source evidence", () => {
    const input = record();
    input.fields.find((field) => field.label === "个得税（计算）")!.amountText = "−30";
    const draft = draftFromCapture(input);
    expect(draft.lines.at(-1)!.rawAmountText).toBe("−30");
    expect(draft.lines.at(-1)!.amountMinor).toBe(-3000);
    expect(reconcile(draft).calculatedDeductionsMinor).toBe(90000);
  });

  it("reports subtotal disagreements without altering source amounts", () => {
    const input = record();
    input.fields.find((field) => field.label === "月度奖惩")!.amountText = "1100";
    const draft = draftFromCapture(input);
    const result = reconcile(draft);
    expect(result.calculatedGrossMinor).toBe(928000);
    expect(result.groupDifferences).toEqual([
      expect.objectContaining({ label: "奖金合计", differenceMinor: 10000 }),
    ]);
  });

  it("validates direct callers and never turns a missing amount into zero", () => {
    const input = record();
    Object.assign(input.fields[2]!, { amountText: null });
    expect(() => draftFromCapture(input)).toThrow("金额");
  });
});
