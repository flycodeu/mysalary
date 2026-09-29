import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EvidenceItem } from "../src/platform/evidence";

const mocks = vi.hoisted(() => ({ hostCall: vi.fn(), listEvidence: vi.fn(), listDeletedEvidence: vi.fn(), deleteEvidence: vi.fn() }));
vi.mock("../src/platform/host", () => ({ hostCall: mocks.hostCall, isNative: true, isWindows: false }));
vi.mock("../src/platform/evidence", async (original) => ({
  ...await original<typeof import("../src/platform/evidence")>(), listEvidence: mocks.listEvidence,
  listDeletedEvidence: mocks.listDeletedEvidence, deleteEvidence: mocks.deleteEvidence,
}));
import { syncEvidence } from "../src/platform/evidenceSync";

const record = `ledger-${"a".repeat(64)}`;
const other = `ledger-${"b".repeat(64)}`;
function image(recordId = record, digit = "1"): EvidenceItem {
  return { recordId, id: digit.repeat(64), mimeType: "image/png", createdAt: "2026-09-29T12:00:00Z",
    sizeBytes: 512, width: 1080, height: 1920 };
}
const address = ({ recordId, id, mimeType }: EvidenceItem) => ({ recordId, id, mimeType });
const key = ({ recordId, id }: { recordId: string; id: string }) => `${recordId}/${id}`;
let local: Map<string, EvidenceItem>;
let remote: Map<string, EvidenceItem>;
let localDeleted: Set<string>;
let remoteDeleted: Set<string>;

beforeEach(() => {
  vi.resetAllMocks();
  local = new Map(); remote = new Map(); localDeleted = new Set(); remoteDeleted = new Set();
  mocks.listEvidence.mockImplementation(async (recordId) => [...local.values()].filter((item) => item.recordId === recordId));
  mocks.listDeletedEvidence.mockImplementation(async (recordId) => [...localDeleted].filter((value) => value.startsWith(`${recordId}/`)).map((value) => value.split("/")[1]));
  mocks.deleteEvidence.mockImplementation(async (recordId, id) => { localDeleted.add(`${recordId}/${id}`); local.delete(`${recordId}/${id}`); });
  mocks.hostCall.mockImplementation(async (method, args) => {
    if (method === "webdavListEvidence") return { items: [...remote.values()].map(address), deleted: [...remoteDeleted].map((value) => ({ recordId: value.split("/")[0], id: value.split("/")[1] })) };
    if (method === "webdavGetEvidence") {
      const item = remote.get(key(args))!; local.set(key(item), item); return { item };
    }
    if (method === "webdavPutEvidence") {
      const item = local.get(key(args))!; remote.set(key(item), item); return {};
    }
    if (method === "webdavPutEvidenceDeletion") { remoteDeleted.add(key(args)); return {}; }
    if (method === "webdavDeleteEvidence") { remote.delete(key(args)); return {}; }
    throw new Error(`Unexpected mutation: ${method}`);
  });
});

describe("original screenshot sync and deletions", () => {
  it("downloads only known record images, deduplicates known IDs and uploads only missing originals", async () => {
    const shared = image(), toDownload = image(record, "2"), toUpload = image(record, "3"), unrelated = image(other, "4");
    for (const item of [shared, toUpload]) local.set(key(item), item);
    for (const item of [shared, toDownload, unrelated]) remote.set(key(item), item);
    const progress = vi.fn();
    await expect(syncEvidence([record, record], progress)).resolves.toEqual({ downloaded: 1, uploaded: 1 });
    expect(mocks.listEvidence).toHaveBeenCalledExactlyOnceWith(record);
    expect(mocks.hostCall.mock.calls.map(([method]) => method)).toEqual(["webdavListEvidence", "webdavGetEvidence", "webdavPutEvidence"]);
    expect(mocks.hostCall).toHaveBeenCalledWith("webdavGetEvidence", address(toDownload));
    expect(mocks.hostCall).toHaveBeenCalledWith("webdavPutEvidence", { recordId: record, id: toUpload.id });
    expect(local.has(key(unrelated))).toBe(false);
    expect(remote.has(key(unrelated))).toBe(true);
    expect(progress.mock.calls).toEqual([[0, 2], [1, 2], [2, 2]]);
    await expect(syncEvidence([record])).resolves.toEqual({ downloaded: 0, uploaded: 0 });
  });

  it("makes no network request for an empty archive", async () => {
    await expect(syncEvidence([])).resolves.toEqual({ downloaded: 0, uploaded: 0 });
    expect(mocks.hostCall).not.toHaveBeenCalled();
  });

  it("rejects an unsafe record key before any network access", async () => {
    await expect(syncEvidence(["../private"])).rejects.toThrow("工资记录列表无效");
    expect(mocks.hostCall).not.toHaveBeenCalled();
  });

  it.each([{ id: "../file" }, { recordId: "../file" }, { mimeType: "image/svg+xml" }])("rejects invalid remote metadata %j before transfers", async (change) => {
    mocks.hostCall.mockResolvedValueOnce({ items: [{ ...address(image()), ...change }], deleted: [] });
    await expect(syncEvidence([record])).rejects.toThrow("云端截图信息无效");
    expect(mocks.hostCall).toHaveBeenCalledTimes(1);
  });

  it("rejects incomplete and duplicate listings without modifying either copy", async () => {
    mocks.hostCall.mockResolvedValueOnce({ truncated: true });
    await expect(syncEvidence([record])).rejects.toThrow("不完整");
    mocks.hostCall.mockResolvedValueOnce({ items: [address(image()), address(image())], deleted: [] });
    await expect(syncEvidence([record])).rejects.toThrow("重复记录");
    expect(mocks.listEvidence).not.toHaveBeenCalled();
  });

  it("rejects a MIME disagreement for the same hash and keeps both files", async () => {
    const item = image(); local.set(key(item), item);
    remote.set(key(item), { ...item, mimeType: "image/jpeg" });
    await expect(syncEvidence([record])).rejects.toThrow("类型与本机不一致");
    expect(local.get(key(item))).toEqual(item);
    expect(remote.get(key(item))?.mimeType).toBe("image/jpeg");
    expect(mocks.hostCall).toHaveBeenCalledTimes(1);
  });

  it.each([{ id: "2".repeat(64) }, { recordId: other }, { mimeType: "image/jpeg" }, { width: 0 }])("rejects mismatched saved download metadata %j", async (change) => {
    mocks.hostCall.mockResolvedValueOnce({ items: [address(image())], deleted: [] }).mockResolvedValueOnce({ item: { ...image(), ...change } });
    await expect(syncEvidence([record])).rejects.toThrow();
    expect(mocks.hostCall).toHaveBeenCalledTimes(2);
  });

  it("passes only the validated address to native download", async () => {
    mocks.hostCall.mockResolvedValueOnce({ items: [{ ...address(image()), path: "private", url: "https://unexpected.invalid" }], deleted: [] }).mockResolvedValueOnce({ item: image() });
    await syncEvidence([record]);
    expect(mocks.hostCall).toHaveBeenLastCalledWith("webdavGetEvidence", address(image()));
  });

  it("keeps successful transfers on partial failure and retries only what is missing", async () => {
    const first = image(), second = image(record, "2"), upload = image(record, "3");
    for (const item of [first, second]) remote.set(key(item), item);
    local.set(key(upload), upload);
    const native = mocks.hostCall.getMockImplementation()!;
    let failed = false;
    mocks.hostCall.mockImplementation(async (method, args) => {
      if (method === "webdavGetEvidence" && args.id === second.id && !failed) { failed = true; throw new Error("连接中断"); }
      return native(method, args);
    });
    await expect(syncEvidence([record])).rejects.toThrow("连接中断");
    expect([...local.values()]).toEqual([upload, first]);
    expect(remote.size).toBe(2);
    await expect(syncEvidence([record])).resolves.toEqual({ downloaded: 1, uploaded: 1 });
    expect(local.size).toBe(3); expect(remote.size).toBe(3);
    expect(mocks.hostCall.mock.calls.filter(([method, args]) => method === "webdavGetEvidence" && args.id === first.id)).toHaveLength(1);
  });

  it("does not begin transfers if uploads would exceed the cloud limit", async () => {
    const item = image(); local.set(key(item), item);
    mocks.hostCall.mockResolvedValueOnce({ items: Array.from({ length: 1200 }, (_, index) => ({
      recordId: other, id: (index + 1).toString(16).padStart(64, "0"), mimeType: "image/png",
    })), deleted: [] });
    await expect(syncEvidence([record])).rejects.toThrow("1200 张");
    expect(mocks.hostCall).toHaveBeenCalledTimes(1);
  });

  it("publishes a local deletion marker before removing the cloud original", async () => {
    const item = image();
    remote.set(key(item), item);
    localDeleted.add(key(item));
    await expect(syncEvidence([record])).resolves.toEqual({ downloaded: 0, uploaded: 0 });
    expect(mocks.hostCall.mock.calls.map(([method]) => method)).toEqual([
      "webdavListEvidence", "webdavPutEvidenceDeletion", "webdavDeleteEvidence",
    ]);
    expect(remoteDeleted.has(key(item))).toBe(true);
    expect(remote.has(key(item))).toBe(false);
    await syncEvidence([record]);
    expect(mocks.hostCall.mock.calls.filter(([method]) => method === "webdavGetEvidence")).toHaveLength(0);
  });

  it("applies a remote deletion to another device before it can reupload", async () => {
    const item = image();
    local.set(key(item), item);
    remote.set(key(item), item);
    remoteDeleted.add(key(item));
    await syncEvidence([record]);
    expect(mocks.deleteEvidence).toHaveBeenCalledExactlyOnceWith(record, item.id);
    expect(local.has(key(item))).toBe(false);
    expect(localDeleted.has(key(item))).toBe(true);
    expect(remote.has(key(item))).toBe(false);
    expect(mocks.hostCall.mock.calls.some(([method]) => method === "webdavPutEvidence")).toBe(false);
  });

  it("leaves an unsynced deletion local and retries after a marker upload failure", async () => {
    const item = image(); remote.set(key(item), item); localDeleted.add(key(item));
    const native = mocks.hostCall.getMockImplementation()!;
    let failed = false;
    mocks.hostCall.mockImplementation(async (method, args) => {
      if (method === "webdavPutEvidenceDeletion" && !failed) { failed = true; throw new Error("marker failed"); }
      return native(method, args);
    });
    await expect(syncEvidence([record])).rejects.toThrow("marker failed");
    expect(remote.has(key(item))).toBe(true);
    await syncEvidence([record]);
    expect(remote.has(key(item))).toBe(false);
  });

  it("keeps a published marker when cloud cleanup fails and retries without resurrecting the image", async () => {
    const item = image(); remote.set(key(item), item); localDeleted.add(key(item));
    const native = mocks.hostCall.getMockImplementation()!;
    let failed = false;
    mocks.hostCall.mockImplementation(async (method, args) => {
      if (method === "webdavDeleteEvidence" && !failed) { failed = true; throw new Error("cloud cleanup failed"); }
      return native(method, args);
    });
    await expect(syncEvidence([record])).rejects.toThrow("cloud cleanup failed");
    expect(remoteDeleted.has(key(item))).toBe(true);
    expect(remote.has(key(item))).toBe(true);
    await syncEvidence([record]);
    expect(remote.has(key(item))).toBe(false);
    expect(mocks.hostCall.mock.calls.some(([method]) => method === "webdavGetEvidence" || method === "webdavPutEvidence")).toBe(false);
  });

  it("rejects malformed or repeated cloud deletion markers", async () => {
    mocks.hostCall.mockResolvedValueOnce({ items: [], deleted: [{ recordId: record, id: "../bad" }] });
    await expect(syncEvidence([record])).rejects.toThrow("云端截图删除记录无效");
    mocks.hostCall.mockResolvedValueOnce({ items: [], deleted: [{ recordId: record, id: image().id }, { recordId: record, id: image().id }] });
    await expect(syncEvidence([record])).rejects.toThrow("重复删除记录");
    expect(mocks.deleteEvidence).not.toHaveBeenCalled();
  });
});
