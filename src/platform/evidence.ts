import { hostCall, isNative, isWindows } from "./host";

export interface EvidenceItem {
  id: string;
  recordId: string;
  createdAt: string;
  mimeType: "image/png" | "image/jpeg";
  sizeBytes: number;
  width: number;
  height: number;
}

export const MAX_EVIDENCE_BYTES = 20 * 1024 * 1024;
export const MAX_EVIDENCE_PIXELS = 40_000_000;
interface StoredEvidence extends EvidenceItem { image: Blob }
let database: Promise<IDBDatabase> | undefined;

function validateRecordId(recordId: string) {
  if (!/^[A-Za-z0-9_-]{1,96}$/.test(recordId)) throw new Error("记录编号无效");
}
function validateId(id: string) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("图片编号无效");
}
export async function evidenceDigest(bytes: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function openDatabase(): Promise<IDBDatabase> {
  return database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("salary-evidence", 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore("images", { keyPath: ["recordId", "id"] });
      store.createIndex("recordId", "recordId");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { database = undefined; reject(new Error("无法打开截图档案")); };
  });
}

export function validateEvidenceItem(value: unknown, recordId: string): EvidenceItem {
  if (!value || typeof value !== "object") throw new Error("截图信息不完整");
  const item = value as EvidenceItem;
  validateRecordId(recordId);
  validateId(item.id);
  if (item.recordId !== recordId || !["image/png", "image/jpeg"].includes(item.mimeType) ||
      !Number.isFinite(Date.parse(item.createdAt)) || !Number.isInteger(item.sizeBytes) ||
      item.sizeBytes <= 0 || item.sizeBytes > MAX_EVIDENCE_BYTES ||
      !Number.isInteger(item.width) || !Number.isInteger(item.height) ||
      item.width < 1 || item.height < 1 || item.width > 32768 || item.height > 32768 ||
      item.width * item.height > MAX_EVIDENCE_PIXELS) throw new Error("截图信息无效");
  return { id: item.id, recordId, createdAt: item.createdAt, mimeType: item.mimeType,
    sizeBytes: item.sizeBytes, width: item.width, height: item.height };
}

export async function listEvidence(recordId: string): Promise<EvidenceItem[]> {
  validateRecordId(recordId);
  let items: unknown[];
  if (isNative) items = (await hostCall<{ items: unknown[] }>("listEvidence", { recordId })).items;
  else {
    const db = await openDatabase();
    items = await new Promise<StoredEvidence[]>((resolve, reject) => {
      const request = db.transaction("images").objectStore("images").index("recordId").getAll(recordId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error("无法读取截图档案"));
    });
  }
  if (!Array.isArray(items)) throw new Error("截图列表不完整");
  return items.map((item) => validateEvidenceItem(item, recordId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function evidenceDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("无法读取截图"));
    reader.readAsDataURL(blob);
  });
}

export async function readEvidence(recordId: string, id: string): Promise<string> {
  validateRecordId(recordId); validateId(id);
  if (isNative) {
    const response = await hostCall<{ base64: string; mimeType: string }>("readEvidence", { recordId, id });
    if (!["image/png", "image/jpeg"].includes(response.mimeType) || typeof response.base64 !== "string" ||
        response.base64.length > Math.ceil(MAX_EVIDENCE_BYTES / 3) * 4) throw new Error("原图读取失败");
    return `data:${response.mimeType};base64,${response.base64}`;
  }
  const db = await openDatabase();
  const stored = await new Promise<StoredEvidence>((resolve, reject) => {
    const request = db.transaction("images").objectStore("images").get([recordId, id]);
    request.onsuccess = () => request.result ? resolve(request.result) : reject(new Error("本机原图缺失"));
    request.onerror = () => reject(new Error("原图读取失败"));
  });
  validateEvidenceItem(stored, recordId);
  if (!(stored.image instanceof Blob) || await evidenceDigest(await stored.image.arrayBuffer()) !== id)
    throw new Error("原图校验失败，文件已保留");
  return evidenceDataUrl(stored.image);
}

export async function addEvidenceFiles(recordId: string, files: File[]): Promise<EvidenceItem[]> {
  validateRecordId(recordId);
  const result: EvidenceItem[] = [];
  for (const file of files) {
    if (!file.size || file.size > MAX_EVIDENCE_BYTES) throw new Error("每张截图不能超过 20 MiB");
    const bytes = await file.arrayBuffer();
    const header = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 8));
    const png = [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => header[index] === value);
    const jpeg = header[0] === 255 && header[1] === 216 && header[2] === 255;
    if (!png && !jpeg) throw new Error("请选择 PNG 或 JPEG 原始截图");
    const mimeType = png ? "image/png" : "image/jpeg";
    const image = new Blob([bytes], { type: mimeType });
    const url = await evidenceDataUrl(image);
    if (isNative) {
      const response = await hostCall<{ item: EvidenceItem }>("addEvidence", { recordId, mimeType, base64: url.split(",")[1] });
      result.push(validateEvidenceItem(response.item, recordId));
      continue;
    }
    const decoded = await createImageBitmap(image).catch(() => { throw new Error("图片损坏或无法读取"); });
    const width = decoded.width, height = decoded.height;
    decoded.close();
    const item = validateEvidenceItem({ id: await evidenceDigest(bytes), recordId, mimeType, sizeBytes: image.size,
      width, height, createdAt: new Date().toISOString() }, recordId);
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("images", "readwrite");
      const store = tx.objectStore("images");
      const exists = store.get([recordId, item.id]);
      // Duplicate imports retain their original timestamp and bytes.
      exists.onsuccess = () => { if (!exists.result) store.add({ ...item, image }); };
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(new Error("保存截图失败，请检查可用空间后重试"));
    });
    result.push(item);
  }
  return result;
}

export async function pickEvidence(recordId: string): Promise<EvidenceItem[]> {
  validateRecordId(recordId);
  const response = await hostCall<{ cancelled?: boolean; items?: EvidenceItem[] }>("pickEvidence", { recordId });
  if (response.cancelled) return [];
  if (!Array.isArray(response.items)) throw new Error("截图未完整保存，请重试");
  return response.items.map((item) => validateEvidenceItem(item, recordId));
}

export async function captureEvidence(recordId: string): Promise<EvidenceItem[]> {
  validateRecordId(recordId);
  if (!isWindows) throw new Error("请先使用手机系统截图，再从相册选择原图");
  const response = await hostCall<{ cancelled?: boolean; items?: EvidenceItem[] }>("captureEvidence", { recordId });
  if (response.cancelled) return [];
  if (!Array.isArray(response.items)) throw new Error("截图未完整保存，请重试");
  return response.items.map((item) => validateEvidenceItem(item, recordId));
}
