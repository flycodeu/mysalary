import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.SALARY_PLAYWRIGHT_MODULE || "playwright");
const output = new URL("../.artifacts/evidence-dashboard/", import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
const errors = [], checks = [];
page.on("pageerror", (error) => errors.push(error.message));
const capture = {
  format: "salary-capture", version: 1,
  source: { kind: "feishu-text", page: "https://hr.hmifo.com/test/#/wages", capturedAt: "2030-09-29T08:00:00Z" },
  records: ["2030-08", "2030-09"].map((payrollMonth) => ({ payrollMonth, fields: [
    { label: "应发工资", amountText: "8000.00" }, { label: "实发工资", amountText: "7000.00" },
    { label: "岗位（基本）薪水", amountText: "8000.00" }, { label: "养老保险费", amountText: "1000.00" },
  ] })),
};
async function screenshot(name, fullPage = true) {
  await page.screenshot({ path: fileURLToPath(new URL(name, output)), fullPage });
}
async function openEvidence() {
  await page.locator(".detail-evidence-entry:visible").click();
  await page.getByRole("dialog", { name: /原始截图/ }).waitFor();
}
async function closeEvidence() {
  await page.getByRole("dialog", { name: /原始截图/ }).getByRole("button", { name: "关闭", exact: true }).click();
}
try {
  await page.goto(process.env.SALARY_TEST_URL || "http://127.0.0.1:5198");
  await page.waitForFunction(() => document.querySelector("[data-storage-state='ready']"));
  await page.getByLabel("选择工资文件").setInputFiles({ name: "synthetic.salary.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(capture)) });
  await page.locator(".working").waitFor({ state: "hidden" });
  await page.locator(".archive-item").first().click();
  await page.getByRole("heading", { name: "2030 年 9 月" }).waitFor();
  await openEvidence();
  await page.getByRole("heading", { name: "保留原始凭证" }).waitFor();
  checks.push("text_record_without_image_still_opens");

  const fixture = await context.newPage();
  await fixture.setContent("<html><body style='background:white;padding:30px;width:320px;color:#173c2f;font:20px sans-serif'><h1>合成测试工资</h1><p>2030 年 9 月</p><p>应发：8000.00</p><p>实发：7000.00</p></body></html>");
  const original = await fixture.screenshot({ type: "png" });
  await fixture.close();
  await page.getByLabel("选择工资截图").setInputFiles({ name: "synthetic-payroll.png", mimeType: "image/png", buffer: original });
  await page.waitForFunction(() => document.querySelector(".evidence-image img")?.naturalWidth > 0);
  assert.equal(await page.locator(".evidence-count").innerText(), "1 张");
  await page.getByLabel("选择工资截图").setInputFiles({ name: "duplicate.png", mimeType: "image/png", buffer: original });
  await page.waitForFunction(() => !Array.from(document.querySelectorAll(".evidence-loading")).some((node) => node.textContent.includes("正在保存原图")));
  assert.equal(await page.locator(".evidence-count").innerText(), "1 张");
  checks.push("original_bytes_persist_and_duplicate_images_do_not_multiply");
  await page.getByLabel("选择工资截图").setInputFiles([
    { name: "kept-original.png", mimeType: "image/png", buffer: original },
    { name: "invalid.png", mimeType: "image/png", buffer: Buffer.from("not-an-image") },
  ]);
  await page.getByRole("alert").filter({ hasText: "请选择 PNG 或 JPEG 原始截图" }).waitFor();
  assert.equal(await page.locator(".evidence-count").innerText(), "1 张");
  await page.waitForFunction(() => document.querySelector(".evidence-image img")?.naturalWidth > 0);
  await page.getByRole("button", { name: "重试读取", exact: true }).click();
  await page.locator(".evidence-error").waitFor({ state: "hidden" });
  checks.push("invalid_image_keeps_previously_saved_original");
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await screenshot(`evidence-${width}.png`, false);
  }
  await closeEvidence();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.waitForFunction(() => document.querySelector("[data-storage-state='ready']"));
  await page.locator(".archive-item").first().click();
  await openEvidence();
  await page.waitForFunction(() => document.querySelector(".evidence-image img")?.naturalWidth > 0);
  const dataUrl = await page.locator(".evidence-image img").getAttribute("src");
  assert.ok(Buffer.from(dataUrl.split(",")[1], "base64").equals(original));
  checks.push("reload_restores_byte_identical_original");
  await closeEvidence();
  await page.getByRole("button", { name: "隐藏金额", exact: true }).click();
  await openEvidence();
  await page.getByText("金额已隐藏，原图同时隐藏。", { exact: true }).waitFor();
  assert.equal(await page.locator(".evidence-image img").count(), 0);
  checks.push("privacy_mask_does_not_render_original_image");
  await closeEvidence();
  await page.getByRole("button", { name: "显示金额", exact: true }).click();
  await page.locator(".detail-back:visible").click();
  await page.locator(".archive-item").nth(1).click();
  await openEvidence();
  await page.getByRole("heading", { name: "保留原始凭证" }).waitFor();
  assert.equal(await page.locator(".evidence-image img").count(), 0);
  checks.push("original_is_linked_to_its_record_only");
  await closeEvidence();
  await page.locator(".detail-back:visible").click();
  await page.getByRole("tab", { name: "看板", exact: true }).click();
  await page.getByRole("heading", { name: "工资看板", exact: true }).waitFor();
  assert.equal(await page.locator(".dashboard-balance strong").innerText(), "14,000.00");
  assert.deepEqual(await page.locator(".dashboard-secondary strong").allTextContents(), ["16,000.00", "2,000.00"]);
  assert.equal(await page.locator(".trend-month").count(), 12);
  assert.equal(await page.locator(".trend-month:disabled").count(), 10);
  checks.push("annual_totals_match_saved_source_totals_and_missing_months_stay_empty");
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await screenshot(`dashboard-${width}.png`);
  }
  await page.getByRole("button", { name: "隐藏金额", exact: true }).click();
  assert.equal(await page.locator(".dashboard-balance strong").innerText(), "••••");
  assert.equal(await page.locator(".trend-chart").count(), 0);
  await page.getByRole("button", { name: "显示金额", exact: true }).click();
  await page.locator(".trend-month").nth(7).click();
  await page.getByRole("heading", { name: "2030 年 8 月", exact: true }).waitFor();
  checks.push("dashboard_mask_hides_trend_and_month_link_opens_its_salary");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".detail-back:visible").click();
  await page.locator(".archive-item").first().click();
  await openEvidence();
  await page.waitForFunction(() => document.querySelector(".evidence-image img")?.naturalWidth > 0);
  await page.getByRole("button", { name: "删除截图", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "删除截图", exact: true });
  await screenshot("evidence-delete-confirm-390.png", false);
  await confirmation.getByRole("button", { name: "取消", exact: true }).click();
  assert.equal(await page.locator(".evidence-image img").count(), 1);
  await page.getByRole("button", { name: "删除截图", exact: true }).click();
  await confirmation.getByRole("button", { name: "确认删除", exact: true }).click();
  await page.getByRole("heading", { name: "保留原始凭证" }).waitFor();
  assert.equal(await page.locator(".evidence-image img").count(), 0);
  await closeEvidence();
  await page.reload();
  await page.waitForFunction(() => document.querySelector("[data-storage-state='ready']"));
  await page.locator(".archive-item").first().click();
  await openEvidence();
  await page.getByRole("heading", { name: "保留原始凭证" }).waitFor();
  await page.getByLabel("选择工资截图").setInputFiles({ name: "deleted-original.png", mimeType: "image/png", buffer: original });
  await page.getByRole("alert").filter({ hasText: "这张截图已删除" }).waitFor();
  checks.push("confirmed_delete_removes_original_and_persists_across_reload_without_reimport");

  assert.deepEqual(errors, []);
  const evidence = { status: "PASS", source: "synthetic browser data and real IndexedDB storage", checks };
  await writeFile(new URL("checks.json", output), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally { await context.close(); await browser.close(); }
