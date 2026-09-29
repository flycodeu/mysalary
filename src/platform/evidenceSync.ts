import { hostCall } from "./host";
import { listEvidence, validateEvidenceItem } from "./evidence";

interface RemoteEvidence { recordId: string; id: string; mimeType: string }
export interface EvidenceSyncResult { downloaded: number; uploaded: number }

function validateRemote(value: unknown): RemoteEvidence {
  if (!value || typeof value !== "object") throw new Error("云端截图列表无效");
  const item = value as RemoteEvidence;
  if (!/^[A-Za-z0-9_-]{1,96}$/.test(item.recordId) || !/^[a-f0-9]{64}$/.test(item.id) ||
      !["image/png", "image/jpeg"].includes(item.mimeType)) throw new Error("云端截图信息无效");
  return { recordId: item.recordId, id: item.id, mimeType: item.mimeType };
}
const key = (item: { recordId: string; id: string }) => `${item.recordId}/${item.id}`;

/** Original bytes stay in the native file/network layer. Only hashes and record
 * links cross the bridge; the ledger's v1 format remains readable by old apps. */
export async function syncEvidence(recordIds: string[], progress?: (done: number, total: number) => void): Promise<EvidenceSyncResult> {
  const known = new Set(recordIds);
  if (known.size > 1200 || [...known].some((id) => !/^[A-Za-z0-9_-]{1,96}$/.test(id))) throw new Error("工资记录列表无效");
  if (!known.size) return { downloaded: 0, uploaded: 0 };
  const listing = await hostCall<{ items: unknown[] }>("webdavListEvidence");
  if (!Array.isArray(listing?.items) || listing.items.length > 1200) throw new Error("云端截图列表超过限制或不完整");
  const remote = new Map<string, RemoteEvidence>();
  for (const value of listing.items) {
    const item = validateRemote(value);
    if (remote.has(key(item))) throw new Error("云端同一张截图有重复记录，请检查后重试");
    remote.set(key(item), item);
  }
  const local = new Map<string, RemoteEvidence>();
  for (const recordId of known) for (const item of await listEvidence(recordId)) local.set(key(item), item);
  const downloads = [...remote.values()].filter((item) => known.has(item.recordId) && !local.has(key(item)));
  const uploads = [...local.values()].filter((item) => !remote.has(key(item)));
  for (const item of local.values()) {
    const counterpart = remote.get(key(item));
    if (counterpart && counterpart.mimeType !== item.mimeType) throw new Error("云端截图类型与本机不一致，原图已保留");
  }
  if (remote.size + uploads.length > 1200) throw new Error("云端截图已达到 1200 张，请先备份整理");
  let done = 0;
  progress?.(0, downloads.length + uploads.length);
  for (const item of downloads) {
    const response = await hostCall<{ item: unknown }>("webdavGetEvidence", { ...item });
    const saved = validateEvidenceItem(response?.item, item.recordId);
    if (saved.id !== item.id || saved.mimeType !== item.mimeType) throw new Error("下载的原图与工资记录不一致");
    progress?.(++done, downloads.length + uploads.length);
  }
  for (const item of uploads) {
    await hostCall("webdavPutEvidence", { recordId: item.recordId, id: item.id });
    progress?.(++done, downloads.length + uploads.length);
  }
  return { downloaded: downloads.length, uploaded: uploads.length };
}
