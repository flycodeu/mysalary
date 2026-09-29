import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.SALARY_PLAYWRIGHT_MODULE || "playwright");
const output = new URL("../.artifacts/startup/", import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const errors = [];
const calls = [];
let releaseFirstRead;
let failNextRead = false;
let failAfterSave = false;
let content = null;
const firstRead = new Promise((resolve) => { releaseFirstRead = resolve; });
function capture(month) {
  return {
    format: "salary-capture", version: 1,
    source: { kind: "feishu-text", page: "https://hr.hmifo.com/test/#/wages", capturedAt: "2030-06-01T00:00:00Z" },
    records: [{ payrollMonth: month, fields: [
      { label: "应发工资", amountText: "1000" },
      { label: "实发工资", amountText: "900" },
      { label: "基本工资", amountText: "1000" },
      { label: "个人所得税", amountText: "100" },
    ] }],
  };
}
await context.exposeFunction("__salaryTestHost", async ({ method, args }) => {
  calls.push(method);
  if (method === "setAppBusy") return {};
  if (method === "loadLedger") {
    if (calls.filter((call) => call === "loadLedger").length === 1) {
      await firstRead;
      throw new Error("合成测试：首次读取失败");
    }
    if (failNextRead) {
      failNextRead = false;
      throw new Error("合成测试：刷新读取失败");
    }
    return { content };
  }
  if (method === "saveLedger") {
    content = args.content;
    if (failAfterSave) failNextRead = true;
    return {};
  }
  if (method === "pickDataFile") return { content: JSON.stringify(capture("2030-04")) };
  throw new Error(`Unexpected test method: ${method}`);
});
await context.addInitScript(() => {
  const listeners = [];
  window.__salaryDesktop = true;
  window.chrome ??= {};
  window.chrome.webview = {
    addEventListener: (_type, listener) => listeners.push(listener),
    postMessage: async (request) => {
      try {
        const result = await window.__salaryTestHost(request);
        listeners.forEach((listener) => listener({ data: { id: request.id, result } }));
      } catch {
        listeners.forEach((listener) => listener({ data: { id: request.id, error: "合成测试：档案读取失败" } }));
      }
    },
  };
});
const page = await context.newPage();
page.on("pageerror", (error) => errors.push(error.message));
const checks = [];
try {
  await page.goto(process.env.SALARY_VIEWER_URL || "http://127.0.0.1:5198");
  await page.locator("main[data-storage-state='loading']").waitFor();
  assert.equal(await page.getByRole("heading", { name: "还没有工资档案" }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "抓取飞书工资", exact: true }).first().isDisabled(), true);
  await page.getByRole("button", { name: "更多操作" }).click();
  assert.equal(await page.getByRole("button", { name: "导入工资文件", exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole("dialog", { name: "更多", exact: true }).getByRole("button", { name: "关闭", exact: true }).isDisabled(), true);
  checks.push("loading_does_not_claim_empty_or_allow_import_capture");
  releaseFirstRead();
  await page.locator("main[data-storage-state='error']").waitFor();
  await page.getByRole("dialog", { name: "更多", exact: true }).getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("heading", { name: "工资档案未能读取" }).waitFor();
  assert.equal(await page.getByRole("heading", { name: "还没有工资档案" }).count(), 0);
  checks.push("startup_failure_shows_error_and_retry_not_empty");
  content = await page.evaluate(async (pack) => {
    const { emptyLedger, captureToEntries, serializeLedger } = await import("/src/domain/ledger.ts");
    return serializeLedger({ ...emptyLedger(), entries: await captureToEntries(pack, "startup-test", "2030-06-01T00:00:00Z") });
  }, capture("2030-05"));
  const beforeRetry = calls.length;
  await page.getByRole("button", { name: "重试读取档案" }).click();
  await page.locator("main[data-storage-state='ready']").waitFor();
  await page.getByRole("heading", { name: "2030 年 5 月" }).waitFor();
  assert.deepEqual(calls.slice(beforeRetry).filter((method) => method !== "setAppBusy"), ["loadLedger"]);
  assert.equal(await page.locator(".archive-row").count(), 1);
  assert.equal(await page.locator(".preview-label").count(), 0);
  checks.push("retry_reads_existing_native_ledger_without_recapture");
  failAfterSave = true;
  await page.getByRole("button", { name: "更多操作" }).click();
  await page.getByRole("button", { name: "导入工资文件", exact: true }).click();
  await page.locator("main[data-storage-state='error']").waitFor();
  assert.equal(await page.locator(".archive-row").count(), 1);
  assert.equal(await page.locator(".detail-balance strong").innerText(), "900.00");
  assert.equal(await page.getByRole("heading", { name: "工资档案未能读取" }).count(), 0);
  checks.push("refresh_failure_preserves_already_loaded_archive");
  failAfterSave = false;
  await page.getByRole("button", { name: "重试读取档案" }).click();
  await page.locator("main[data-storage-state='ready']").waitFor();
  assert.equal(await page.locator(".archive-row").count(), 2);
  assert.equal(calls.includes("captureFeishu"), false);
  checks.push("retry_refreshes_saved_records_without_capture");
  assert.deepEqual(errors, []);
  await writeFile(new URL("checks.json", output), JSON.stringify({ source: "synthetic-desktop-bridge", status: "PASS", checks }, null, 2));
  console.log(JSON.stringify({ status: "PASS", checks }));
} finally {
  await context.close();
  await browser.close();
}
