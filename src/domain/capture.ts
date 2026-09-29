import { parseMoney } from "./money";
import { normalizeSalaryDraft, salaryEffectFor } from "./salaryRules";
import type { SalaryDraft, SalaryLine } from "./types";

export interface CaptureField {
  label: string;
  amountText: string;
}

export interface CaptureRecord {
  payrollMonth: string;
  fields: CaptureField[];
}

export interface CapturePackage {
  format: "salary-capture";
  version: 1;
  source: {
    kind: "feishu-text";
    page: "https://hr.hmifo.com/test/#/wages";
    capturedAt: string;
  };
  records: CaptureRecord[];
}

export const CAPTURE_MAX_BYTES = 1024 * 1024;
export const CAPTURE_PAGE = "https://hr.hmifo.com/test/#/wages" as const;
const maxRecords = 120;
const maxFields = 256;
const controlCharacters = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const compact = (label: string) => label.replace(/[\s()（）：:]/g, "");

function fail(reason: string): never {
  // Payload values can contain personal data; errors describe the problem only.
  throw new Error(`工资文件无效：${reason}`);
}

function objectWithKeys(
  value: unknown,
  keys: readonly string[],
  description: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail(`${description}格式错误`);
  const object = value as Record<string, unknown>;
  const actual = Object.keys(object);
  if (
    actual.length !== keys.length ||
    actual.some((key) => !keys.includes(key)) ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(object, key))
  )
    fail(`${description}字段缺失或包含不支持的内容`);
  return object;
}

function totalKind(label: string): "gross" | "net" | null {
  const name = compact(label);
  if (/^(?:应发工资|应发合计|应发总额|应发)$/.test(name)) return "gross";
  if (/^(?:实发工资|实发合计|实发总额|实发)$/.test(name)) return "net";
  return null;
}

function isPrivateOrNonSalaryLabel(label: string): boolean {
  const name = compact(label);
  if (/^岗位基本薪水$/.test(name)) return false;
  return (
    /^(?:姓名|员工姓名|工号|员工编号|人员编号|身份证|证件号|银行卡|银行账号|开户行|手机号|手机号码|联系电话|邮箱|住址|地址|所属部门|部门|职务|职位|薪资发放公司|发放公司|所属公司|公司名称|出生日期|发放日期|发薪日期|账号|帐号|密码|凭据|令牌|token|cookie|authorization)/i.test(
      name,
    ) ||
    /^(?:岗位|公司|手机|电话|工资查询|工资详细|工资详情|工资明细|返回|关闭|智慧HR|展开|收起)$/i.test(
      name,
    )
  );
}

function validCapturedAt(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,7})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    year < 1 ||
    month < 1 || month > 12 ||
    day < 1 || day > monthDays[month - 1]! ||
    hour > 23 || minute > 59 || second > 59
  ) return false;
  const zone = match[7]!;
  if (zone !== "Z") {
    const zoneHour = Number(zone.slice(1, 3));
    const zoneMinute = Number(zone.slice(4, 6));
    if (zoneHour > 14 || zoneMinute > 59 || (zoneHour === 14 && zoneMinute !== 0))
      return false;
  }
  return Number.isFinite(Date.parse(value));
}

function validatedRecord(value: unknown): CaptureRecord {
  const record = objectWithKeys(value, ["payrollMonth", "fields"], "月份记录");
  if (
    typeof record.payrollMonth !== "string" ||
    !/^(?!0000)\d{4}-(?:0[1-9]|1[0-2])$/.test(record.payrollMonth)
  ) fail("工资月份必须是 YYYY-MM");
  if (!Array.isArray(record.fields) || record.fields.length < 3 || record.fields.length > maxFields)
    fail("每月须包含两项总额及工资明细，且不超过 256 行");
  const totalKinds = new Set<string>();
  const labels = new Set<string>();
  const fields = record.fields.map((value): CaptureField => {
    const field = objectWithKeys(value, ["label", "amountText"], "工资项目");
    if (
      typeof field.label !== "string" ||
      !compact(field.label) ||
      field.label.length > 100 ||
      controlCharacters.test(field.label)
    ) fail("项目名称为空、过长或包含不支持的字符");
    if (isPrivateOrNonSalaryLabel(field.label))
      fail("包含身份信息或非工资项目，请重新采集");
    if (
      typeof field.amountText !== "string" ||
      field.amountText.length > 64 ||
      controlCharacters.test(field.amountText) ||
      parseMoney(field.amountText) === null
    ) fail("金额缺失、格式错误或超出安全范围，请重新采集");
    const kind = totalKind(field.label);
    if (kind && totalKinds.has(kind)) fail("应发或实发总额重复");
    if (kind) totalKinds.add(kind);
    const key = compact(field.label);
    if (labels.has(key)) fail("工资项目重复，请重新采集");
    labels.add(key);
    return { label: field.label, amountText: field.amountText };
  });
  if (!totalKinds.has("gross") || !totalKinds.has("net"))
    fail("缺少应发或实发总额，请展开工资明细后重新采集");
  return { payrollMonth: record.payrollMonth, fields };
}

/** Validate a portable salary-only file before it reaches the local archive. */
export function parseCapturePackage(input: string): CapturePackage {
  if (
    typeof input !== "string" ||
    input.length > CAPTURE_MAX_BYTES ||
    new TextEncoder().encode(input).byteLength > CAPTURE_MAX_BYTES
  ) fail("文件超过 1 MiB 限制");
  let value: unknown;
  try {
    value = JSON.parse(input.replace(/^\uFEFF/, ""));
  } catch {
    fail("不是有效的 JSON 文件");
  }
  const data = objectWithKeys(value, ["format", "version", "source", "records"], "文件");
  if (data.format !== "salary-capture" || data.version !== 1)
    fail("文件类型或版本不支持");
  const source = objectWithKeys(data.source, ["kind", "page", "capturedAt"], "来源");
  if (source.kind !== "feishu-text" || source.page !== CAPTURE_PAGE)
    fail("来源类型或页面不支持");
  if (!validCapturedAt(source.capturedAt)) fail("采集时间无效或缺少时区");
  if (!Array.isArray(data.records) || !data.records.length || data.records.length > maxRecords)
    fail("须包含 1 至 120 个月份");
  const months = new Set<string>();
  const records = data.records.map((value) => {
    const record = validatedRecord(value);
    if (months.has(record.payrollMonth)) fail("同一月份存在重复记录");
    months.add(record.payrollMonth);
    return record;
  });
  return {
    format: "salary-capture",
    version: 1,
    source: { kind: "feishu-text", page: CAPTURE_PAGE, capturedAt: source.capturedAt },
    records,
  };
}

/** Text capture has no OCR boxes; source totals remain independent of accounting. */
export function draftFromCapture(input: CaptureRecord): SalaryDraft {
  const record = validatedRecord(input);
  const draft: SalaryDraft = {
    payrollMonth: record.payrollMonth,
    statedGrossMinor: null,
    statedNetMinor: null,
    lines: [],
    warnings: [],
    reviewStatus: "draft",
  };
  for (const field of record.fields) {
    const amountMinor = parseMoney(field.amountText)!;
    const kind = totalKind(field.label);
    if (kind === "gross") draft.statedGrossMinor = amountMinor;
    else if (kind === "net") draft.statedNetMinor = amountMinor;
    else {
      const effect = salaryEffectFor(field.label);
      const line: SalaryLine = {
        id: `capture-line-${draft.lines.length + 1}`,
        label: field.label,
        rawAmountText: field.amountText,
        amountMinor,
        effect,
        rowRole: /合计$/.test(compact(field.label)) ? "subtotal" : "detail",
        calculationMode: effect === "unknown" ? "unresolved" : "self",
        parentLineId: null,
        issues: effect === "unknown" ? ["此项目尚无核算规则"] : [],
        accountingSource: "automatic",
      };
      draft.lines.push(line);
    }
  }
  return normalizeSalaryDraft(draft);
}
