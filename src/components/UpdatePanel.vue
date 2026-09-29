<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { RELEASES_URL } from "../domain/release";
import { appVersion, cancelUpdateDownload, downloadUpdate, getUpdateDownloadStatus, installUpdate, openRelease, type DownloadUpdateStatus } from "../platform/updates";
import { useUpdateCheck } from "../composables/useUpdateCheck";
import { waitForLedgerWrites } from "../platform/ledgerStore";
import { isAndroid, isNative } from "../platform/host";
import AppIcon from "./AppIcon.vue";
import ModalSheet from "./ModalSheet.vue";

const props = defineProps<{ open: boolean; blocked?: boolean }>();
const emit = defineEmits<{ close: []; working: [busy: boolean] }>();
const updates = useUpdateCheck();
const { result, checking } = updates;
const actionError = ref("");
const error = computed(() => actionError.value || updates.error.value);
const downloadState = ref<DownloadUpdateStatus>({ state: "idle" });
const requesting = ref(false);
const installing = ref(false);
const downloading = computed(() => requesting.value || ["downloading", "verifying"].includes(downloadState.value.state));
const working = computed(() => downloading.value || installing.value);
const ready = computed(() => result.value?.state === "available" &&
  downloadState.value.state === "ready" && downloadState.value.version === result.value.version);
const progress = computed(() => downloadState.value.totalBytes
  ? Math.min(100, Math.max(0, Math.round((downloadState.value.receivedBytes ?? 0) * 100 / downloadState.value.totalBytes)))
  : 0);
let progressTimer: ReturnType<typeof setInterval> | undefined;
let readingStatus = false;
watch(working, (value) => emit("working", value), { flush: "sync" });

async function check() {
  if (working.value) return;
  actionError.value = "";
  await updates.check();
}
async function launchRelease(url: string) {
  if (props.blocked || working.value) return;
  installing.value = true;
  actionError.value = "";
  try { await waitForLedgerWrites(); await openRelease(url); }
  catch (cause) { actionError.value = cause instanceof Error ? cause.message : "无法打开发行页面"; }
  finally { installing.value = false; }
}
async function refreshDownloadState() {
  if (!isNative || readingStatus) return;
  readingStatus = true;
  try { downloadState.value = await getUpdateDownloadStatus(); }
  catch { /* Explicit actions surface errors; a transient progress read is retried. */ }
  finally { readingStatus = false; }
}
function stopProgressPolling() {
  if (progressTimer) clearInterval(progressTimer);
  progressTimer = undefined;
}
function startProgressPolling() {
  if (!progressTimer) progressTimer = setInterval(() => void refreshDownloadState(), 500);
}
async function openInstaller(version: string) {
  await waitForLedgerWrites();
  const response = await installUpdate(version);
  if (response.state === "permission-required") actionError.value = "请允许安装未知应用，返回后继续安装。";
}
async function updateNow() {
  const release = result.value;
  if (!isNative || props.blocked || checking.value || release?.state !== "available" || !release.download || working.value) return;
  actionError.value = "";
  requesting.value = true;
  downloadState.value = { state: "downloading", version: release.version };
  startProgressPolling();
  try {
    downloadState.value = await downloadUpdate(release.version);
    if (downloadState.value.state === "ready") {
      installing.value = true;
      await openInstaller(release.version);
    } else if (downloadState.value.state === "error") actionError.value = downloadState.value.error ?? "下载更新失败";
  } catch (cause) { actionError.value = cause instanceof Error ? cause.message : "下载更新失败"; }
  finally {
    requesting.value = false;
    installing.value = false;
    await refreshDownloadState();
    if (!downloading.value) stopProgressPolling();
  }
}
async function cancelDownload() {
  if (!downloading.value) return;
  try { await cancelUpdateDownload(); await refreshDownloadState(); }
  catch { actionError.value = "取消未完成，请重试"; }
}
async function installReady() {
  const version = downloadState.value.version;
  if (!isNative || !ready.value || !version || working.value || props.blocked) return;
  installing.value = true;
  actionError.value = "";
  try { await openInstaller(version); }
  catch (cause) { actionError.value = cause instanceof Error ? cause.message : "无法打开安装确认"; }
  finally { installing.value = false; }
}
watch(() => props.open, async (value) => {
  if (!value) { stopProgressPolling(); return; }
  await refreshDownloadState();
  if (downloading.value) startProgressPolling();
  else void check();
});
onBeforeUnmount(() => { stopProgressPolling(); emit("working", false); });
</script>

<template>
  <ModalSheet :open="open" title="应用更新" :busy="working || checking" @close="$emit('close')">
    <div class="update-identity"><img src="/brand.svg" alt="" /><div><strong>薪迹</strong><span>当前版本 {{ appVersion }}</span></div></div>
    <div class="update-status" role="status" aria-live="polite">
      <p v-if="checking"><span class="spinner" />正在检查更新</p>
      <template v-else-if="downloading">
        <h3>{{ downloadState.state === "verifying" ? "正在校验更新" : "正在下载更新" }}</h3>
        <div class="update-progress" role="progressbar" :aria-valuenow="progress" aria-valuemin="0" aria-valuemax="100"><span :style="{ width: `${progress}%` }" /></div>
        <p class="update-progress-label">{{ downloadState.state === "verifying" ? "下载完成，正在校验" : `${progress}%` }}</p>
      </template>
      <p v-else-if="error" class="update-error">{{ error }}</p>
      <p v-else-if="result?.state === 'unpublished'">暂未找到公开发行版</p>
      <p v-else-if="result?.state === 'current'"><AppIcon name="check" />已是最新版本</p>
      <template v-else-if="result?.state === 'available'">
        <h3>发现新版本 {{ result.version }}</h3>
        <p v-if="isAndroid && result.download">下载完成后，按系统提示覆盖安装。工资和截图会保留。</p>
        <p v-else-if="isNative && result.download">应用会下载并校验安装包，然后退出并打开安装器。工资和截图会保留。</p>
        <p v-else>前往发行页面查看更新内容和可用安装包。</p>
        <details v-if="result.notes" class="update-notes"><summary>更新内容</summary><pre>{{ result.notes }}</pre></details>
      </template>
      <p v-if="blocked" class="update-error">正在保存或同步，完成后可更新。</p>
    </div>
    <div class="sheet-actions">
      <button class="secondary-button" :disabled="checking || working" @click="check"><AppIcon name="sync" />重新检查</button>
      <button v-if="isNative && downloading" class="secondary-button" @click="cancelDownload"><AppIcon name="close" />取消下载</button>
      <template v-else-if="result?.state === 'available'">
        <button v-if="isNative && result.download && ready" class="primary-button" :disabled="installing || blocked" @click="installReady"><AppIcon name="download" />{{ installing ? '正在打开安装' : '继续安装' }}</button>
        <button v-else-if="isNative && result.download" class="primary-button" :disabled="working || blocked" @click="updateNow"><AppIcon name="download" />立即更新</button>
        <button v-else class="primary-button" :disabled="working || blocked" @click="launchRelease(result.url)"><AppIcon name="download" />{{ result.download ? '获取新版' : '查看发行版' }}</button>
      </template>
      <button v-else class="text-button" :disabled="working || blocked" @click="launchRelease(RELEASES_URL)">发行页面<AppIcon name="arrow" /></button>
    </div>
  </ModalSheet>
</template>
