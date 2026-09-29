import {
  Capacitor,
  registerPlugin,
  type PluginListenerHandle,
} from "@capacitor/core";
import type { OcrResult, SalaryDraft } from "../domain/types";
import { demoImageUrl, demoOcr } from "../domain/demo";
import { parseSalary } from "../domain/parseSalary";
import {
  draftFromCapture,
  parseCapturePackage,
  type CapturePackage,
} from "../domain/capture";
import {
  captureToEntries,
  emptyLedger,
  mergeLedgers,
  parseLedger,
  serializeLedger,
  updateEntryState,
  type LedgerEntry,
} from "../domain/ledger";
import { deviceId, readLedger, updateLedger } from "./ledgerStore";
import { hostCall, isWindows, isNative } from "./host";

export interface ArchiveItem {
  id: string;
  fileName: string;
  imagePath: string;
  width: number;
  height: number;
  createdAt: string;
  deletedAt?: string;
  sha256: string;
  status: "pending" | "recognized" | "reviewed" | "error";
  draft?: SalaryDraft;
  ocr?: OcrResult;
  error?: string;
  copyState?: "copying" | "complete";
  previewPath?: string;
  demo?: boolean;
  sourceKind?: "image" | "feishu-text";
  captureJson?: string;
  capture?: CapturePackage;
  ledgerId?: string;
}

export interface ImportEvent {
  id?: string;
  ids?: string[];
  error?: string;
  errorCode?: string;
  content?: string;
  pendingId?: string;
}

interface NativeArchive {
  listImports(): Promise<{ items: ArchiveItem[] }>;
  deleteImport(options: { id: string }): Promise<{ item: ArchiveItem }>;
  restoreImport(options: { id: string }): Promise<{ item: ArchiveItem }>;
  addListener(
    event: "importReceived",
    listener: (event: ImportEvent) => void,
  ): Promise<PluginListenerHandle>;
}

const native = registerPlugin<NativeArchive>("SalaryNative");
export const isAndroid = Capacitor.getPlatform() === "android";
const DEMO_ID = "sample-salary-september";
let demoItem: ArchiveItem | undefined;

// Keep the old image store readable, including original Blobs and edited drafts.
// New imports are capture files saved in the shared ledger.
interface BrowserItem extends ArchiveItem {
  image?: Blob;
}
let database: Promise<IDBDatabase> | undefined;
const previewUrls = new Map<string, string>();
let browserMutation: Promise<unknown> = Promise.resolve();

// Serialize legacy deletion/restoration so the last user action wins.
function mutateBrowser<T>(operation: () => Promise<T>): Promise<T> {
  const result = browserMutation.then(operation);
  browserMutation = result.catch(() => undefined);
  return result;
}

function openDatabase(): Promise<IDBDatabase> {
  return (database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("salary-preview", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("imports", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      database = undefined;
      reject(new Error("无法打开本机档案"));
    };
  }));
}

async function readBrowserItems(): Promise<BrowserItem[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction("imports").objectStore("imports").getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("读取档案失败，请重试"));
  });
}

async function putBrowserItem(item: BrowserItem): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction("imports", "readwrite");
    const plain = JSON.parse(JSON.stringify({ ...item, image: undefined }));
    // Vue proxies are not structured-cloneable; preserve the Blob separately.
    transaction
      .objectStore("imports")
      .put(item.image ? { ...plain, image: item.image } : plain);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(new Error("保存失败，请检查可用空间后重试"));
    transaction.onabort = () => reject(new Error("保存中断，请重试"));
  });
}

function browserView(item: BrowserItem): ArchiveItem {
  if (item.image && !previewUrls.has(item.id)) {
    previewUrls.set(item.id, URL.createObjectURL(item.image));
  }
  return { ...item, imagePath: previewUrls.get(item.id) ?? item.imagePath };
}

export function imageUrl(item: ArchiveItem): string {
  return isAndroid && !item.demo
    ? Capacitor.convertFileSrc(item.previewPath || item.imagePath)
    : item.imagePath;
}

export async function listImports(): Promise<ArchiveItem[]> {
  const items = isAndroid
    ? (await native.listImports()).items
    : isWindows
      ? []
      : (await readBrowserItems()).map(browserView);
  const migrated = new Set<string>();
  const candidates: LedgerEntry[] = [];
  for (const item of items.filter(
    (item) => item.sourceKind === "feishu-text",
  )) {
    try {
      const entries = await captureToEntries(
        parseCapturePackage(item.captureJson ?? ""),
        "legacy",
        item.createdAt,
      );
      for (const entry of entries) {
        if (item.deletedAt)
          entry.state = {
            deleted: true,
            clock: 1,
            device: "legacy",
            at: item.deletedAt,
          };
        candidates.push(entry);
      }
      migrated.add(item.id);
    } catch {
      /* Keep damaged legacy files visible; never discard the original. */
    }
  }
  const ledger = await updateLedger((current) =>
    candidates.reduce(
      (next, entry) =>
        mergeLedgers(next, { ...emptyLedger(), entries: [entry] }),
      current,
    ),
  );
  const visible = [
    ...items.filter((item) => !migrated.has(item.id)),
    ...ledger.entries.map(ledgerItem),
  ];
  if (demoItem) visible.push(demoItem);
  return visible
    .map(hydrateItem)
    .sort(
      (a, b) =>
        (b.draft?.payrollMonth ?? "").localeCompare(
          a.draft?.payrollMonth ?? "",
        ) ||
        Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
        b.id.localeCompare(a.id),
    );
}

export function ledgerItem(entry: LedgerEntry): ArchiveItem {
  return hydrateItem({
    id: `ledger-${entry.id}`,
    ledgerId: entry.id,
    fileName: `${entry.capture.records[0]!.payrollMonth}.salary.json`,
    imagePath: "",
    width: 0,
    height: 0,
    createdAt: entry.createdAt,
    ...(entry.state.deleted ? { deletedAt: entry.state.at } : {}),
    sha256: entry.id,
    status: "recognized",
    sourceKind: "feishu-text",
    captureJson: JSON.stringify(entry.capture),
    copyState: "complete",
  });
}

function hydrateItem(item: ArchiveItem): ArchiveItem {
  if (item.sourceKind === "feishu-text") {
    try {
      const capture = parseCapturePackage(item.captureJson ?? "");
      if (capture.records.length !== 1)
        throw new Error("档案月份不完整，请重新导入工资文件");
      return {
        ...item,
        capture,
        draft: draftFromCapture(capture.records[0]!),
        status: "recognized",
      };
    } catch (cause) {
      return {
        ...item,
        draft: undefined,
        capture: undefined,
        status: "error",
        error: cause instanceof Error ? cause.message : "工资文件无法读取",
      };
    }
  }
  // Existing drafts remain the authority for historical manual changes.
  return item.draft || !item.ocr
    ? item
    : { ...item, draft: parseSalary(item.ocr) };
}

export function pickNativeData() {
  return hostCall<{
    content?: string;
    pendingId?: string;
    cancelled?: boolean;
  }>("pickDataFile");
}

export async function importBrowserCapture(file: File): Promise<ArchiveItem[]> {
  if (file.size > 8 * 1024 * 1024) throw new Error("工资文件超过 8 MB");
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(
      await file.arrayBuffer(),
    );
  } catch {
    throw new Error("工资文件编码损坏，请从电脑重新导出");
  }
  return importDataText(content);
}

export async function importDataText(
  content: string,
  restoreDeleted = true,
): Promise<ArchiveItem[]> {
  let format: unknown;
  try {
    format = JSON.parse(content.replace(/^\uFEFF/, ""))?.format;
  } catch {
    throw new Error("工资文件损坏，请重新导出");
  }
  const isBundle = format === "salary-archive";
  const incoming = isBundle
    ? await parseLedger(content)
    : {
        ...emptyLedger(),
        entries: await captureToEntries(
          parseCapturePackage(content),
          deviceId(),
        ),
      };
  const merged = await updateLedger((current) => {
    let next = mergeLedgers(current, incoming);
    // Explicitly re-importing an original source restores it. Sync and whole-archive imports preserve tombstones.
    if (!isBundle && restoreDeleted)
      for (const entry of incoming.entries) {
        if (next.entries.find((item) => item.id === entry.id)?.state.deleted)
          next = updateEntryState(next, entry.id, false, deviceId());
      }
    return next;
  });
  return merged.entries
    .filter((entry) => incoming.entries.some((item) => item.id === entry.id))
    .map(ledgerItem);
}

export async function captureFeishu(): Promise<ArchiveItem[]> {
  const result = await hostCall<{ content: string }>("captureFeishu");
  return importDataText(result.content, false);
}

export async function exportArchive(): Promise<boolean> {
  const ledger = await readLedger();
  if (!ledger.entries.length) throw new Error("还没有可导出的采集数据");
  const content = serializeLedger(ledger);
  const fileName = `salary-archive-${new Date().toISOString().slice(0, 10)}.json`;
  if (isNative)
    return !(
      await hostCall<{ cancelled?: boolean }>("exportDataFile", {
        content,
        fileName,
      })
    ).cancelled;
  const url = URL.createObjectURL(
    new Blob([content], { type: "application/json" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return true;
}

export async function processPendingFiles(): Promise<void> {
  if (!isAndroid) return;
  const { files } = await hostCall<{
    files: Array<{ content: string; pendingId: string }>;
  }>("listPendingDataFiles");
  let failed = 0;
  for (const file of files) {
    try {
      await importDataText(file.content, false);
      await hostCall("ackDataFile", { pendingId: file.pendingId });
    } catch {
      // Keep failed sources pending without blocking other shared files.
      failed++;
    }
  }
  if (failed)
    throw new Error(`有 ${failed} 个导入文件未能合并，原文件已保留，请重新导出后导入`);
}

async function setDeleted(
  item: ArchiveItem,
  deleted: boolean,
): Promise<ArchiveItem> {
  if (item.ledgerId) {
    const ledger = await updateLedger((current) =>
      updateEntryState(current, item.ledgerId!, deleted, deviceId()),
    );
    return ledgerItem(
      ledger.entries.find((entry) => entry.id === item.ledgerId)!,
    );
  }
  if (item.demo) {
    const current = demoItem ?? item;
    demoItem = { ...current };
    if (deleted) demoItem.deletedAt ??= new Date().toISOString();
    else delete demoItem.deletedAt;
    return demoItem;
  }
  if (isAndroid) {
    return (
      deleted
        ? await native.deleteImport({ id: item.id })
        : await native.restoreImport({ id: item.id })
    ).item;
  }
  return mutateBrowser(async () => {
    const stored = (await readBrowserItems()).find(
      (value) => value.id === item.id,
    );
    if (!stored) throw new Error("档案不存在，请重新打开");
    if (deleted) stored.deletedAt ??= new Date().toISOString();
    else delete stored.deletedAt;
    await putBrowserItem(stored);
    return browserView(stored);
  });
}

export function deleteImport(item: ArchiveItem): Promise<ArchiveItem> {
  return setDeleted(item, true);
}

export function restoreImport(item: ArchiveItem): Promise<ArchiveItem> {
  return setDeleted(item, false);
}

export function createDemo(): ArchiveItem {
  if (demoItem) {
    delete demoItem.deletedAt;
    return demoItem;
  }
  return (demoItem ??= {
    id: DEMO_ID,
    fileName: "合成工资样例",
    imagePath: demoImageUrl,
    width: demoOcr.imageWidth,
    height: demoOcr.imageHeight,
    createdAt: new Date().toISOString(),
    sha256: "synthetic",
    status: "recognized",
    draft: parseSalary(demoOcr),
    ocr: demoOcr,
    demo: true,
  });
}

export async function watchImports(
  listener: (event: ImportEvent) => void,
): Promise<() => void> {
  if (!isAndroid) return () => {};
  const handle = await native.addListener("importReceived", listener);
  return () => {
    void handle.remove();
  };
}
