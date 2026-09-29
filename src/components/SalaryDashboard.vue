<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { annualDashboard } from "../domain/overview";
import { formatMoney } from "../domain/money";
import type { ArchiveItem } from "../platform/archive";
import AppIcon from "./AppIcon.vue";

const props = defineProps<{ items: ArchiveItem[]; masked: boolean }>();
const emit = defineEmits<{ open: [item: ArchiveItem] }>();
const year = ref("");
const values = computed(() => props.items.filter((item) => !item.demo && !item.deletedAt).map((item) => ({
  id: item.id,
  month: item.draft?.payrollMonth ?? null,
  createdAt: item.createdAt,
  gross: item.draft?.statedGrossMinor ?? null,
  net: item.draft?.statedNetMinor ?? null,
})));
const years = computed(() => [...new Set(values.value.map((value) => value.month?.slice(0, 4)).filter(Boolean))].sort().reverse() as string[]);
watch(years, (available) => {
  if (!available.includes(year.value)) year.value = available[0] ?? "";
}, { immediate: true });
const dashboard = computed(() => annualDashboard(values.value, year.value));
const maximum = computed(() => Math.max(0, ...dashboard.value.trend.flatMap((row) => [row.gross ?? 0, row.net ?? 0])));
function money(value: number | null) { return props.masked ? "••••" : value === null ? "—" : formatMoney(value); }
function height(value: number | null) {
  if (value === null || value <= 0 || maximum.value === 0) return "0%";
  return `${Math.max(2, value / maximum.value * 100)}%`;
}
function open(id: string | null) {
  const item = props.items.find((item) => item.id === id);
  if (item) emit("open", item);
}
</script>

<template>
  <section class="dashboard-page" aria-label="工资看板">
    <div class="dashboard-heading">
      <div><p class="dashboard-eyebrow">你的每一份收入</p><h1>工资看板</h1></div>
      <select v-if="years.length" v-model="year" aria-label="看板年份">
        <option v-for="value in years" :key="value" :value="value">{{ value }} 年</option>
      </select>
    </div>
    <div v-if="dashboard.months" class="dashboard-content">
      <section class="dashboard-totals" aria-label="年度工资合计">
        <div class="dashboard-net">
          <p>{{ year }} 年实发合计</p>
          <div class="dashboard-balance"><span v-if="!masked">¥</span><strong>{{ money(dashboard.net) }}</strong></div>
          <span class="dashboard-count">已保存 {{ dashboard.months }} 个月</span>
        </div>
        <div class="dashboard-secondary">
          <div><span>应发合计</span><strong>{{ money(dashboard.gross) }}</strong></div>
          <div><span>扣款合计</span><strong>{{ money(dashboard.deduction) }}</strong></div>
        </div>
      </section>
      <section class="dashboard-trend" aria-label="月度工资趋势">
        <div class="trend-heading"><h2>月度趋势</h2><div class="trend-legend"><span><i class="gross-key" />应发</span><span><i class="net-key" />实发</span></div></div>
        <p v-if="masked" class="trend-masked">显示金额后可查看趋势</p>
        <div v-else class="trend-scroll">
          <div class="trend-chart">
            <button v-for="row in dashboard.trend" :key="row.month" class="trend-month" :disabled="!row.sourceId" :aria-label="`${Number(row.month.slice(5))} 月，应发 ${money(row.gross)} 元，实发 ${money(row.net)} 元，查看明细`" @click="open(row.sourceId)">
              <div class="trend-bars" aria-hidden="true">
                <span v-if="row.gross !== null && row.gross > 0" class="trend-bar gross-bar" :style="{ height: height(row.gross) }" />
                <span v-if="row.net !== null && row.net > 0" class="trend-bar net-bar" :style="{ height: height(row.net) }" />
                <span v-if="row.sourceId && (row.gross === null || row.net === null)" class="trend-missing">待补</span>
                <span v-else-if="!row.sourceId" class="trend-empty">—</span>
                <span v-else-if="row.gross === 0 && row.net === 0" class="trend-zero">0</span>
                <span v-else-if="(row.gross !== null && row.gross < 0) || (row.net !== null && row.net < 0)" class="trend-missing">含负值</span>
              </div>
              <span class="trend-month-label">{{ Number(row.month.slice(5)) }}<span class="trend-month-unit"> 月</span></span>
              <span class="trend-month-value">{{ money(row.net) }}</span>
            </button>
          </div>
        </div>
        <p v-if="dashboard.hasVersions" class="dashboard-note">同月多份档案，统计最近保存的一份。</p>
        <p v-if="dashboard.gross === null || dashboard.net === null" class="dashboard-note">部分原载总额缺失，合计保留为空。</p>
      </section>
      <section class="dashboard-months" aria-label="月度工资概览">
        <div class="dashboard-months-heading"><h2>月度概览</h2><span>实发 / 扣款</span></div>
        <button v-for="row in dashboard.trend.filter((row) => row.sourceId).slice().reverse()" :key="row.month" class="dashboard-month-row" @click="open(row.sourceId)">
          <span>{{ Number(row.month.slice(5)) }} 月</span><strong>{{ money(row.net) }}</strong><span class="dashboard-deduction">{{ money(row.deduction) }}</span><AppIcon name="arrow" />
        </button>
      </section>
    </div>
    <div v-else class="dashboard-empty"><AppIcon name="file" /><h2>还没有可统计的工资</h2><p>保存工资档案后，年度汇总和月度变化会出现在这里。</p></div>
  </section>
</template>

<style scoped>
.dashboard-page { min-width: 0; padding: 30px 0 40px; }
.dashboard-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 24px; }
.dashboard-eyebrow { color: var(--muted); font-size: 12px; margin-bottom: 4px; }
.dashboard-heading select { border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 9px 12px; background: var(--surface); color: var(--ink); }
.dashboard-totals { display: grid; grid-template-columns: 1.6fr 1fr; border: 1px solid var(--line); border-radius: var(--radius-lg); overflow: hidden; }
.dashboard-net { padding: 30px 32px; background: var(--accent); color: var(--on-accent); }
.dashboard-net > p { font-size: 14px; color: var(--on-accent-muted); }
.dashboard-balance { display: flex; align-items: baseline; gap: 8px; margin: 10px 0 16px; }
.dashboard-balance > span { font-size: 20px; }
.dashboard-balance strong { font-family: var(--number-font); font-size: clamp(29px, 4.5vw, 44px); line-height: 1.2; font-weight: 600; letter-spacing: -1px; }
.dashboard-count { font-size: 12px; color: var(--on-accent-muted); }
.dashboard-secondary { display: grid; padding: 12px 28px; }
.dashboard-secondary > div { display: flex; flex-direction: column; justify-content: center; gap: 6px; padding: 14px 0; }
.dashboard-secondary > div + div { border-top: 1px solid var(--line); }
.dashboard-secondary span { color: var(--muted); font-size: 13px; }
.dashboard-secondary strong { font-family: var(--number-font); font-size: 24px; font-weight: 600; }
.dashboard-trend { padding: 28px 0 24px; border-bottom: 1px solid var(--line); }
.trend-heading, .dashboard-months-heading { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.trend-legend { display: flex; gap: 14px; font-size: 12px; color: var(--muted); }
.trend-legend span { display: flex; align-items: center; gap: 6px; }
.trend-legend i { width: 8px; height: 8px; border-radius: 2px; }
.gross-key { background: #bed8ca; }.net-key { background: var(--accent); }
.trend-scroll { overflow-x: auto; padding: 24px 0 6px; }
.trend-chart { display: grid; grid-template-columns: repeat(12, minmax(54px, 1fr)); gap: 8px; min-width: 704px; }
.trend-month { display: flex; flex-direction: column; align-items: center; min-width: 0; padding: 0 2px; border-radius: 4px; }
.trend-month:disabled { opacity: 1; }
.trend-month:not(:disabled):hover { background: var(--subtle); }
.trend-bars { height: 146px; width: 100%; display: flex; justify-content: center; align-items: flex-end; gap: 3px; border-bottom: 1px solid var(--line); position: relative; }
.trend-bar { width: 14px; max-width: 30%; border-radius: 4px 4px 0 0; min-height: 3px; }
.gross-bar { background: #bed8ca; }.net-bar { background: var(--accent); }
.trend-empty, .trend-zero, .trend-missing { color: var(--muted); font-size: 12px; margin-bottom: 8px; }
.trend-missing { position: absolute; bottom: 0; right: 0; background: var(--surface); padding: 2px; }
.trend-month-label { margin-top: 10px; font-size: 12px; color: var(--muted); white-space: nowrap; }
.trend-month-value { font-family: var(--number-font); font-size: 11px; margin-top: 4px; white-space: nowrap; }
.dashboard-note, .trend-masked { margin-top: 16px; font-size: 12px; color: var(--muted); }
.trend-masked { padding: 40px 0; text-align: center; }
.dashboard-months { padding-top: 24px; }.dashboard-months-heading > span { font-size: 12px; color: var(--muted); }
.dashboard-month-row { display: grid; grid-template-columns: 1fr 1.3fr 1fr 24px; gap: 18px; align-items: center; width: 100%; padding: 17px 0; border-bottom: 1px solid var(--line); text-align: left; }
.dashboard-month-row:hover { background: var(--subtle); }.dashboard-month-row > strong, .dashboard-deduction { font-family: var(--number-font); text-align: right; font-size: 17px; font-weight: 500; }.dashboard-deduction { color: var(--muted); font-size: 15px; }.dashboard-month-row > svg { color: var(--muted); width: 17px; }
.dashboard-empty { padding: 80px 20px; text-align: center; color: var(--muted); }.dashboard-empty > svg { width: 38px; height: 38px; margin-bottom: 14px; }.dashboard-empty h2 { margin-bottom: 8px; color: var(--ink); }.dashboard-empty p { font-size: 14px; }
@media (max-width: 640px) {
  .dashboard-page { padding-top: 24px; }.dashboard-totals { grid-template-columns: 1fr; }.dashboard-net { padding: 26px 24px; }.dashboard-secondary { grid-template-columns: 1fr 1fr; padding: 4px 24px; gap: 24px; }.dashboard-secondary > div + div { border-top: 0; }.dashboard-secondary strong { font-size: 21px; }.dashboard-month-row { gap: 12px; }.dashboard-month-row > strong { font-size: 16px; }.dashboard-deduction { font-size: 14px; }
  .trend-chart { min-width: 0; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: 3px; }.trend-month { padding: 0; }.trend-bars { height: 130px; gap: 2px; }.trend-bar { width: 7px; max-width: 38%; border-radius: 2px 2px 0 0; }.trend-month-label { font-size: 10px; }.trend-month-unit, .trend-month-value { display: none; }.trend-missing { font-size: 9px; right: -3px; writing-mode: vertical-rl; padding: 1px; }
}
</style>
