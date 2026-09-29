// Real sources stay in a disposable local browser context; never log values or save screenshots.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const capturePath = process.env.SALARY_PRIVATE_CAPTURE;
if (!capturePath)
  throw new Error("Set SALARY_PRIVATE_CAPTURE to a local capture file");
const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.SALARY_PLAYWRIGHT_MODULE || "playwright",
);
const content = await readFile(capturePath);
const capture = JSON.parse(content.toString("utf8"));
const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext();
try {
  const page = await context.newPage();
  await page.goto(process.env.SALARY_VIEWER_URL || "http://127.0.0.1:5198");
  await page.getByRole("heading", { name: "还没有工资档案" }).waitFor();
  await page.getByLabel("选择工资文件").setInputFiles({
    name: "private-capture.salary.json",
    mimeType: "application/json",
    buffer: content,
  });
  await page.locator(".working").waitFor({ state: "hidden" });
  if (capture.records.length === 1)
    await page.getByRole("button", { name: "薪迹首页", exact: true }).click();
  await page.waitForFunction(
    (n) => document.querySelectorAll(".archive-item").length === n,
    capture.records.length,
  );
  let verified = 0;
  let unresolvedCount = 0;
  let unresolvedMonths = 0;
  for (let i = 0; i < capture.records.length; i++) {
    await page.locator(".archive-item").nth(i).click();
    const matches = await page.evaluate(async (data) => {
      const { parseCapturePackage, draftFromCapture } = await import(
        "/src/domain/capture.ts"
      );
      const { formatMoney } = await import("/src/domain/money.ts");
      const { reconcile } = await import("/src/domain/reconcile.ts");
      const parsed = parseCapturePackage(JSON.stringify(data));
      const title = document.querySelector(".detail-title h1").textContent;
      const record = parsed.records.find(
        (r) =>
          title ===
          `${r.payrollMonth.slice(0, 4)} 年 ${Number(r.payrollMonth.slice(5))} 月`,
      );
      if (!record) return { recordFound: false };
      const draft = draftFromCapture(record);
      const result = reconcile(draft);
      return {
        recordFound: true,
        netMatches: document.querySelector(".detail-balance strong").textContent === formatMoney(draft.statedNetMinor),
        grossMatches: document.querySelector(".source-totals strong").textContent === formatMoney(draft.statedGrossMinor),
        unresolvedCount: result.unresolvedLineIds.length,
      };
    }, capture);
    assert.ok(
      matches.recordFound && matches.netMatches && matches.grossMatches,
      `Imported source verification failed: ${JSON.stringify(matches)}`,
    );
    unresolvedCount += matches.unresolvedCount;
    if (matches.unresolvedCount > 0) unresolvedMonths++;
    await page.getByRole("button", { name: "查看来源", exact: true }).click();
    const sameFields = await page.evaluate((data) => {
      const title = document.querySelector(".detail-title h1").textContent;
      const record = data.records.find(
        (r) =>
          title ===
          `${r.payrollMonth.slice(0, 4)} 年 ${Number(r.payrollMonth.slice(5))} 月`,
      );
      const rows = [
        ...document.querySelectorAll(".source-fields .salary-line"),
      ];
      return (
        rows.length === record.fields.length &&
        rows.every(
          (row, i) =>
            row.children[0].textContent === record.fields[i].label &&
            row.children[1].textContent === record.fields[i].amountText,
        )
      );
    }, capture);
    assert.ok(sameFields, "Source field display did not match");
    verified++;
    await page
      .getByRole("dialog", { name: "工资来源" })
      .getByRole("button", { name: "关闭", exact: true })
      .click();
    await page.getByRole("button", { name: "薪迹首页", exact: true }).click();
  }
  await page.reload();
  await page.waitForFunction(
    (n) => document.querySelectorAll(".archive-item").length === n,
    verified,
  );
  console.log(
    JSON.stringify({
      status: "PASS",
      validationScope: "source-display-and-reload-persistence",
      months: verified,
      fields: capture.records.reduce((n, r) => n + r.fields.length, 0),
      sourceTotalsMatch: true,
      sourceFieldsMatch: true,
      reloadPersistence: true,
      classificationStatus: unresolvedCount ? "UNRESOLVED" : "CLASSIFIED",
      unresolvedCount,
      unresolvedMonths,
    }),
  );
} finally {
  await context.close();
  await browser.close();
}
