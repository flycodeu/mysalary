import {
  emptyLedger,
  parseLedger,
  serializeLedger,
  type Ledger,
} from "../domain/ledger";
import { hostCall, isNative } from "./host";

let queue: Promise<unknown> = Promise.resolve();
let database: Promise<IDBDatabase> | undefined;
export class LedgerReadError extends Error {}
function openDatabase(): Promise<IDBDatabase> {
  return (database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("salary-ledger", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("state");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      database = undefined;
      reject(new Error("无法打开本机账本"));
    };
  }));
}
async function load(): Promise<Ledger> {
  let content: string | null | undefined;
  if (isNative) {
    const response = await hostCall<{ content: string | null }>("loadLedger");
    if (
      !response ||
      !("content" in response) ||
      (response.content !== null && typeof response.content !== "string")
    )
      throw new Error("本机账本未返回完整读取结果，请重试");
    content = response.content;
  } else {
    const db = await openDatabase();
    content = await new Promise<string | undefined>((resolve, reject) => {
      const request = db
        .transaction("state")
        .objectStore("state")
        .get("ledger");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error("读取工资账本失败"));
    });
  }
  // A damaged file is an error, never an empty ledger that could overwrite the cloud.
  return content == null ? emptyLedger() : parseLedger(content);
}
async function save(ledger: Ledger): Promise<void> {
  const content = serializeLedger(ledger);
  if (isNative) {
    await hostCall("saveLedger", { content });
    return;
  }
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("state", "readwrite");
    const store = tx.objectStore("state");
    const old = store.get("ledger");
    old.onsuccess = () => {
      if (old.result != null) store.put(old.result, "backup");
      store.put(content, "ledger");
    };
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () =>
      reject(new Error("保存工资账本失败，原数据仍保留"));
  });
}
export function deviceId(): string {
  const saved = localStorage.getItem("salary-device-id");
  if (saved && /^[\w.:-]{1,80}$/.test(saved)) return saved;
  const id = crypto.randomUUID();
  localStorage.setItem("salary-device-id", id);
  return id;
}
export function updateLedger(
  operation: (ledger: Ledger) => Ledger | Promise<Ledger>,
): Promise<Ledger> {
  const result = queue.then(async () => {
    let current: Ledger;
    try {
      current = await load();
    } catch {
      throw new LedgerReadError(
        "本机账本无法读取，原文件仍保留。请导入 JSON 档案备份恢复。",
      );
    }
    const updated = await operation(current);
    if (serializeLedger(current) !== serializeLedger(updated))
      await save(updated);
    return updated;
  });
  queue = result.catch(() => undefined);
  return result;
}
export function readLedger(): Promise<Ledger> {
  return updateLedger((ledger) => ledger);
}

export async function waitForLedgerWrites(): Promise<void> {
  await queue;
}

export function restoreLocalLedger(ledger: Ledger): Promise<void> {
  const result = queue.then(async () => {
    const content = serializeLedger(ledger);
    if (isNative) {
      await hostCall("restoreLedger", { content });
      return;
    }
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("state", "readwrite");
      const store = tx.objectStore("state");
      const stamp = `recovery-${Date.now()}-${crypto.randomUUID()}`;
      for (const key of ["ledger", "backup"]) {
        const request = store.get(key);
        request.onsuccess = () => {
          if (request.result != null)
            store.put(request.result, `${stamp}-${key}`);
        };
      }
      store.put(content, "ledger");
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () =>
        reject(new Error("恢复失败，原文件仍保留"));
    });
  });
  queue = result.catch(() => undefined);
  return result;
}
