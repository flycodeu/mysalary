<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { formatMoney } from "./domain/money";
import { monthlyOverview } from "./domain/overview";
import { createDemo, type ArchiveItem } from "./platform/archive";
import { useArchive } from "./composables/useArchive";
import AppIcon from "./components/AppIcon.vue";
import SalaryDetail from "./components/SalaryDetail.vue";
import ModalSheet from "./components/ModalSheet.vue";
import SyncPanel from "./components/SyncPanel.vue";
import UpdatePanel from "./components/UpdatePanel.vue";
import { appVersion } from "./platform/updates";
import { isNative, isWindows } from "./platform/host";

const fileInput = ref<HTMLInputElement>();
const {
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
  recover,
  afterSync,
  filesChanged,
  removeArchive,
  restoreArchive,
  importFile: importArchiveFile,
  collect: collectArchive,
  exportFile: exportArchiveFile,
} = useArchive(fileInput);
const showMenu = ref(false);
const showSync = ref(false);
const showUpdates = ref(false);
const masked = ref(false);

const recent = computed(() =>
  active.value.find(
    (item) =>
      item.draft?.statedNetMinor != null &&
      (!year.value || item.draft.payrollMonth?.startsWith(year.value)),
  ),
);
const overview = computed(() =>
  monthlyOverview(
    visible.value.map((item) => ({
      id: item.id,
      month: item.draft?.payrollMonth ?? null,
      createdAt: item.createdAt,
      gross: item.draft?.statedGrossMinor ?? null,
      net: item.draft?.statedNetMinor ?? null,
    })),
  ),
);
const legacyCount = computed(
  () => active.value.filter((item) => item.sourceKind !== "feishu-text").length,
);
const visible = computed(() =>
  (showDeleted.value ? deleted.value : active.value).filter(
    (item) =>
      showDeleted.value ||
      !year.value ||
      item.draft?.payrollMonth?.startsWith(year.value),
  ),
);
// Desktop can preview the first archive without entering the mobile detail screen.
const detailItem = computed(() =>
  selected.value ?? (showDeleted.value ? undefined : visible.value[0]),
);
watch(year, () => {
  selected.value = undefined;
});
const sections = computed(() => {
  const result = new Map<string, ArchiveItem[]>();
  for (const item of visible.value) {
    const label = item.draft?.payrollMonth?.slice(0, 4) ?? "其他档案";
    result.set(label, [...(result.get(label) ?? []), item]);
  }
  return [...result].map(([label, entries]) => ({ label, entries }));
});
function monthLabel(item: ArchiveItem) {
  const month = item.draft?.payrollMonth;
  return month
    ? `${month.slice(0, 4)} 年 ${Number(month.slice(5))} 月`
    : "历史档案";
}
function duplicateMonth(item: ArchiveItem) {
  return (
    Boolean(item.draft?.payrollMonth) &&
    active.value.filter(
      (other) => other.draft?.payrollMonth === item.draft?.payrollMonth,
    ).length > 1
  );
}
function money(value: number | null | undefined) {
  return masked.value ? "••••" : value == null ? "—" : formatMoney(value);
}
function sourceLabel(item: ArchiveItem) {
  if (item.status === "error") return "文件读取异常";
  if (duplicateMonth(item)) return "同月多份";
  return item.sourceKind === "feishu-text" ? "" : "历史截图";
}
function importFile() {
  showMenu.value = false;
  return importArchiveFile();
}
function collect() {
  showMenu.value = false;
  return collectArchive();
}
function exportFile() {
  showMenu.value = false;
  return exportArchiveFile();
}
function showDemo() {
  showMenu.value = false;
  selected.value = createDemo();
}
</script>

<template>
  <div class="app-shell">
    <header class="app-header">
      <div class="brand-group"><button
        class="brand"
        aria-label="薪迹首页"
        @click="
          selected = undefined;
          showDeleted = false;
        "
      >
        <img class="brand-mark" src="/brand.svg" alt="" /><span>薪迹</span>
      </button><span v-if="!isNative" class="preview-badge" title="网页预览，数据保存在此浏览器">预览</span></div>
      <div class="header-tools">
        <button
          class="primary-button desktop-import"
          :disabled="operationBlocked"
          @click="isWindows ? collect() : importFile()"
        >
          <AppIcon :name="isWindows ? 'scan' : 'plus'" />{{
            isWindows ? "抓取飞书工资" : "导入文件"
          }}
        </button>
        <button
          class="icon-button"
          title="坚果云同步"
          aria-label="坚果云同步"
          :disabled="operationBlocked"
          @click="showSync = true"
        >
          <AppIcon name="cloud" />
        </button>
        <button
          class="icon-button"
          :title="masked ? '显示金额' : '隐藏金额'"
          :aria-label="masked ? '显示金额' : '隐藏金额'"
          :aria-pressed="masked"
          @click="masked = !masked"
        >
          <AppIcon name="eye" />
        </button>
        <button
          class="icon-button"
          title="更多操作"
          aria-label="更多操作"
          @click="showMenu = true"
        >
          <AppIcon name="more" />
        </button>
      </div>
    </header>
    <div v-if="error" class="alert error-alert" role="alert">
      <span>{{ error }}</span
      ><button
        class="icon-button"
        aria-label="关闭错误提示"
        @click="error = ''"
      >
        <AppIcon name="close" />
      </button>
    </div>
    <button
      v-if="archiveLoadError"
      class="secondary-button recovery-entry"
      :disabled="operationBlocked"
      @click="retryArchive"
    >
      重试读取档案
    </button>
    <button
      v-if="ledgerUnreadable"
      class="secondary-button recovery-entry"
      :disabled="operationBlocked"
      @click="importFile"
    >
      选择 JSON 档案备份恢复
    </button>
    <div v-if="busy || initialLoading" class="working" role="status">
      <span class="spinner" />{{ initialLoading ? "正在读取工资档案" : "正在处理，请稍候" }}
    </div>
    <input
      ref="fileInput"
      type="file"
      hidden
      accept=".salary.json,.json,application/json"
      class="visually-hidden"
      aria-label="选择工资文件"
      @change="filesChanged"
    />
    <div v-if="notice" class="notice" role="status">
      {{ notice }}<button
        class="icon-button"
        aria-label="关闭提示"
        @click="notice = ''"
      ><AppIcon name="close" /></button>
    </div>
    <main
      class="workspace"
      :data-storage-state="storageState"
      :class="{ 'has-detail': detailItem, 'detail-selected': selected }"
    >
    <section class="archive-page" aria-label="工资档案列表">
      <div class="page-heading">
        <div>
          <h1>{{ showDeleted ? "已删除" : "工资档案" }}</h1>
        </div>
        <button
          v-if="showDeleted"
          class="text-button"
          @click="showDeleted = false"
        >
          <AppIcon name="back" />返回
        </button>
      </div>
      <section
        v-if="recent && !showDeleted"
        class="latest-pay"
        aria-label="最近实发"
      >
        <div>
          <p class="muted">{{ monthLabel(recent) }} · 实发</p>
          <div class="balance">
            <span v-if="!masked" class="currency">¥</span
            ><strong>{{ money(recent.draft?.statedNetMinor) }}</strong>
          </div>
        </div>
        <button class="icon-button" title="查看明细" aria-label="查看最近工资明细" @click="selected = recent">
          <AppIcon name="arrow" />
        </button>
      </section>
      <div v-if="active.length && !showDeleted" class="list-toolbar">
        <span v-if="overview.months">{{ overview.months }} 个月<span v-if="visible.length !== overview.months"> · {{ visible.length }} 份档案</span></span>
        <span v-else>{{ visible.length }} 份档案</span
        ><select v-if="years.length > 1" v-model="year" aria-label="按年份筛选">
          <option value="">全部年份</option>
          <option v-for="value in years" :key="value" :value="value">
            {{ value }} 年
          </option>
        </select>
      </div>
      <details
        v-if="overview.months && !showDeleted"
        class="archive-summary"
        aria-label="工资汇总"
      >
        <summary><span>{{ year ? `${year} 年汇总` : "工资汇总" }}</span><span class="details-chevron">⌄</span></summary>
        <div class="archive-overview">
        <div>
          <span>实发合计</span
          ><strong>{{ money(overview.net) }}</strong>
        </div>
        <div>
          <span>应发合计</span><strong>{{ money(overview.gross) }}</strong>
        </div>
        <p v-if="overview.hasVersions">
          同月多份，仅计最新一份。
        </p>
        </div>
      </details>
      <section v-if="!visible.length && !initialLoading && !archiveLoadError" class="empty-state">
        <span class="empty-symbol"
          ><AppIcon :name="showDeleted ? 'trash' : 'file'"
        /></span>
        <h2>{{ showDeleted ? "没有已删除的档案" : "还没有工资档案" }}</h2>
        <p>
          {{
            showDeleted
              ? "删除的档案会保留在这里。"
              : isWindows
                ? "在飞书打开工资页，展开月份后开始采集"
                : "导入工资文件，或从坚果云同步"
          }}
        </p>
        <button
          v-if="!showDeleted"
          class="primary-button"
          :disabled="operationBlocked"
          @click="isWindows ? collect() : importFile()"
        >
          <AppIcon :name="isWindows ? 'scan' : 'plus'" />{{
            isWindows ? "抓取飞书工资" : "导入工资文件"
          }}
        </button>
        <button
          v-if="!showDeleted"
          class="text-button sample-link"
          @click="showDemo"
        >
          查看示例<AppIcon name="arrow" />
        </button>
      </section>
      <section v-if="archiveLoadError && !visible.length" class="empty-state">
        <span class="empty-symbol"><AppIcon name="file" /></span>
        <h2>工资档案未能读取</h2>
        <p>请重试读取，已有文件仍保留在本机。</p>
      </section>
      <section
        v-for="section in sections"
        :key="section.label"
        class="year-section"
      >
        <h2>
          {{ section.label
          }}<span v-if="section.label !== '其他档案'"> 年</span>
        </h2>
        <div class="archive-list">
          <div
            v-for="item in section.entries"
            :key="item.id"
            class="archive-row"
            :class="{ 'is-selected': detailItem?.id === item.id && !showDeleted }"
          >
            <button
              class="archive-item"
              :aria-current="detailItem?.id === item.id && !showDeleted ? 'true' : undefined"
              :disabled="operationBlocked || Boolean(item.deletedAt)"
              @click="selected = item"
            >
              <span class="month-number"
                >{{
                  item.draft?.payrollMonth
                    ? Number(item.draft.payrollMonth.slice(5))
                    : "—"
                }}<small>月</small></span
              >
              <span v-if="sourceLabel(item)" class="archive-item-text">{{ sourceLabel(item) }}</span>
              <span class="archive-item-amount">{{
                money(item.draft?.statedNetMinor)
              }}</span
              ><AppIcon v-if="!item.deletedAt" class="row-arrow" name="arrow" />
            </button>
            <button
              v-if="item.deletedAt"
              class="text-button"
              :disabled="operationBlocked"
              @click="restoreArchive(item)"
            >
              恢复
            </button>
          </div>
        </div>
      </section>
      <div v-if="isWindows && active.length && !showDeleted" class="mobile-import-bar">
        <button
          class="primary-button"
          :disabled="operationBlocked"
          @click="isWindows ? collect() : importFile()"
        >
          <AppIcon :name="isWindows ? 'scan' : 'plus'" />{{
            isWindows ? "抓取飞书工资" : "导入工资文件"
          }}
        </button>
      </div>
    </section>
    <SalaryDetail
      v-if="detailItem"
      :key="detailItem.id"
      :item="detailItem"
      :masked="masked"
      @close="selected = undefined"
      @remove="deleteTarget = detailItem"
    />
    </main>
    <ModalSheet :open="showMenu" title="更多" @close="showMenu = false">
      <div class="action-list">
        <button v-if="isWindows" :disabled="operationBlocked" @click="collect">
          <AppIcon name="scan" />抓取飞书工资
        </button>
        <button :disabled="operationBlocked" @click="importFile"><AppIcon name="plus" />导入工资文件</button
        ><button :disabled="operationBlocked" @click="exportFile">
          <AppIcon name="download" />导出 JSON 档案
        </button>
        <button
          :disabled="operationBlocked"
          @click="
            showMenu = false;
            showSync = true;
          "
        >
          <AppIcon name="cloud" />坚果云同步
        </button>
        <button
          @click="
            showMenu = false;
            selected = undefined;
            showDeleted = true;
          "
        >
          <AppIcon name="trash" />已删除<span class="action-count">{{
            deleted.length
          }}</span></button
        ><button @click="showDemo">
          <AppIcon name="file" />查看示例<span class="muted">合成数据</span>
        </button>
        <button @click="showMenu = false; showUpdates = true">
          <AppIcon name="sync" />检查更新<span class="muted">{{ appVersion }}</span>
        </button>
      </div>
      <p v-if="!isNative" class="preview-label">网页预览 · 数据保存在此浏览器</p>
    </ModalSheet>
    <UpdatePanel :open="showUpdates" @close="showUpdates = false" />
    <SyncPanel
      :open="showSync"
      :legacy-count="legacyCount"
      @close="showSync = false"
      @synced="afterSync"
      @working="busy = $event"
    />
    <ModalSheet
      :open="Boolean(recovery)"
      title="恢复本机账本"
      :busy="busy"
      @close="recovery = undefined"
    >
      <p class="delete-description">
        这份备份包含
        {{
          recovery?.ledger.entries.length
        }}
        份工资记录。恢复后将用它作为本机账本，当前文件和已有备份会另存保留。
      </p>
      <div class="sheet-actions">
        <button
          class="secondary-button"
          :disabled="busy"
          @click="recovery = undefined"
        >
          取消</button
        ><button class="primary-button" :disabled="busy" @click="recover">
          确认恢复
        </button>
      </div>
    </ModalSheet>
    <ModalSheet
      :open="Boolean(deleteTarget)"
      title="删除工资档案"
      :busy="busy"
      @close="deleteTarget = undefined"
    >
      <p class="delete-description">
        {{ deleteTarget ? monthLabel(deleteTarget) : "" }}
        的档案将移至“已删除”，随时可以恢复。
      </p>
      <div class="sheet-actions">
        <button
          class="secondary-button"
          :disabled="busy"
          @click="deleteTarget = undefined"
        >
          取消</button
        ><button class="danger-button" :disabled="busy" @click="removeArchive">
          删除档案
        </button>
      </div>
    </ModalSheet>
  </div>
</template>
