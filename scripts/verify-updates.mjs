import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.SALARY_PLAYWRIGHT_MODULE || "playwright");
const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const output = new URL("../.artifacts/updates/", import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const calls = [], errors = [], checks = [];
let reply = { status: 404, content: null };
const nextVersion = `${Number(version.split(".")[0]) + 1}.0.0`;
const releaseUrl = `https://github.com/flycodeu/mysalary/releases/download/v${nextVersion}/salary-${nextVersion}-windows-setup.exe`;
let downloadState = { state: "idle" };
let finishDownload;
await context.exposeFunction("__salaryTestHost", async ({ method, args }) => {
  calls.push({ method, args });
  if (method === "loadLedger") return { content: null };
  if (method === "checkForUpdates") return reply;
  if (method === "getUpdateDownloadStatus") return downloadState;
  if (method === "downloadUpdate") {
    downloadState = { state: "downloading", version: args.version, receivedBytes: 25, totalBytes: 100 };
    return new Promise((resolve) => { finishDownload = resolve; });
  }
  if (method === "cancelUpdateDownload") {
    downloadState = { state: "idle" };
    finishDownload?.(downloadState);
    finishDownload = undefined;
    return {};
  }
  if (method === "installUpdate") return { state: "installer-opened" };
  if (method === "openExternal") return {};
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
        listeners.forEach((receive) => receive({ data: { id: request.id, result } }));
      } catch { listeners.forEach((receive) => receive({ data: { id: request.id, error: "合成接口错误" } })); }
    },
  };
});
const page = await context.newPage();
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.goto(process.env.SALARY_TEST_URL || "http://127.0.0.1:5198");
  await page.getByRole("heading", { name: "还没有工资档案" }).waitFor();
  assert.equal(calls.some(({ method }) => method === "checkForUpdates"), false);
  checks.push("startup_does_not_request_network_updates");
  await page.getByRole("button", { name: "更多操作" }).click();
  await page.getByRole("button", { name: `检查更新 ${version}`, exact: true }).click();
  await page.getByText("暂未找到公开发行版", { exact: true }).waitFor();
  checks.push("unpublished_release_is_not_latest_or_error");
  reply = { status: 200, content: JSON.stringify({ tag_name: `v${nextVersion}`, draft: false, prerelease: false, body: "<script>ignored</script>\n测试更新", assets: [{
    name: `salary-${nextVersion}-windows-setup.exe`, state: "uploaded", size: 100,
    browser_download_url: releaseUrl,
  }] }) };
  await page.getByRole("button", { name: "重新检查" }).click();
  await page.getByText(`发现新版本 ${nextVersion}`, { exact: true }).waitFor();
  await page.getByRole("button", { name: "立即更新", exact: true }).click();
  await page.locator("[role='progressbar'][aria-valuenow='25']").waitFor();
  assert.equal(await page.getByRole("button", { name: "关闭", exact: true }).isDisabled(), true);
  assert.equal(calls.some(({ method }) => method === "openExternal"), false);
  checks.push("windows_download_progress_stays_inside_app_and_blocks_exit");
  await page.getByRole("button", { name: "取消下载", exact: true }).click();
  await page.getByRole("button", { name: "立即更新", exact: true }).waitFor();
  assert.equal(calls.some(({ method }) => method === "installUpdate"), false);
  checks.push("windows_download_can_cancel_without_opening_installer");
  await page.getByRole("button", { name: "立即更新", exact: true }).click();
  await page.getByRole("button", { name: "取消下载", exact: true }).waitFor();
  downloadState = { state: "ready", version: nextVersion, receivedBytes: 100, totalBytes: 100 };
  finishDownload(downloadState);
  finishDownload = undefined;
  await page.getByRole("button", { name: "继续安装", exact: true }).waitFor();
  for (let attempt = 0; attempt < 40 && !calls.some(({ method }) => method === "installUpdate"); attempt++) await page.waitForTimeout(50);
  assert.deepEqual(calls.filter(({ method }) => method === "installUpdate").map(({ args }) => args), [{ version: nextVersion }]);
  assert.equal(calls.some(({ method }) => /saveLedger|restoreLedger|webdavPublish/.test(method)), false);
  checks.push("matching_verified_installer_handoff_does_not_touch_ledger");
  await page.getByText("更新内容", { exact: true }).click();
  assert.match(await page.locator(".update-notes pre").innerText(), /<script>/);
  assert.equal(await page.locator(".update-notes script").count(), 0);
  checks.push("release_notes_render_as_text");
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: fileURLToPath(new URL(`update-${width}.png`, output)) });
  }
  checks.push("responsive_update_dialog");
  reply = { status: 200, content: JSON.stringify({ tag_name: `v${version}`, draft: false, prerelease: false }) };
  await page.getByRole("button", { name: "重新检查" }).click();
  await page.getByText("已是最新版本", { exact: true }).waitFor();
  checks.push("same_version_does_not_offer_installation");
  reply = { status: 503, content: null };
  await page.getByRole("button", { name: "重新检查" }).click();
  await page.getByText("暂时无法连接更新服务，请稍后重试", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "立即更新", exact: true }).count(), 0);
  checks.push("network_error_clears_previous_offer_and_allows_retry");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("heading", { name: "还没有工资档案" }).waitFor();
  reply = { status: 404, content: null };
  await page.getByRole("button", { name: "更多操作" }).click();
  await page.getByRole("button", { name: `检查更新 ${version}`, exact: true }).click();
  await page.getByText("暂未找到公开发行版", { exact: true }).waitFor();
  checks.push("reopening_checks_fresh_release_information");
  assert.deepEqual(errors, []);
  const evidence = { status: "PASS", source: "synthetic native bridge", checks };
  await writeFile(new URL("checks.json", output), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally { await context.close(); await browser.close(); }
