import { describe, expect, it } from "vitest";
import { CAPTURE_PAGE, type CapturePackage } from "../src/domain/capture";
import {
  LEDGER_MAX_BYTES,
  captureToEntries,
  createEntry,
  emptyLedger,
  mergeLedgers,
  parseLedger,
  serializeLedger,
  updateEntryState,
  type Ledger,
  type LedgerEntry,
} from "../src/domain/ledger";

const firstTime = "2026-09-01T08:00:00.000Z";
const laterTime = "2026-09-03T08:00:00.000Z";

function capture(month = "2026-09", amountText = "1000.00"): CapturePackage {
  return {
    format: "salary-capture",
    version: 1,
    source: { kind: "feishu-text", page: CAPTURE_PAGE, capturedAt: firstTime },
    records: [{
      payrollMonth: month,
      fields: [
        { label: "应发工资", amountText },
        { label: "实发工资", amountText: "900.00" },
        { label: "基本工资", amountText },
        { label: "个税", amountText: "100.00" },
      ],
    }],
  };
}

function ledger(...entries: LedgerEntry[]): Ledger {
  return { format: "salary-archive", version: 1, entries };
}

async function initial(month = "2026-09"): Promise<Ledger> {
  return ledger(await createEntry(capture(month), "device-a", firstTime));
}

describe("immutable salary ledger identity", () => {
  it("round-trips an empty ledger and a validated entry", async () => {
    expect(await parseLedger(serializeLedger(emptyLedger()))).toEqual(emptyLedger());
    const input = await initial();
    expect(input.entries[0]!.id).toMatch(/^[a-f0-9]{64}$/);
    expect(await parseLedger(`\uFEFF${serializeLedger(input)}`)).toEqual(input);
  });

  it("deduplicates capture timestamps and device metadata while retaining earliest observation", async () => {
    const original = await initial();
    const repeatedCapture = capture();
    repeatedCapture.source.capturedAt = laterTime;
    const repeated = ledger(await createEntry(repeatedCapture, "device-b", laterTime));
    expect(original.entries[0]!.id).toBe(repeated.entries[0]!.id);
    const merged = mergeLedgers(original, repeated);
    expect(merged.entries).toHaveLength(1);
    expect(merged.entries[0]!.capture.source.capturedAt).toBe(firstTime);
    expect(merged.entries[0]!.createdAt).toBe(firstTime);
    expect(mergeLedgers(repeated, original)).toEqual(merged);
  });

  it("canonicalizes JSON object property order before calculating identity", async () => {
    const original = capture();
    const reordered = JSON.parse(JSON.stringify({
      records: original.records.map((record) => ({
        fields: record.fields.map((field) => ({ amountText: field.amountText, label: field.label })),
        payrollMonth: record.payrollMonth,
      })),
      source: { capturedAt: firstTime, page: CAPTURE_PAGE, kind: "feishu-text" },
      version: 1,
      format: "salary-capture",
    })) as CapturePackage;
    expect((await createEntry(original, "device-a", firstTime)).id)
      .toBe((await createEntry(reordered, "device-b", laterTime)).id);
  });

  it("preserves different salary content for the same month and different months", async () => {
    const entries = await Promise.all([
      createEntry(capture(), "device-a", firstTime),
      createEntry(capture("2026-09", "1100.00"), "device-a", firstTime),
      createEntry(capture("2026-08"), "device-a", firstTime),
    ]);
    const merged = mergeLedgers(ledger(entries[0]!), ledger(...entries.slice(1)));
    expect(new Set(merged.entries.map((entry) => entry.id)).size).toBe(3);
    expect(merged.entries.filter((entry) => entry.capture.records[0]!.payrollMonth === "2026-09"))
      .toHaveLength(2);
    expect(await parseLedger(serializeLedger(merged))).toEqual(merged);
  });

  it("splits an old multi-month capture package without invented OCR or extra metadata", async () => {
    const input = capture();
    input.records.push(capture("2026-08").records[0]!);
    const before = JSON.stringify(input);
    const entries = await captureToEntries(input, "device-a", firstTime);
    expect(entries).toHaveLength(2);
    expect(entries.every((entry) => entry.capture.records.length === 1)).toBe(true);
    expect(entries.every((entry) => entry.state.clock === 0 && !entry.state.deleted)).toBe(true);
    expect(entries[0]!.capture.records[0]).toEqual(input.records[0]);
    expect(JSON.stringify(input)).toBe(before);
    await expect(createEntry(input, "device-a", firstTime)).rejects.toThrow("一个月份");
  });
});

describe("deterministic salary ledger merge", () => {
  it("is commutative, associative and idempotent across changes on three devices", async () => {
    const base = await initial();
    const id = base.entries[0]!.id;
    const a = updateEntryState(base, id, true, "device-a", laterTime);
    const b = updateEntryState(base, id, false, "device-b", firstTime);
    const c = mergeLedgers(
      ledger(await createEntry(capture("2026-08"), "device-c", laterTime)),
      updateEntryState(a, id, false, "device-c", firstTime),
    );
    const variants = [base, a, b, c, emptyLedger()];
    for (const left of variants) {
      expect(mergeLedgers(left, left)).toEqual(left);
      for (const right of variants) {
        expect(mergeLedgers(left, right)).toEqual(mergeLedgers(right, left));
        for (const third of variants) {
          expect(mergeLedgers(mergeLedgers(left, right), third))
            .toEqual(mergeLedgers(left, mergeLedgers(right, third)));
        }
      }
    }
  });

  it("does not resurrect a deleted entry through old state or new observation replay", async () => {
    const base = await initial();
    const id = base.entries[0]!.id;
    const deleted = updateEntryState(base, id, true, "device-a", firstTime);
    const recapture = capture();
    recapture.source.capturedAt = laterTime;
    const replay = ledger(await createEntry(recapture, "device-z", laterTime));
    const merged = mergeLedgers(mergeLedgers(deleted, base), replay);
    expect(merged.entries).toHaveLength(1);
    expect(merged.entries[0]!.state).toEqual(deleted.entries[0]!.state);
  });

  it("keeps concurrent deletion over restoration at the same Lamport clock", async () => {
    const base = await initial();
    const id = base.entries[0]!.id;
    const deletion = updateEntryState(base, id, true, "device-a", firstTime);
    const concurrentRestoration = updateEntryState(base, id, false, "device-z", laterTime);
    expect(mergeLedgers(deletion, concurrentRestoration).entries[0]!.state.deleted).toBe(true);
    const observedThenRestored = updateEntryState(mergeLedgers(deletion, concurrentRestoration), id, false, "device-b", firstTime);
    expect(observedThenRestored.entries[0]!.state.clock).toBe(2);
    expect(mergeLedgers(observedThenRestored, deletion).entries[0]!.state.deleted).toBe(false);
  });

  it("uses clocks before wall time and advances beyond operations on all entries", async () => {
    const first = await initial();
    const other = await initial("2026-08");
    other.entries[0]!.state.clock = 40;
    other.entries[0]!.state.at = "2099-01-01T00:00:00Z";
    const both = mergeLedgers(first, other);
    const changed = updateEntryState(both, first.entries[0]!.id, true, "device-a", "2001-01-01T00:00:00Z");
    expect(changed.entries.find((entry) => entry.id === first.entries[0]!.id)!.state.clock).toBe(41);
    expect(mergeLedgers(first, changed).entries.find((entry) => entry.id === first.entries[0]!.id)!.state.deleted)
      .toBe(true);
  });

  it("breaks identical clocks and deletion states deterministically by device then time", async () => {
    const a = await initial();
    const b = structuredClone(a);
    b.entries[0]!.state.device = "device-z";
    b.entries[0]!.state.at = "2001-01-01T00:00:00Z";
    expect(mergeLedgers(a, b).entries[0]!.state.device).toBe("device-z");
    const c = structuredClone(b);
    c.entries[0]!.state.at = laterTime;
    expect(mergeLedgers(b, c).entries[0]!.state.at).toBe(laterTime);
    expect(mergeLedgers(b, c)).toEqual(mergeLedgers(c, b));
  });

  it("is stable for equivalent timezone representations and unordered entries", async () => {
    const a = await initial();
    const b = structuredClone(a);
    b.entries[0]!.createdAt = "2026-09-01T16:00:00.000+08:00";
    b.entries[0]!.capture.source.capturedAt = "2026-09-01T16:00:00.0000000+08:00";
    b.entries[0]!.state.at = "2026-09-01T16:00:00.000+08:00";
    const c = await initial("2026-08");
    expect(mergeLedgers(a, b)).toEqual(mergeLedgers(b, a));
    const combined = mergeLedgers(mergeLedgers(a, b), c);
    const reversed = ledger(...structuredClone(combined.entries).reverse());
    expect(serializeLedger(combined)).toBe(serializeLedger(reversed));
    expect(await parseLedger(serializeLedger(reversed))).toEqual(combined);
  });

  it("never mutates or aliases caller-owned entries when merging or changing state", async () => {
    const a = await initial();
    const before = JSON.stringify(a);
    const merged = mergeLedgers(a, emptyLedger());
    merged.entries[0]!.capture.records[0]!.fields[0]!.amountText = "42";
    const changed = updateEntryState(a, a.entries[0]!.id, true, "device-b", laterTime);
    changed.entries[0]!.state.deleted = false;
    expect(JSON.stringify(a)).toBe(before);
  });

  it("rejects the same ID with conflicting immutable content without overwriting either side", async () => {
    const a = await initial();
    const b = structuredClone(a);
    b.entries[0]!.capture.records[0]!.fields[2]!.amountText = "1100.00";
    const before = JSON.stringify([a, b]);
    expect(() => mergeLedgers(a, b)).toThrow("工资内容发生冲突");
    expect(JSON.stringify([a, b])).toBe(before);
  });
});

describe("salary ledger input safety", () => {
  it("recalculates the source hash and rejects salary content corruption", async () => {
    const a = await initial();
    a.entries[0]!.capture.records[0]!.fields[0]!.amountText = "1100.00";
    await expect(parseLedger(JSON.stringify(a))).rejects.toThrow("来源内容与编号不一致");
    const b = await initial();
    b.entries[0]!.id = "0".repeat(64);
    await expect(parseLedger(JSON.stringify(b))).rejects.toThrow("来源内容与编号不一致");
  });

  it("rejects duplicate source IDs even when entries appear identical", async () => {
    const a = await initial();
    a.entries.push(structuredClone(a.entries[0]!));
    await expect(parseLedger(JSON.stringify(a))).rejects.toThrow("重复条目");
  });

  it("rejects unsupported or unknown properties at every contract level", async () => {
    const mutate: Array<(input: Ledger) => void> = [
      (input) => Object.assign(input, { version: 2 }),
      (input) => Object.assign(input, { format: "other" }),
      (input) => Object.assign(input, { credentials: "secret" }),
      (input) => Object.assign(input.entries[0]!, { employeeId: "secret" }),
      (input) => Object.assign(input.entries[0]!.state, { token: "secret" }),
      (input) => Object.assign(input.entries[0]!.capture.source, { token: "secret" }),
    ];
    const base = await initial();
    for (const change of mutate) {
      const input = structuredClone(base);
      change(input);
      await expect(parseLedger(JSON.stringify(input))).rejects.toThrow();
    }
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, null, "1"])(
    "rejects invalid Lamport clocks %s",
    async (clock) => {
      const input = await initial();
      Object.assign(input.entries[0]!.state, { clock });
      await expect(parseLedger(JSON.stringify(input))).rejects.toThrow("操作序号");
    },
  );

  it("rejects exhausted clocks instead of wrapping or rounding on update", async () => {
    const input = await initial();
    input.entries[0]!.state.clock = Number.MAX_SAFE_INTEGER;
    expect(() => updateEntryState(input, input.entries[0]!.id, true, "device-a", firstTime)).toThrow("安全上限");
  });

  it.each(["", "spaces not allowed", "x\n", "设备", "x".repeat(81)])(
    "rejects invalid device IDs",
    async (device) => {
      await expect(createEntry(capture(), device, firstTime)).rejects.toThrow("设备标识");
      const input = await initial();
      input.entries[0]!.state.device = device;
      await expect(parseLedger(JSON.stringify(input))).rejects.toThrow("设备标识");
    },
  );

  it.each([
    "2026-09-28T12:00:00", "2026-02-29T12:00:00Z", "2026-04-31T12:00:00Z",
    "2026-09-28T24:00:00Z", "2026-09-28T12:00:00+14:01", "2026-09-28T12:00:00+08:60", "not-a-date",
  ])("rejects invalid creation and operation times", async (invalidTime) => {
    await expect(createEntry(capture(), "device-a", invalidTime)).rejects.toThrow("时间");
    const input = await initial();
    input.entries[0]!.state.at = invalidTime;
    await expect(parseLedger(JSON.stringify(input))).rejects.toThrow("时间");
  });

  it("rejects metadata, missing amounts and multi-month source snapshots", async () => {
    const base = await initial();
    for (const field of [{ label: "身份证号", amountText: "123456" }, { label: "特别工资", amountText: "" }]) {
      const input = structuredClone(base);
      input.entries[0]!.capture.records[0]!.fields.push(field);
      await expect(parseLedger(JSON.stringify(input))).rejects.toThrow();
    }
    const input = structuredClone(base);
    input.entries[0]!.capture.records.push(capture("2026-08").records[0]!);
    await expect(parseLedger(JSON.stringify(input))).rejects.toThrow("一个月份");
  });

  it("checks UTF-8 byte size and entry count before accepting remote contents", async () => {
    const text = JSON.stringify(emptyLedger());
    await expect(parseLedger(text.padEnd(LEDGER_MAX_BYTES + 1))).rejects.toThrow("8 MiB");
    const multibyte = `{"padding":"${"薪".repeat(Math.floor(LEDGER_MAX_BYTES / 2))}"}`;
    expect(multibyte.length).toBeLessThan(LEDGER_MAX_BYTES);
    await expect(parseLedger(multibyte)).rejects.toThrow("8 MiB");
    const input = await initial();
    input.entries = Array.from({ length: 1201 }, () => input.entries[0]!);
    await expect(parseLedger(JSON.stringify(input))).rejects.toThrow("1200");
    for (const invalid of ["{", "null", "[]", "123", '{"__proto__":{}}'])
      await expect(parseLedger(invalid)).rejects.toThrow();
  });

  it("rejects missing entries and non-boolean deletion state", async () => {
    const input = await initial();
    expect(() => updateEntryState(input, "missing", true, "device-a", firstTime)).toThrow("找不到");
    Object.assign(input.entries[0]!.state, { deleted: "false" });
    await expect(parseLedger(JSON.stringify(input))).rejects.toThrow("删除状态");
  });
});
