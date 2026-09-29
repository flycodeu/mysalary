import { computed, onMounted, onUnmounted, ref, watch, type Ref } from "vue";
import {
  deleteImport,
  importBrowserCapture,
  captureFeishu,
  exportArchive,
  importDataText,
  processPendingFiles,
  listImports,
  pickNativeData,
  restoreImport,
  watchImports,
  type ArchiveItem,
  type ImportEvent,
} from "../platform/archive";
import { hostCall, isNative } from "../platform/host";
import { LedgerReadError, restoreLocalLedger } from "../platform/ledgerStore";
import { parseLedger, type Ledger } from "../domain/ledger";

/** Archive operations share one lifecycle so imports never bypass startup or recovery. */
export function useArchive(fileInput: Ref<HTMLInputElement | undefined>) {
  const items = ref<ArchiveItem[]>([]);
  const selected = ref<ArchiveItem>();
  const busy = ref(false);
  const initialLoading = ref(true);
  const archiveLoadError = ref(false);
  const operationBlocked = computed(() => busy.value || initialLoading.value);
  const storageState = computed(() =>
    initialLoading.value ? "loading" : archiveLoadError.value ? "error" : "ready",
  );
  const error = ref("");
  const notice = ref("");
  const ledgerUnreadable = ref(false);
  const recovery = ref<{ ledger: Ledger; pendingId?: string }>();
  const showDeleted = ref(false);
  const deleteTarget = ref<ArchiveItem>();
  const year = ref("");
  let unwatch = () => {};
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  watch(notice, (message) => {
    clearTimeout(noticeTimer);
    if (message) {
      noticeTimer = setTimeout(() => {
        notice.value = "";
      }, 5000);
    }
  });
  const active = computed(() =>
    items.value.filter((item) => !item.deletedAt && !item.demo),
  );
  const deleted = computed(() => items.value.filter((item) => item.deletedAt));
  const years = computed(
    () =>
      [
        ...new Set(
          active.value
            .map((item) => item.draft?.payrollMonth?.slice(0, 4))
            .filter(Boolean),
        ),
      ]
        .sort()
        .reverse() as string[],
  );
  async function refresh() {
    try {
      items.value = await listImports();
      ledgerUnreadable.value = false;
      archiveLoadError.value = false;
    } catch (cause) {
      archiveLoadError.value = true;
      if (cause instanceof LedgerReadError) ledgerUnreadable.value = true;
      throw cause;
    }
    if (year.value && !years.value.includes(year.value)) year.value = "";
    if (selected.value && !selected.value.demo)
      selected.value = items.value.find(
        (item) => item.id === selected.value!.id && !item.deletedAt,
      );
  }
  async function retryArchive() {
    if (operationBlocked.value) return;
    initialLoading.value = true;
    error.value = "";
    try {
      await refresh();
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : "档案读取失败";
    } finally {
      initialLoading.value = false;
    }
  }
  async function receiveImport(event: ImportEvent = {}) {
    try {
      if (event.content) {
        await importDataText(event.content);
        if (event.pendingId)
          await hostCall("ackDataFile", { pendingId: event.pendingId });
        notice.value = "工资文件已合并";
      }
      await refresh();
      if (event.error) {
        error.value = event.error;
        return;
      }
      if (event.id) notice.value = "工资文件已保存";
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : "档案读取失败";
    }
  }
  async function finishImport(imported: ArchiveItem[]) {
    if (!imported.length) return;
    await refresh();
    showDeleted.value = false;
    year.value = "";
    const failed = imported.filter((item) => item.status === "error");
    notice.value = failed.length
      ? "来源文件已保留，部分内容无法读取"
      : `已合并 ${imported.length} 份工资记录`;
    if (imported.length === 1)
      selected.value = items.value.find(
        (item) => item.id === imported[0]!.id && !item.deletedAt,
      );
    else selected.value = undefined;
  }
  async function importFile() {
    if (operationBlocked.value) return;
    if (!isNative) {
      fileInput.value?.click();
      return;
    }
    busy.value = true;
    error.value = "";
    notice.value = "";
    try {
      const file = await pickNativeData();
      if (!file.cancelled && file.content)
        await acceptText(file.content, file.pendingId);
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : "工资文件导入失败";
    } finally {
      busy.value = false;
    }
  }
  async function acceptText(content: string, pendingId?: string) {
    if (ledgerUnreadable.value) {
      recovery.value = { ledger: await parseLedger(content), pendingId };
      return;
    }
    await finishImport(await importDataText(content));
    if (pendingId) await hostCall("ackDataFile", { pendingId });
  }
  async function recover() {
    if (!recovery.value || busy.value) return;
    busy.value = true;
    try {
      await restoreLocalLedger(recovery.value.ledger);
      if (recovery.value.pendingId)
        await hostCall("ackDataFile", { pendingId: recovery.value.pendingId });
      recovery.value = undefined;
      error.value = "";
      selected.value = undefined;
      await refresh();
      notice.value = "已从 JSON 备份恢复本机账本";
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : "恢复失败";
    } finally {
      busy.value = false;
    }
  }
  async function collect() {
    if (operationBlocked.value) return;
    busy.value = true;
    error.value = "";
    notice.value = "";
    try {
      await finishImport(await captureFeishu());
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : "读取飞书工资失败";
    } finally {
      busy.value = false;
    }
  }
  async function exportFile() {
    if (operationBlocked.value) return;
    busy.value = true;
    error.value = "";
    try {
      if (await exportArchive()) notice.value = "工资档案已导出";
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : "导出失败";
    } finally {
      busy.value = false;
    }
  }
  async function afterSync() {
    try {
      await refresh();
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : "刷新档案失败";
    }
  }
  async function filesChanged(event: Event) {
    if (operationBlocked.value) return;
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    busy.value = true;
    error.value = "";
    notice.value = "";
    try {
      if (ledgerUnreadable.value) {
        if (file.size > 8 * 1024 * 1024) throw new Error("工资文件超过 8 MB");
        await acceptText(
          new TextDecoder("utf-8", { fatal: true }).decode(
            await file.arrayBuffer(),
          ),
        );
      } else await finishImport(await importBrowserCapture(file));
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : "工资文件导入失败";
    } finally {
      busy.value = false;
      input.value = "";
    }
  }
  async function removeArchive() {
    const target = deleteTarget.value;
    if (!target || busy.value) return;
    busy.value = true;
    try {
      await deleteImport(target);
      if (selected.value?.id === target.id) selected.value = undefined;
      deleteTarget.value = undefined;
      await refresh();
      notice.value = "已移至已删除";
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : "删除失败";
    } finally {
      busy.value = false;
    }
  }
  async function restoreArchive(item: ArchiveItem) {
    if (operationBlocked.value) return;
    busy.value = true;
    try {
      await restoreImport(item);
      await refresh();
      notice.value = "工资档案已恢复";
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : "恢复失败";
    } finally {
      busy.value = false;
    }
  }
  onMounted(async () => {
    try {
      unwatch = await watchImports((event) => {
        void receiveImport(event);
      });
      await processPendingFiles();
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : "档案读取失败";
    }
    // A bad shared file must not hide the ledger already saved on this device.
    try {
      await refresh();
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : "档案读取失败";
    } finally {
      initialLoading.value = false;
    }
  });
  onUnmounted(() => {
    unwatch();
    clearTimeout(noticeTimer);
  });
  return {
    selected,
    busy,
    initialLoading,
    archiveLoadError,
    operationBlocked,
    storageState,
    error,
    notice,
    ledgerUnreadable,
    recovery,
    showDeleted,
    deleteTarget,
    year,
    active,
    deleted,
    years,
    retryArchive,
    importFile,
    recover,
    collect,
    exportFile,
    afterSync,
    filesChanged,
    removeArchive,
    restoreArchive,
  };
}
