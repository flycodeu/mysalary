import { parseCapturePackage, type CapturePackage } from "./capture";

export interface LedgerState {
  deleted: boolean;
  clock: number;
  device: string;
  at: string;
}

export interface LedgerEntry {
  id: string;
  capture: CapturePackage;
  createdAt: string;
  state: LedgerState;
}

export interface Ledger {
  format: "salary-archive";
  version: 1;
  entries: LedgerEntry[];
}

export const LEDGER_MAX_BYTES = 8 * 1024 * 1024;
export const LEDGER_MAX_ENTRIES = 1200;

function fail(reason: string): never {
  throw new Error(`工资档案无效：${reason}`);
}

function objectWithKeys(value: unknown, keys: string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail("数据结构不完整");
  const object = value as Record<string, unknown>;
  const actual = Object.keys(object);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key)))
    fail("字段缺失或包含不支持的内容");
  return object;
}

function json(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    if (typeof text !== "string") fail("不是有效的 JSON 内容");
    return text;
  } catch {
    fail("不是有效的 JSON 内容");
  }
}

function enforceSize(text: string): void {
  if (text.length > LEDGER_MAX_BYTES || new TextEncoder().encode(text).byteLength > LEDGER_MAX_BYTES)
    fail("文件超过 8 MiB 限制");
}

function time(value: unknown): string {
  if (typeof value !== "string") fail("时间无效或缺少时区");
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,7})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) fail("时间无效或缺少时区");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]! ||
    Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59 ||
    !Number.isFinite(Date.parse(value))
  ) fail("时间无效或缺少时区");
  if (match[7] !== "Z") {
    const zone = match[7]!;
    const hours = Number(zone.slice(1, 3));
    const minutes = Number(zone.slice(4, 6));
    if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0))
      fail("时间无效或缺少时区");
  }
  return value;
}

function deviceId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,80}$/.test(value))
    fail("设备标识无效");
  return value;
}

function singleCapture(value: unknown): CapturePackage {
  const capture = parseCapturePackage(json(value));
  if (capture.records.length !== 1) fail("每份来源必须只包含一个月份");
  return capture;
}

// Capture timestamps describe observations, not salary identity. Field order and
// raw amount text are source evidence and remain part of the immutable content.
function sourceIdentity(capture: CapturePackage): string {
  const record = capture.records[0]!;
  return JSON.stringify({
    source: { kind: capture.source.kind, page: capture.source.page },
    record: {
      payrollMonth: record.payrollMonth,
      fields: record.fields.map((field) => ({ label: field.label, amountText: field.amountText })),
    },
  });
}

async function sourceHash(capture: CapturePackage): Promise<string> {
  if (!globalThis.crypto?.subtle) fail("当前环境不支持来源校验");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sourceIdentity(capture)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validatedEntry(value: unknown): LedgerEntry {
  const entry = objectWithKeys(value, ["id", "capture", "createdAt", "state"]);
  if (typeof entry.id !== "string" || !/^[a-f0-9]{64}$/.test(entry.id)) fail("来源编号无效");
  const state = objectWithKeys(entry.state, ["deleted", "clock", "device", "at"]);
  if (typeof state.deleted !== "boolean") fail("删除状态无效");
  if (typeof state.clock !== "number" || !Number.isSafeInteger(state.clock) || state.clock < 0)
    fail("操作序号无效");
  return {
    id: entry.id,
    capture: singleCapture(entry.capture),
    createdAt: time(entry.createdAt),
    state: { deleted: state.deleted, clock: state.clock, device: deviceId(state.device), at: time(state.at) },
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareTime(left: string, right: string): number {
  return Date.parse(left) - Date.parse(right) || compareText(left, right);
}

function validatedLedger(value: unknown): Ledger {
  const ledger = objectWithKeys(value, ["format", "version", "entries"]);
  if (ledger.format !== "salary-archive" || ledger.version !== 1) fail("文件类型或版本不支持");
  if (!Array.isArray(ledger.entries) || ledger.entries.length > LEDGER_MAX_ENTRIES)
    fail("档案不得超过 1200 条");
  const ids = new Set<string>();
  const entries = ledger.entries.map((value) => {
    const entry = validatedEntry(value);
    if (ids.has(entry.id)) fail("同一来源存在重复条目");
    ids.add(entry.id);
    return entry;
  });
  const result: Ledger = { format: "salary-archive", version: 1, entries: entries.sort((a, b) => compareText(a.id, b.id)) };
  enforceSize(json(result));
  return result;
}

export function emptyLedger(): Ledger {
  return { format: "salary-archive", version: 1, entries: [] };
}

/** New observations start at zero so replaying a capture cannot undo a deletion. */
export async function createEntry(
  input: CapturePackage,
  device: string,
  createdAt = new Date().toISOString(),
): Promise<LedgerEntry> {
  const capture = singleCapture(input);
  const validDevice = deviceId(device);
  const created = time(createdAt);
  return {
    id: await sourceHash(capture),
    capture,
    createdAt: created,
    state: { deleted: false, clock: 0, device: validDevice, at: created },
  };
}

export async function captureToEntries(
  input: CapturePackage,
  device: string,
  createdAt = new Date().toISOString(),
): Promise<LedgerEntry[]> {
  const capture = parseCapturePackage(json(input));
  deviceId(device);
  time(createdAt);
  return Promise.all(capture.records.map((record) =>
    createEntry({ ...capture, records: [record] }, device, createdAt),
  ));
}

/** Every externally supplied ledger must pass this asynchronous integrity check. */
export async function parseLedger(input: string): Promise<Ledger> {
  if (typeof input !== "string") fail("不是有效的 JSON 内容");
  enforceSize(input);
  let value: unknown;
  try { value = JSON.parse(input.replace(/^\uFEFF/, "")); }
  catch { fail("不是有效的 JSON 内容"); }
  const ledger = validatedLedger(value);
  const hashes = await Promise.all(ledger.entries.map((entry) => sourceHash(entry.capture)));
  if (ledger.entries.some((entry, index) => entry.id !== hashes[index]))
    fail("来源内容与编号不一致，请使用完整的档案文件");
  return ledger;
}

function compareState(left: LedgerState, right: LedgerState): number {
  if (left.clock !== right.clock) return left.clock < right.clock ? -1 : 1;
  if (left.deleted !== right.deleted) return left.deleted ? 1 : -1;
  return compareText(left.device, right.device) || compareTime(left.at, right.at);
}

/** Pure union of validated ledgers. A total order on state makes retries and
 * delivery order irrelevant; immutable source conflicts fail without data loss. */
export function mergeLedgers(left: Ledger, right: Ledger): Ledger {
  const entries = new Map<string, LedgerEntry>();
  for (const entry of [...validatedLedger(left).entries, ...validatedLedger(right).entries]) {
    const existing = entries.get(entry.id);
    if (!existing) {
      entries.set(entry.id, entry);
      continue;
    }
    if (sourceIdentity(existing.capture) !== sourceIdentity(entry.capture))
      fail("同一来源编号的工资内容发生冲突，原档案未覆盖");
    entries.set(entry.id, {
      id: entry.id,
      capture: compareTime(existing.capture.source.capturedAt, entry.capture.source.capturedAt) <= 0
        ? existing.capture : entry.capture,
      createdAt: compareTime(existing.createdAt, entry.createdAt) <= 0 ? existing.createdAt : entry.createdAt,
      state: compareState(existing.state, entry.state) >= 0 ? existing.state : entry.state,
    });
  }
  return validatedLedger({ format: "salary-archive", version: 1, entries: [...entries.values()] });
}

/** Explicit user changes advance beyond every operation already observed locally. */
export function updateEntryState(
  ledger: Ledger,
  id: string,
  deleted: boolean,
  device: string,
  at = new Date().toISOString(),
): Ledger {
  const result = validatedLedger(ledger);
  const entry = result.entries.find((value) => value.id === id);
  if (!entry) fail("找不到要修改的工资档案");
  if (typeof deleted !== "boolean") fail("删除状态无效");
  const clock = Math.max(0, ...result.entries.map((value) => value.state.clock));
  if (clock === Number.MAX_SAFE_INTEGER) fail("操作序号已达到安全上限，无法继续修改");
  entry.state = { deleted, clock: clock + 1, device: deviceId(device), at: time(at) };
  enforceSize(json(result));
  return result;
}

/** Stable JSON gives identical changes the same content hash; it does not replace parseLedger. */
export function serializeLedger(ledger: Ledger): string {
  return json(validatedLedger(ledger));
}
