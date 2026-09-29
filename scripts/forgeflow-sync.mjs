import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Supported API only. Design/document/source updates use server-side revision checks.
// Feature names and statuses have no CAS route, so this tool preserves those records
// and supersedes their old design heads instead of rewriting execution history.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, ".artifacts", "forgeflow");
const projectId = "62c318b4-045b-40a1-8c2a-030d203c35d7";
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const targetVersion = packageJson.version;
if (typeof targetVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(targetVersion)) throw new Error("package.json must contain a stable release version.");
const apply = process.argv.includes("--apply");
const evidenceIndex = process.argv.indexOf("--evidence");
if (evidenceIndex >= 0 && !process.argv[evidenceIndex + 1]) throw new Error("--evidence requires a JSON path.");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const normalize = (value) => value.replace(/\r\n?/g, "\n").trim();
const heading = `薪迹 ${targetVersion} 当前双端方案`;
const ownership = "设计、实现、自动化测试、真实设备验证与 Owner 验收分别记录。本文不代表 Owner 验收；未发布 GitHub Release。";
const modules = [
  {
    code: "D01", name: "Windows 工资采集", legacy: ["F04", "F21"],
    purpose: "用户在飞书打开并展开工资月份后，由 Windows 采集可访问的页面文字，保存结构化来源并交给共享规则处理。",
    design: [
      "采集仅针对用户已登录、已打开的工资页面；从 Windows 可访问性接口读取文本。独立网页存在飞书登录上下文限制，不能将匿名网页请求失败当成金额为空。",
      "来源包含月份、标签与原载金额文本。采集内容按格式校验后保存，重复采集相同内容去重；同月内容不同保留来源版本，不覆盖旧数据。",
      "Windows 负责采集、规则计算、归档和数据整合。沿用 .NET Framework、WinForms 与系统 WebView2，避免打包浏览器和常驻模型；采集程序按需运行。",
      "采集失败显示具体失败状态，不能补零、套用上月或要求用户逐行重新填写；来源金额与核算结果保持独立。",
    ],
    files: ["windows/SalaryCollector/Program.cs", "windows/SalaryDesktop/Program.cs", "src/domain/capture.ts", "src/platform/archive.ts"],
    acceptance: "可在真实飞书工资页读取展开月份；重复导入不增加同内容档案，同月异内容保留；失败不影响已有账本。",
  },
  {
    code: "D02", name: "工资核算与可靠档案", legacy: ["F06", "F08", "F11", "F12"],
    purpose: "以应发和扣款两类解释工资，保存来源总额、计算值和差额，让用户直接查阅结果。",
    design: [
      "金额统一使用整数分；未知为 null。应发由基本薪水、津贴奖金、工程类嘉奖及补发等实际字段构成，负补发保留负号；其他扣款按字段语义处理。",
      "汇总字段和子项不能重复计入。核算规则为纯函数，由共享领域层定义，Windows 和 Android 使用同一套结构化数据。",
      "来源应发、来源实发和明细计算值分开保存。应发减实发可以展示来源扣款；明细有差额时明确显示，不调整其他项目凑平。",
      "账本保存使用已有原子替换与备份路径。启动先显示读取中；读取失败显示错误和只读重试入口，不能冒充空账本。刷新失败保留已展示数据。",
      "删除采用可恢复状态，多端以版本状态合并；原档案证据和有效历史不因重复导入、删除恢复或升级消失。",
    ],
    files: ["src/domain/money.ts", "src/domain/salaryRules.ts", "src/domain/reconcile.ts", "src/domain/ledger.ts", "src/platform/ledgerStore.ts", "windows/SalaryDesktop/LocalStore.cs"],
    acceptance: "负值、未知值、汇总去重、同月多来源与差额回归通过；读取失败不清空现有档案；重启可读取原账本。",
  },
  {
    code: "D03", name: "双端轻量阅读界面", legacy: ["F02", "F07", "F13", "F14"],
    purpose: "桌面便于连续浏览月份，手机负责阅读数据，正常页面不堆输入框与内部分类选项。",
    design: [
      "桌面采用左侧档案列表、右侧月度详情；手机保持单列列表和详情导航。优先显示实发工资，其次是应发、扣款及两组明细。",
      "年度汇总、来源、补充信息等按需展开。隐藏金额时来源弹层也不泄露金额；示例明确标注为合成数据。",
      "保留年份筛选、同月多来源、来源查看、删除与恢复。新流程不再让手机承担 OCR 和逐行人工核对；旧档案读取仅作为兼容边界，不成为新采集入口。",
      "统一桌面、Android 与网页预览的品牌和交互。预览明确说明数据存于该浏览器；原生桌面与手机不得静默回退到浏览器档案库。",
    ],
    files: ["src/App.vue", "src/style.css", "src/components/SalaryDetail.vue", "src/components/ModalSheet.vue", "src/platform/host.ts"],
    acceptance: "320/390 像素手机与桌面宽度下无横向溢出，月份选择、金额遮挡、来源弹层、删除恢复真实交互通过；Android 真机结果独立登记。",
  },
  {
    code: "D04", name: "共享 JSON 与坚果云同步", legacy: ["F01", "F16", "F17", "F18", "F19", "F22"],
    purpose: "电脑处理后的工资可通过 JSON 导入导出或坚果云传到手机，共享同一账本与删除状态。",
    design: [
      "共享 JSON 使用版本化格式与严格校验，导入通过合并进入已有账本；损坏、超限或编码无效的文件不能覆盖当前数据。",
      "WebDAV 使用固定工资目录和按内容哈希命名的追加文件，兼容旧 archive-v1.json。不能依赖坚果云未保证的条件覆盖行为来保护并发数据。",
      "发布后回读并验证哈希；目录清单只接受同域、固定目录下的允许文件名，拒绝跳转、嵌套路径、遍历和超限数据。网络错误不替换本地账本。",
      "Windows 凭据使用系统保护，Android 使用平台已有私有存储边界；凭据不写日志、Git 或同步报告。当前同步对象是工资 JSON，经 HTTPS 传输，不能宣传为端到端加密档案。",
      "手机保留导入、同步及查看职责，不增加服务器、复杂多包层或常驻识别模型。",
    ],
    files: ["src/platform/sync.ts", "src/components/SyncPanel.vue", "src/domain/ledger.ts", "windows/SalaryDesktop/WebDavClient.cs", "windows/SalaryDesktop/WebDavSnapshots.cs"],
    acceptance: "合成双端合并、重复同步、删除恢复与错误隔离通过；真实云连通性、Windows 读写和 Android 真机同步分开记录。",
  },
  {
    code: "D05", name: "安装、覆盖升级与更新检查", legacy: ["F20"],
    purpose: "保留稳定应用身份和独立数据目录，支持轻量安装、原位置升级和主动查询新版本。",
    design: [
      "Windows 正式安装身份固定，支持自选普通目录，升级默认沿用原目录。安装与卸载仅管理程序文件，拒绝与数据目录重叠、目录联接和短路径别名等危险目标。",
      "Android applicationId 与签名保持稳定；覆盖安装兼容性必须以签名和设备实际安装为证据，编译成功不能替代升级保留数据验证。",
      "GitHub Releases 查询由用户主动触发，区分无新版本、未配置发布源、网络失败和可下载版本。不能把未发布的版本显示成已可用更新，也不后台自动覆盖安装。",
      "本轮准备源码与本地构建产物，不自动发布 GitHub Release。安装器隔离测试与真实应用启动验证单独报告。",
    ],
    files: ["windows/Installer/Salary.iss", "scripts/windows-installer.ps1", "scripts/windows-installer-test.ps1", "src/domain/release.ts", "src/platform/updates.ts", "src/components/UpdatePanel.vue"],
    acceptance: "自选目录、覆盖升级、卸载保留数据和路径拒绝用例通过；真实程序两次启动数据一致；发布源未准备好时不制造更新状态。",
  },
  {
    code: "D06", name: "代码维护、回归与 Git 准备", legacy: ["F05"],
    purpose: "清理已被替代的 OCR 和旧文档入口，保留可信测试历史，以可重复脚本维护当前工程和 ForgeFlow。",
    design: [
      "产品源码按采集、领域规则、平台存储和阅读界面分工，复用一个 Vue/Capacitor 工程；不为尚无复用需求建立新框架。",
      "过时方案退出当前入口，旧测试和历史修订保留作为当时证据。不能继续运行旧 OCR 导入脚本覆盖当前设计。",
      "Git 准备排除工资原文、图片、凭据、构建产物、缓存和本地运行证据；远程创建、推送和 Release 发布以用户实际授权与执行结果为准。",
      "ForgeFlow 通过已公开 API 同步；规格用 expectedHeadRevisionId，档案用 expectedRevisionId，来源用 expectedUpdatedAt。发生冲突即停止，不直写数据库。",
      "自动化、构建、浏览器、真实 Windows、真实云和 Android 真机分别登记；没有 Owner 验收记录时不得宣称整体验收完成。",
    ],
    files: ["package.json", "scripts/forgeflow-sync.mjs", "scripts/verify-viewer.mjs", "scripts/verify-startup.mjs", "scripts/verify-desktop-sync.mjs"],
    acceptance: "领域测试、生产构建与实际浏览器交互通过；敏感文件未纳入 Git；ForgeFlow 回读与版本校验通过，保留原历史 Run。",
  },
];
const overview = [`# ${heading}`, "## 当前职责与范围", ...modules.map((item) => `- ${item.code} ${item.name}：${item.purpose}`),
  "## 与旧方案的关系", "旧的 Android 优先、手机 OCR、逐行人工核对及将桌面/同步推迟到未来的规划已经被本方案取代。当前范围以本文和 D01–D06 为准；旧功能树名称属于历史索引，最新设计正文说明承接关系。",
  "## 数据与验收约束", "金额为整数分，未知为 null；来源总额、计算值和差额分开。保留用户原始数据，不补零、不抄上月、不凑平。", ownership,
  "## 维护入口", "由 scripts/forgeflow-sync.mjs 自包含生成当前方案；不依赖已归档的旧 Markdown。正式验证结果单独存为当前验证登记；历史 Run 和已验证文档保持不可变。",
].join("\n\n");
const contentFor = (item) => [`# ${item.code} ${item.name}`, `目标版本：${targetVersion}。${ownership}`, "## 用户结果", item.purpose,
  "## 实施规则", ...item.design.map((line) => `- ${line}`), "## 源码职责", ...item.files.map((file) => `- ${file}`),
  "## 验证要求", item.acceptance, "## 历史承接", `历史编号：${item.legacy.join("、")}。旧任务与旧测试结论只描述当时版本；当前设计和最终验证分别登记。`,
].join("\n\n");
const retired = {
  F03: "手机本地 OCR 已退出新流程，当前采集由 D01 的 Windows 飞书结构化读取承担。旧识别测试只作为历史证据，不能用于宣称当前识别准确率。",
  F09: "动态自定义类别暂不属于当前轻量流程。已有字段语义由 D02 的纯函数规则处理；未知字段保留来源，不自动猜测。",
  F10: "公司模板与别名学习不属于当前范围。当前 D01 读取已展开的飞书工资页面，D02 使用明确字段规则。",
  F15: "独立本地加密档案与恢复密钥未纳入本次交付。D04 的系统凭据保护和 HTTPS 同步不等同于工资档案端到端加密。",
};
const currentSpecs = [
  { kind: "background", content: overview },
  { kind: "requirements", content: [`# ${heading}：需求与验证`, ...modules.map((item) => `## ${item.code} ${item.name}\n\n${item.purpose}\n\n验收：${item.acceptance}`), ownership].join("\n\n") },
  { kind: "research", content: `# 结构化采集可行性与旧 OCR 方案取代说明\n\n${contentFor(modules[0])}\n\n## 可行性证据边界\n\n独立网页受飞书会话限制，不据此绕过认证。使用用户已打开的桌面页面读取可访问文本。模型识别准确率不再是新流程的数据来源；真实页面覆盖月份、采集稳定性和合计校验以实际结果为准。旧 OCR 候选调研保存在本栏历史修订中。` },
  { kind: "architecture", content: [`# ${heading}：架构`, "Windows 采集 → 结构化来源 → 共享领域规则与账本 → JSON / WebDAV → Android 阅读。", contentFor(modules[1]), contentFor(modules[3]), contentFor(modules[4])].join("\n\n") },
  { kind: "technology", content: [`# ${heading}：技术与维护`, "保留 Vue 3、TypeScript、Capacitor、.NET Framework / WinForms / WebView2 和已有 WebDAV 桥接。Windows 采集按需运行；手机不新增常驻模型和服务。", contentFor(modules[2]), contentFor(modules[5])].join("\n\n") },
];
const documents = [{ key: "overview", title: heading, content: overview }, ...modules.map((item) => ({ key: item.code, title: `${item.code} ${item.name}（当前）`, content: contentFor(item) }))]
  .map((item) => ({ ...item, sourcePath: `salary://current/${item.key}`, originalFilename: `${item.key}.md`, contentType: "text/markdown" }));
let evidence;
let evidenceManifest = [];
async function safeFile(path) {
  if (typeof path !== "string" || !path) throw new Error("Evidence paths must be non-empty workspace-relative paths.");
  const absolute = resolve(root, path);
  const fromRoot = relative(root, absolute);
  if (isAbsolute(path) || fromRoot.startsWith("..") || isAbsolute(fromRoot)) throw new Error("Evidence path escapes workspace.");
  const info = await stat(absolute);
  if (!info.isFile()) throw new Error("Evidence path is not a file.");
  return { path: fromRoot.replaceAll("\\", "/"), sizeBytes: info.size, sha256: hash(await readFile(absolute)) };
}
if (evidenceIndex >= 0) {
  const input = resolve(root, process.argv[evidenceIndex + 1]);
  if (!input.startsWith(output + "\\") && !input.startsWith(output + "/")) throw new Error("Evidence JSON must be under .artifacts/forgeflow.");
  evidence = JSON.parse(await readFile(input, "utf8"));
  if (evidence.targetVersion !== targetVersion || packageJson.version !== targetVersion) throw new Error("Evidence version must match the target and package.json.");
  if (typeof evidence.summary !== "string" || !evidence.summary.trim() || !Array.isArray(evidence.checks) || !evidence.checks.length
    || !Array.isArray(evidence.limitations) || evidence.limitations.some((value) => typeof value !== "string")) throw new Error("Invalid evidence schema.");
  const ids = new Set();
  for (const check of evidence.checks) {
    if (typeof check.id !== "string" || !check.id || ids.has(check.id) || !["PASS", "FAIL", "NOT_RUN"].includes(check.status)
      || typeof check.command !== "string" || typeof check.summary !== "string" || !Array.isArray(check.featureCodes)
      || check.featureCodes.some((code) => !modules.some((item) => item.code === code)) || !Array.isArray(check.evidencePaths)) throw new Error("Invalid or duplicated evidence check.");
    ids.add(check.id);
  }
  const paths = [...new Set([...evidence.checks.flatMap((check) => check.evidencePaths), ...(evidence.artifacts ?? []).map((item) => item.path)])];
  evidenceManifest = await Promise.all(paths.map(safeFile));
  const content = [`# ${targetVersion} 实现与分层验证登记`, evidence.summary, "## 当前源码版本", `package.json：${packageJson.version}。证据为 AI 登记，不是 Owner 验收。`,
    "## 分层结果", ...evidence.checks.map((check) => `### ${check.id} · ${check.status}\n\n关联：${check.featureCodes.join("、")}\n\n命令／操作：${check.command}\n\n${check.summary}\n\n证据：${check.evidencePaths.join("；") || "人工操作结果，由登记人明确报告"}`),
    "## 尚未验证与限制", ...evidence.limitations.map((line) => `- ${line}`), "## 文件指纹", ...evidenceManifest.map((file) => `- ${file.path} · ${file.sizeBytes} bytes · SHA-256 ${file.sha256}`), "## 验收", ownership,
  ].join("\n\n");
  documents.push({ key: "verification", title: `${targetVersion} 实现与分层验证（当前）`, sourcePath: "salary://current/verification", originalFilename: "verification.md", contentType: "text/markdown", content });
}

const { discoverArchiveRuntime } = await import(pathToFileURL(join(process.env.FORGEFLOW_REPO ?? resolve(root, "../ForgeFlow"), "scripts/lib/runtime-discovery.mjs")));
const runtime = await discoverArchiveRuntime();
if (runtime.source !== "desktop") throw new Error("Use the authenticated installed ForgeFlow desktop runtime; no development fallback.");
const token = process.env.FORGEFLOW_MCP_TOKEN;
if (!token) throw new Error("An existing AI token is required; never record AI work as Owner evidence.");
let mutations = 0;
async function api(path, method = "GET", body) {
  const response = await fetch(new URL(path, runtime.url), { method, redirect: "error", signal: AbortSignal.timeout(15000),
    headers: { ...runtime.getHeaders(), Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const failure = await response.json().catch(() => ({}));
    throw new Error(`${method} ${path}: HTTP_${response.status} ${failure.code ?? failure.error?.code ?? ""}`);
  }
  const result = await response.json();
  if (method !== "GET" && result.replayed !== true) mutations++;
  return result;
}
const base = `/api/projects/${projectId}`;
const [before, archiveBefore] = await Promise.all([api(base), api(`${base}/archive/export`)]);
if (before.project.projectKey !== "SALARY" || before.project.id !== projectId) throw new Error("Unexpected project identity.");
const source = before.sources.find((item) => item.alias === "salary-app");
if (!source) throw new Error("Missing salary-app source.");
// These two fields are computed against today's design heads on every GET;
// superseding a design should make old runs STALE without rewriting their evidence.
const immutableRuns = (runs) => runs.map(({designSnapshotStatus,designSnapshotWarnings,...run})=>run);
const preservedRunHash = hash(JSON.stringify(immutableRuns(before.runs)));
const preservedTaskHash = hash(JSON.stringify(before.tasks));
const preservedHistories = archiveBefore.documents.filter((item) => /P0(?:\.1|[- ]?Android| 实现)/.test(item.title));
const obsoletePaths = ["工资档案App-可实施方案.md", "功能清单与P0实施设计.md", "技术选型与学习路线.md", "README.md"];
const obsoleteDocuments = archiveBefore.documents.filter((item) => item.sourcePath && obsoletePaths.some((file) => item.sourcePath.replaceAll("\\", "/").endsWith(`/${file}`)));
const plan = { targetVersion, observedPackageVersion: packageJson.version, projectId, evidenceIncluded: Boolean(evidence),
  currentSpecifications: currentSpecs.map(({kind})=>kind), currentDocuments: documents.map(({key,title,sourcePath,content})=>({key,title,sourcePath,sha256:hash(content)})),
  supersededDesigns: before.specifications.filter((item) => item.kind === "capability-design").map(({id,title,latestRevisionId})=>({id,title,expectedHeadRevisionId:latestRevisionId})),
  supersededDocuments: obsoleteDocuments.map(({id,title,currentRevisionId})=>({id,title,expectedRevisionId:currentRevisionId})),
  preservedRuns: before.runs.length, preservedTasks: before.tasks.length, preservedHistories: preservedHistories.map(({id,title,currentRevisionId})=>({id,title,currentRevisionId})),
  limits: ["Project description and tree names have no supported CAS update route; current design heads explicitly replace the historical catalog.", "No task confirmation, status promotion, Run rewrite, direct database write or GitHub publication."],
};
await mkdir(output, {recursive:true});
await writeFile(join(output, "sync-plan.json"), JSON.stringify(plan,null,2)+"\n");
if (!apply) {
  console.log(JSON.stringify({mode:"plan",targetVersion,observedPackageVersion:packageJson.version,currentDocuments:documents.length,specifications:currentSpecs.length,supersededDesigns:plan.supersededDesigns.length,preservedRuns:before.runs.length,plan:join(output,"sync-plan.json")}));
  process.exit(0);
}
const snapshotId = new Date().toISOString().replaceAll(":", "-");
await writeFile(join(output,`before-${snapshotId}.json`),JSON.stringify(archiveBefore,null,2)+"\n");
const specificationReceipts = [];
async function saveSpecification(spec, content) {
  const current = await api(`${base}/specifications/${spec.id}`);
  if (normalize(current.latestRevision?.content ?? "") !== normalize(content)) {
    await api(`${base}/specifications/${spec.id}/revisions`, "POST", { content,
      expectedHeadRevisionId: current.specification.latestRevisionId,
      changeSummary: `以 ${targetVersion} 双端方案取代旧设计入口，保留历史版本与测试证据`,
    });
  }
  const saved = await api(`${base}/specifications/${spec.id}`);
  if (normalize(saved.latestRevision?.content ?? "") !== normalize(content)) throw new Error("Specification readback mismatch.");
  specificationReceipts.push({id:spec.id,headRevisionId:saved.specification.latestRevisionId,sha256:hash(content)});
}
for (const descriptor of currentSpecs) {
  const spec = before.specifications.find((item)=>item.kind === descriptor.kind && !item.featureId);
  if (!spec) throw new Error(`Missing existing specification: ${descriptor.kind}`);
  await saveSpecification(spec, descriptor.content);
}
for (const spec of before.specifications.filter((item)=>item.kind === "capability-design")) {
  const feature = before.features.find((item)=>item.id === spec.featureId);
  if (!feature || !/^F\d{2}$/.test(feature.code)) continue;
  const current = modules.filter((item)=>item.legacy.includes(feature.code));
  const content = [`# ${feature.code} ${feature.name}：旧设计已取代`,
    `本功能树节点保留为历史索引。${targetVersion} 当前方案已经取代原先的阶段和技术假设；旧任务、Run 与历史修订原样保留，不能作为当前版本完成状态。`,
    "## 当前承接", retired[feature.code] ?? current.map((item)=>`${item.code} ${item.name}：${item.purpose}`).join("\n\n"),
    ...current.map((item)=>contentFor(item)),
    "## 历史证据边界", "原始完整设计请查看本规格历史修订；旧截图、OCR、人工核对和未来加密规划不再作为当前实施入口。部分旧标题受现有 API 限制保留，正文为当前权威边界。", ownership,
  ].join("\n\n");
  await saveSpecification(spec, content);
}
const documentReceipts = [];
async function saveDocument(existing, descriptor) {
  let saved = existing ? await api(`${base}/archive/documents/${existing.id}`) : undefined;
  const input = { title:descriptor.title,content:descriptor.content,sourcePath:descriptor.sourcePath,originalFilename:descriptor.originalFilename,contentType:descriptor.contentType,changeSummary:`维护 ${targetVersion} 当前事实与历史取代关系` };
  if (!saved) saved = await api(`${base}/archive/documents`,"POST",input);
  else if (saved.title !== input.title || normalize(saved.content) !== normalize(input.content)) saved = await api(`${base}/archive/documents/${saved.id}`,"PATCH",{...input,expectedRevisionId:saved.currentRevisionId});
  const checked = await api(`${base}/archive/documents/${saved.id}`);
  if (checked.title !== input.title || normalize(checked.content) !== normalize(input.content)) throw new Error("Document readback mismatch.");
  documentReceipts.push({id:checked.id,currentRevisionId:checked.currentRevisionId,sourcePath:checked.sourcePath,sha256:hash(checked.content)});
}
for (const document of documents) await saveDocument(archiveBefore.documents.find((item)=>item.sourcePath === document.sourcePath),document);
for (const document of obsoleteDocuments) {
  const originalTitle = document.title.replace(/^【历史已取代】/, "");
  await saveDocument(document,{...document,title:`【历史已取代】${originalTitle}`,
    content:[`# ${originalTitle}（历史已取代）`, `此文档当前入口已由 ${heading} 和 D01–D06 取代。原始全文与当时修订仍可在历史版本中查看。`,
      "旧方案中的手机 OCR、逐行核对、桌面与同步仅属未来的假设已经失效；不能继续将旧导入脚本作为当前维护入口。",
      `当前方案来源：salary://current/overview；当前验证来源：salary://current/verification。维护脚本：scripts/forgeflow-sync.mjs。`, ownership].join("\n\n")});
}
const desiredSource = {alias:source.alias,displayName:"薪迹 Windows 与 Android 工程",purpose:"Windows 采集、共享工资规则与账本、Android 阅读、JSON/WebDAV 同步及安装升级",
  sourceKind:"GIT",environmentKey:source.locations[0]?.environmentKey ?? "flycode-pc",localRoot:root,remoteUrl:"https://github.com/flycodeu/mysalary.git",repoSubdir:source.repoSubdir,
  scope:{include:["README*","package.json","src/**","windows/**","android/app/src/**","tests/**","scripts/**"],exclude:["node_modules/**","dist/**",".git/**",".artifacts/**","releases/**","logs/**","*.log",".env",".env.*","android/.gradle/**","android/app/build/**","android/build/**","**/*.salary.json","**/archive-v1.json"]},
};
let sourceReceipt = {id:source.id,updatedAt:source.updatedAt};
const sourceMatches = (value) => value.displayName === desiredSource.displayName && value.purpose === desiredSource.purpose
  && value.sourceKind === desiredSource.sourceKind && value.remoteUrl === desiredSource.remoteUrl
  && JSON.stringify(value.scope?.include) === JSON.stringify(desiredSource.scope.include)
  && desiredSource.scope.exclude.every((path) => value.scope?.exclude?.includes(path));
if (!sourceMatches(source)) {
  const updated = await api(`${base}/sources/${source.id}`,"PATCH",{...desiredSource,expectedUpdatedAt:source.updatedAt,idempotencyKey:`salary-current-source-${hash(JSON.stringify(desiredSource)).slice(0,32)}`});
  sourceReceipt = {id:updated.id,updatedAt:updated.updatedAt};
}
const eventHash = hash(JSON.stringify({specificationReceipts,documentReceipts,evidenceManifest}));
await api(`${base}/archive/events`,"POST",{operationId:`salary-current-${eventHash.slice(0,32)}`,type:evidence?"RESULT":"DESIGN",title:evidence?`${targetVersion} 实现与分层验证已登记，Owner 未验收`:`${targetVersion} 双端方案已取代旧 OCR 规划`,
  content:`当前范围：Windows 采集/核算/整合，Android 阅读，共享 JSON/WebDAV，轻量安装升级与代码维护。\n\n${evidence?.summary ?? "本轮同步当前设计边界；最终实现与测试证据后续独立登记。"}\n\n保留 ${before.runs.length} 条历史 Run、${before.tasks.length} 项历史 Task；旧设计与过时文档通过新修订取代，未删除不可变证据。元数据 API 不支持版本保护的项目描述与旧树标题未强行改写；当前正文明确其历史性质。\n\n${ownership}`,
  documentRevisionIds:documentReceipts.map((item)=>item.currentRevisionId)});
const [after, archiveAfter] = await Promise.all([api(base),api(`${base}/archive/export`)]);
if (!sourceMatches(after.sources.find((item)=>item.id===source.id))) throw new Error("Source readback mismatch.");
if (hash(JSON.stringify(immutableRuns(after.runs))) !== preservedRunHash || hash(JSON.stringify(after.tasks)) !== preservedTaskHash) throw new Error("Historical execution records changed during sync; inspect concurrent changes.");
for (const prior of preservedHistories) {
  const saved = archiveAfter.documents.find((item)=>item.id===prior.id);
  if (!saved || saved.currentRevisionId!==prior.currentRevisionId || saved.content!==prior.content) throw new Error("Historical test document changed.");
}
for (const prior of archiveBefore.specificationRevisions) {
  if (!archiveAfter.specificationRevisions.some((item)=>item.id===prior.id && JSON.stringify(item)===JSON.stringify(prior))) throw new Error("Historical design revision changed.");
}
for (const prior of archiveBefore.documents) {
  const saved = archiveAfter.documents.find((item)=>item.id===prior.id);
  if (!saved || prior.revisions.some((revision)=>!saved.revisions.some((item)=>item.id===revision.id && JSON.stringify(item)===JSON.stringify(revision)))) throw new Error("Historical archive revision changed.");
}
const receipt={recordedAt:new Date().toISOString(),targetVersion,observedPackageVersion:packageJson.version,projectId,mutations,evidenceIncluded:Boolean(evidence),specificationReceipts,documentReceipts,sourceReceipt,
  preservation:{runs:before.runs.length,tasks:before.tasks.length,testDocuments:preservedHistories.length,oldSpecificationRevisions:archiveBefore.specificationRevisions.length,oldDocumentRevisions:archiveBefore.documents.reduce((count,item)=>count+item.revisions.length,0),staleDesignSnapshots:after.runs.filter((run)=>run.designSnapshotStatus==="STALE").length},
  verification:{apiReadback:"PASS",serverVersionChecks:["expectedHeadRevisionId","expectedRevisionId","expectedUpdatedAt"],directDatabaseWrite:false,ownerAccepted:false,githubPublished:false},limits:plan.limits};
await writeFile(join(output,"sync-receipt.json"),JSON.stringify(receipt,null,2)+"\n");
await writeFile(join(output,`after-${snapshotId}.json`),JSON.stringify(archiveAfter,null,2)+"\n");
console.log(JSON.stringify({targetVersion,mutations,evidenceIncluded:Boolean(evidence),preservation:receipt.preservation,verification:receipt.verification,receipt:join(output,"sync-receipt.json")},null,2));
