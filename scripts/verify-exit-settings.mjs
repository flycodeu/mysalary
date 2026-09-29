import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.SALARY_PLAYWRIGHT_MODULE || "playwright");
const output = new URL("../.artifacts/exit-settings/", import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const checks = [];

try {
  for (const platform of ["windows", "android"]) {
    const viewport = platform === "windows" ? { width: 1280, height: 900 } : { width: 390, height: 844 };
    const context = await browser.newContext({ viewport });
    let confirmExit = true;
    let loading;
    let releaseLoading;
    const calls = [], errors = [];
    await context.exposeFunction("__salaryTestHost", async ({ method, args }) => {
      calls.push({ method, args });
      switch (method) {
        case "loadLedger": await loading; return { content: null };
        case "listImports": return { items: [] };
        case "listPendingDataFiles": return { files: [] };
        case "getAppSettings": return { confirmExit };
        case "setAppSettings": confirmExit = args.confirmExit; return {};
        case "checkForUpdates": return { status: 404, content: null };
        case "setAppBusy":
        case "setExitHandlerReady":
        case "acknowledgeExitRequest":
        case "cancelAppExit":
        case "exitApp": return {};
        default: throw new Error(`Unexpected synthetic method: ${method}`);
      }
    });
    await context.addInitScript((platform) => {
      if (platform === "windows") {
        const listeners = [];
        window.__salaryDesktop = true;
        window.chrome ??= {};
        window.chrome.webview = {
          addEventListener: (_type, listener) => listeners.push(listener),
          postMessage: async (request) => {
            try {
              const result = await window.__salaryTestHost(request);
              listeners.forEach((receive) => receive({ data: { id: request.id, result } }));
            } catch (error) { listeners.forEach((receive) => receive({ data: { id: request.id, error: error.message } })); }
          },
        };
        window.__salaryRequestExit = () => listeners.forEach((receive) => receive({ data: { event: "requestExit" } }));
      } else {
        window.androidBridge = {};
        window.Capacitor = {
          PluginHeaders: [{ name: "SalaryNative", methods: [
            ...["listImports", "listPendingDataFiles", "loadLedger", "getAppSettings", "setAppSettings", "checkForUpdates", "exitApp"]
              .map((name) => ({ name, rtype: "promise" })),
            { name: "addListener", rtype: "callback" }, { name: "removeListener", rtype: "callback" },
          ] }],
          nativePromise: (_plugin, method, args) => window.__salaryTestHost({ method, args }),
          nativeCallback: () => "synthetic-listener",
        };
        window.__salaryRequestExit = () => window.dispatchEvent(new Event("salary:navigate-back"));
      }
    }, platform);
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    const requestExit = () => page.evaluate(() => window.__salaryRequestExit());
    const exits = () => calls.filter(({ method }) => method === "exitApp").length;
    const ready = () => page.locator('.app-shell[data-back-state="root"]').waitFor();
    const settings = async () => {
      await page.getByRole("button", { name: "更多操作", exact: true }).click();
      await page.getByRole("button", { name: "设置", exact: true }).click();
      return page.getByRole("dialog", { name: "设置", exact: true });
    };
    try {
      await page.goto(process.env.SALARY_TEST_URL || "http://127.0.0.1:5198");
      await ready();
      await requestExit();
      const dialog = page.getByRole("dialog", { name: "退出薪迹？", exact: true });
      await dialog.waitFor();
      const bounds = await dialog.boundingBox();
      assert.ok(bounds && Math.abs(bounds.y + bounds.height / 2 - viewport.height / 2) < 2, "exit dialog must be vertically centered");
      assert.equal(exits(), 0);
      await page.screenshot({ path: fileURLToPath(new URL(`${platform}-exit.png`, output)) });
      await dialog.getByRole("button", { name: "继续使用", exact: true }).click();
      await ready();
      assert.equal(exits(), 0);
      checks.push(`${platform}_exit_is_centered_and_can_be_cancelled`);

      let panel = await settings();
      const toggle = panel.getByRole("switch", { name: "退出前确认", exact: true });
      assert.equal(await toggle.getAttribute("aria-checked"), "true");
      await toggle.click();
      await page.waitForFunction(() => document.querySelector('[role="switch"]')?.getAttribute("aria-checked") === "false");
      assert.equal(confirmExit, false);
      await page.screenshot({ path: fileURLToPath(new URL(`${platform}-settings.png`, output)) });
      await panel.getByRole("button", { name: "关闭", exact: true }).click();
      await ready();
      await requestExit();
      await page.waitForFunction(() => document.querySelectorAll("dialog[open]").length === 0);
      await ready();
      assert.equal(exits(), 1);
      checks.push(`${platform}_disabled_confirmation_exits_without_a_dialog`);

      await page.reload();
      await ready();
      panel = await settings();
      assert.equal(await panel.getByRole("switch").getAttribute("aria-checked"), "false");
      await panel.getByRole("switch").click();
      await page.waitForFunction(() => document.querySelector('[role="switch"]')?.getAttribute("aria-checked") === "true");
      await panel.getByRole("button", { name: "关闭", exact: true }).click();
      await requestExit();
      await dialog.waitFor();
      await dialog.getByRole("button", { name: "退出应用", exact: true }).click();
      await ready();
      assert.equal(exits(), 2);
      checks.push(`${platform}_setting_survives_reload_and_confirmation_can_be_restored`);

      confirmExit = false;
      loading = new Promise((resolve) => { releaseLoading = resolve; });
      await page.reload();
      await page.locator('.app-shell[data-back-state="busy"]').waitFor();
      await requestExit();
      assert.equal(exits(), 2);
      assert.equal(await page.locator("dialog[open]").count(), 0);
      releaseLoading();
      await ready();
      assert.equal(calls.some(({ method }) => /saveLedger|restoreLedger|webdavPublish/.test(method)), false);
      assert.deepEqual(errors, []);
      checks.push(`${platform}_busy_loading_blocks_exit_even_when_confirmation_is_disabled`);
      checks.push(`${platform}_exit_and_preferences_do_not_modify_salary_data`);
    } finally { releaseLoading?.(); await context.close(); }
  }
  const evidence = { status: "PASS", source: "browser interaction with synthetic Windows and Android bridges", checks };
  await writeFile(new URL("checks.json", output), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally { await browser.close(); }
