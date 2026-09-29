<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { addEvidenceFiles, captureEvidence, deleteEvidence, listEvidence, pickEvidence, readEvidence, type EvidenceItem } from "../platform/evidence";
import { isNative, isWindows } from "../platform/host";
import AppIcon from "./AppIcon.vue";
import ModalSheet from "./ModalSheet.vue";

const props = defineProps<{ open: boolean; recordId: string; title: string; masked: boolean }>();
const emit = defineEmits<{ close: []; working: [busy: boolean]; changed: [count: number] }>();
const filesInput = ref<HTMLInputElement>();
const images = ref<EvidenceItem[]>([]);
const chosen = ref<string>();
const preview = ref("");
const zoomed = ref(false);
const error = ref("");
const loading = ref(false);
const saving = ref(false);
const reading = ref(false);
const pendingDelete = ref<string>();
const busy = computed(() => saving.value || reading.value);
let recordRequest = 0;
let previewRequest = 0;
let listRequest = 0;

watch(busy, (value) => emit("working", value), { flush: "sync" });
watch(() => props.recordId, () => {
  recordRequest++;
  previewRequest++;
  images.value = [];
  chosen.value = undefined;
  pendingDelete.value = undefined;
  preview.value = "";
  zoomed.value = false;
  error.value = "";
  reading.value = false;
  emit("changed", 0);
  void refresh();
}, { immediate: true });
watch(() => props.open, (open) => {
  if (open) void refresh();
  else { previewRequest++; preview.value = ""; reading.value = false; }
});
watch(() => props.masked, (masked) => {
  if (masked) { previewRequest++; preview.value = ""; reading.value = false; }
  else if (props.open && chosen.value) void showImage(chosen.value);
});

async function refresh() {
  const request = recordRequest;
  const listing = ++listRequest;
  const recordId = props.recordId;
  loading.value = true;
  error.value = "";
  try {
    const next = await listEvidence(recordId);
    if (request !== recordRequest || listing !== listRequest) return;
    images.value = next;
    emit("changed", next.length);
    if (!next.some((image) => image.id === chosen.value)) chosen.value = next[0]?.id;
    if (props.open && chosen.value && !props.masked && !preview.value) await showImage(chosen.value);
  } catch (cause) {
    if (request === recordRequest && listing === listRequest) error.value = cause instanceof Error ? cause.message : "截图列表读取失败，请重试";
  } finally { if (request === recordRequest && listing === listRequest) loading.value = false; }
}

async function showImage(id: string) {
  if (props.masked) return;
  const request = ++previewRequest;
  const recordId = props.recordId;
  chosen.value = id;
  preview.value = "";
  zoomed.value = false;
  reading.value = true;
  error.value = "";
  try {
    const url = await readEvidence(recordId, id);
    if (request === previewRequest && recordId === props.recordId && !props.masked && props.open) preview.value = url;
  } catch (cause) {
    if (request === previewRequest) error.value = cause instanceof Error ? cause.message : "截图读取失败，原文件仍保留在本机";
  } finally { if (request === previewRequest) reading.value = false; }
}

async function save(operation: (recordId: string) => Promise<EvidenceItem[]>) {
  if (busy.value) return;
  const request = recordRequest;
  const recordId = props.recordId;
  saving.value = true;
  error.value = "";
  try {
    const added = await operation(recordId);
    if (request !== recordRequest || !added.length) return;
    preview.value = "";
    chosen.value = added[added.length - 1]?.id;
    await refresh();
  } catch (cause) {
    if (request === recordRequest) {
      const message = cause instanceof Error ? cause.message : "截图保存失败，请重试";
      // Multi-file selection may have saved earlier originals before one file failed.
      await refresh();
      if (request === recordRequest) error.value = message;
    }
  } finally { saving.value = false; }
}

function pick() {
  if (busy.value) return;
  if (isNative) void save(pickEvidence);
  else filesInput.value?.click();
}

async function filesChanged(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = "";
  if (files.length) await save((recordId) => addEvidenceFiles(recordId, files));
}

async function confirmDelete() {
  const id = pendingDelete.value;
  if (!id || busy.value) return;
  const request = recordRequest;
  const recordId = props.recordId;
  pendingDelete.value = undefined;
  saving.value = true;
  error.value = "";
  try {
    await deleteEvidence(recordId, id);
    if (request !== recordRequest) return;
    previewRequest++;
    preview.value = "";
    chosen.value = undefined;
    await refresh();
  } catch (cause) {
    if (request === recordRequest) {
      await refresh();
      error.value = cause instanceof Error ? cause.message : "删除截图失败，请重试";
    }
  } finally { saving.value = false; }
}

onUnmounted(() => { recordRequest++; previewRequest++; emit("working", false); });
</script>

<template>
  <ModalSheet :open="open" :title="`${title} · 原始截图`" :busy="busy" @close="$emit('close')">
    <div class="evidence-panel">
      <p v-if="error" class="evidence-error" role="alert">{{ error }}</p>
      <div class="evidence-actions">
        <button v-if="isWindows" class="primary-button" :disabled="busy" @click="save(captureEvidence)"><AppIcon name="scan" />截取工资页</button>
        <button :class="isWindows ? 'secondary-button' : 'primary-button'" :disabled="busy" @click="pick"><AppIcon name="image" />添加截图</button>
        <button v-if="error" class="text-button" :disabled="busy" @click="refresh">重试读取</button>
        <span v-if="images.length" class="evidence-count">{{ images.length }} 张</span>
      </div>
      <input ref="filesInput" type="file" accept="image/png,image/jpeg" multiple hidden aria-label="选择工资截图" @change="filesChanged" />
      <p v-if="saving" class="evidence-loading" role="status"><span class="spinner" />正在保存原图</p>
      <p v-else-if="loading && !images.length" class="evidence-loading" role="status">正在读取截图</p>
      <div v-if="images.length" class="evidence-gallery">
        <div v-if="images.length > 1" class="evidence-tabs" aria-label="切换原始截图">
          <button v-for="(image, index) in images" :key="image.id" :aria-pressed="chosen === image.id" :disabled="saving" @click="showImage(image.id)">截图 {{ index + 1 }}</button>
        </div>
        <div v-if="masked" class="evidence-empty">金额已隐藏，原图同时隐藏。</div>
        <div v-else-if="reading" class="evidence-loading" role="status">正在打开原图</div>
        <template v-else-if="preview">
          <div class="evidence-preview-tools">
            <button class="text-button" :aria-pressed="zoomed" @click="zoomed = !zoomed">{{ zoomed ? "适应宽度" : "原始尺寸" }}</button>
            <button class="text-button evidence-delete" :disabled="busy" @click="pendingDelete = chosen"><AppIcon name="trash" />删除截图</button>
          </div>
          <div class="evidence-image" :class="{ zoomed }"><img :src="preview" alt="已保存的工资页面原始截图" /></div>
        </template>
      </div>
      <div v-else-if="!loading && !saving" class="evidence-empty"><AppIcon name="image" /><h3>保留原始凭证</h3><p>{{ isWindows ? "展开公司的工资页面后截取，或添加已有截图。" : "在公司工资页面截屏，再将原图添加到这条记录。" }}</p></div>
      <p class="evidence-note">原图保存在本机，与工资记录关联。</p>
    </div>
  </ModalSheet>
  <ModalSheet :open="Boolean(pendingDelete)" title="删除截图" centered :busy="saving" @close="pendingDelete = undefined">
    <p class="evidence-delete-copy">删除后无法重新添加同一张原图。<span v-if="isNative">下次同步会从其他设备和坚果云移除。</span></p>
    <div class="sheet-actions">
      <button class="secondary-button" :disabled="saving" @click="pendingDelete = undefined">取消</button>
      <button class="danger-button" :disabled="saving" @click="confirmDelete">确认删除</button>
    </div>
  </ModalSheet>
</template>

<style scoped>
.evidence-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-bottom: 16px; }.evidence-actions button { font-size: 13px; }.evidence-count { margin-left: auto; color: var(--muted); font-size: 13px; }
.evidence-error { padding: 12px; margin-bottom: 16px; background: var(--danger-soft); color: var(--danger); border-radius: var(--radius-sm); font-size: 13px; }
.evidence-empty { padding: 34px 10px; color: var(--muted); text-align: center; font-size: 14px; }.evidence-empty > svg { width: 36px; height: 36px; color: #8ca598; }.evidence-empty h3 { color: var(--ink); font-size: 17px; margin: 12px 0 8px; }.evidence-empty p { max-width: 330px; margin: auto; line-height: 1.8; }
.evidence-tabs { display: flex; gap: 8px; padding-bottom: 12px; overflow-x: auto; }.evidence-tabs button { flex-shrink: 0; padding: 8px 14px; border: 1px solid var(--line); border-radius: var(--radius-sm); font-size: 13px; }.evidence-tabs button[aria-pressed="true"] { background: var(--accent-soft); color: var(--accent); border-color: var(--accent); }
.evidence-image { max-height: 60dvh; overflow: auto; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--subtle); }.evidence-image img { display: block; max-width: 100%; height: auto; margin: 0 auto; }
.evidence-image.zoomed img { max-width: none; }.evidence-preview-tools { display: flex; justify-content: flex-end; gap: 10px; margin: -8px 0 4px; }.evidence-preview-tools button { min-height: 32px; font-size: 12px; color: var(--accent); }.evidence-preview-tools .evidence-delete { color: var(--danger); }.evidence-delete svg { width: 15px; height: 15px; }.evidence-delete-copy { line-height: 1.7; color: var(--muted); margin: 0 0 20px; }
.evidence-note { font-size: 12px; color: var(--muted); line-height: 1.7; margin-top: 16px; }.evidence-loading { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--muted); padding: 20px 0; }
</style>
