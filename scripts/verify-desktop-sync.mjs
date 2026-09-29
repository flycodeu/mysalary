import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.SALARY_PLAYWRIGHT_MODULE || "playwright",
);
const browser = await chromium.launch({ channel: "msedge", headless: true });
const url = process.env.SALARY_VIEWER_URL || "http://127.0.0.1:5198";
const output = new URL("../.artifacts/desktop-sync/", import.meta.url);
await mkdir(output, { recursive: true });
const remote = new Map();
const remoteEvidence = new Map();
const errors = [];
const checks = [];
function capture(months) {
  return JSON.stringify({
    format: "salary-capture",
    version: 1,
    source: {
      kind: "feishu-text",
      page: "https://hr.hmifo.com/test/#/wages",
      capturedAt: "2030-04-01T00:00:00Z",
    },
    records: months.map((payrollMonth) => ({
      payrollMonth,
      fields: [
        { label: "应发工资", amountText: "1000" },
        { label: "实发工资", amountText: "900" },
        { label: "基本工资", amountText: "1000" },
        { label: "个人所得税", amountText: "100" },
      ],
    })),
  });
}
async function client(width, months) {
  const state = {
    content: null,
    configured: false,
    username: "",
    exported: null,
    pick: null,
    recoveries: [],
    calls: [],
    evidence: new Map(),
  };
  const context = await browser.newContext({
    viewport: { width, height: 900 },
  });
  await context.exposeFunction("__salaryTestHost", async ({ method, args }) => {
    state.calls.push(method);
    switch (method) {
      case "loadLedger":
        return { content: state.content };
      case "getAppSettings":
        return { confirmExit: true };
      case "setAppBusy":
      case "setExitHandlerReady":
        return {};
      case "listEvidence":
        return { items: [...state.evidence.values()].filter((item) => item.recordId === args.recordId) };
      case "webdavListEvidence":
        return { items: [...remoteEvidence.values()].map(({ recordId, id, mimeType }) => ({ recordId, id, mimeType })) };
      case "webdavGetEvidence": {
        const item = remoteEvidence.get(`${args.recordId}/${args.id}`);
        assert.ok(item);
        state.evidence.set(`${args.recordId}/${args.id}`, item);
        return { item };
      }
      case "webdavPutEvidence": {
        const item = state.evidence.get(`${args.recordId}/${args.id}`);
        assert.ok(item);
        remoteEvidence.set(`${args.recordId}/${args.id}`, item);
        return {};
      }
      case "saveLedger":
        state.content = args.content;
        return {};
      case "restoreLedger":
        state.recoveries.push(state.content);
        state.content = args.content;
        return {};
      case "captureFeishu":
        return { content: capture(months) };
      case "exportDataFile":
        state.exported = args.content;
        return {};
      case "pickDataFile":
        return state.pick ? { content: state.pick } : { cancelled: true };
      case "getSyncSettings":
        return { configured: state.configured, username: state.username };
      case "setSyncSettings":
        state.configured = true;
        state.username = args.username;
        return {};
      case "clearSyncSettings":
        state.configured = false;
        state.username = "";
        return {};
      case "webdavPull":
        return { files: [...remote].map(([name, content]) => ({name, content})) };
      case "webdavPublish": {
        assert.ok(state.configured);
        const hash = createHash("sha256").update(args.content, "utf8").digest("hex");
        remote.set(`changes-${hash}.json`, args.content);
        return {};
      }
      default:
        throw new Error(`Unexpected test method: ${method}`);
    }
  });
  await context.addInitScript(() => {
    const listeners = [];
    window.chrome ??= {};
    window.chrome.webview = {
      addEventListener: (_type, listener) => listeners.push(listener),
      postMessage: async (request) => {
        try {
          const result = await window.__salaryTestHost(request);
          listeners.forEach((listener) =>
            listener({ data: { id: request.id, result } }),
          );
        } catch {
          listeners.forEach((listener) =>
            listener({ data: { id: request.id, error: "测试桥接失败" } }),
          );
        }
      },
    };
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await page.getByRole("heading", { name: "还没有工资档案" }).waitFor();
  return { page, context, state };
}
async function rows(page, expected) {
  await page.waitForFunction(
    (n) => document.querySelectorAll(".archive-row").length === n,
    expected,
  );
}
async function collect(page, count) {
  await page
    .getByRole("button", { name: "抓取飞书工资", exact: true })
    .filter({ visible: true })
    .first()
    .click();
  if (count === 1)
    await page.getByRole("button", { name: "工资档案", exact: true }).click();
  await rows(page, count);
}
async function openSync(page) {
  await page.getByRole("button", { name: "坚果云同步", exact: true }).click();
  return page.getByRole("dialog", { name: "坚果云同步" });
}
async function sync(client) {
  const panel = await openSync(client.page);
  if (!client.state.configured) {
    await panel.getByLabel("坚果云账号").fill("synthetic@example.invalid");
    await panel.getByLabel("第三方应用密码").fill("synthetic-test-no-secret");
    await panel.getByRole("button", { name: "保存连接" }).click();
  }
  await panel.getByRole("button", { name: "立即同步" }).click();
  await panel.getByRole("status").filter({ hasText: "工资和截图已同步" }).waitFor();
  await panel.getByRole("button", { name: "关闭", exact: true }).click();
}
async function exportFile(client) {
  await client.page.getByRole("button", { name: "更多操作" }).click();
  await client.page.getByRole("button", { name: "导出 JSON 档案" }).click();
  await client.page
    .getByRole("status")
    .filter({ hasText: "工资档案已导出" })
    .waitFor();
  assert.equal(JSON.parse(client.state.exported).format, "salary-archive");
}
try {
  const a = await client(1280, ["2030-03", "2030-02"]);
  const b = await client(390, ["2030-01"]);
  await collect(a.page, 2);
  await a.page.locator(".archive-summary > summary").click();
  assert.match(
    await a.page.locator(".archive-overview").innerText(),
    /1,800.00/,
  );
  await collect(a.page, 2);
  checks.push("desktop_capture_auto_archive_compute_and_deduplicate");
  await exportFile(a);
  assert.equal(JSON.parse(a.state.exported).entries.length, 2);
  await sync(a);
  const evidence = { recordId: `ledger-${JSON.parse(a.state.content).entries[0].id}`, id: "c".repeat(64), mimeType: "image/png",
    createdAt: "2030-04-01T00:00:00Z", sizeBytes: 128, width: 10, height: 10 };
  remoteEvidence.set(`${evidence.recordId}/${evidence.id}`, evidence);
  await sync(a);
  await a.page.locator('.record-evidence[aria-label="1 张原始截图"]').waitFor();
  checks.push("sync_refreshes_screenshot_count_for_unchanged_record");
  await collect(b.page, 1);
  await sync(b);
  await rows(b.page, 3);
  await sync(a);
  await rows(a.page, 3);
  assert.equal(new Set([...remote.values()].flatMap(content => JSON.parse(content).entries.map(entry => entry.id))).size, 3);
  checks.push("two_clients_merge_json_and_cloud_without_overwrite");
  await a.page.locator(".archive-item").first().click();
  await a.page.getByRole("button", { name: "删除档案", exact: true }).click();
  await a.page
    .getByRole("dialog", { name: "删除工资档案" })
    .getByRole("button", { name: "删除档案", exact: true })
    .click();
  await sync(a);
  await sync(b);
  await rows(b.page, 2);
  await b.page.getByRole("button", { name: "更多操作" }).click();
  await b.page.getByRole("button", { name: /已删除/ }).click();
  await b.page.getByRole("button", { name: "恢复", exact: true }).click();
  await b.page.getByRole("button", { name: "返回", exact: true }).click();
  await sync(b);
  await sync(a);
  await rows(a.page, 3);
  checks.push("cross_device_delete_and_restore");
  await a.page.reload();
  await rows(a.page, 3);
  await exportFile(a);
  const web = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const page = await web.newPage();
  await page.goto(url);
  await page.getByRole("heading", { name: "还没有工资档案" }).waitFor();
  await page
    .getByLabel("选择工资文件")
    .setInputFiles({
      name: "synthetic-archive.json",
      mimeType: "application/json",
      buffer: Buffer.from(a.state.exported),
    });
  await rows(page, 3);
  const malformed = JSON.parse(a.state.exported);
  malformed.entries[0].capture.records[0].fields[0].amountText = "2000";
  await page
    .getByLabel("选择工资文件")
    .setInputFiles({
      name: "bad.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(malformed)),
    });
  await page.getByRole("alert").waitFor();
  await rows(page, 3);
  await page.getByRole('button', { name: '关闭错误提示' }).click();
  checks.push("desktop_export_import_into_mobile_layout_and_tamper_rejection");
  for (const [label, target] of [
    ["desktop", a.page],
    ["mobile", page],
  ]) {
    assert.equal(
      await target.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await target.screenshot({
      path: new URL(`${label}.png`, output).pathname.replace(
        /^\/([A-Z]:)/,
        "$1",
      ),
      fullPage: true,
    });
  }
  a.state.content = "{damaged";
  await a.page.reload();
  await a.page
    .getByRole("button", { name: "选择 JSON 档案备份恢复" })
    .waitFor();
  a.state.pick = a.state.exported;
  await a.page.getByRole("button", { name: "选择 JSON 档案备份恢复" }).click();
  await a.page
    .getByRole("dialog", { name: "恢复本机账本" })
    .getByRole("button", { name: "确认恢复" })
    .click();
  await rows(a.page, 3);
  assert.deepEqual(a.state.recoveries, ["{damaged"]);
  checks.push("explicit_json_recovery_preserves_damaged_source");
  assert.deepEqual(errors, []);
  await writeFile(
    new URL("checks.json", output),
    JSON.stringify(
      {
        status: "PASS",
        scope: "synthetic app bridge and cloud; not actual WebDAV service",
        checks,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ status: "PASS", checks }));
} finally {
  await browser.close();
}
