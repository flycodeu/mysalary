import { describe, expect, it, vi } from "vitest";

vi.mock("../src/platform/host", () => ({ hostCall: vi.fn(), isNative: false, isWindows: false }));
import { validateEvidenceItem, evidenceDigest, MAX_EVIDENCE_BYTES } from "../src/platform/evidence";

const item = { id: "a".repeat(64), recordId: "ledger-" + "b".repeat(64), createdAt: "2026-09-29T12:00:00Z", mimeType: "image/png", sizeBytes: 512, width: 1080, height: 1920 };

describe("original screenshot metadata", () => {
  it("accepts the original dimensions and strips paths from display metadata", () => {
    expect(validateEvidenceItem({ ...item, path: "private" }, item.recordId)).toEqual(item);
  });
  it.each([
    { recordId: "different-record" }, { id: "../image" }, { mimeType: "image/svg+xml" },
    { width: 32769 }, { height: 0 }, { width: 32768, height: 32768 },
    { sizeBytes: MAX_EVIDENCE_BYTES + 1 }, { createdAt: "invalid" },
  ])("rejects mismatched or invalid metadata %j", (change) => {
    expect(() => validateEvidenceItem({ ...item, ...change }, item.recordId)).toThrow();
  });
  it("rejects traversal in a record key", () => {
    expect(() => validateEvidenceItem({ ...item, recordId: "../../other" }, "../../other")).toThrow();
  });
  it("identifies identical bytes independently of file names", async () => {
    const one = await evidenceDigest(new TextEncoder().encode("original").buffer);
    expect(one).toMatch(/^[a-f0-9]{64}$/);
    expect(await evidenceDigest(new TextEncoder().encode("original").buffer)).toBe(one);
    expect(await evidenceDigest(new TextEncoder().encode("altered").buffer)).not.toBe(one);
  });
});
