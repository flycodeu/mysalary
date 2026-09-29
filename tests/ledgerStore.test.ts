import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAPTURE_PAGE, type CapturePackage } from "../src/domain/capture";
import { captureToEntries, emptyLedger, mergeLedgers, parseLedger, serializeLedger, updateEntryState, type Ledger } from "../src/domain/ledger";

const mocks = vi.hoisted(() => ({ hostCall: vi.fn(), indexedDbOpen: vi.fn() }));
vi.mock("../src/platform/host", () => ({ hostCall: mocks.hostCall, isNative: true }));

let store: typeof import("../src/platform/ledgerStore");
let persisted: string | null;
let original: Ledger;
const at = "2026-09-29T01:00:00.000Z";

async function months(...months: string[]): Promise<Ledger> {
  const capture: CapturePackage = {
    format: "salary-capture", version: 1,
    source: { kind: "feishu-text", page: CAPTURE_PAGE, capturedAt: at },
    records: months.map((payrollMonth) => ({ payrollMonth, fields: [
      { label: "应发工资", amountText: "1000.00" },
      { label: "实发工资", amountText: "900.00" },
      { label: "基本工资", amountText: "1000.00" },
      { label: "个税", amountText: "100.00" },
    ] })),
  };
  return { ...emptyLedger(), entries: await captureToEntries(capture, "device-test", at) };
}

function calls(): string[] {
  return mocks.hostCall.mock.calls.map(([method]) => method);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  original = await months("2026-09", "2026-08");
  original = await parseLedger(serializeLedger(original));
  persisted = serializeLedger(original);
  mocks.indexedDbOpen.mockImplementation(() => { throw new Error("native storage must not fall back to the browser"); });
  vi.stubGlobal("indexedDB", { open: mocks.indexedDbOpen });
  // This string represents the native file, outside the frontend module lifetime.
  mocks.hostCall.mockImplementation(async (method: string, args?: { content: string }) => {
    if (method === "loadLedger") return { content: persisted };
    if (method === "saveLedger") { persisted = args!.content; return {}; }
    throw new Error(`Unexpected host method: ${method}`);
  });
  store = await import("../src/platform/ledgerStore");
});

afterEach(() => {
  expect(mocks.indexedDbOpen).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("native ledger reads", () => {
  it("loads the complete saved ledger without rewriting it", async () => {
    const before = persisted;
    await expect(store.readLedger()).resolves.toEqual(original);
    expect(calls()).toEqual(["loadLedger"]);
    expect(persisted).toBe(before);
  });

  it("accepts an explicit null as a missing ledger and does not create a file on read", async () => {
    persisted = null;
    await expect(store.readLedger()).resolves.toEqual(emptyLedger());
    expect(calls()).toEqual(["loadLedger"]);
    expect(persisted).toBeNull();
  });

  it("accepts a valid stored empty ledger without rewriting it", async () => {
    persisted = serializeLedger(emptyLedger());
    await expect(store.readLedger()).resolves.toEqual(emptyLedger());
    expect(calls()).toEqual(["loadLedger"]);
  });

  it.each([
    undefined, null, {}, { content: undefined }, { content: 0 },
    { content: false }, { content: {} }, { content: [] },
  ])("reports an invalid native response instead of returning an empty ledger (%j)", async (response) => {
    const before = persisted;
    mocks.hostCall.mockResolvedValueOnce(response);
    const operation = vi.fn((current: Ledger) => current);
    await expect(store.updateLedger(operation)).rejects.toBeInstanceOf(store.LedgerReadError);
    expect(operation).not.toHaveBeenCalled();
    expect(calls()).toEqual(["loadLedger"]);
    expect(persisted).toBe(before);
  });

  it.each(["", "{invalid", '{"format":"salary-archive","version":1}'])(
    "reports damaged native data without modifying the file (%s)", async (content) => {
      persisted = content;
      const operation = vi.fn((current: Ledger) => current);
      await expect(store.updateLedger(operation)).rejects.toBeInstanceOf(store.LedgerReadError);
      expect(operation).not.toHaveBeenCalled();
      expect(calls()).toEqual(["loadLedger"]);
      expect(persisted).toBe(content);
    },
  );

  it("does not hide a salary source integrity failure as an empty ledger", async () => {
    const corrupt = structuredClone(original);
    corrupt.entries[0]!.capture.records[0]!.fields[0]!.amountText = "2000.00";
    persisted = JSON.stringify(corrupt);
    const before = persisted;
    await expect(store.readLedger()).rejects.toBeInstanceOf(store.LedgerReadError);
    expect(persisted).toBe(before);
    expect(calls()).toEqual(["loadLedger"]);
  });

  it("rejects native read failures and retries the native file on a later read", async () => {
    const before = persisted;
    mocks.hostCall.mockRejectedValueOnce(new Error("native bridge unavailable"));
    const operation = vi.fn((current: Ledger) => current);
    await expect(store.updateLedger(operation)).rejects.toBeInstanceOf(store.LedgerReadError);
    expect(operation).not.toHaveBeenCalled();
    expect(persisted).toBe(before);
    await expect(store.readLedger()).resolves.toEqual(original);
    expect(calls()).toEqual(["loadLedger", "loadLedger"]);
  });

  it("reads the native file again instead of retaining an old in-memory snapshot", async () => {
    await expect(store.readLedger()).resolves.toEqual(original);
    const changed = updateEntryState(original, original.entries[0]!.id, true, "device-other", at);
    persisted = serializeLedger(changed);
    await expect(store.readLedger()).resolves.toEqual(changed);
    expect(calls()).toEqual(["loadLedger", "loadLedger"]);
  });
});

describe("native ledger writes and startup persistence", () => {
  it("saves all entries and reads the same complete ledger after the module reloads", async () => {
    const extra = await months("2026-07");
    const expected = updateEntryState(mergeLedgers(original, extra), original.entries[0]!.id, true, "device-test", at);
    await expect(store.updateLedger((current) => updateEntryState(mergeLedgers(current, extra), original.entries[0]!.id, true, "device-test", at)))
      .resolves.toEqual(expected);
    expect(await parseLedger(persisted!)).toEqual(expected);
    vi.resetModules();
    const reopened = await import("../src/platform/ledgerStore");
    await expect(reopened.readLedger()).resolves.toEqual(expected);
    expect(calls()).toEqual(["loadLedger", "saveLedger", "loadLedger"]);
  });

  it("does not rewrite the file when the same captured entries are merged again", async () => {
    const before = persisted;
    await expect(store.updateLedger((current) => mergeLedgers(current, original))).resolves.toEqual(original);
    expect(calls()).toEqual(["loadLedger"]);
    expect(persisted).toBe(before);
  });

  it("returns native save failure to the caller and keeps the previous saved file", async () => {
    const extra = await months("2026-07");
    const before = persisted;
    const failure = new Error("native disk write failed");
    mocks.hostCall.mockResolvedValueOnce({ content: persisted }).mockRejectedValueOnce(failure);
    await expect(store.updateLedger((current) => mergeLedgers(current, extra))).rejects.toBe(failure);
    expect(persisted).toBe(before);
    await expect(store.readLedger()).resolves.toEqual(original);
    const expected = mergeLedgers(original, extra);
    await expect(store.updateLedger((current) => mergeLedgers(current, extra))).resolves.toEqual(expected);
    expect(await parseLedger(persisted!)).toEqual(expected);
    expect(calls()).toEqual(["loadLedger", "saveLedger", "loadLedger", "loadLedger", "saveLedger"]);
  });

  it("does not save or poison the queue when the requested operation fails", async () => {
    const before = persisted;
    const failure = new Error("requested operation failed");
    await expect(store.updateLedger(() => { throw failure; })).rejects.toBe(failure);
    await expect(store.readLedger()).resolves.toEqual(original);
    expect(calls()).toEqual(["loadLedger", "loadLedger"]);
    expect(persisted).toBe(before);
  });

  it("does not resolve a successful update until native persistence finishes", async () => {
    const extra = await months("2026-07");
    const started = deferred<void>();
    const finish = deferred<void>();
    const before = persisted;
    mocks.hostCall.mockImplementation(async (method: string, args?: { content: string }) => {
      if (method === "loadLedger") return { content: persisted };
      expect(method).toBe("saveLedger");
      started.resolve();
      await finish.promise;
      persisted = args!.content;
      return {};
    });
    let resolved = false;
    const updating = store.updateLedger((current) => mergeLedgers(current, extra)).then((value) => { resolved = true; return value; });
    await started.promise;
    expect(resolved).toBe(false);
    expect(persisted).toBe(before);
    finish.resolve();
    await expect(updating).resolves.toEqual(mergeLedgers(original, extra));
    expect(await parseLedger(persisted!)).toEqual(mergeLedgers(original, extra));
  });

  it("serializes concurrent changes so the second update sees the first saved result", async () => {
    const extra = await months("2026-07");
    const entered = deferred<void>();
    const resume = deferred<void>();
    const first = store.updateLedger(async (current) => {
      entered.resolve();
      await resume.promise;
      return mergeLedgers(current, extra);
    });
    await entered.promise;
    const second = store.updateLedger((current) => updateEntryState(current, original.entries[0]!.id, true, "device-test", at));
    expect(calls()).toEqual(["loadLedger"]);
    resume.resolve();
    const expected = updateEntryState(mergeLedgers(original, extra), original.entries[0]!.id, true, "device-test", at);
    await expect(first).resolves.toEqual(mergeLedgers(original, extra));
    await expect(second).resolves.toEqual(expected);
    expect(await parseLedger(persisted!)).toEqual(expected);
    expect(calls()).toEqual(["loadLedger", "saveLedger", "loadLedger", "saveLedger"]);
  });

  it("waits for an in-flight save before serving a queued read", async () => {
    const extra = await months("2026-07");
    const started = deferred<void>();
    const finish = deferred<void>();
    mocks.hostCall.mockImplementation(async (method: string, args?: { content: string }) => {
      if (method === "loadLedger") return { content: persisted };
      expect(method).toBe("saveLedger");
      started.resolve();
      await finish.promise;
      persisted = args!.content;
      return {};
    });
    const first = store.updateLedger((current) => mergeLedgers(current, extra));
    await started.promise;
    const queuedRead = store.readLedger();
    expect(calls()).toEqual(["loadLedger", "saveLedger"]);
    finish.resolve();
    await first;
    await expect(queuedRead).resolves.toEqual(mergeLedgers(original, extra));
    expect(calls()).toEqual(["loadLedger", "saveLedger", "loadLedger"]);
  });

  it("continues a queued change from the saved file after an earlier save rejects", async () => {
    const extra = await months("2026-07");
    const failedSave = deferred<void>();
    const started = deferred<void>();
    let writes = 0;
    const failure = new Error("first save failed");
    mocks.hostCall.mockImplementation(async (method: string, args?: { content: string }) => {
      if (method === "loadLedger") return { content: persisted };
      expect(method).toBe("saveLedger");
      if (writes++ === 0) { started.resolve(); await failedSave.promise; }
      persisted = args!.content;
      return {};
    });
    const first = store.updateLedger((current) => mergeLedgers(current, extra));
    const firstRejected = expect(first).rejects.toBe(failure);
    await started.promise;
    const second = store.updateLedger((current) => updateEntryState(current, original.entries[0]!.id, true, "device-test", at));
    failedSave.reject(failure);
    await firstRejected;
    const expected = updateEntryState(original, original.entries[0]!.id, true, "device-test", at);
    await expect(second).resolves.toEqual(expected);
    expect(await parseLedger(persisted!)).toEqual(expected);
    expect(calls()).toEqual(["loadLedger", "saveLedger", "loadLedger", "saveLedger"]);
  });
});
