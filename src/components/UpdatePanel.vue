<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { type UpdateResult, RELEASES_URL } from "../domain/release";
import { appVersion, cancelUpdateDownload, checkForUpdates, downloadUpdate, getUpdateDownloadStatus, installUpdate, openRelease, type DownloadUpdateStatus } from "../platform/updates";
import { isAndroid, isNative } from "../platform/host";
import AppIcon from "./AppIcon.vue";
import ModalSheet from "./ModalSheet.vue";

const props = defineProps<{ open: boolean }>();
defineEmits<{ close: [] }>();
const checking = ref(false);
const error = ref("");
const result = ref<UpdateResult>();
const downloadState = ref<DownloadUpdateStatus>({ state: "idle" });
const installing = ref(false);
let progressTimer: ReturnType<typeof setInterval> | undefined;
const downloading = computed(() => downloadState.value.state === "downloading" || downloadState.value.state === "verifying");
async function check() {
  if (checking.value) return;
  checking.value = true;
  error.value = "";
  result.value = undefined;
  try { result.value = await checkForUpdates(); }
  catch (cause) { error.value = cause instanceof Error ? cause.message : "检查更新失败"; }
  finally { checking.value = false; }
}
async function launchRelease(url: string) {
  try { await openRelease(url); }
  catch (cause) { error.value = cause instanceof Error ? cause.message : "无法打开发行页面"; }
}
async function refreshDownloadState() {
  try { downloadState.value = await getUpdateDownloadStatus(); } catch { /* the next request will surface bridge errors */ }
}
function startProgressPolling() {
  if (progressTimer) return;
  void refreshDownloadState();
  progressTimer = setInterval(() => void refreshDownloadState(), 400);
}
function stopProgressPolling() {
  if (progressTimer) clearInterval(progressTimer);
  progressTimer = undefined;
}
async function updateNow() {
  if (!isAndroid || checking.value || !result.value || result.value.state !== "available" || !result.value.download || downloading.value || installing.value) return;
  error.value = "";
  startProgressPolling();
  try {
    downloadState.value = await downloadUpdate(result.value.version);
    if (downloadState.value.state === "ready") {
      const response = await installUpdate(result.value.version);
      if (response.state === "permission-required") error.value = "请允许安装未知来源应用，然后再次点击安装";
    }
    else if (downloadState.value.state === "error") error.value = downloadState.value.error ?? "下载更新失败";
  } catch (cause) { error.value = cause instanceof Error ? cause.message : "下载更新失败"; }
  finally { await refreshDownloadState(); if (!downloading.value) stopProgressPolling(); }
}
async function cancelDownload() {
  if (!downloading.value) return;
  cancelUpdateDownload();
  await refreshDownloadState();
  stopProgressPolling();
}
async function installReady() {
  const version = downloadState.value.version;
  if (!isAndroid || downloadState.value.state !== "ready" || !version || installing.value) return;
  installing.value = true;
  try { const response = await installUpdate(version); if (response.state === "permission-required") error.value = "请允许安装未知来源应用，然后再次点击安装"; }
  catch (cause) { error.value = cause instanceof Error ? cause.message : "无法打开安装确认"; }
  finally { installing.value = false; }
}
watch(() => props.open, (value) => { if (value) { void check(); void refreshDownloadState(); } else { stopProgressPolling(); } });
onBeforeUnmount(stopProgressPolling);
</script>

<template>
  <ModalSheet :open="open" title="应用更新" :busy="downloading || checking || installing" @close="$emit('close')">
    <div class="update-identity"><img src="/brand.svg" alt="" /><div><strong>薪迹</strong><span>当前版本 {{ appVersion }}</span></div></div>
    <div class="update-status" role="status" aria-live="polite">
      <p v-if="checking"><span class="spinner" />正在检查更新</p>
      <template v-else-if="downloading">
        <h3>{{ downloadState.state === "verifying" ? "正在校验更新" : "正在下载更新" }}</h3>
        <div class="update-progress" role="progressbar" :aria-valuenow="downloadState.totalBytes ? Math.round((downloadState.receivedBytes ?? 0) * 100 / downloadState.totalBytes) : undefined" aria-valuemin="0" aria-valuemax="100"><span :style="{ width: `${downloadState.totalBytes ? Math.max(8, Math.round((downloadState.receivedBytes ?? 0) * 100 / downloadState.totalBytes)) : 8}%` }" /></div>
        <p class="update-progress-label"><span>{{ downloadState.state === "verifying" ? "正在校验" : "正在下载" }}</span><span v-if="downloadState.totalBytes">{{ downloadState.receivedBytes ?? 0 }} / {{ downloadState.totalBytes }} 字节</span></p>
      </template>
      <p v-else-if="error" class="update-error">{{ error }}</p>
      <p v-else-if="result?.state === 'unpublished'">暂未找到公开发行版</p>
      <p v-else-if="result?.state === 'current'"><AppIcon name="check" />已是最新版本</p>
      <template v-else-if="result?.state === 'available'">
        <h3>发现新版本 {{ result.version }}</h3>
        <p v-if="isAndroid && result.download">在应用内下载并校验 APK，然后按系统提示覆盖安装。</p>
        <p v-else-if="isNative && result.download">下载后运行安装包，即可覆盖升级并保留档案。</p>
        <p v-else>前往发行页面查看更新内容和可用安装包。</p>
        <details v-if="result.notes" class="update-notes"><summary>更新内容</summary><pre>{{ result.notes }}</pre></details>
      </template>
    </div>
    <div class="sheet-actions">
      <button class="secondary-button" :disabled="checking" @click="check"><AppIcon name="sync" />重新检查</button>
      <template v-if="result?.state === 'available'">
        <button v-if="isAndroid && result.download && downloading" class="secondary-button" @click="cancelDownload"><AppIcon name="close" />取消下载</button>
        <button v-else-if="isAndroid && result.download && downloadState.state === 'ready'" class="primary-button" :disabled="installing" @click="installReady"><AppIcon name="download" />{{ installing ? '正在打开安装' : '继续安装' }}</button>
        <button v-else-if="isAndroid && result.download" class="primary-button" :disabled="downloading" @click="updateNow"><AppIcon name="download" />立即更新</button>
        <button v-else class="primary-button" @click="launchRelease(result.url)"><AppIcon name="download" />{{ result.download ? '获取新版' : '查看发行版' }}</button>
      </template>
      <button v-else class="text-button" @click="launchRelease(RELEASES_URL)">发行页面<AppIcon name="arrow" /></button>
    </div>
  </ModalSheet>
</template>
