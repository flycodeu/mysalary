import { beforeEach, describe, expect, it, vi } from "vitest";
import { CAPTURE_PAGE, type CapturePackage } from "../src/domain/capture";
import { captureToEntries, emptyLedger, updateEntryState, type Ledger } from "../src/domain/ledger";

const mocks = vi.hoisted(() => ({ hostCall: vi.fn(), updateLedger: vi.fn(), readLedger: vi.fn() }));
vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => "android", convertFileSrc: (path: string) => path },
  registerPlugin: () => ({}),
}));
vi.mock("../src/platform/host", () => ({ hostCall: mocks.hostCall, isWindows: false, isNative: true }));
vi.mock("../src/platform/ledgerStore", () => ({
  updateLedger: mocks.updateLedger,
  readLedger: mocks.readLedger,
  deviceId: () => "device-android-test",
}));
import { captureFeishu, importDataText, processPendingFiles } from "../src/platform/archive";

let stored: Ledger;
const at = "2026-09-28T10:00:00.000Z";

function capture(month = "2026-09"): CapturePackage {
  return {
    format: "salary-capture", version: 1,
    source: { kind: "feishu-text", page: CAPTURE_PAGE, capturedAt: at },
    records: [{ payrollMonth: month, fields: [
      { label: "应发工资", amountText: "1500.00" },
      { label: "实发工资", amountText: "1400.00" },
      { label: "基本工资", amountText: "1500.00" },
      { label: "个税", amountText: "100.00" },
    ] }],
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  stored = emptyLedger();
  mocks.updateLedger.mockImplementation(async (operation: (ledger: Ledger) => Ledger | Promise<Ledger>) => {
    const next = await operation(structuredClone(stored));
    stored = next;
    return structuredClone(stored);
  });
  mocks.readLedger.mockImplementation(async () => structuredClone(stored));
});

async function deletedLedger(): Promise<Ledger> {
  const entries = await captureToEntries(capture(), "device-android-test", at);
  return updateEntryState({ ...emptyLedger(), entries }, entries[0]!.id, true, "device-android-test", at);
}

describe("Android pending salary files", () => {
  it("keeps a malformed file pending and still saves and acknowledges the following valid file", async () => {
    const events: string[] = [];
    mocks.hostCall.mockImplementation(async (method: string, args?: { pendingId: string }) => {
      if (method === "listPendingDataFiles") return { files: [
        { pendingId: "bad-file", content: "{invalid-json" },
        { pendingId: "good-file", content: JSON.stringify(capture()) },
      ] };
      expect(method).toBe("ackDataFile");
      expect(args?.pendingId).toBe("good-file");
      // An acknowledgement may remove the inbox source, so the ledger must be durable first.
      expect(stored.entries).toHaveLength(1);
      expect(stored.entries[0]!.capture.records[0]!.payrollMonth).toBe("2026-09");
      events.push("ack-good");
      return {};
    });
    mocks.updateLedger.mockImplementation(async (operation: (ledger: Ledger) => Ledger | Promise<Ledger>) => {
      stored = await operation(structuredClone(stored));
      events.push("saved-good");
      return structuredClone(stored);
    });
    await expect(processPendingFiles()).rejects.toThrow("有 1 个导入文件未能合并，原文件已保留，请重新导出后导入");
    expect(events).toEqual(["saved-good", "ack-good"]);
    expect(mocks.updateLedger).toHaveBeenCalledTimes(1);
    expect(mocks.hostCall.mock.calls.filter(([method]) => method === "ackDataFile"))
      .toEqual([["ackDataFile", { pendingId: "good-file" }]]);
  });

  it("never acknowledges an unpersisted file and continues with later valid files", async () => {
    mocks.hostCall.mockResolvedValueOnce({ files: [
      { pendingId: "save-fails", content: JSON.stringify(capture()) },
      { pendingId: "save-succeeds", content: JSON.stringify(capture("2026-08")) },
    ] }).mockResolvedValue({});
    mocks.updateLedger.mockImplementationOnce(async (operation: (ledger: Ledger) => Ledger | Promise<Ledger>) => {
      await operation(structuredClone(stored));
      throw new Error("storage unavailable");
    });
    await expect(processPendingFiles()).rejects.toThrow("有 1 个导入文件未能合并");
    expect(stored.entries).toHaveLength(1);
    expect(stored.entries[0]!.capture.records[0]!.payrollMonth).toBe("2026-08");
    expect(mocks.hostCall.mock.calls.filter(([method]) => method === "ackDataFile"))
      .toEqual([["ackDataFile", { pendingId: "save-succeeds" }]]);
  });

  it("propagates failure to list the inbox without pretending it was empty", async () => {
    const failure = new Error("inbox unavailable");
    mocks.hostCall.mockRejectedValueOnce(failure);
    await expect(processPendingFiles()).rejects.toBe(failure);
    expect(mocks.hostCall).toHaveBeenCalledExactlyOnceWith("listPendingDataFiles");
    expect(mocks.updateLedger).not.toHaveBeenCalled();
    expect(stored).toEqual(emptyLedger());
  });

  it("retains saved records when acknowledgement fails and continues processing", async () => {
    mocks.hostCall.mockImplementation(async (method: string, args?: { pendingId: string }) => {
      if (method === "listPendingDataFiles") return { files: [
        { pendingId: "ack-fails", content: JSON.stringify(capture()) },
        { pendingId: "ack-succeeds", content: JSON.stringify(capture("2026-08")) },
      ] };
      if (args?.pendingId === "ack-fails") throw new Error("ack unavailable");
      return {};
    });
    await expect(processPendingFiles()).rejects.toThrow("有 1 个导入文件未能合并");
    expect(stored.entries).toHaveLength(2);
    expect(mocks.hostCall.mock.calls.filter(([method]) => method === "ackDataFile"))
      .toEqual([["ackDataFile", { pendingId: "ack-fails" }], ["ackDataFile", { pendingId: "ack-succeeds" }]]);
  });

  it("does not revive a deleted salary when an unacknowledged source is replayed at startup", async () => {
    stored = await deletedLedger();
    const before = structuredClone(stored);
    mocks.hostCall.mockResolvedValueOnce({ files: [{ pendingId: "unacknowledged", content: JSON.stringify(capture()) }] })
      .mockResolvedValueOnce({});
    await expect(processPendingFiles()).resolves.toBeUndefined();
    expect(stored).toEqual(before);
    expect(mocks.hostCall).toHaveBeenLastCalledWith("ackDataFile", { pendingId: "unacknowledged" });
  });

  it("preserves deletion when the user captures the same Feishu month again", async () => {
    stored = await deletedLedger();
    const previousState = structuredClone(stored.entries[0]!.state);
    mocks.hostCall.mockResolvedValueOnce({ content: JSON.stringify(capture()) });
    const items = await captureFeishu();
    expect(stored.entries).toHaveLength(1);
    expect(stored.entries[0]!.state).toEqual(previousState);
    expect(items[0]).toHaveProperty("deletedAt", previousState.at);
  });

  it("keeps explicit re-import of an original capture file as a deliberate restore", async () => {
    stored = await deletedLedger();
    const previousClock = stored.entries[0]!.state.clock;
    const items = await importDataText(JSON.stringify(capture()));
    expect(stored.entries).toHaveLength(1);
    expect(stored.entries[0]!.state.deleted).toBe(false);
    expect(stored.entries[0]!.state.clock).toBe(previousClock + 1);
    expect(items[0]).not.toHaveProperty("deletedAt");
  });
});
