<script setup lang="ts">
import { ref, watch } from "vue";
import ModalSheet from "./ModalSheet.vue";
import AppIcon from "./AppIcon.vue";
import {
  getSyncSettings,
  setSyncSettings,
  clearSyncSettings,
  syncNutstore,
} from "../platform/sync";
import { isNative } from "../platform/host";

const props = defineProps<{ open: boolean; legacyCount: number }>();
const emit = defineEmits<{
  close: [];
  synced: [];
  working: [value: boolean];
}>();
const username = ref("");
const password = ref("");
const configured = ref(false);
const editing = ref(false);
const busy = ref(false);
const error = ref("");
const message = ref("");
const lastSync = ref(localStorage.getItem("salary-last-sync") ?? "");
async function run(operation: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  emit("working", true);
  error.value = "";
  message.value = "";
  try {
    await operation();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "同步未完成，请重试";
  } finally {
    busy.value = false;
    emit("working", false);
  }
}
watch(
  () => props.open,
  async (open) => {
    password.value = "";
    error.value = "";
    message.value = "";
    if (!open || !isNative) return;
    await run(async () => {
      const settings = await getSyncSettings();
      username.value = settings.username;
      configured.value = settings.configured;
      editing.value = !settings.configured;
    });
  },
);
async function save() {
  if (!username.value.trim() || !password.value) {
    error.value = "请输入账号和第三方应用密码";
    return;
  }
  await run(async () => {
    await setSyncSettings(username.value.trim(), password.value);
    password.value = "";
    configured.value = true;
    editing.value = false;
    message.value = "连接已保存";
  });
}
async function sync() {
  await run(async () => {
    const result = await syncNutstore();
    lastSync.value = new Date().toLocaleString("zh-CN", { hour12: false });
    localStorage.setItem("salary-last-sync", lastSync.value);
    message.value = result.count ? "同步完成" : "暂无工资数据可同步";
  });
  // Downloaded records are saved even if the conditional upload later fails.
  emit("synced");
}
async function disconnect() {
  await run(async () => {
    await clearSyncSettings();
    configured.value = false;
    editing.value = true;
    username.value = "";
    password.value = "";
    lastSync.value = "";
    localStorage.removeItem("salary-last-sync");
  });
}
</script>
<template>
  <ModalSheet
    :open="open"
    title="坚果云同步"
    :busy="busy"
    @close="emit('close')"
  >
    <div class="sync-panel">
      <div v-if="!isNative" class="notice">
        请在 Windows 或 Android 应用中连接坚果云。
      </div>
      <template v-else>
        <form v-if="editing" class="sync-form" @submit.prevent="save">
          <label
            >坚果云账号<input
              v-model="username"
              type="text"
              autocomplete="username"
              :disabled="busy"
              maxlength="254"
              placeholder="注册邮箱"
              required
          /></label>
          <label
            >第三方应用密码<input
              v-model="password"
              type="password"
              autocomplete="off"
              :disabled="busy"
              maxlength="256"
              placeholder="输入应用密码"
              required
          /></label>
          <div class="sheet-actions">
            <button
              v-if="configured"
              type="button"
              class="text-button"
              :disabled="busy"
              @click="
                editing = false;
                password = '';
              "
            >
              取消</button
            ><button class="primary-button" :disabled="busy">保存连接</button>
          </div>
        </form>
        <div v-else class="sync-connected">
          <div class="sync-account">
            <span class="sync-symbol"><AppIcon name="cloud" /></span>
            <div>
              <strong>已连接</strong><span>{{ username }}</span>
            </div>
          </div>
          <p v-if="lastSync" class="muted">上次同步 {{ lastSync }}</p>
          <button class="primary-button" :disabled="busy" @click="sync">
            <span v-if="busy" class="spinner" /><AppIcon v-else name="sync" />{{
              busy ? "正在同步" : "立即同步"
            }}
          </button>
          <div class="sync-options">
            <button
              class="text-button"
              :disabled="busy"
              @click="editing = true"
            >
              更换账号</button
            ><button class="text-button" :disabled="busy" @click="disconnect">
              断开连接
            </button>
          </div>
        </div>
      </template>
      <p v-if="error" role="alert" class="alert error-alert">{{ error }}</p>
      <p v-if="message" role="status" class="notice">{{ message }}</p>
      <details v-if="isNative" class="sync-help">
        <summary>
          <span>{{ editing ? "连接与同步说明" : "同步说明" }}</span>
          <span class="details-chevron" aria-hidden="true">⌄</span>
        </summary>
        <div class="sync-help-content">
          <p v-if="editing">
            在坚果云“账户信息 → 安全选项 → 第三方应用管理”中生成应用密码。
          </p>
          <p>两端使用同一账号。工资记录的新增、删除和恢复都会同步。</p>
          <p v-if="legacyCount">
            {{ legacyCount }} 份历史截图仅保存在本机，不参与同步。
          </p>
        </div>
      </details>
    </div>
  </ModalSheet>
</template>
