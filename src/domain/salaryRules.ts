import type { SalaryDraft, SalaryEffect, SalaryLine } from "./types";

const compact = (label: string) => label.replace(/[\s()（）：:]/g, "");
const refund = (label: string) =>
  /退还|返还|退税|退费|退回|refund/i.test(label);
const allowancesTotal = /^(?:津贴奖金合计|津贴与奖金合计|津补贴奖金合计)$/;
const allowance =
  /^(?:工龄津贴|高温津贴|高温补贴|岗位津贴|交通补贴|餐费补贴|通讯补贴|住房补贴|月度奖惩|月度奖金|季度奖金|年度奖金|奖金合计)$/;

/** Classification comes from a field's meaning, never from its numeric sign. */
export function salaryEffectFor(label: string): SalaryEffect {
  const name = compact(label);
  if (
    allowancesTotal.test(name) ||
    allowance.test(name) ||
    /^(?:岗位基本薪水|基本薪水|基本工资|岗位工资|嘉奖合计|工程类嘉奖|信息工程类嘉奖|补发合计|社保津贴补差)$/.test(
      name,
    )
  )
    return "earning";
  if (
    /^(?:养老保险费|失业保险费|医疗保险费|养老保险|失业保险|医疗保险|公积金|住房公积金|养老金补扣|养老保险补扣|医疗保险补扣|失业保险补扣|个得税计算|所得税计算|个人所得税|个税|个得税|扣款合计|其他扣款|工资扣款|工会费|工会会费|水电费|房租扣款)$/.test(
      name,
    ) ||
    /(?:社保|养老保险|医疗保险|失业保险|公积金|个税|所得税).*(?:扣款|补扣)$/.test(
      name,
    ) ||
    (refund(name) && /社保|保险|公积金|个税|所得税|税款/.test(name))
  )
    return "deduction";
  return "unknown";
}

/** Raw signed amounts remain intact; a printed minus on a deduction must not add pay. */
export function accountingAmount(line: SalaryLine): number | null {
  if (line.amountMinor === null || !Number.isSafeInteger(line.amountMinor))
    return null;
  if (line.effect !== "deduction") return line.amountMinor;
  return refund(line.label)
    ? -Math.abs(line.amountMinor)
    : Math.abs(line.amountMinor);
}

const obsoleteIssue =
  /^(?:补发与补差关系待确认|新字段，请确认收入或扣款|合计与子项不一致或缺失，请确认采用口径|出现多个合计，请确认分组)$/;
const ambiguous = (line: SalaryLine) =>
  line.issues.some((issue) => issue.includes("识别结果不一致"));

/** Upgrade automatic choices in old drafts without changing any source name or amount. */
export function normalizeSalaryDraft(input: SalaryDraft): SalaryDraft {
  const lines = input.lines.map((line) => ({
    ...line,
    issues: [...line.issues],
  }));
  for (const line of lines) {
    // Legacy drafts had no edit provenance; a selected detail calculation must survive upgrade.
    if (!line.accountingSource && line.calculationMode === "children") {
      line.accountingSource = "manual";
    }
    if (line.accountingSource === "manual" || ambiguous(line)) continue;
    const effect = salaryEffectFor(line.label);
    if (effect === "unknown") continue;
    // An old explicit exclusion or different chosen category is preserved.
    if (
      line.calculationMode === "exclude" ||
      (line.effect !== "unknown" && line.effect !== effect)
    )
      continue;
    line.effect = effect;
    line.accountingSource = "automatic";
    line.calculationMode = "self";
    line.issues = line.issues.filter((issue) => !obsoleteIssue.test(issue));
  }

  const rules = [
    {
      parent: /^奖金合计$/,
      child: /^(?:月度奖惩|月度奖金|季度奖金|年度奖金)$/,
    },
    { parent: /^嘉奖合计$/, child: /^(?:信息)?工程类嘉奖$/ },
    { parent: /^补发合计$/, child: /^社保津贴补差$/ },
    { parent: allowancesTotal, child: allowance },
    { parent: /^扣款合计$/, child: null },
  ];
  for (const rule of rules) {
    const parents = lines.filter((line) =>
      rule.parent.test(compact(line.label)),
    );
    if (parents.length !== 1) {
      for (const parent of parents) {
        if (parent.accountingSource === "manual") continue;
        parent.calculationMode = "unresolved";
        if (!parent.issues.includes("出现多个合计，请确认分组"))
          parent.issues.push("出现多个合计，请确认分组");
      }
      continue;
    }
    const parent = parents[0]!;
    if (
      parent.effect === "unknown" ||
      ambiguous(parent) ||
      parent.calculationMode === "exclude"
    )
      continue;
    const children = lines.filter(
      (line) =>
        line.id !== parent.id &&
        (line.parentLineId === parent.id ||
          (!line.parentLineId &&
            line.effect === parent.effect &&
            line.accountingSource !== "manual" &&
            (rule.child
              ? rule.child.test(compact(line.label))
              : line.effect === "deduction"))),
    );
    for (const child of children) child.parentLineId = parent.id;
    if (parent.accountingSource !== "manual") {
      parent.rowRole = "subtotal";
      parent.calculationMode =
        parent.amountMinor === null && children.length ? "children" : "self";
    }
  }
  const warnings = input.warnings.filter(
    (warning) => warning !== "存在未确认的工资项目",
  );
  if (
    lines.some(
      (line) => line.effect === "unknown" && line.calculationMode !== "exclude",
    )
  ) {
    warnings.push("存在未确认的工资项目");
  }
  return { ...input, lines, warnings };
}

export interface SalaryGroupRow {
  id: string;
  label: string;
  amountMinor: number | null;
  /** Null denotes a display-only grouping, never an invented source salary row. */
  line: SalaryLine | null;
  children: SalaryLine[];
}

export interface SalaryGroups {
  earnings: SalaryGroupRow[];
  deductions: SalaryGroupRow[];
  unresolved: SalaryGroupRow[];
  excluded: SalaryGroupRow[];
}

function safeSum(values: Array<number | null>): number | null {
  if (!values.length || values.some((value) => value === null)) return null;
  const sum = values.reduce<bigint>(
    (total, value) => total + BigInt(value!),
    0n,
  );
  return sum > BigInt(Number.MAX_SAFE_INTEGER) ||
    sum < BigInt(Number.MIN_SAFE_INTEGER)
    ? null
    : Number(sum);
}

/** Only the view is grouped; accounting and saved OCR rows retain their own identities. */
export function salaryGroups(draft: SalaryDraft): SalaryGroups {
  const groups: SalaryGroups = {
    earnings: [],
    deductions: [],
    unresolved: [],
    excluded: [],
  };
  const descendants = (
    line: SalaryLine,
    seen = new Set<string>(),
  ): SalaryLine[] => {
    if (seen.has(line.id)) return [];
    const visited = new Set([...seen, line.id]);
    return draft.lines
      .filter((child) => child.parentLineId === line.id)
      .flatMap((child) => [child, ...descendants(child, visited)]);
  };
  const amount = (
    line: SalaryLine,
    seen = new Set<string>(),
  ): number | null => {
    if (
      seen.has(line.id) ||
      line.calculationMode === "unresolved" ||
      line.effect === "unknown"
    )
      return null;
    if (line.calculationMode === "exclude" || line.effect === "display")
      return 0;
    if (line.calculationMode === "self") return accountingAmount(line);
    return safeSum(
      draft.lines
        .filter((child) => child.parentLineId === line.id)
        .map((child) => amount(child, new Set([...seen, line.id]))),
    );
  };
  for (const line of draft.lines.filter((row) => !row.parentLineId)) {
    const group: SalaryGroupRow = {
      id: line.id,
      label: line.label,
      line,
      amountMinor: amount(line),
      children: descendants(line),
    };
    if (line.calculationMode === "exclude" || line.effect === "display")
      groups.excluded.push(group);
    else if (line.effect === "unknown" || line.calculationMode === "unresolved")
      groups.unresolved.push(group);
    else if (line.effect === "earning") groups.earnings.push(group);
    else groups.deductions.push(group);
  }
  const hasAllowanceTotal = groups.earnings.some((row) =>
    allowancesTotal.test(compact(row.label)),
  );
  const allowances = groups.earnings.filter((row) =>
    allowance.test(compact(row.label)),
  );
  if (!hasAllowanceTotal && allowances.length > 1) {
    const first = groups.earnings.indexOf(allowances[0]!);
    groups.earnings = groups.earnings.filter(
      (row) => !allowances.includes(row),
    );
    groups.earnings.splice(first, 0, {
      id: "group-allowances",
      label: "津贴奖金合计",
      line: null,
      amountMinor: safeSum(allowances.map((row) => row.amountMinor)),
      children: allowances.flatMap((row) => [row.line!, ...row.children]),
    });
  }
  const order = (label: string) => {
    const name = compact(label);
    if (/^(?:岗位基本薪水|基本薪水|基本工资|岗位工资)$/.test(name)) return 0;
    if (allowancesTotal.test(name) || allowance.test(name)) return 1;
    if (/^(?:嘉奖合计|工程类嘉奖|信息工程类嘉奖)$/.test(name)) return 2;
    if (/^(?:补发合计|社保津贴补差)$/.test(name)) return 3;
    return 4;
  };
  groups.earnings.sort((a, b) => order(a.label) - order(b.label));
  return groups;
}
