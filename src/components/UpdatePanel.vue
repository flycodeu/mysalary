<script setup lang="ts">
import { ref, watch } from "vue";
import { type UpdateResult, RELEASES_URL } from "../domain/release";
import { appVersion, checkForUpdates, openRelease } from "../platform/updates";
import { isNative, isWindows } from "../platform/host";
import AppIcon from "./AppIcon.vue";
import ModalSheet from "./ModalSheet.vue";

const props = defineProps<{ open: boolean }>();
defineEmits<{ close: [] }>();
const checking = ref(false);
const error = ref("");
const result = ref<UpdateResult>();
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
watch(() => props.open, (value) => { if (value) void check(); });
</script>

<template>
  <ModalSheet :open="open" title="应用更新" @close="$emit('close')">
    <div class="update-identity"><img src="/brand.svg" alt="" /><div><strong>薪迹</strong><span>当前版本 {{ appVersion }}</span></div></div>
    <div class="update-status" role="status" aria-live="polite">
      <p v-if="checking"><span class="spinner" />正在检查更新</p>
      <p v-else-if="error" class="update-error">{{ error }}</p>
      <p v-else-if="result?.state === 'unpublished'">暂未找到公开发行版</p>
      <p v-else-if="result?.state === 'current'"><AppIcon name="check" />已是最新版本</p>
      <template v-else-if="result?.state === 'available'">
        <h3>发现新版本 {{ result.version }}</h3>
        <p v-if="isNative && result.download">{{ isWindows ? '下载后运行安装包，即可覆盖升级并保留档案。' : '下载后按系统提示安装，即可更新并保留档案。' }}</p>
        <p v-else>前往发行页面查看更新内容和可用安装包。</p>
        <details v-if="result.notes" class="update-notes"><summary>更新内容</summary><pre>{{ result.notes }}</pre></details>
      </template>
    </div>
    <div class="sheet-actions">
      <button class="secondary-button" :disabled="checking" @click="check"><AppIcon name="sync" />重新检查</button>
      <button v-if="result?.state === 'available'" class="primary-button" @click="launchRelease(result.url)"><AppIcon name="download" />{{ result.download ? '获取新版' : '查看发行版' }}</button>
      <button v-else class="text-button" @click="launchRelease(RELEASES_URL)">发行页面<AppIcon name="arrow" /></button>
    </div>
  </ModalSheet>
</template>
