import { beforeEach, describe, expect, it, vi } from "vitest";
import { CAPTURE_PAGE, type CapturePackage } from "../src/domain/capture";
import { demoOcr } from "../src/domain/demo";
import { emptyLedger, updateEntryState, type Ledger } from "../src/domain/ledger";
import { parseSalary } from "../src/domain/parseSalary";

const mocks = vi.hoisted(() => ({
  listImports: vi.fn(),
  updateLedger: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => "android",
    convertFileSrc: (path: string) => `native-preview:${path}`,
  },
  registerPlugin: () => ({ listImports: mocks.listImports }),
}));
vi.mock("../src/platform/host", () => ({
  hostCall: vi.fn(),
  isWindows: false,
  isNative: true,
}));
vi.mock("../src/platform/ledgerStore", () => ({
  updateLedger: mocks.updateLedger,
  readLedger: vi.fn(),
  deviceId: () => "test-device",
}));

import { imageUrl, listImports, type ArchiveItem } from "../src/platform/archive";

const at = "2026-09-28T10:00:00.000Z";
let stored: Ledger;

function legacyItem(overrides: Partial<ArchiveItem> = {}): ArchiveItem {
  return {
    id: "legacy-synthetic-source",
    fileName: "synthetic-source.png",
    imagePath: "/private/synthetic-source.png",
    width: 720,
    height: 1600,
    createdAt: at,
    sha256: "synthetic-test-only",
    status: "recognized",
    ...overrides,
  };
}

function capture(): CapturePackage {
  return {
    format: "salary-capture",
    version: 1,
    source: { kind: "feishu-text", page: CAPTURE_PAGE, capturedAt: at },
    records: [{ payrollMonth: "2026-09", fields: [
      { label: "应发工资", amountText: "1000.00" },
      { label: "实发工资", amountText: "900.00" },
      { label: "基本工资", amountText: "1000.00" },
      { label: "个税", amountText: "100.00" },
    ] }],
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  stored = emptyLedger();
  mocks.updateLedger.mockImplementation(async (operation: (ledger: Ledger) => Ledger) => {
    stored = operation(structuredClone(stored));
    return structuredClone(stored);
  });
});

describe("historical archives after the capture-only transition", () => {
  it("keeps a previously edited draft and its original image instead of re-parsing OCR", async () => {
    const draft = parseSalary(demoOcr);
    draft.statedNetMinor = 123456;
    draft.reviewStatus = "reviewed";
    draft.lines[0]!.accountingSource = "manual";
    const source = legacyItem({ draft, ocr: demoOcr, status: "reviewed" });
    const before = structuredClone(source);
    mocks.listImports.mockResolvedValue({ items: [source] });

    const [item] = await listImports();

    expect(item).toEqual(before);
    expect(item!.draft!.statedNetMinor).toBe(123456);
    expect(imageUrl(item!)).toBe("native-preview:/private/synthetic-source.png");
    expect(source).toEqual(before);
    expect(stored.entries).toEqual([]);
  });

  it("still reconstructs a legacy draft from saved OCR when no manual draft exists", async () => {
    const source = legacyItem({ ocr: demoOcr });
    mocks.listImports.mockResolvedValue({ items: [source] });

    const [item] = await listImports();

    expect(item!.draft).toEqual(parseSalary(demoOcr));
    expect(item!.ocr).toEqual(demoOcr);
    expect(source.draft).toBeUndefined();
  });

  it("keeps unfinished image archives and available previews readable", async () => {
    const source = legacyItem({
      status: "error",
      error: "旧识别未完成",
      previewPath: "/private/synthetic-preview.png",
    });
    mocks.listImports.mockResolvedValue({ items: [source] });

    const [item] = await listImports();

    expect(item).toEqual(source);
    expect(item!.draft).toBeUndefined();
    expect(imageUrl(item!)).toBe("native-preview:/private/synthetic-preview.png");
  });

  it("migrates repeated legacy captures once and never revives a newer deletion", async () => {
    const source = legacyItem({ sourceKind: "feishu-text", captureJson: JSON.stringify(capture()) });
    const before = structuredClone(source);
    mocks.listImports.mockResolvedValue({ items: [source] });

    const [first] = await listImports();
    stored = updateEntryState(stored, first!.ledgerId!, true, "test-device", at);
    const [second] = await listImports();

    expect(stored.entries).toHaveLength(1);
    expect(second!.id).toBe(first!.id);
    expect(second!.deletedAt).toBe(at);
    expect(stored.entries[0]!.state.deleted).toBe(true);
    expect(source).toEqual(before);
  });

  it("preserves legacy deletion during initial migration", async () => {
    mocks.listImports.mockResolvedValue({ items: [legacyItem({
      sourceKind: "feishu-text",
      captureJson: JSON.stringify(capture()),
      deletedAt: at,
    })] });

    const [item] = await listImports();

    expect(item!.deletedAt).toBe(at);
    expect(stored.entries[0]!.state.deleted).toBe(true);
  });

  it("leaves a damaged legacy source visible and keeps its original bytes", async () => {
    const source = legacyItem({ sourceKind: "feishu-text", captureJson: "{broken-source" });
    const before = structuredClone(source);
    mocks.listImports.mockResolvedValue({ items: [source] });

    const [item] = await listImports();

    expect(item!.id).toBe(source.id);
    expect(item!.status).toBe("error");
    expect(item!.captureJson).toBe("{broken-source");
    expect(item!.draft).toBeUndefined();
    expect(source).toEqual(before);
    expect(stored.entries).toEqual([]);
  });
});
