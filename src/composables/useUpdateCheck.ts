import { computed, readonly, ref } from "vue";
import type { UpdateResult } from "../domain/release";
import { checkForUpdates } from "../platform/updates";

const result = ref<UpdateResult>();
const checking = ref(false);
const error = ref("");
let pending: Promise<void> | undefined;

// Settings and the download sheet share one answer. A failed refresh must not
// leave an old download offer looking like a newly confirmed release.
function check() {
  if (pending) return pending;
  checking.value = true;
  error.value = "";
  result.value = undefined;
  pending = (async () => {
    try { result.value = await checkForUpdates(); }
    catch (cause) { error.value = cause instanceof Error ? cause.message : "检查更新失败，请重试"; }
    finally { checking.value = false; pending = undefined; }
  })();
  return pending;
}

export function useUpdateCheck() {
  const available = computed(() => result.value?.state === "available");
  const label = computed(() => {
    if (checking.value) return "正在检查";
    if (error.value) return "检查失败，点击重试";
    if (result.value?.state === "available") return `有新版本 ${result.value.version}`;
    if (result.value?.state === "current") return "已是最新版本";
    if (result.value?.state === "unpublished") return "暂无公开版本";
    return "检查更新";
  });
  return { result: readonly(result), checking: readonly(checking), error: readonly(error), available, label, check };
}
