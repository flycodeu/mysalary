import {
  emptyLedger,
  mergeLedgers,
  parseLedger,
  serializeLedger,
} from "../domain/ledger";
import { hostCall } from "./host";
import { updateLedger } from "./ledgerStore";
import { readLedger } from "./ledgerStore";
import { syncEvidence } from "./evidenceSync";

export interface SyncSettings {
  configured: boolean;
  username: string;
}
export const getSyncSettings = () => hostCall<SyncSettings>("getSyncSettings");
export const setSyncSettings = (username: string, password: string) =>
  hostCall<void>("setSyncSettings", { username, password });
export const clearSyncSettings = () => hostCall<void>("clearSyncSettings");
interface SyncResult {
  count: number;
  uploaded: boolean;
}

let syncing: Promise<SyncResult> | undefined;

async function performSync(): Promise<SyncResult> {
  const remote = await hostCall<{
    files: Array<{ name: string; content: string }>;
  }>("webdavPull");
  if (!Array.isArray(remote?.files) || remote.files.length > 1201)
    throw new Error("云端档案列表不完整或超过数量限制，本机数据未被替换");
  let remoteLedger = emptyLedger();
  let bytes = 0;
  const names = new Set<string>();
  for (const file of remote.files) {
    if (
      !file ||
      typeof file.name !== "string" ||
      typeof file.content !== "string" ||
      names.has(file.name)
    )
      throw new Error("云端档案列表无效，本机数据未被替换");
    names.add(file.name);
    const match = /^changes-([a-f0-9]{64})\.json$/.exec(file.name);
    if (!match && file.name !== "archive-v1.json")
      throw new Error("云端档案名称无效，本机数据未被替换");
    const encoded = new TextEncoder().encode(file.content);
    bytes += encoded.byteLength;
    if (bytes > 16 * 1024 * 1024)
      throw new Error("云端档案超过 16 MB，请先导出备份后整理");
    if (match) {
      const digest = await crypto.subtle.digest("SHA-256", encoded);
      const hash = Array.from(new Uint8Array(digest), (value) =>
        value.toString(16).padStart(2, "0"),
      ).join("");
      if (hash !== match[1])
        throw new Error("云端档案校验失败，本机数据未被替换");
    }
    remoteLedger = mergeLedgers(remoteLedger, await parseLedger(file.content));
  }
  const merged = await updateLedger((local) => mergeLedgers(local, remoteLedger));
  const remoteEntries = new Map(
    remoteLedger.entries.map((entry) => [entry.id, JSON.stringify(entry)]),
  );
  const changes = merged.entries.filter(
    (entry) => remoteEntries.get(entry.id) !== JSON.stringify(entry),
  );
  if (!changes.length)
    return { count: merged.entries.length, uploaded: false };
  // Content-addressed files make concurrent publishes independent of server overwrite guards.
  // Only changed entries are added; older sources and deletion states remain available for merging.
  await hostCall("webdavPublish", {
    content: serializeLedger({ ...emptyLedger(), entries: changes }),
  });
  return { count: merged.entries.length, uploaded: true };
}
export function syncNutstore(): Promise<SyncResult> {
  return (syncing ??= performSync().finally(() => {
    syncing = undefined;
  }));
}

let completeSync: Promise<SyncResult> | undefined;
export function syncNutstoreWithEvidence(progress?: (done: number, total: number) => void): Promise<SyncResult> {
  return completeSync ??= (async () => {
    const result = await syncNutstore();
    const ledger = await readLedger();
    try { await syncEvidence(ledger.entries.map((entry) => `ledger-${entry.id}`), progress); }
    catch (cause) {
      const reason = cause instanceof Error ? cause.message : "请重试";
      throw new Error(`工资已同步，截图同步未完成：${reason}`);
    }
    return result;
  })().finally(() => { completeSync = undefined; });
}
