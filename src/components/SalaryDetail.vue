<script setup lang="ts">
import { computed, ref } from "vue";
import { formatMoney } from "../domain/money";
import { reconcile } from "../domain/reconcile";
import { salaryGroups } from "../domain/salaryRules";
import { imageUrl, type ArchiveItem } from "../platform/archive";
import AppIcon from "./AppIcon.vue";
import ModalSheet from "./ModalSheet.vue";
const props = defineProps<{ item: ArchiveItem; masked: boolean }>();
defineEmits<{ close: []; remove: [] }>();
const showSource = ref(false);
const draft = computed(() => props.item.draft);
const result = computed(() =>
  draft.value ? reconcile(draft.value) : undefined,
);
const groups = computed(() =>
  draft.value ? salaryGroups(draft.value) : undefined,
);
const sections = computed(() =>
  groups.value
    ? [
        { key: "earning", title: "应发构成", rows: groups.value.earnings },
        { key: "deduction", title: "扣款明细", rows: groups.value.deductions },
        { key: "unknown", title: "其他项目", rows: groups.value.unresolved },
        { key: "excluded", title: "补充信息", rows: groups.value.excluded },
      ].filter((section) => section.rows.length)
    : [],
);
const monthLabel = computed(() =>
  draft.value?.payrollMonth
    ? `${draft.value.payrollMonth.slice(0, 4)} 年 ${Number(draft.value.payrollMonth.slice(5))} 月`
    : "历史工资",
);
const hasSource = computed(() =>
  Boolean(props.item.capture || props.item.imagePath),
);
const statusLabel = computed(() =>
  props.item.demo
    ? "示例数据"
    : props.item.status === "error"
      ? "读取异常"
      : "",
);
const differenceLabel = computed(() => {
  const value = result.value;
  if (!value) return "";
  if (value.status === "consistent") return "金额一致";
  if (value.deductionDifferenceMinor)
    return `已列扣款差 ${props.masked ? "••••" : formatMoney(Math.abs(value.deductionDifferenceMinor))} 元`;
  if (value.grossDifferenceMinor)
    return `应发明细差 ${props.masked ? "••••" : formatMoney(Math.abs(value.grossDifferenceMinor))} 元`;
  if (value.statedDeductionMinor === null) return "原载总额缺失，无法完整核对";
  if (value.unresolvedLineIds.length) return "部分明细未归类或金额缺失";
  return value.status === "unresolved" ? "部分金额无法核算" : "合计与明细有差额";
});
const deductionExplanation = computed(() => {
  const difference = result.value?.deductionDifferenceMinor;
  if (difference == null || difference === 0) return "";
  const amount = props.masked ? "••••" : formatMoney(Math.abs(difference));
  return difference > 0
    ? `总额推导的扣款比已识别扣款多 ${amount} 元。`
    : `已识别扣款比总额推导的扣款多 ${amount} 元。`;
});
function money(value: number | null | undefined) {
  return props.masked ? "••••" : value == null ? "—" : formatMoney(value);
}
</script>
<template>
  <section class="detail-page" aria-label="月度工资明细">
    <nav class="detail-nav">
      <button class="text-button detail-back" :class="{ 'demo-back': item.demo }" @click="$emit('close')">
        <AppIcon name="back" />工资档案
      </button>
      <div class="header-tools">
        <button
          v-if="hasSource"
          class="text-button source-button"
          title="查看来源"
          aria-label="查看来源"
          @click="showSource = true"
        >
          <AppIcon name="file" /><span>来源</span></button
        ><button
          v-if="!item.demo"
          class="icon-button"
          title="删除档案"
          aria-label="删除档案"
          @click="$emit('remove')"
        >
          <AppIcon name="trash" />
        </button>
      </div>
    </nav>
    <section class="pay-overview">
      <div class="detail-title">
        <h1>{{ monthLabel }}</h1>
        <span v-if="statusLabel" class="status-dot" :class="{ sample: item.demo }">{{
          statusLabel
        }}</span>
      </div>
      <p class="muted">实发工资</p>
      <div class="balance detail-balance">
        <span v-if="!masked" class="currency">¥</span
        ><strong>{{ money(draft?.statedNetMinor) }}</strong>
      </div>
      <div class="source-totals">
        <div>
          <span>应发工资</span
          ><strong>{{ money(draft?.statedGrossMinor) }}</strong>
        </div>
        <div>
          <span>扣款（推算）</span
          ><strong>{{ money(result?.statedDeductionMinor) }}</strong>
        </div>
      </div>
    </section>
    <div v-if="item.error" class="alert error-alert" role="alert">
      {{ item.error }}
    </div>
    <details
      v-if="result"
      class="reconciliation"
      :class="{ 'has-difference': result.status !== 'consistent' }"
    >
      <summary>
        <span
          ><AppIcon
            :name="result.status === 'consistent' ? 'check' : 'scan'"
          />{{ differenceLabel }}</span
        ><span class="details-chevron">⌄</span>
      </summary>
      <div class="reconciliation-body">
        <p><strong>扣款核对</strong></p>
        <dl>
          <div>
            <dt>原载应发</dt>
            <dd>{{ money(draft?.statedGrossMinor) }}</dd>
          </div>
          <div>
            <dt>原载实发</dt>
            <dd>{{ money(draft?.statedNetMinor) }}</dd>
          </div>
          <div>
            <dt>两项相减 · 推导扣款</dt>
            <dd>{{ money(result.statedDeductionMinor) }}</dd>
          </div>
          <div>
            <dt>已识别扣款{{ result.calculatedDeductionsMinor === null ? "（部分）" : "" }}</dt>
            <dd>{{ money(result.knownDeductionsMinor) }}</dd>
          </div>
          <div>
            <dt>两者差额</dt>
            <dd>{{ money(result.deductionDifferenceMinor) }}</dd>
          </div>
        </dl>
        <p v-if="deductionExplanation">{{ deductionExplanation }}</p>
        <p v-if="result.deductionDifferenceMinor" class="muted">
          当前采集明细尚未解释这部分差额，无法仅凭此档案确定是采集遗漏、页面未列明扣项，还是合计口径不同。原载实发保持不变。
        </p>
        <p v-if="result.calculatedDeductionsMinor === null" class="muted">
          仍有未归类或金额缺失的项目，当前扣款小计不完整。
        </p>
        <p v-if="result.statedDeductionMinor === null" class="muted">
          原载应发或实发缺失，无法推导扣款及比较差额。
        </p>
        <p><strong>应发与明细核对</strong></p>
        <dl>
          <div>
            <dt>已识别应发{{ result.calculatedGrossMinor === null ? "（部分）" : "" }}</dt>
            <dd>{{ money(result.knownGrossMinor) }}</dd>
          </div>
          <div>
            <dt>与原载应发差额</dt>
            <dd>{{ money(result.grossDifferenceMinor) }}</dd>
          </div>
          <div>
            <dt>明细实发</dt>
            <dd>{{ money(result.calculatedNetMinor) }}</dd>
          </div>
          <div v-for="difference in result.groupDifferences" :key="difference.lineId">
            <dt>{{ difference.label }}与已列子项差额</dt>
            <dd>{{ money(difference.differenceMinor) }}</dd>
          </div>
        </dl>
        <p v-if="result.unresolvedLineIds.length" class="muted">以下项目尚未确定计入口径，保留来源金额：</p>
        <ul v-if="result.unresolvedLineIds.length">
          <li
            v-for="line in draft?.lines.filter((line) =>
              result?.unresolvedLineIds.includes(line.id),
            )"
            :key="line.id"
          >
            {{ line.label }}
          </li>
        </ul>
      </div>
    </details>
    <div class="salary-breakdown"><details
      v-for="section in sections"
      :key="section.key"
      class="salary-section"
      :class="`salary-section-${section.key}`"
      :open="section.key !== 'excluded'"
    >
      <summary class="salary-section-heading">
      <h2>
        {{ section.title }}
      </h2>
      <span class="details-chevron">⌄</span>
      </summary>
      <div class="salary-lines">
        <template v-for="row in section.rows" :key="row.id">
          <details v-if="row.children.length" class="salary-group">
            <summary>
              <span class="line-label"
                >{{ row.label }}<span class="details-chevron">⌄</span></span
              ><span
                class="line-amount"
                :class="{
                  negative: row.amountMinor !== null && row.amountMinor < 0,
                }"
                >{{ money(row.amountMinor) }}</span
              >
            </summary>
            <div class="child-lines">
              <div
                v-for="child in row.children"
                :key="child.id"
                class="salary-line"
              >
                <span>{{ child.label }}</span
                ><span>{{ money(child.amountMinor) }}</span>
              </div>
            </div>
          </details>
          <div v-else class="salary-line">
            <span class="line-label">{{ row.label }}</span
            ><span
              class="line-amount"
              :class="{
                negative: row.amountMinor !== null && row.amountMinor < 0,
              }"
              >{{
                money(
                  section.key === "unknown"
                    ? row.line?.amountMinor
                    : row.amountMinor,
                )
              }}</span
            >
          </div>
        </template>
      </div>
    </details></div>
    <p v-if="!draft" class="muted legacy-empty">
      这份档案尚无工资数据，可查看已保存的来源。
    </p>
    <ModalSheet :open="showSource" title="工资来源" @close="showSource = false">
      <div v-if="masked" class="source-masked">
        金额已隐藏。显示金额后可查看来源。
      </div>
      <div v-else-if="item.capture" class="source-fields">
        <div class="source-meta"><span>{{ monthLabel }} · 飞书智慧 HR</span><span>保存于 {{ item.createdAt.slice(0, 10).replaceAll("-", ".") }}</span></div>
        <div
          v-for="(field, index) in item.capture.records[0]?.fields"
          :key="index"
          class="salary-line"
        >
          <span>{{ field.label }}</span
          ><span class="line-amount">{{ field.amountText }}</span>
        </div>
      </div>
      <div v-else-if="item.imagePath" class="image-viewport">
        <p class="source-meta">{{ item.demo ? "合成示例" : "历史截图" }} · {{ item.createdAt.slice(0, 10).replaceAll("-", ".") }}</p>
        <img :src="imageUrl(item)" alt="已保存的工资原图" />
      </div>
    </ModalSheet>
  </section>
</template>
