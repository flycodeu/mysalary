import { normalizeMoneyText, parseMoney } from "./money";
import type {
  Box,
  OcrLine,
  OcrResult,
  SalaryDraft,
  SalaryEffect,
} from "./types";
import { normalizeSalaryDraft, salaryEffectFor } from "./salaryRules";

interface TextPart extends OcrLine {
  index: number;
}

interface Candidate {
  label: string;
  rawAmountText: string;
  amountMinor: number | null;
  box: Box;
  needsReview: boolean;
  issue?: string;
}

interface ParsedCandidates {
  rows: Candidate[];
  warnings: string[];
}

interface MonthRegion {
  month: string | null;
  top: number;
  bottom: number;
  headerIndex: number | null;
}

const cleanLabel = (label: string) => label.replace(/[：:]\s*$/, "").trim();
const compact = (label: string) => cleanLabel(label).replace(/[\s()（）]/g, "");
const centerY = (box: Box) => box.y + box.height / 2;
const hasAmbiguity = (part: OcrLine) =>
  part.needsReview === true || Boolean(part.alternatives?.length);

function unionBox(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

function sameRow(a: Box, b: Box): boolean {
  const overlap = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return (
    overlap >= Math.min(a.height, b.height) * 0.4 ||
    Math.abs(centerY(a) - centerY(b)) <= Math.max(a.height, b.height) * 0.45
  );
}

function monthFrom(text: string): string | null {
  const normalized = normalizeMoneyText(text).replace(/\s/g, "");
  const match = /^(20\d{2})(?:年|[-/.])(\d{1,2})月?$/.exec(normalized);
  if (!match) return null;
  const month = Number(match[2]);
  return month >= 1 && month <= 12
    ? `${match[1]}-${String(month).padStart(2, "0")}`
    : null;
}

function isPrivateMetadata(text: string): boolean {
  // These details may remain in the private original, but never become salary fields.
  const value = text.trim();
  if (
    /^(?:姓名|员工姓名|工号|员工编号|身份证|证件号|银行账号|银行卡号|手机号|手机号码|发放日期|发薪日期|出生日期)/.test(
      value,
    )
  )
    return true;
  if (/^岗位\s*[（(]?\s*基本/.test(value)) return false;
  return /^(?:部门|岗位|职位|薪资发放公司|发放公司|公司名称)(?:\s*[：:]|\s+|$)/.test(
    value,
  );
}

function isDecoration(text: string): boolean {
  return /^(?:返回|关闭|智慧HR|工资查询|工资详情|工资明细|收起|展开|[.。·…]+|[<>‹›^⌃]+)$/.test(
    text.replace(/\s/g, ""),
  );
}

function isDateOrTime(text: string): boolean {
  const value = normalizeMoneyText(text).replace(/\s/g, "");
  return (
    /^\d{1,2}:\d{2}(?::\d{2})?$/.test(value) ||
    /^(?:19|20|21)\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?$/.test(value) ||
    /^\d{1,2}月\d{1,2}日$/.test(value)
  );
}

function effectFor(label: string): SalaryEffect {
  return salaryEffectFor(label);
}

function anchorFor(label: string): "gross" | "net" | null {
  const name = compact(label);
  if (/^(?:应发工资|应发合计|应发总额|应发)$/.test(name)) return "gross";
  if (/^(?:实发工资|实发合计|实发总额|实发)$/.test(name)) return "net";
  return null;
}

function numericPart(text: string): { label: string; raw: string } | null {
  const normalized = normalizeMoneyText(text);
  // Require a complete numeric-looking token. O/decimal errors remain null amounts.
  const match = /([+\-]?[¥￥]?\s*[\dOoIl][\dOoIl, .]*)(?:\s*元)?$/.exec(
    normalized,
  );
  if (!match || match.index === undefined) return null;
  if (!/\d/.test(match[0])) return null;
  const prefix = normalized.slice(0, match.index);
  const label = cleanLabel(prefix);
  if (
    label &&
    !/[\s：:]$/.test(prefix) &&
    effectFor(label) === "unknown" &&
    !anchorFor(label)
  ) {
    return null;
  }
  return { label, raw: match[0].trim() };
}

function joinAmountSymbols(parts: TextPart[], imageWidth: number): TextPart[] {
  const numericToken = (part: TextPart) =>
    part.box.x >= imageWidth * 0.45 &&
    /^[+\-¥￥\dOoIl,.]+$/.test(normalizeMoneyText(part.text));
  const result = parts.filter((part) => !numericToken(part));
  let pending = parts.filter(numericToken);
  while (pending.length) {
    const baseline = pending[0]!;
    const row = pending
      .filter((part) => sameRow(part.box, baseline.box))
      .sort((a, b) => a.box.x - b.box.x);
    const rowIds = new Set(row.map((part) => part.index));
    pending = pending.filter((part) => !rowIds.has(part.index));
    const joined: TextPart[] = [];
    for (const part of row) {
      const previous = joined.at(-1);
      const previousText = previous ? normalizeMoneyText(previous.text) : "";
      const currentText = normalizeMoneyText(part.text);
      // Only combine fragments linked by an explicit sign/decimal separator.
      // Two independent numbers on a row must not silently become one amount.
      if (
        previous &&
        part.box.x >= previous.box.x + previous.box.width - 2 &&
        part.box.x - (previous.box.x + previous.box.width) <=
          Math.max(part.box.height, previous.box.height) &&
        (/^[+\-¥￥]$/.test(previousText) ||
          /[.,]$/.test(previousText) ||
          /^[.,]/.test(currentText))
      ) {
        previous.text = previousText + currentText;
        previous.box = unionBox(previous.box, part.box);
        if (hasAmbiguity(previous) || hasAmbiguity(part)) {
          previous.needsReview = true;
          previous.alternatives = [
            ...(previous.alternatives ?? []),
            ...(part.alternatives ?? []),
          ];
        }
      } else joined.push({ ...part, box: { ...part.box } });
    }
    result.push(...joined);
  }
  return result.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
}

function candidatesFor(
  parts: TextPart[],
  imageWidth: number,
): ParsedCandidates {
  const privateRows = parts.filter((part) => isPrivateMetadata(part.text));
  const visible = joinAmountSymbols(
    parts.filter(
      (part) =>
        !privateRows.some((row) => sameRow(row.box, part.box)) &&
        (!isDecoration(part.text) ||
          (part.box.x >= imageWidth * 0.45 && /^[.,]$/.test(part.text))) &&
        !monthFrom(part.text) &&
        !isDateOrTime(part.text),
    ),
    imageWidth,
  );
  const candidates: Candidate[] = [];
  const warnings: string[] = [];
  const labels: TextPart[] = [];
  const amounts: Array<TextPart & { raw: string }> = [];
  const consumed = new Set<number>();
  const unmatched: Array<TextPart & { raw: string }> = [];

  for (const part of visible) {
    const numeric = numericPart(part.text);
    if (numeric?.label) {
      candidates.push({
        label: numeric.label,
        rawAmountText: numeric.raw,
        amountMinor: hasAmbiguity(part) ? null : parseMoney(numeric.raw),
        box: part.box,
        needsReview: hasAmbiguity(part),
      });
    } else if (
      numeric &&
      part.box.x + part.box.width / 2 >= imageWidth * 0.45
    ) {
      amounts.push({ ...part, raw: numeric.raw });
    } else if (/[\u3400-\u9fffA-Za-z]/.test(part.text)) {
      labels.push(part);
    }
  }

  for (const amount of amounts) {
    const matches = labels.filter(
      (label) =>
        !consumed.has(label.index) &&
        label.box.x < amount.box.x &&
        sameRow(label.box, amount.box),
    );
    matches.sort(
      (a, b) =>
        Math.abs(centerY(a.box) - centerY(amount.box)) -
          Math.abs(centerY(b.box) - centerY(amount.box)) || a.box.x - b.box.x,
    );
    const label = matches[0];
    if (!label) {
      unmatched.push(amount);
      continue;
    }
    consumed.add(label.index);
    let labelText = cleanLabel(label.text);
    let box = unionBox(label.box, amount.box);
    let needsReview = hasAmbiguity(label) || hasAmbiguity(amount);

    // A wrapped label may end on the amount's baseline. Only join an adjacent,
    // short continuation; never swallow a distinct preceding missing amount.
    const previous = labels.filter(
      (part) =>
        !consumed.has(part.index) &&
        part.box.y < label.box.y &&
        label.box.y - (part.box.y + part.box.height) >= -2 &&
        label.box.y - (part.box.y + part.box.height) <=
          Math.max(part.box.height, label.box.height) * 0.7 &&
        Math.abs(part.box.x - label.box.x) < imageWidth * 0.12 &&
        !/[：:]\s*$/.test(part.text) &&
        !anchorFor(part.text) &&
        effectFor(part.text) === "unknown",
    );
    previous.sort((a, b) => b.box.y - a.box.y);
    if (previous[0] && labelText.length <= 6) {
      const preceding = previous[0];
      labelText = `${cleanLabel(preceding.text)}${labelText}`;
      box = unionBox(preceding.box, box);
      consumed.add(preceding.index);
      needsReview ||= hasAmbiguity(preceding);
    }
    candidates.push({
      label: labelText,
      rawAmountText: amount.raw,
      amountMinor: needsReview ? null : parseMoney(amount.raw),
      box,
      needsReview,
    });
  }

  const detailPositions = candidates
    .filter((row) => !anchorFor(row.label))
    .map((row) => row.box.y);
  const anchorPositions = candidates
    .filter((row) => anchorFor(row.label))
    .map((row) => row.box.y);
  const firstDetailY = detailPositions.length
    ? Math.min(...detailPositions)
    : anchorPositions.length
      ? Math.max(...anchorPositions)
      : Number.POSITIVE_INFINITY;

  const salaryRows = candidates.filter(
    (row) =>
      !anchorFor(row.label) &&
      (effectFor(row.label) !== "unknown" ||
        /工资|薪水|补助|补贴|奖金|津贴|奖惩|嘉奖|扣|社保|公积金|税/.test(
          row.label,
        )),
  );
  const salaryAreaTop = Math.min(...salaryRows.map((row) => row.box.y));
  for (const amount of unmatched) {
    const normalized = normalizeMoneyText(amount.raw).replace(
      /[¥￥,\s元]/g,
      "",
    );
    const integerDigits = normalized.replace(/^[+-]/, "").split(".")[0] ?? "";
    const hasAmountNotation = /[.¥￥]|^[+-]/.test(
      normalizeMoneyText(amount.raw),
    );
    const plausibleAmount =
      amount.box.y >= salaryAreaTop &&
      hasAmountNotation &&
      integerDigits.length <= 5 &&
      parseMoney(amount.raw) !== null;
    if (plausibleAmount) {
      // Without a label, even a perfectly read number is not a known salary amount.
      candidates.push({
        label: "未配对金额",
        rawAmountText: amount.raw,
        amountMinor: null,
        box: amount.box,
        needsReview: hasAmbiguity(amount),
        issue: "金额没有对应项目，请对照原图填写名称和金额",
      });
      warnings.push("存在未配对金额，请点击对应行查看原图");
    } else {
      // A bare number may be an employee ID or a date. Keep its text only in the
      // original OCR evidence; the draft exposes location, not identifying digits.
      warnings.push(
        `原图位置（${Math.round(amount.box.x)}, ${Math.round(amount.box.y)}）有未配对数字，请核对是否属于工资`,
      );
    }
  }
  for (const label of labels) {
    if (consumed.has(label.index)) continue;
    const text = cleanLabel(label.text);
    // Retain a missing amount in the salary area, but do not ingest company/name text.
    if (
      effectFor(text) !== "unknown" ||
      anchorFor(text) ||
      (label.box.y >= firstDetailY &&
        label.box.x < imageWidth * 0.6 &&
        /[\u3400-\u9fff]/.test(label.text))
    ) {
      candidates.push({
        label: text,
        rawAmountText: "",
        amountMinor: null,
        box: label.box,
        needsReview: hasAmbiguity(label),
      });
    }
  }
  return {
    rows: candidates.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x),
    warnings,
  };
}

function draftFrom(
  candidates: ParsedCandidates,
  month: string | null,
): SalaryDraft {
  const draft: SalaryDraft = {
    payrollMonth: month,
    statedGrossMinor: null,
    statedNetMinor: null,
    lines: [],
    warnings: [...candidates.warnings],
    reviewStatus: "draft",
  };
  const anchors = { gross: [] as Candidate[], net: [] as Candidate[] };
  for (const candidate of candidates.rows) {
    if (candidate.needsReview) {
      draft.warnings.push(`${candidate.label}存在多个识别候选，请对照原图核对`);
    }
    const anchor = anchorFor(candidate.label);
    if (anchor) {
      anchors[anchor].push(candidate);
      continue;
    }
    const effect = candidate.needsReview
      ? "unknown"
      : effectFor(candidate.label);
    const issues: string[] = [];
    if (candidate.issue) issues.push(candidate.issue);
    if (candidate.needsReview)
      issues.push("同一位置的识别结果不一致，金额和项目口径待核对");
    if (candidate.amountMinor === null && !candidate.issue)
      issues.push(candidate.rawAmountText ? "金额格式待核对" : "金额未识别");
    if (effect === "unknown") issues.push("新字段，请确认收入或扣款");
    draft.lines.push({
      id: `line-${draft.lines.length + 1}`,
      label: candidate.label,
      rawAmountText: candidate.rawAmountText,
      amountMinor: candidate.amountMinor,
      effect,
      rowRole: /合计$/.test(compact(candidate.label)) ? "subtotal" : "detail",
      calculationMode: effect === "unknown" ? "unresolved" : "self",
      parentLineId: null,
      sourceBox: candidate.box,
      issues,
    });
  }
  for (const key of ["gross", "net"] as const) {
    const rows = anchors[key];
    if (rows.length === 1) {
      if (key === "gross") draft.statedGrossMinor = rows[0]!.amountMinor;
      else draft.statedNetMinor = rows[0]!.amountMinor;
    } else if (rows.length > 1) {
      draft.warnings.push(
        `${key === "gross" ? "应发" : "实发"}出现多个候选，请对照原图填写`,
      );
    }
  }
  if (!month) draft.warnings.push("工资月份未识别，请填写");
  if (draft.statedGrossMinor === null) draft.warnings.push("应发工资待核对");
  if (draft.statedNetMinor === null) draft.warnings.push("实发工资待核对");
  if (draft.lines.some((line) => line.effect === "unknown"))
    draft.warnings.push("存在未确认的工资项目");
  return normalizeSalaryDraft(draft);
}

/** Produce a draft only: OCR never marks a record as reviewed. */
export function parseSalary(ocr: OcrResult): SalaryDraft {
  const parts: TextPart[] = ocr.lines
    .map((line, index) => ({ ...line, text: line.text.trim(), index }))
    .filter(
      (line) =>
        line.text &&
        Object.values(line.box).every(Number.isFinite) &&
        line.box.width > 0 &&
        line.box.height > 0,
    )
    .sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  const headers = parts.filter((line) => monthFrom(line.text));
  const regions: MonthRegion[] = headers.length
    ? headers.map((header, index) => ({
        month: hasAmbiguity(header) ? null : monthFrom(header.text),
        top: header.box.y + header.box.height,
        bottom: headers[index + 1]?.box.y ?? Number.POSITIVE_INFINITY,
        headerIndex: header.index,
      }))
    : [
        {
          month: null,
          top: Number.NEGATIVE_INFINITY,
          bottom: Number.POSITIVE_INFINITY,
          headerIndex: null,
        },
      ];
  const drafts = regions.map((region) =>
    draftFrom(
      candidatesFor(
        parts.filter(
          (line) =>
            line.index !== region.headerIndex &&
            centerY(line.box) >= region.top &&
            centerY(line.box) < region.bottom,
        ),
        ocr.imageWidth,
      ),
      region.month,
    ),
  );
  const withContent = drafts.filter(
    (draft) =>
      draft.lines.length > 0 ||
      draft.statedGrossMinor !== null ||
      draft.statedNetMinor !== null,
  );
  const fullCandidates = withContent.filter(
    (draft) => draft.statedGrossMinor !== null && draft.statedNetMinor !== null,
  );
  const selected = fullCandidates[0] ?? withContent[0] ?? drafts[0]!;
  if (withContent.length > 1) {
    selected.warnings.push(
      "图片包含其他月份的工资内容，P0 仅显示当前月份；请将其他月份分别导入",
    );
  }
  const titlesOnly = drafts.filter(
    (draft) => !withContent.includes(draft) && draft.payrollMonth,
  );
  if (titlesOnly.length)
    selected.warnings.push("另有月份仅出现标题，未创建工资记录");
  if (!fullCandidates.length && withContent.length)
    selected.warnings.push("截图总额信息不完整，请对照原图补充");
  if (!withContent.length)
    selected.warnings.push("未找到工资内容，请重新选择或手工填写");
  return selected;
}
