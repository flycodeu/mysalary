import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CAPTURE_PAGE, type CapturePackage } from "../src/domain/capture";
import { createEntry, emptyLedger, mergeLedgers, parseLedger, serializeLedger, updateEntryState, type Ledger } from "../src/domain/ledger";

const mocks = vi.hoisted(() => ({ hostCall: vi.fn(), updateLedger: vi.fn() }));
vi.mock("../src/platform/host", () => ({ hostCall: mocks.hostCall }));
vi.mock("../src/platform/ledgerStore", () => ({ updateLedger: mocks.updateLedger }));
import { syncNutstore } from "../src/platform/sync";

interface RemoteFile { name: string; content: string }
let local: Ledger;
let queue: Promise<unknown>;
const at = "2026-09-28T10:00:00.000Z";

async function month(month: string, device = "device-a"): Promise<Ledger> {
  const capture: CapturePackage = {
    format: "salary-capture", version: 1,
    source: { kind: "feishu-text", page: CAPTURE_PAGE, capturedAt: at },
    records: [{ payrollMonth: month, fields: [
      { label: "应发工资", amountText: "1000.00" },
      { label: "实发工资", amountText: "900.00" },
      { label: "基本工资", amountText: "1000.00" },
      { label: "个税", amountText: "100.00" },
    ] }],
  };
  return { format: "salary-archive", version: 1, entries: [await createEntry(capture, device, at)] };
}

function delta(content: string): RemoteFile {
  return { name: `changes-${createHash("sha256").update(content, "utf8").digest("hex")}.json`, content };
}

function legacy(ledger: Ledger): RemoteFile {
  return { name: "archive-v1.json", content: serializeLedger(ledger) };
}

function publishedRequests(): Array<{ content: string }> {
  return mocks.hostCall.mock.calls.filter(([method]) => method === "webdavPublish").map(([, request]) => request);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  local = emptyLedger();
  queue = Promise.resolve();
  mocks.updateLedger.mockImplementation((operation: (ledger: Ledger) => Ledger | Promise<Ledger>) => {
    // The real store serializes operations and loads the latest state for each one.
    const result = queue.then(async () => {
      local = await operation(structuredClone(local));
      return structuredClone(local);
    });
    queue = result.then(() => undefined, () => undefined);
    return result;
  });
});

describe("append-only salary archive synchronization", () => {
  it("publishes local entries to an empty cloud without a conditional overwrite", async () => {
    local = await month("2026-09");
    mocks.hostCall.mockResolvedValueOnce({ files: [] }).mockResolvedValueOnce({});
    await expect(syncNutstore()).resolves.toEqual({ count: 1, uploaded: true });
    expect(mocks.hostCall).toHaveBeenNthCalledWith(1, "webdavPull");
    expect(mocks.hostCall).toHaveBeenNthCalledWith(2, "webdavPublish", { content: serializeLedger(local) });
    expect(await parseLedger(publishedRequests()[0]!.content)).toEqual(local);
  });

  it("does not publish an empty ledger", async () => {
    mocks.hostCall.mockResolvedValueOnce({ files: [] });
    await expect(syncNutstore()).resolves.toEqual({ count: 0, uploaded: false });
    expect(mocks.hostCall).toHaveBeenCalledTimes(1);
  });

  it.each(["legacy", "delta"])("does not republish entries already present in a %s file", async (kind) => {
    local = await month("2026-09");
    const file = kind === "legacy" ? legacy(local) : delta(serializeLedger(local));
    mocks.hostCall.mockResolvedValueOnce({ files: [file] });
    await expect(syncNutstore()).resolves.toEqual({ count: 1, uploaded: false });
    expect(publishedRequests()).toHaveLength(0);
  });

  it("merges a legacy archive and UTF-8 deltas, publishing only local changes", async () => {
    const first = await month("2026-09");
    const second = await month("2026-08");
    const remoteOnly = await month("2026-07", "device-b");
    local = updateEntryState(mergeLedgers(first, second), first.entries[0]!.id, true, "device-a", at);
    const expectedDelta = structuredClone(local);
    mocks.hostCall.mockResolvedValueOnce({ files: [legacy(first), delta(serializeLedger(remoteOnly))] })
      .mockResolvedValueOnce({});
    await expect(syncNutstore()).resolves.toEqual({ count: 3, uploaded: true });
    expect(await parseLedger(publishedRequests()[0]!.content)).toEqual(expectedDelta);
    expect(local).toEqual(mergeLedgers(expectedDelta, remoteOnly));
    expect(mocks.hostCall.mock.calls.map(([method]) => method)).toEqual(["webdavPull", "webdavPublish"]);
  });

  it.each([false, true])("merges deletion and recovery regardless of file order (reverse=%s)", async (reverse) => {
    const initial = await month("2026-09");
    const deleted = updateEntryState(initial, initial.entries[0]!.id, true, "device-a", at);
    const restored = updateEntryState(deleted, initial.entries[0]!.id, false, "device-b", at);
    const files = [delta(serializeLedger(restored)), legacy(initial), delta(serializeLedger(deleted))];
    local = deleted;
    mocks.hostCall.mockResolvedValueOnce({ files: reverse ? files.reverse() : files });
    await expect(syncNutstore()).resolves.toEqual({ count: 1, uploaded: false });
    expect(local).toEqual(restored);
    expect(publishedRequests()).toHaveLength(0);
  });

  it("does not restore a cloud tombstone when an old local capture is replayed", async () => {
    const original = await month("2026-09");
    const deleted = updateEntryState(original, original.entries[0]!.id, true, "device-b", at);
    local = original;
    mocks.hostCall.mockResolvedValueOnce({ files: [legacy(original), delta(serializeLedger(deleted))] });
    await expect(syncNutstore()).resolves.toEqual({ count: 1, uploaded: false });
    expect(local).toEqual(deleted);
    expect(publishedRequests()).toHaveLength(0);
  });

  it("publishes an explicit local recovery with its higher operation clock", async () => {
    const original = await month("2026-09");
    const deleted = updateEntryState(original, original.entries[0]!.id, true, "device-b", at);
    local = updateEntryState(deleted, original.entries[0]!.id, false, "device-a", at);
    mocks.hostCall.mockResolvedValueOnce({ files: [legacy(original), delta(serializeLedger(deleted))] })
      .mockResolvedValueOnce({});
    await expect(syncNutstore()).resolves.toEqual({ count: 1, uploaded: true });
    const uploaded = await parseLedger(publishedRequests()[0]!.content);
    expect(uploaded).toEqual(local);
    expect(uploaded.entries[0]!.state).toMatchObject({ deleted: false, clock: 2 });
  });

  it("retains both device deltas published from the same stale cloud snapshot", async () => {
    const firstDevice = await month("2026-09", "device-a");
    const secondDevice = await month("2026-08", "device-b");
    local = firstDevice;
    const cloud = new Map<string, RemoteFile>();
    const expected = mergeLedgers(firstDevice, secondDevice);
    let firstPull = true;
    mocks.hostCall.mockImplementation(async (method: string, request?: { content: string }) => {
      if (method === "webdavPull") {
        if (firstPull) { firstPull = false; return { files: [] }; }
        return { files: [...cloud.values()] };
      }
      expect(method).toBe("webdavPublish");
      // Device B publishes after A's empty read. A's distinct file must retain B's file.
      const concurrent = delta(serializeLedger(secondDevice));
      cloud.set(concurrent.name, concurrent);
      const current = delta(request!.content);
      cloud.set(current.name, current);
      return {};
    });
    await expect(syncNutstore()).resolves.toEqual({ count: 1, uploaded: true });
    expect(cloud.size).toBe(2);
    await expect(syncNutstore()).resolves.toEqual({ count: 2, uploaded: false });
    expect(local).toEqual(expected);
    local = secondDevice;
    await expect(syncNutstore()).resolves.toEqual({ count: 2, uploaded: false });
    expect(local).toEqual(expected);
    expect(publishedRequests()).toHaveLength(1);
  });

  it("accepts the same source in several valid files without duplicate records", async () => {
    const source = await month("2026-09");
    mocks.hostCall.mockResolvedValueOnce({ files: [legacy(source), delta(serializeLedger(source))] });
    await expect(syncNutstore()).resolves.toEqual({ count: 1, uploaded: false });
    expect(local).toEqual(source);
  });

  it("includes a local import made while the cloud download is pending", async () => {
    const pulled = deferred<{ files: RemoteFile[] }>();
    local = await month("2026-09");
    const extra = await month("2026-08");
    mocks.hostCall.mockReturnValueOnce(pulled.promise).mockResolvedValueOnce({});
    const running = syncNutstore();
    await mocks.updateLedger((current: Ledger) => mergeLedgers(current, extra));
    pulled.resolve({ files: [] });
    await expect(running).resolves.toEqual({ count: 2, uploaded: true });
    expect(await parseLedger(publishedRequests()[0]!.content)).toEqual(local);
  });

  it("keeps imports made during publication and publishes them on the next sync", async () => {
    const initial = await month("2026-09");
    const remote = await month("2026-08", "device-b");
    const extra = await month("2026-07");
    local = initial;
    const cloud = [delta(serializeLedger(remote))];
    mocks.hostCall.mockImplementation(async (method: string, request?: { content: string }) => {
      if (method === "webdavPull") return { files: [...cloud] };
      expect(method).toBe("webdavPublish");
      cloud.push(delta(request!.content));
      await mocks.updateLedger((current: Ledger) => mergeLedgers(current, extra));
      return {};
    });
    await expect(syncNutstore()).resolves.toMatchObject({ uploaded: true });
    expect(await parseLedger(publishedRequests()[0]!.content)).toEqual(initial);
    expect(local).toEqual(mergeLedgers(mergeLedgers(initial, remote), extra));
    await expect(syncNutstore()).resolves.toEqual({ count: 3, uploaded: true });
    expect(await parseLedger(publishedRequests()[1]!.content)).toEqual(extra);
    await expect(syncNutstore()).resolves.toEqual({ count: 3, uploaded: false });
  });

  it("preserves downloaded records when publication fails and allows a later retry", async () => {
    const initial = await month("2026-09");
    const remote = await month("2026-08", "device-b");
    local = initial;
    mocks.hostCall.mockResolvedValueOnce({ files: [legacy(remote)] }).mockRejectedValueOnce(new Error("upload unavailable"));
    await expect(syncNutstore()).rejects.toThrow("upload unavailable");
    expect(local).toEqual(mergeLedgers(initial, remote));
    expect(mocks.hostCall).toHaveBeenCalledTimes(2);
    mocks.hostCall.mockResolvedValueOnce({ files: [legacy(remote)] }).mockResolvedValueOnce({});
    await expect(syncNutstore()).resolves.toEqual({ count: 2, uploaded: true });
    expect(await parseLedger(publishedRequests()[1]!.content)).toEqual(initial);
  });

  it("does not publish when local persistence fails", async () => {
    local = await month("2026-09");
    const before = serializeLedger(local);
    mocks.hostCall.mockResolvedValueOnce({ files: [legacy(await month("2026-08"))] });
    mocks.updateLedger.mockRejectedValueOnce(new Error("local write failed"));
    await expect(syncNutstore()).rejects.toThrow("local write failed");
    expect(serializeLedger(local)).toBe(before);
    expect(publishedRequests()).toHaveLength(0);
  });

  it("does not change local data when cloud download fails", async () => {
    local = await month("2026-09");
    const before = serializeLedger(local);
    mocks.hostCall.mockRejectedValueOnce(new Error("network unavailable"));
    await expect(syncNutstore()).rejects.toThrow("network unavailable");
    expect(serializeLedger(local)).toBe(before);
    expect(mocks.updateLedger).not.toHaveBeenCalled();
    expect(publishedRequests()).toHaveLength(0);
  });

  it("shares an in-flight promise and permits another sync after completion", async () => {
    const pulled = deferred<{ files: RemoteFile[] }>();
    mocks.hostCall.mockReturnValueOnce(pulled.promise);
    const first = syncNutstore();
    const second = syncNutstore();
    expect(first).toBe(second);
    expect(mocks.hostCall).toHaveBeenCalledTimes(1);
    pulled.resolve({ files: [] });
    await first;
    mocks.hostCall.mockResolvedValueOnce({ files: [] });
    const later = syncNutstore();
    expect(later).not.toBe(first);
    await later;
  });
});

describe("remote snapshot validation before local changes", () => {
  it.each([
    null, undefined, {}, { files: null }, { files: "invalid" },
    { files: [null] }, { files: [{ name: "archive-v1.json" }] },
    { files: [{ name: "archive-v1.json", content: 123 }] },
  ])("rejects an incomplete pull response (%j)", async (response) => {
    local = await month("2026-09");
    const before = serializeLedger(local);
    mocks.hostCall.mockResolvedValueOnce(response);
    await expect(syncNutstore()).rejects.toThrow();
    expect(serializeLedger(local)).toBe(before);
    expect(mocks.updateLedger).not.toHaveBeenCalled();
    expect(publishedRequests()).toHaveLength(0);
  });

  it.each(["../archive-v1.json", "archive-v2.json", "changes-abc.json", `changes-${"A".repeat(64)}.json`])(
    "rejects unsupported remote names (%s)", async (name) => {
      mocks.hostCall.mockResolvedValueOnce({ files: [{ name, content: serializeLedger(emptyLedger()) }] });
      await expect(syncNutstore()).rejects.toThrow();
      expect(mocks.updateLedger).not.toHaveBeenCalled();
    },
  );

  it("rejects repeated filenames even when both contents are equal", async () => {
    const file = delta(serializeLedger(await month("2026-09")));
    mocks.hostCall.mockResolvedValueOnce({ files: [file, structuredClone(file)] });
    await expect(syncNutstore()).rejects.toThrow();
    expect(mocks.updateLedger).not.toHaveBeenCalled();
    expect(publishedRequests()).toHaveLength(0);
  });

  it("checks the exact UTF-8 file bytes rather than reserialized JSON", async () => {
    const file = delta(serializeLedger(await month("2026-09")));
    file.content += "\n";
    mocks.hostCall.mockResolvedValueOnce({ files: [file] });
    await expect(syncNutstore()).rejects.toThrow();
    expect(mocks.updateLedger).not.toHaveBeenCalled();
  });

  it("rejects a malformed ledger even when its filename hash is valid", async () => {
    mocks.hostCall.mockResolvedValueOnce({ files: [delta("{invalid")] });
    await expect(syncNutstore()).rejects.toThrow();
    expect(mocks.updateLedger).not.toHaveBeenCalled();
  });

  it("rejects a changed salary source even when the outer file hash is valid", async () => {
    const corrupt = await month("2026-08");
    corrupt.entries[0]!.capture.records[0]!.fields[0]!.amountText = "1100";
    mocks.hostCall.mockResolvedValueOnce({ files: [delta(JSON.stringify(corrupt))] });
    await expect(syncNutstore()).rejects.toThrow();
    expect(mocks.updateLedger).not.toHaveBeenCalled();
  });

  it("validates every remote file before saving any downloaded entries", async () => {
    local = await month("2026-09");
    const before = serializeLedger(local);
    mocks.hostCall.mockResolvedValueOnce({ files: [legacy(await month("2026-08")), delta("{invalid")] });
    await expect(syncNutstore()).rejects.toThrow();
    expect(serializeLedger(local)).toBe(before);
    expect(mocks.updateLedger).not.toHaveBeenCalled();
    expect(publishedRequests()).toHaveLength(0);
  });

  it("accepts the maximum of 1201 valid remote files", async () => {
    const content = serializeLedger(emptyLedger());
    const files = Array.from({ length: 1201 }, (_, index) => delta(content + " ".repeat(index)));
    mocks.hostCall.mockResolvedValueOnce({ files });
    await expect(syncNutstore()).resolves.toEqual({ count: 0, uploaded: false });
    expect(publishedRequests()).toHaveLength(0);
  });

  it("rejects more than 1201 valid remote files before persistence", async () => {
    const content = serializeLedger(emptyLedger());
    const files = Array.from({ length: 1202 }, (_, index) => delta(content + " ".repeat(index)));
    mocks.hostCall.mockResolvedValueOnce({ files });
    await expect(syncNutstore()).rejects.toThrow();
    expect(mocks.updateLedger).not.toHaveBeenCalled();
    expect(publishedRequests()).toHaveLength(0);
  });

  it("accepts exactly 16 MiB across valid files", async () => {
    const content = serializeLedger(emptyLedger());
    const first = content + " ".repeat(8 * 1024 * 1024 - content.length);
    const second = first.slice(0, -1) + "\n";
    mocks.hostCall.mockResolvedValueOnce({ files: [{ name: "archive-v1.json", content: first }, delta(second)] });
    await expect(syncNutstore()).resolves.toEqual({ count: 0, uploaded: false });
  });

  it("enforces the 16 MiB total using UTF-8 bytes rather than string length", async () => {
    const content = serializeLedger(await month("2026-09"));
    const charactersPerFile = Math.floor((16 * 1024 * 1024 - 1) / 3);
    const padded = content + " ".repeat(charactersPerFile - content.length - 1);
    const files = [delta(padded + " "), delta(padded + "\t"), delta(padded + "\n")];
    expect(files.reduce((size, file) => size + file.content.length, 0)).toBeLessThan(16 * 1024 * 1024);
    expect(files.reduce((size, file) => size + Buffer.byteLength(file.content, "utf8"), 0)).toBeGreaterThan(16 * 1024 * 1024);
    mocks.hostCall.mockResolvedValueOnce({ files });
    await expect(syncNutstore()).rejects.toThrow();
    expect(mocks.updateLedger).not.toHaveBeenCalled();
    expect(publishedRequests()).toHaveLength(0);
  });
});
