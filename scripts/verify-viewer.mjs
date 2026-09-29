import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.SALARY_PLAYWRIGHT_MODULE || "playwright",
);
const output = new URL("../.artifacts/viewer/", import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
});
const page = await context.newPage();
const failures = [];
page.on("pageerror", (error) => failures.push(error.message));
const checks = [];
const fields = [
  ["应发工资", "8050"],
  ["实发工资", "7090"],
  ["岗位（基本）薪水", "6000"],
  ["工龄津贴", "200"],
  ["高温津贴", "100"],
  ["补发合计", "-50"],
  ["月度奖惩", "1000"],
  ["奖金合计", "1000"],
  ["信息工程类嘉奖", "800"],
  ["嘉奖合计", "800"],
  ["养老保险费", "500"],
  ["失业保险费", "50"],
  ["医疗保险费", "100"],
  ["公积金", "300"],
  ["社保津贴补差", "-50"],
].map(([label, amountText]) => ({ label, amountText }));
function pack(months = ["2030-05"]) {
  return {
    format: "salary-capture",
    version: 1,
    source: {
      kind: "feishu-text",
      page: "https://hr.hmifo.com/test/#/wages",
      capturedAt: "2030-06-01T08:00:00Z",
    },
    records: months.map((payrollMonth) => ({
      payrollMonth,
      fields: structuredClone(fields),
    })),
  };
}
async function upload(value) {
  await page.getByLabel("选择工资文件").setInputFiles({
    name: "synthetic.salary.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(value)),
  });
  await page.locator(".working").waitFor({ state: "hidden" });
}
async function back() {
  const button = page.getByRole("button", { name: "工资档案", exact: true });
  if (await button.isVisible()) await button.click();
  else await page.getByRole("button", { name: "薪迹首页", exact: true }).click();
}
async function count(expected) {
  await page.waitForFunction(
    (n) => document.querySelectorAll(".archive-row").length === n,
    expected,
  );
}
try {
  await page.goto(process.env.SALARY_VIEWER_URL || "http://127.0.0.1:5198");
  await page.getByRole("heading", { name: "还没有工资档案" }).waitFor();
  await upload(pack());
  await page.getByRole("heading", { name: "2030 年 5 月" }).waitFor();
  assert.equal(
    await page.locator(".detail-balance strong").innerText(),
    "7,090.00",
  );
  assert.match(
    await page.locator(".reconciliation > summary").innerText(),
    /10.00/,
  );
  assert.equal(await page.locator("input:visible,textarea:visible").count(), 0);
  assert.equal(
    await page.getByRole("button", { name: /编辑|识别|核对保存/ }).count(),
    0,
  );
  assert.equal(
    await page.locator(".reconciliation").getAttribute("open"),
    null,
  );
  checks.push(
    "import_source_totals_and_preserve_difference",
    "read_only_detail_no_forced_review",
  );
  await page
    .locator(".salary-group > summary")
    .filter({ hasText: "津贴奖金合计" })
    .click();
  assert.ok(await page.getByText("工龄津贴", { exact: true }).isVisible());
  await page
    .locator(".salary-group > summary")
    .filter({ hasText: "津贴奖金合计" })
    .click();
  await page.getByRole("button", { name: "查看来源", exact: true }).click();
  assert.equal(await page.locator(".source-fields .salary-line").count(), 15);
  await page
    .getByRole("dialog", { name: "工资来源" })
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await page.getByRole("button", { name: "隐藏金额", exact: true }).click();
  assert.equal(
    await page.locator(".detail-balance strong").innerText(),
    "••••",
  );
  await page.getByRole("button", { name: "查看来源", exact: true }).click();
  assert.equal(await page.locator(".source-fields").count(), 0);
  await page
    .getByRole("dialog", { name: "工资来源" })
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await page.getByRole("button", { name: "显示金额", exact: true }).click();
  await page.getByRole("button", { name: "关闭提示", exact: true }).click();
  checks.push("expand_groups_and_view_source", "mask_hides_source_amounts");
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      ),
      false,
    );
    await page.screenshot({
      path: new URL(`detail-${width}.png`, output).pathname.replace(
        /^\/([A-Z]:)/,
        "$1",
      ),
      fullPage: true,
    });
  }
  checks.push("responsive_320_390_1280");
  await back();
  await count(1);
  const again = pack();
  again.source.capturedAt = "2030-06-02T08:00:00Z";
  await upload(again);
  await back();
  await count(1);
  await page.reload();
  await count(1);
  checks.push("repeat_capture_ignores_timestamp", "reload_persistence");
  await page.locator(".archive-item").first().click();
  await page.getByRole("button", { name: "删除档案", exact: true }).click();
  await page
    .getByRole("dialog", { name: "删除工资档案" })
    .getByRole("button", { name: "删除档案", exact: true })
    .click();
  await page.getByRole("heading", { name: "还没有工资档案" }).waitFor();
  await page.getByRole("button", { name: "更多操作" }).click();
  await page
    .getByRole("dialog", { name: "更多", exact: true })
    .getByRole("button", { name: /已删除/ })
    .click();
  await page.getByRole("button", { name: "恢复", exact: true }).click();
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await count(1);
  checks.push("delete_and_restore");
  await upload(pack(["2030-04", "2029-12"]));
  await count(3);
  await page.getByLabel("按年份筛选").selectOption("2029");
  await count(1);
  await page.getByLabel("按年份筛选").selectOption("");
  await count(3);
  const changed = pack();
  changed.records[0].fields[1].amountText = "7080";
  await upload(changed);
  await back();
  await count(4);
  assert.equal(
    await page.getByText("同月多份", { exact: true }).count(),
    2,
  );
  checks.push(
    "multi_month_import_year_filter",
    "changed_month_preserves_both_sources",
  );
  assert.equal(
    await page.locator(".latest-pay .balance strong").innerText(),
    await page.locator(".archive-item-amount").first().innerText(),
  );
  assert.equal(
    await page.locator(".latest-pay .balance strong").innerText(),
    "7,080.00",
  );
  checks.push("latest_summary_matches_newest_source");
  const invalid = pack(["2030-03"]);
  invalid.records[0].fields[0].amountText = "not-money";
  await upload(invalid);
  await page.getByRole("alert").waitFor();
  await count(4);
  checks.push("malformed_file_does_not_add_archive");
  await page.getByRole("button", { name: "关闭错误提示" }).click();
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      ),
      false,
    );
    await page.screenshot({
      path: new URL(`archive-${width}.png`, output).pathname.replace(
        /^\/([A-Z]:)/,
        "$1",
      ),
      fullPage: true,
    });
  }
  const unknown = pack(["2030-06"]);
  unknown.records[0].fields.push({ label: "特殊绩效", amountText: "123.45" });
  await upload(unknown);
  assert.equal(
    await page
      .locator(".salary-line")
      .filter({ hasText: "特殊绩效" })
      .locator(".line-amount")
      .innerText(),
    "123.45",
  );
  await back();
  await count(5);
  checks.push("unknown_label_preserves_visible_amount");
  await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("salary-preview", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction("imports", "readwrite");
      const store = tx.objectStore("imports");
      store.put({
        id: "damaged-legacy-source",
        fileName: "synthetic-damaged.salary.json",
        sourceKind: "feishu-text",
        captureJson: "{corrupt",
        createdAt: "2030-06-01T08:00:00Z",
        imagePath: "",
        width: 0,
        height: 0,
        sha256: "damaged",
        status: "recognized",
      });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  await page.reload();
  await page.getByText("文件读取异常", { exact: true }).waitFor();
  await upload(unknown);
  await page.getByRole("heading", { name: "2030 年 6 月" }).waitFor();
  await back();
  await count(6);
  await upload(unknown);
  await back();
  await count(6);
  checks.push("corrupt_source_reimport_recovers_without_losing_original");
  await page.getByLabel("选择工资文件").setInputFiles({
    name: "invalid-encoding.salary.json",
    mimeType: "application/json",
    buffer: Buffer.from([0xc3, 0x28]),
  });
  await page.getByRole("alert").filter({ hasText: "编码损坏" }).waitFor();
  await count(6);
  checks.push("invalid_utf8_is_rejected");
  await page.getByRole("button", { name: "关闭错误提示" }).click();
  await page.evaluate(async () => {
    const { demoOcr, demoImageUrl } = await import("/src/domain/demo.ts");
    const { parseSalary } = await import("/src/domain/parseSalary.ts");
    const draft = parseSalary(demoOcr);
    draft.payrollMonth = "2025-08";
    draft.statedNetMinor = 123456;
    draft.reviewStatus = "reviewed";
    const image = await (await fetch(demoImageUrl)).blob();
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("salary-preview", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction("imports", "readwrite");
      const base = {
        fileName: "synthetic-legacy.svg",
        imagePath: "",
        width: 390,
        height: 1160,
        createdAt: "2025-09-01T08:00:00Z",
        image,
        ocr: demoOcr,
      };
      tx.objectStore("imports").put({
        ...base,
        id: "legacy-reviewed",
        sha256: "legacy-reviewed",
        status: "reviewed",
        draft,
      });
      tx.objectStore("imports").put({
        ...base,
        id: "legacy-ocr",
        sha256: "legacy-ocr",
        status: "recognized",
      });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  await page.reload();
  await count(8);
  await page.locator(".archive-item").filter({ hasText: "1,234.56" }).click();
  await page.getByRole("heading", { name: "2025 年 8 月" }).waitFor();
  assert.equal(
    await page.locator(".detail-balance strong").innerText(),
    "1,234.56",
  );
  await page.getByRole("button", { name: "查看来源", exact: true }).click();
  await page.getByRole("img", { name: "已保存的工资原图" }).waitFor();
  assert.equal(
    await page
      .getByRole("img", { name: "已保存的工资原图" })
      .evaluate((img) => img.complete && img.naturalWidth > 0),
    true,
  );
  await page
    .getByRole("dialog", { name: "工资来源" })
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await back();
  await page.locator(".archive-item").filter({ hasText: "12,145.82" }).click();
  await page.getByRole("heading", { name: "2026 年 9 月" }).waitFor();
  assert.equal(
    await page.locator(".detail-balance strong").innerText(),
    "12,145.82",
  );
  checks.push("legacy_reviewed_draft_image_and_saved_ocr_remain_readable");
  assert.deepEqual(failures, []);
  await writeFile(
    new URL("checks.json", output),
    JSON.stringify({ source: "synthetic", status: "PASS", checks }, null, 2),
  );
  console.log(JSON.stringify({ status: "PASS", checks }));
} finally {
  await context.close();
  await browser.close();
}
