import type {
  Reconciliation,
  SalaryDraft,
  SalaryEffect,
  SalaryLine,
} from "./types";
import { accountingAmount } from "./salaryRules";

export function reconcile(draft: SalaryDraft): Reconciliation {
  const issues: string[] = [];
  const unresolved = new Set<string>();
  const byId = new Map<string, SalaryLine>();
  const children = new Map<string, SalaryLine[]>();
  const invalid = new Set<string>();
  let grossComplete = true;
  let deductionsComplete = true;
  let gross = 0n;
  let deductions = 0n;

  if (!draft.lines.length) {
    grossComplete = false;
    deductionsComplete = false;
    issues.push("尚无可核算明细");
  }

  function markUnresolved(
    line: SalaryLine,
    reason: string,
    effect: SalaryEffect = line.effect,
  ) {
    unresolved.add(line.id);
    issues.push(`${line.label}：${reason}`);
    if (effect === "earning") grossComplete = false;
    else if (effect === "deduction") deductionsComplete = false;
    else if (effect !== "display") {
      grossComplete = false;
      deductionsComplete = false;
    }
  }

  for (const line of draft.lines) {
    if (byId.has(line.id)) invalid.add(line.id);
    byId.set(line.id, line);
    if (line.parentLineId) {
      const siblings = children.get(line.parentLineId) ?? [];
      siblings.push(line);
      children.set(line.parentLineId, siblings);
    }
  }

  // Validate the graph independently from which rows are selected for totals.
  for (const line of draft.lines) {
    const chain = new Set<string>();
    let current: SalaryLine | undefined = line;
    while (current) {
      if (chain.has(current.id)) {
        for (const id of chain) invalid.add(id);
        break;
      }
      chain.add(current.id);
      if (!current.parentLineId) break;
      if (!byId.has(current.parentLineId)) {
        invalid.add(line.id);
        break;
      }
      current = byId.get(current.parentLineId);
    }
  }

  for (const line of draft.lines) {
    if (invalid.has(line.id))
      markUnresolved(line, "明细关系重复、缺失或成环", "unknown");
  }

  function add(line: SalaryLine) {
    if (line.effect === "display") return;
    if (line.effect === "unknown") {
      markUnresolved(line, "请确认收入或扣款口径");
      return;
    }
    if (line.amountMinor === null || !Number.isSafeInteger(line.amountMinor)) {
      markUnresolved(line, "金额缺失或超出有效范围");
      return;
    }
    const amount = accountingAmount(line)!;
    if (line.effect === "earning") gross += BigInt(amount);
    else deductions += BigInt(amount);
  }

  function visit(line: SalaryLine) {
    if (invalid.has(line.id) || line.calculationMode === "exclude") return;
    if (line.calculationMode === "unresolved") {
      markUnresolved(line, "合计关系待确认");
      return;
    }
    if (line.calculationMode === "self") {
      add(line);
      return; // Choosing a subtotal explicitly excludes its descendants.
    }
    const descendants = children.get(line.id) ?? [];
    if (!descendants.length) {
      markUnresolved(line, "选择按子项计算，但没有子项", "unknown");
      return;
    }
    for (const child of descendants) visit(child);
  }

  for (const line of draft.lines) {
    if (!line.parentLineId) visit(line);
  }

  function safe(value: bigint, description: string): number | null {
    if (
      value > BigInt(Number.MAX_SAFE_INTEGER) ||
      value < BigInt(Number.MIN_SAFE_INTEGER)
    ) {
      issues.push(`${description}超出安全金额范围`);
      return null;
    }
    return Number(value);
  }

  const knownGross = safe(gross, "收入小计");
  const knownDeductions = safe(deductions, "扣款小计");
  if (knownGross === null) grossComplete = false;
  if (knownDeductions === null) deductionsComplete = false;
  const calculatedGrossMinor = grossComplete ? knownGross : null;
  const calculatedDeductionsMinor = deductionsComplete ? knownDeductions : null;
  const calculatedNetMinor =
    grossComplete && deductionsComplete
      ? safe(gross - deductions, "计算实发")
      : null;
  const validStated = [draft.statedGrossMinor, draft.statedNetMinor].every(
    (value) => value !== null && Number.isSafeInteger(value),
  );
  const statedDeductionMinor = validStated
    ? safe(
        BigInt(draft.statedGrossMinor!) - BigInt(draft.statedNetMinor!),
        "总额推导扣款",
      )
    : null;
  const deductionDifferenceMinor =
    statedDeductionMinor !== null && knownDeductions !== null
      ? safe(BigInt(statedDeductionMinor) - deductions, "可见扣款差额")
      : null;
  const grossDifferenceMinor =
    calculatedGrossMinor !== null &&
    draft.statedGrossMinor !== null &&
    Number.isSafeInteger(draft.statedGrossMinor)
      ? safe(BigInt(draft.statedGrossMinor) - gross, "应发差额")
      : null;
  const complete =
    grossComplete &&
    deductionsComplete &&
    validStated &&
    calculatedNetMinor !== null &&
    deductionDifferenceMinor !== null &&
    grossDifferenceMinor !== null;
  if (!validStated) issues.push("请核对原载应发与实发");
  if (deductionDifferenceMinor !== null && deductionDifferenceMinor !== 0) {
    issues.push("原载总额与可见扣款存在差额");
  }
  // Check source subtotals even when their children are not selected for accounting.
  function detailAmount(
    line: SalaryLine,
    seen = new Set<string>(),
  ): bigint | null {
    if (
      invalid.has(line.id) ||
      seen.has(line.id) ||
      line.effect === "unknown" ||
      line.calculationMode === "unresolved"
    )
      return null;
    if (line.calculationMode === "exclude" || line.effect === "display")
      return 0n;
    if (line.calculationMode === "self") {
      const amount = accountingAmount(line);
      return amount === null ? null : BigInt(amount);
    }
    const nested = children.get(line.id) ?? [];
    if (!nested.length) return null;
    const values = nested.map((child) =>
      detailAmount(child, new Set([...seen, line.id])),
    );
    return values.some((value) => value === null)
      ? null
      : values.reduce<bigint>((sum, value) => sum + value!, 0n);
  }
  const groupDifferences: Reconciliation["groupDifferences"] = [];
  for (const line of draft.lines) {
    const nested = children.get(line.id) ?? [];
    const amount = accountingAmount(line);
    if (
      !nested.length ||
      amount === null ||
      invalid.has(line.id) ||
      line.effect === "unknown" ||
      line.effect === "display" ||
      line.calculationMode === "exclude"
    )
      continue;
    if (
      nested.some(
        (child) => child.effect !== line.effect && child.effect !== "display",
      )
    )
      continue;
    const values = nested.map((child) => detailAmount(child));
    if (values.some((value) => value === null)) continue;
    const difference = safe(
      BigInt(amount) - values.reduce<bigint>((sum, value) => sum + value!, 0n),
      "合计差额",
    );
    if (difference !== null && difference !== 0) {
      groupDifferences.push({
        lineId: line.id,
        label: line.label,
        differenceMinor: difference,
      });
      issues.push(`${line.label}与已列子项相差 ${Math.abs(difference) / 100} 元`);
    }
  }
  return {
    // Overflow is reported and all complete totals become null, never rounded.
    knownGrossMinor: knownGross,
    knownDeductionsMinor: knownDeductions,
    calculatedGrossMinor,
    calculatedDeductionsMinor,
    calculatedNetMinor,
    statedDeductionMinor,
    deductionDifferenceMinor,
    deductionComparisonComplete:
      deductionsComplete && validStated && deductionDifferenceMinor !== null,
    grossDifferenceMinor,
    status: !complete
      ? "unresolved"
      : deductionDifferenceMinor !== 0 ||
          grossDifferenceMinor !== 0 ||
          groupDifferences.length
        ? "difference"
        : "consistent",
    issues: [...new Set(issues)],
    unresolvedLineIds: [...unresolved],
    groupDifferences,
  };
}
