import { hostCall } from "./host";
import { deleteEvidence, listDeletedEvidence, listEvidence, validateEvidenceItem } from "./evidence";

interface RemoteEvidence { recordId: string; id: string; mimeType: string }
interface RemoteDeletion { recordId: string; id: string }
export interface EvidenceSyncResult { downloaded: number; uploaded: number }

function validateRemote(value: unknown): RemoteEvidence {
  if (!value || typeof value !== "object") throw new Error("云端截图列表无效");
  const item = value as RemoteEvidence;
  if (!/^[A-Za-z0-9_-]{1,96}$/.test(item.recordId) || !/^[a-f0-9]{64}$/.test(item.id) ||
      !["image/png", "image/jpeg"].includes(item.mimeType)) throw new Error("云端截图信息无效");
  return { recordId: item.recordId, id: item.id, mimeType: item.mimeType };
}
const key = (item: { recordId: string; id: string }) => `${item.recordId}/${item.id}`;
function validateDeletion(value: unknown): RemoteDeletion {
  if (!value || typeof value !== "object") throw new Error("云端截图删除记录无效");
  const item = value as RemoteDeletion;
  if (!/^[A-Za-z0-9_-]{1,96}$/.test(item.recordId) || !/^[a-f0-9]{64}$/.test(item.id)) throw new Error("云端截图删除记录无效");
  return { recordId: item.recordId, id: item.id };
}

/** Original bytes stay native. A deletion marker reaches the cloud before its
 * image is removed, so another current client cannot re-import an old copy. */
export async function syncEvidence(recordIds: string[], progress?: (done: number, total: number) => void): Promise<EvidenceSyncResult> {
  const known = new Set(recordIds);
  if (known.size > 1200 || [...known].some((id) => !/^[A-Za-z0-9_-]{1,96}$/.test(id))) throw new Error("工资记录列表无效");
  if (!known.size) return { downloaded: 0, uploaded: 0 };
  const listing = await hostCall<{ items: unknown[]; deleted: unknown[] }>("webdavListEvidence");
  if (!Array.isArray(listing?.items) || !Array.isArray(listing?.deleted) || listing.items.length > 1200 || listing.deleted.length > 1200)
    throw new Error("云端截图列表超过限制或不完整");
  const remote = new Map<string, RemoteEvidence>();
  for (const value of listing.items) {
    const item = validateRemote(value);
    if (remote.has(key(item))) throw new Error("云端同一张截图有重复记录，请检查后重试");
    remote.set(key(item), item);
  }
  const remoteDeleted = new Map<string, RemoteDeletion>();
  for (const value of listing.deleted) {
    const item = validateDeletion(value);
    if (remoteDeleted.has(key(item))) throw new Error("云端同一张截图有重复删除记录");
    remoteDeleted.set(key(item), item);
  }
  const local = new Map<string, RemoteEvidence>();
  const localDeleted = new Map<string, RemoteDeletion>();
  for (const recordId of known) {
    for (const item of await listEvidence(recordId)) local.set(key(item), item);
    for (const id of await listDeletedEvidence(recordId)) localDeleted.set(key({ recordId, id }), { recordId, id });
  }
  const deleted = new Map([...remoteDeleted, ...localDeleted].filter(([, item]) => known.has(item.recordId)));
  const markerUploads = [...localDeleted.values()].filter((item) => !remoteDeleted.has(key(item)));
  const localRemovals = [...remoteDeleted.values()].filter((item) => known.has(item.recordId) && !localDeleted.has(key(item)));
  const cloudRemovals = [...remote.values()].filter((item) => deleted.has(key(item)));
  const downloads = [...remote.values()].filter((item) => known.has(item.recordId) && !deleted.has(key(item)) && !local.has(key(item)));
  const uploads = [...local.values()].filter((item) => !deleted.has(key(item)) && !remote.has(key(item)));
  for (const item of local.values()) {
    if (deleted.has(key(item))) continue;
    const counterpart = remote.get(key(item));
    if (counterpart && counterpart.mimeType !== item.mimeType) throw new Error("云端截图类型与本机不一致，原图已保留");
  }
  if (remote.size - cloudRemovals.length + uploads.length > 1200 || remoteDeleted.size + markerUploads.length > 1200)
    throw new Error("云端截图已达到 1200 张，请先备份整理");
  let done = 0;
  const total = markerUploads.length + localRemovals.length + cloudRemovals.length + downloads.length + uploads.length;
  progress?.(0, total);
  for (const item of markerUploads) {
    await hostCall("webdavPutEvidenceDeletion", { ...item });
    progress?.(++done, total);
  }
  for (const item of localRemovals) {
    await deleteEvidence(item.recordId, item.id);
    progress?.(++done, total);
  }
  for (const item of cloudRemovals) {
    await hostCall("webdavDeleteEvidence", { ...item });
    progress?.(++done, total);
  }
  for (const item of downloads) {
    const response = await hostCall<{ item: unknown }>("webdavGetEvidence", { ...item });
    const saved = validateEvidenceItem(response?.item, item.recordId);
    if (saved.id !== item.id || saved.mimeType !== item.mimeType) throw new Error("下载的原图与工资记录不一致");
    progress?.(++done, total);
  }
  for (const item of uploads) {
    await hostCall("webdavPutEvidence", { recordId: item.recordId, id: item.id });
    progress?.(++done, total);
  }
  return { downloaded: downloads.length, uploaded: uploads.length };
}
