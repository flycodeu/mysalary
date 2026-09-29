import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.SALARY_PLAYWRIGHT_MODULE || "playwright");
const output = new URL("../.artifacts/navigation/", import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const calls = [], errors = [], checks = [];
let ledger = null;
let releaseStartup;
const startup = new Promise((resolve) => { releaseStartup = resolve; });
let releaseSettings;
const settings = new Promise((resolve) => { releaseSettings = resolve; });
const capture = JSON.stringify({
  format: "salary-capture", version: 1,
  source: { kind: "feishu-text", page: "https://hr.hmifo.com/test/#/wages", capturedAt: "2030-06-01T00:00:00Z" },
  records: [{ payrollMonth: "2030-05", fields: [
    { label: "应发工资", amountText: "1000.00" },
    { label: "实发工资", amountText: "900.00" },
    { label: "基本工资", amountText: "1000.00" },
    { label: "个税", amountText: "100.00" },
  ] }],
});
await context.exposeFunction("__salaryTestHost", async ({ method, args }) => {
  calls.push({ method, args });
  switch (method) {
    case "listImports": return { items: [] };
    case "listPendingDataFiles": return { files: [] };
    case "loadLedger": await startup; return { content: ledger };
    case "saveLedger": ledger = args.content; return {};
    case "pickDataFile": return { content: capture };
    case "getSyncSettings": await settings; return { configured: false, username: "" };
    case "exitApp": return {};
    default: throw new Error(`Unexpected synthetic Android method: ${method}`);
  }
});
await context.addInitScript(() => {
  window.__navigationTouches = [];
  for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
    document.addEventListener(type, (event) => {
      window.__navigationTouches.push({ type, points: [...event.changedTouches].map((touch) => [touch.identifier, touch.clientX, touch.clientY]) });
      window.__navigationTouches = window.__navigationTouches.slice(-20);
    });
  }
  // Exercise the actual Capacitor adapter; no production-only test flags are needed.
  window.androidBridge = {};
  window.Capacitor = {
    PluginHeaders: [{ name: "SalaryNative", methods: [
      ...["listImports", "listPendingDataFiles", "loadLedger", "saveLedger", "pickDataFile", "getSyncSettings", "exitApp"]
        .map((name) => ({ name, rtype: "promise" })),
      { name: "addListener", rtype: "callback" }, { name: "removeListener", rtype: "callback" },
    ] }],
    nativePromise: (_plugin, method, args) => window.__salaryTestHost({ method, args }),
    nativeCallback: () => "synthetic-listener",
  };
});
const page = await context.newPage();
page.on("pageerror", (error) => errors.push(error.message));
const cdp = await context.newCDPSession(page);
async function nativeBack(count = 1) {
  await page.evaluate((times) => {
    for (let index = 0; index < times; index++) window.dispatchEvent(new Event("salary:navigate-back"));
  }, count);
}
async function state(expected) {
  try { await page.locator(`.app-shell[data-back-state="${expected}"]`).waitFor({ timeout: 5_000 }); }
  catch (cause) {
    const observed = await page.evaluate(() => ({
      state: document.querySelector(".app-shell")?.getAttribute("data-back-state"),
      dialogs: [...document.querySelectorAll("dialog[open]")].map((dialog) => dialog.getAttribute("aria-label")),
      scrollY,
      url: location.href,
      touches: window.__navigationTouches,
    }));
    throw new Error(`Expected back state ${expected}; observed ${JSON.stringify(observed)}`, { cause });
  }
}
async function swipe(points) {
  const [first, ...rest] = points;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: first[0], y: first[1] }] });
  for (const [x, y] of rest) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
async function menu() {
  await page.getByRole("button", { name: "更多操作", exact: true }).click();
  await page.getByRole("dialog", { name: "更多", exact: true }).waitFor();
}
try {
  await page.goto(process.env.SALARY_TEST_URL || "http://127.0.0.1:5198");
  await state("busy");
  await nativeBack();
  assert.equal(await page.locator("dialog[open]").count(), 0);
  assert.equal(calls.some(({ method }) => method === "exitApp"), false);
  releaseStartup();
  await state("root");
  checks.push("startup_back_does_not_exit_or_interrupt_loading");

  await nativeBack();
  await page.getByRole("dialog", { name: "退出薪迹？", exact: true }).waitFor();
  assert.equal(calls.some(({ method }) => method === "exitApp"), false);
  await nativeBack();
  await state("root");
  checks.push("root_back_requires_confirmation_and_second_back_cancels");

  await menu();
  await page.getByRole("dialog", { name: "更多", exact: true })
    .getByRole("button", { name: "导入工资文件", exact: true }).click();
  await state("detail");
  await page.getByRole("heading", { name: "2030 年 5 月", exact: true }).waitFor();
  const persisted = ledger;

  await menu();
  await page.evaluate(() => document.querySelector(".source-button").click());
  await page.getByRole("dialog", { name: "工资来源", exact: true }).waitFor();
  assert.equal(await page.locator("dialog[open]").count(), 2);
  await nativeBack(2);
  await page.getByRole("dialog", { name: "工资来源", exact: true }).waitFor({ state: "hidden" });
  await page.getByRole("dialog", { name: "更多", exact: true }).waitFor();
  assert.equal(await page.locator("dialog[open]").count(), 1);
  await nativeBack();
  await state("detail");
  checks.push("nested_dialogs_use_open_order_and_one_back_never_closes_two_layers");

  await page.getByRole("button", { name: "坚果云同步", exact: true }).click();
  await state("busy");
  await nativeBack();
  await swipe([[8, 400], [35, 401], [130, 402]]);
  assert.equal(await page.getByRole("dialog", { name: "坚果云同步", exact: true }).isVisible(), true);
  assert.equal(calls.some(({ method }) => method === "exitApp"), false);
  releaseSettings();
  await state("modal");
  await nativeBack();
  await state("detail");
  checks.push("busy_modal_consumes_native_and_swipe_back_until_operation_finishes");

  await page.getByRole("button", { name: "删除档案", exact: true }).click();
  await nativeBack();
  await state("detail");
  assert.equal(ledger, persisted);
  await nativeBack();
  await state("root");
  await page.getByRole("heading", { name: "工资档案", exact: true }).waitFor();
  checks.push("delete_confirmation_back_keeps_record_then_detail_back_returns_to_list");

  await menu();
  await page.getByRole("button", { name: /^已删除/ }).click();
  await state("deleted");
  await nativeBack();
  await state("root");
  checks.push("deleted_list_back_returns_to_active_list");

  await page.locator(".archive-item").first().click();
  await state("detail");
  await swipe([[8, 440], [12, 400], [95, 350]]);
  await state("detail");
  await swipe([[150, 350], [190, 350], [290, 350]]);
  await state("detail");
  await swipe([[8, 350], [25, 351], [45, 352]]);
  await state("detail");
  checks.push("vertical_center_and_short_gestures_do_not_navigate");
  await swipe([[8, 350], [30, 351], [80, 352], [135, 352]]);
  await state("root");
  await nativeBack(); // Simulate a WebView delivering both touch-end and Android edge-back.
  assert.equal(await page.locator("dialog[open]").count(), 0);
  checks.push("left_edge_swipe_returns_once_even_with_duplicate_native_callback");

  await page.locator(".archive-item").first().click();
  await state("detail");
  await swipe([[382, 350], [355, 351], [300, 352], [250, 352]]);
  await state("root");
  checks.push("right_edge_swipe_returns_to_list");

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator(".archive-item").first().click();
  await swipe([[8, 350], [50, 350], [310, 350]]);
  await state("detail");
  await page.getByRole("button", { name: "薪迹首页", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await state("root");
  checks.push("desktop_width_does_not_claim_edge_swipes");

  // The next independent system press is outside the brief duplicate-gesture guard.
  await menu();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll("dialog[open]").length === 0);
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 450)));
  await nativeBack();
  await page.getByRole("dialog", { name: "退出薪迹？", exact: true }).waitFor();
  await page.screenshot({ path: new URL("exit-confirmation.png", output).pathname.replace(/^\/([A-Z]:)/, "$1") });
  await page.getByRole("button", { name: "退出应用", exact: true }).click();
  await state("root");
  assert.equal(calls.filter(({ method }) => method === "exitApp").length, 1);
  assert.equal(ledger, persisted);
  assert.deepEqual(errors, []);
  checks.push("confirmed_exit_calls_android_once_without_modifying_salary");
  const evidence = { status: "PASS", source: "synthetic Android bridge and browser touch input", checks };
  await writeFile(new URL("checks.json", output), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally { await context.close(); await browser.close(); }
