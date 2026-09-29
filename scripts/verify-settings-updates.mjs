import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.SALARY_PLAYWRIGHT_MODULE || "playwright");
const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const nextVersion = `${Number(version.split(".")[0]) + 1}.0.0`;
const laterVersion = `${Number(version.split(".")[0]) + 2}.0.0`;
const output = new URL("../.artifacts/settings-updates/", import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const calls = [], errors = [], checks = [];
function release(candidate = nextVersion) {
  return { status: 200, content: JSON.stringify({ tag_name: `v${candidate}`, draft: false, prerelease: false,
    body: "合成测试：改进界面与本机保存。", assets: [{ name: `salary-${candidate}-debug.apk`, state: "uploaded", size: 100,
      browser_download_url: `https://github.com/flycodeu/mysalary/releases/download/v${candidate}/salary-${candidate}-debug.apk` }] }) };
}
let reply = release();
let state = { state: "idle" };
let finishDownload;
let installerState = "permission-required";
await context.exposeFunction("__salaryTestHost", async ({ method, args }) => {
  calls.push({ method, args });
  switch (method) {
    case "listImports": return { items: [] };
    case "listPendingDataFiles": return { files: [] };
    case "loadLedger": return { content: null };
    case "getAppSettings": return { confirmExit: true };
    case "checkForUpdates": return reply;
    case "getUpdateDownloadStatus": return state;
    case "downloadUpdate":
      state = { state: "downloading", version: args.version, receivedBytes: 25, totalBytes: 100 };
      return new Promise((resolve) => { finishDownload = resolve; });
    case "cancelUpdateDownload":
      state = { state: "idle" };
      finishDownload?.(state);
      finishDownload = undefined;
      return {};
    case "installUpdate": return { state: installerState };
    case "exitApp": return {};
    default: throw new Error(`Unexpected synthetic Android method: ${method}`);
  }
});
await context.addInitScript(() => {
  window.androidBridge = {};
  window.Capacitor = {
    PluginHeaders: [{ name: "SalaryNative", methods: [
      ...["listImports", "listPendingDataFiles", "loadLedger", "saveLedger", "getAppSettings", "checkForUpdates",
        "getUpdateDownloadStatus", "downloadUpdate", "cancelUpdateDownload", "installUpdate", "exitApp"]
        .map((name) => ({ name, rtype: "promise" })),
      { name: "addListener", rtype: "callback" }, { name: "removeListener", rtype: "callback" },
    ] }],
    nativePromise: (_plugin, method, args) => window.__salaryTestHost({ method, args }),
    nativeCallback: () => "synthetic-listener",
  };
});
const page = await context.newPage();
page.setDefaultTimeout(10_000);
page.on("pageerror", (error) => errors.push(error.message));
const updateDialog = page.getByRole("dialog", { name: "应用更新", exact: true });
async function closeDialog(dialog) {
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
}
async function nativeBack() { await page.evaluate(() => window.dispatchEvent(new Event("salary:navigate-back"))); }
async function completeDownload(next) {
  assert.equal(typeof finishDownload, "function");
  state = next;
  const finish = finishDownload;
  finishDownload = undefined;
  finish(next);
}
try {
  await page.goto(process.env.SALARY_TEST_URL || "http://127.0.0.1:5198");
  await page.waitForFunction(() => document.querySelector("[data-storage-state='ready']"));
  assert.equal(calls.some(({ method }) => method === "checkForUpdates"), false);
  await page.getByRole("button", { name: "打开设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  await settings.getByText(`有新版本 ${nextVersion}`, { exact: true }).waitFor();
  assert.equal(calls.filter(({ method }) => method === "checkForUpdates").length, 1);
  assert.equal(await page.locator(".update-dot").count(), 1);
  await page.screenshot({ path: fileURLToPath(new URL("android-settings.png", output)) });
  checks.push("opening_settings_checks_latest_release_and_marks_new_version");

  await closeDialog(settings);
  reply = { status: 503, content: null };
  await page.getByRole("button", { name: "打开设置", exact: true }).click();
  await settings.getByText("检查失败，点击重试", { exact: true }).waitFor();
  assert.equal(await page.locator(".update-dot").count(), 0);
  state = { state: "ready", version };
  await settings.getByRole("button", { name: /应用更新/ }).click();
  await updateDialog.getByText("暂时无法连接更新服务，请稍后重试", { exact: true }).waitFor();
  assert.equal(await updateDialog.getByRole("button", { name: "立即更新", exact: true }).count(), 0);
  reply = release();
  await updateDialog.getByRole("button", { name: "重新检查", exact: true }).click();
  await updateDialog.getByRole("heading", { name: `发现新版本 ${nextVersion}`, exact: true }).waitFor();
  assert.equal(await updateDialog.getByRole("button", { name: "继续安装", exact: true }).count(), 0);
  checks.push("failed_refresh_removes_stale_offer_and_retry_ignores_other_version_cached_apk");

  await updateDialog.getByRole("button", { name: "立即更新", exact: true }).click();
  await page.locator(".app-shell[data-back-state='busy']").waitFor();
  await updateDialog.locator("[role='progressbar'][aria-valuenow='25']").waitFor();
  assert.equal(await updateDialog.getByRole("button", { name: "关闭", exact: true }).isDisabled(), true);
  await nativeBack();
  await page.evaluate(() => window.dispatchEvent(new Event("salary:request-exit")));
  assert.equal(await updateDialog.isVisible(), true);
  assert.equal(calls.some(({ method }) => method === "exitApp"), false);
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: fileURLToPath(new URL(`android-download-${width}.png`, output)) });
  }
  checks.push("download_progress_and_native_back_exit_are_blocked_while_busy");
  await updateDialog.getByRole("button", { name: "取消下载", exact: true }).click();
  await updateDialog.getByRole("button", { name: "立即更新", exact: true }).waitFor();
  assert.equal(calls.filter(({ method }) => method === "cancelUpdateDownload").length, 1);
  assert.equal(calls.some(({ method }) => method === "installUpdate"), false);
  checks.push("cancel_download_stops_without_opening_installer_and_can_retry");

  await updateDialog.getByRole("button", { name: "立即更新", exact: true }).click();
  await updateDialog.getByRole("button", { name: "取消下载", exact: true }).waitFor();
  await completeDownload({ state: "error", version: nextVersion, error: "合成下载中断，请重试" });
  await updateDialog.getByText("合成下载中断，请重试", { exact: true }).waitFor();
  assert.equal(calls.some(({ method }) => method === "installUpdate"), false);
  await updateDialog.getByRole("button", { name: "立即更新", exact: true }).click();
  await updateDialog.getByRole("button", { name: "取消下载", exact: true }).waitFor();
  await completeDownload({ state: "ready", version: nextVersion, receivedBytes: 100, totalBytes: 100 });
  await updateDialog.getByText("请允许安装未知应用，返回后继续安装。", { exact: true }).waitFor();
  await updateDialog.getByRole("button", { name: "继续安装", exact: true }).waitFor();
  assert.deepEqual(calls.filter(({ method }) => method === "installUpdate").map(({ args }) => args), [{ version: nextVersion }]);
  installerState = "installer-opened";
  await updateDialog.getByRole("button", { name: "继续安装", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".app-shell")?.getAttribute("data-back-state") === "modal");
  assert.deepEqual(calls.filter(({ method }) => method === "installUpdate").map(({ args }) => args), [{ version: nextVersion }, { version: nextVersion }]);
  checks.push("download_error_retries_and_ready_apk_opens_matching_system_installer_after_permission_prompt");

  await closeDialog(updateDialog);
  reply = release(laterVersion);
  await page.getByRole("button", { name: "打开设置", exact: true }).click();
  await settings.getByText(`有新版本 ${laterVersion}`, { exact: true }).waitFor();
  await settings.getByRole("button", { name: /应用更新/ }).click();
  await updateDialog.getByRole("heading", { name: `发现新版本 ${laterVersion}`, exact: true }).waitFor();
  assert.equal(await updateDialog.getByRole("button", { name: "继续安装", exact: true }).count(), 0);
  assert.equal(await updateDialog.getByRole("button", { name: "立即更新", exact: true }).count(), 1);
  assert.equal(calls.filter(({ method }) => method === "installUpdate").length, 2);
  assert.equal(calls.some(({ method }) => ["saveLedger", "restoreLedger", "webdavPublish", "addEvidence"].includes(method)), false);
  assert.deepEqual(errors, []);
  checks.push("later_release_does_not_install_older_ready_apk_and_updates_never_write_salary_data");
  const evidence = { status: "PASS", source: "synthetic Android Capacitor bridge; no physical installation", checks };
  await writeFile(new URL("checks.json", output), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally { finishDownload?.({ state: "idle" }); await context.close(); await browser.close(); }
