<script setup lang="ts">
import { appVersion } from "../platform/updates";
import AppIcon from "./AppIcon.vue";
import ModalSheet from "./ModalSheet.vue";

defineProps<{
  open: boolean;
  confirmExit: boolean;
  saving?: boolean;
  error?: string;
  updateLabel?: string;
  updateAvailable?: boolean;
  checkingUpdates?: boolean;
}>();
defineEmits<{ close: []; "change-confirm-exit": [enabled: boolean]; update: [] }>();
</script>

<template>
  <ModalSheet :open="open" title="设置" :busy="saving" @close="$emit('close')">
    <div class="settings-list">
      <div class="settings-row">
        <span id="exit-confirm-label">退出前确认</span>
        <button
          class="settings-switch"
          type="button"
          role="switch"
          aria-labelledby="exit-confirm-label"
          :aria-checked="confirmExit"
          :disabled="saving"
          @click="$emit('change-confirm-exit', !confirmExit)"
        ><span /></button>
      </div>
      <button class="settings-row settings-update" @click="$emit('update')">
        <span>应用更新<small>当前版本 {{ appVersion }}</small></span>
        <span class="settings-update-status" :class="{ 'has-update': updateAvailable }">
          <span>{{ checkingUpdates ? '正在检查' : updateLabel || '检查更新' }}</span>
          <AppIcon name="arrow" />
        </span>
      </button>
    </div>
    <p v-if="error" class="settings-error" role="alert">{{ error }}</p>
    <slot />
  </ModalSheet>
</template>

<style scoped>
.settings-row { display: flex; align-items: center; justify-content: space-between; width: 100%; min-height: 62px; gap: 20px; text-align: left; }
.settings-row + .settings-row { border-top: 1px solid var(--line); }
.settings-switch { width: 44px; height: 26px; flex: none; border-radius: 18px; padding: 3px; background: #bdc7c0; transition: background 120ms ease; }
.settings-switch span { display: block; width: 20px; height: 20px; border-radius: 50%; background: white; box-shadow: 0 1px 3px #243b3333; transition: transform 120ms ease; }
.settings-switch[aria-checked="true"] { background: var(--accent); }
.settings-switch[aria-checked="true"] span { transform: translateX(18px); }
.settings-update { padding: 14px 0; }
.settings-update small { display: block; color: var(--muted); font-size: 12px; margin-top: 3px; }
.settings-update-status { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 13px; }
.settings-update-status svg { width: 17px; height: 17px; }
.settings-update-status.has-update { color: var(--accent); font-weight: 600; }
.settings-error { margin-top: 12px; color: var(--danger); font-size: 13px; }
@media (prefers-reduced-motion: reduce) { .settings-switch, .settings-switch span { transition: none; } }
</style>
