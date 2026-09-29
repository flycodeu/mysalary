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
const includeGitHub = process.argv.includes("--github");
if (evidenceIndex >= 0 && !process.argv[evidenceIndex + 1]) throw new Error("--evidence requires a JSON path.");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const normalize = (value) => value.replace(/\r\n?/g, "\n").trim();
const heading = `薪迹 ${targetVersion} 当前双端方案`;
const ownership = "设计、实现、自动化测试、真实设备验证与 Owner 验收分别记录。设计章节描述当前职责、实现约束与验收条件，不自动证明测试已通过；具体结果以独立分层验证登记为准。本文不代表 Owner 验收；源码推送和安装包发布以 GitHub 交付记录中的版本、提交与证据为准。";
const modules = [
  {
    code: "D01", name: "Windows 工资采集", legacy: ["F04", "F21"],
    purpose: "用户在飞书打开并展开工资月份后，由 Windows 采集可访问的页面文字，保存结构化来源并交给共享规则处理。",
    design: [
      "采集仅针对用户已登录、已打开的工资页面；从 Windows 可访问性接口读取文本。独立网页存在飞书登录上下文限制，不能将匿名网页请求失败当成金额为空。",
      "来源包含月份、标签与原载金额文本。采集内容按格式校验后保存，重复采集相同内容去重；同月内容不同保留来源版本，不覆盖旧数据。",
      "Windows 负责采集、规则计算、归档和数据整合。沿用 .NET Framework、WinForms 与系统 WebView2，避免打包浏览器和常驻模型；采集程序按需运行。",
      "采集失败显示具体失败状态，不能补零、套用上月或要求用户逐行重新填写；来源金额与核算结果保持独立。",
      "工资文本与原始截图分开留存。Windows 可在用户主动操作时隐藏薪迹窗口并框选真实工资页，截图直接保存到所选记录；不根据文字重绘图片，不把无截图的旧记录标为已有凭证。Android 使用系统截图后导入，跨应用直接采集仍待真机验证。",
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
      "应发减实发属于总额推导扣款，不冒充原载扣款字段。存在差额时展开显示推导金额、已列明细合计和未解释差额；原始文件未提供归属证据时，不猜测遗漏项、不自动改实发。",
      "账本保存使用已有原子替换与备份路径。启动先显示读取中；读取失败显示错误和只读重试入口，不能冒充空账本。刷新失败保留已展示数据。",
      "删除采用可恢复状态，多端以版本状态合并；原档案证据和有效历史不因重复导入、删除恢复或升级消失。",
    ],
    files: ["src/domain/money.ts", "src/domain/salaryRules.ts", "src/domain/reconcile.ts", "src/domain/ledger.ts", "src/platform/ledgerStore.ts", "windows/SalaryDesktop/LocalStore.cs"],
    acceptance: "负值、未知值、汇总去重、同月多来源与差额回归通过；读取失败不清空现有档案；重启可读取原账本。",
  },
  {
    code: "D03", name: "双端档案、看板与原图界面", legacy: ["F02", "F07", "F13", "F14"],
    purpose: "共用清晰的工资档案、年度看板与原图查看，设置集中管理更新和退出行为，正常页面不堆输入框与内部分类选项。",
    design: [
      "桌面采用左侧档案列表、右侧月度详情；手机保持单列列表和详情导航。优先显示实发工资，其次是应发、扣款及两组明细。",
      "看板独立为一级页面，提供年度实发、应发与推导扣款合计、12 个月趋势及月份跳转。同月多来源只计最近保存的一份，排除示例与已删除档案；缺失月份和未知原载总额保留为空，不补零。",
      "来源、补充信息与原始截图按需打开。隐藏金额时来源弹层、原图和图表也隐藏；示例明确标注为合成数据。原图支持多张、切换与原始尺寸查看，切换工资记录时不得显示前一条记录的异步图片。",
      "每条记录提供原始截图入口；Windows 允许截取工资页或选择已有 PNG/JPEG，Android 通过系统图片选择器导入已截取的原图。保存到应用私有目录后再展示，取消选择不增加记录，读取失败保留已保存原图。",
      "保留年份筛选、同月多来源、来源查看、删除与恢复。新流程不再让手机承担 OCR 和逐行人工核对；旧档案读取仅作为兼容边界，不成为新采集入口。",
      "统一桌面、Android 与网页预览的品牌和交互。预览明确说明数据存于该浏览器；原生桌面与手机不得静默回退到浏览器档案库。",
      "Android 系统返回先关闭最上层弹窗，再从月份详情或已删除列表返回主页；主页退出按设置处理。窄屏支持两侧边缘返回手势，纵向滚动不能误触。Windows 关闭按钮或 Alt+F4 进入共享居中退出确认；原生界面尚未就绪时保留原生确认回退。",
      "退出确认默认开启，可在设置关闭，并持久保存到本机。无论确认开关状态如何，保存、采集、截图和同步进行中都不能直接退出；退出前等待账本写入队列结束。",
    ],
    files: ["src/App.vue", "src/style.css", "src/components/SalaryDetail.vue", "src/components/SalaryDashboard.vue", "src/components/EvidencePanel.vue", "src/components/SettingsPanel.vue", "src/components/ModalSheet.vue", "src/domain/overview.ts", "src/platform/settings.ts", "src/platform/evidence.ts", "src/platform/host.ts"],
    acceptance: "320/390 像素手机与桌面宽度无横向溢出；年度去重和空值、月份跳转、原图字节持久化与记录隔离、遮挡、居中退出、设置重启保持和操作中退出保护分别验证；浏览器模拟与 Android 真机结果独立登记。",
  },
  {
    code: "D04", name: "共享 JSON 与坚果云同步", legacy: ["F01", "F16", "F17", "F18", "F19", "F22"],
    purpose: "通过 JSON 共享工资账本，通过坚果云共享工资与关联原图，保留来源、删除和恢复状态。",
    design: [
      "共享 JSON 使用版本化格式与严格校验，导入通过合并进入已有账本；损坏、超限或编码无效的文件不能覆盖当前数据。",
      "WebDAV 使用固定工资目录和按内容哈希命名的追加文件，兼容旧 archive-v1.json。不能依赖坚果云未保证的条件覆盖行为来保护并发数据。",
      "发布后回读并验证哈希；目录清单只接受同域、固定目录下的允许文件名，拒绝跳转、嵌套路径、遍历和超限数据。网络错误不替换本地账本。",
      "原图与严格 v1 工资 JSON 分离，原图按记录 ID 与 SHA-256 命名，PNG/JPEG 原始字节存入原生私有目录。每张不超过 20 MiB、4000 万像素；相同记录与哈希重复添加不增加副本，删除工资不物理删除凭证。UI 不读取原生路径。",
      "同步先合并工资，再按已知账本记录合并原图，只追加、不远程删除。云端图片清单最多 1200 项，未知记录的图不下载；目录、类型、哈希与下载体积都需校验。图片上传后回读核对哈希；部分失败保留已完成结果并明确显示工资已同步、截图未完成，可重试。",
      "JSON 导入导出只包含工资，不包含原图。坚果云工资增量文件与 evidence-记录ID-哈希.png/jpg 共处固定目录，各自严格筛选允许文件名；旧客户端账本读取不依赖新图片格式。旧 OCR 与人工草稿不自动转为新共享账本。",
      "Windows 凭据使用 DPAPI，Android 使用 Keystore 保护；凭据不写日志、Git 或同步报告。工资 JSON 和截图经 HTTPS 传输，云端对象未做端到端加密，不能宣传为加密档案。",
      "手机保留导入、同步及查看职责，不增加服务器、复杂多包层或常驻识别模型。真实坚果云原图双端往返与 Android 真机同步需独立验证，测试桩通过不提升其状态。",
    ],
    files: ["src/platform/sync.ts", "src/platform/evidenceSync.ts", "src/platform/evidence.ts", "src/components/SyncPanel.vue", "src/domain/ledger.ts", "windows/SalaryDesktop/WebDavClient.cs", "windows/SalaryDesktop/WebDavSnapshots.cs", "windows/SalaryDesktop/WebDavEvidence.cs", "windows/SalaryDesktop/EvidenceStore.cs", "android/app/src/main/java/com/flylabs/salary/EvidenceStore.java", "android/app/src/main/java/com/flylabs/salary/SalaryNativePlugin.java"],
    acceptance: "合成双端合并、原图哈希一致、重复同步、删除恢复、未知记录隔离与部分失败重试通过；真实云连通性、Windows/Android 原图往返和真实设备持久化分开记录。",
  },
  {
    code: "D05", name: "安装、覆盖升级与更新检查", legacy: ["F20"],
    purpose: "保留稳定应用身份和独立数据目录，在设置中发现 GitHub 新版本，按平台下载并覆盖升级。",
    design: [
      "Windows 正式安装身份固定，支持自选普通目录，升级默认沿用原目录。安装与卸载仅管理程序文件，拒绝与数据目录重叠、目录联接和短路径别名等危险目标。",
      "Android applicationId 与签名保持稳定；覆盖安装兼容性必须以签名和设备实际安装为证据，编译成功不能替代升级保留数据验证。",
      "用户打开设置时检查 GitHub 最新正式 Release，设置和更新弹窗共享同一结果，并提供重新检查。启动时不自动联网；区分无新版本、无公开版本、网络失败和可下载版本，检查失败时清除旧提示。不能把未发布的版本显示成已可用更新，也不后台自动覆盖安装。",
      "Android 在应用内下载当前 debug.apk 发行线，显示进度并支持取消重试，校验后打开系统安装器由用户确认；未知来源权限由系统处理。缓存安装包版本必须匹配当前提示版本。Windows 在应用内下载对应安装包，显示进度并支持取消重试；核对 GitHub Release 的 SHA-256 摘要，退出旧程序后由独立更新助手启动安装器，安装仍由用户确认。0.5.0 缺少此能力，首次安装 0.5.1 仍需手动下载。",
      "保存、同步或截图处理中阻止开始安装；安装前等待账本写入结束。Windows 下载仅接受当前最新正式 Release 的固定安装包名、HTTPS GitHub 下载链和可用 SHA-256 摘要，超限、取消及摘要不符时不得运行；安装前再次校验，并待旧程序关闭。更新流程不写工资和原图，不改变私有数据目录。签名、版本与固定安装身份检查属于静态门槛；真实带数据覆盖升级仍需单独执行。",
      "构建命令只生成本地产物；GitHub 推送与 Release 发布按用户授权执行，并登记准确提交、标签、安装包及公开下载校验。安装器隔离测试与真实应用启动验证单独报告。",
      "双端居中退出确认由持久设置控制；关闭确认不能绕过操作中保护。系统关机不显示交互式确认。Android 卸载仍会清除私有数据，更新应覆盖安装而非先卸载。",
    ],
    files: ["windows/Installer/Salary.iss", "windows/SalaryDesktop/WindowsUpdateManager.cs", "windows/SalaryDesktop/UpdateHandoff.cs", "scripts/windows-installer.ps1", "scripts/windows-installer-test.ps1", "scripts/release.ps1", "scripts/verify-android-upgrade.ps1", "src/domain/release.ts", "src/platform/updates.ts", "src/composables/useUpdateCheck.ts", "src/components/UpdatePanel.vue", "src/components/SettingsPanel.vue"],
    acceptance: "安装路径与身份、覆盖升级与卸载保留数据分别验证；设置自动检查、失败清除旧状态、版本匹配、双端下载进度、取消重试及安装前忙状态保护分别回归；Windows 校验和独立助手、Android 实际系统安装器、升级后的账本原图一致性按自动化与真实设备分别登记。",
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
const mobileCaptureDesign = [
  "# Android 直接采集：候选方案与验证条件",
  "## 状态与前提",
  "状态：设计评估完成；采集实现未开始，真机验证 NOT_RUN。用户确认公司 HR 应用代码不能修改，当前不便连接手机，先交付返回、退出与核对修复。0.4.1 不增加无障碍服务、权限或手机抓取按钮。",
  "## 预期操作",
  "用户在飞书或公司 HR 应用打开智慧 HR 并展开月份，主动触发一次读取；薪迹检查月份、字段与金额，复用现有规则归档。无须逐行填写或自行对比金额。工资来源已存在差额时，如实保留。",
  "## 先验证能否读取",
  "连接授权的 Android 设备后，只探测用户主动打开的目标页面，不枚举其他应用内容。检查节点是否暴露月份、原载应发/实发、标签、金额和负号；检查折叠、滚动或虚拟列表是否造成整行缺失。ADB 节点可见只能说明实验工具可读，不能替代实际 Android 服务读取验证。",
  "通过后才实现可选的按次采集：用户手动开启相应能力，用系统快捷操作触发，限定经过真机确认的目标应用和 HR 页面；读取完成即结束，不闲置轮询、不抓取其他页面、不上传或记录工资原文。采集前后的月份必须一致，页面变动时拒绝入账。",
  "月份不明确、标签金额未配对、重复项冲突或无法证明完整时，保存私有原始采集并提示重试，不进入正式账本。全字段完整性与应发减实发的算术校验分开，不能因为金额凑平便宣称采集完整。",
  "## 选型边界",
  "AccessibilityService 是待验证候选，需要用户明确开启和 canRetrieveWindowContent。Android 官方将其定位为辅助使用能力，正式方案还需确认适用性与分发要求，不能仅凭 API 存在就承诺可上线。节点缺失或受保护时不尝试绕过应用隔离；保留已有 Windows 采集后同步路径。",
  "如果原 HR 应用已提供工资 JSON 导出/分享，可直接复用 ACTION_SEND / ACTION_VIEW 导入。普通分享链接不是工资数据。自建 WebView 只能访问它自己加载的页面，不能继承另一应用的登录会话或直接读取其页面。截图 OCR 不作为准确、省事目标下的默认方案。",
  "## 验收",
  "目标手机上完整月份读出、原始字段逐项自动比对、负号/零/空值、滚动与折叠、重复读取去重、切月中断、失败保留来源、应用重启和数据持久化均需真实验证。采集入口、系统授权与停止流程也必须实际操作通过。当前以上结果均为 NOT_RUN，不提升 Owner 状态。",
  "## 官方参考",
  "https://developer.android.com/reference/android/accessibilityservice/AccessibilityService",
  "https://developer.android.com/guide/topics/ui/accessibility/service",
  "https://developer.android.com/reference/android/webkit/WebView",
].join("\n\n");
const currentSpecs = [
  { kind: "background", content: overview },
  { kind: "requirements", content: [`# ${heading}：需求与验证`, ...modules.map((item) => `## ${item.code} ${item.name}\n\n${item.purpose}\n\n验收：${item.acceptance}`), ownership].join("\n\n") },
  { kind: "research", content: `# 结构化采集可行性与旧 OCR 方案取代说明\n\n${contentFor(modules[0])}\n\n## 可行性证据边界\n\n独立网页受飞书会话限制，不据此绕过认证。使用用户已打开的桌面页面读取可访问文本。模型识别准确率不再是新流程的数据来源；真实页面覆盖月份、采集稳定性和合计校验以实际结果为准。旧 OCR 候选调研保存在本栏历史修订中。\n\n${mobileCaptureDesign}` },
  { kind: "architecture", content: [`# ${heading}：架构`, "Windows 采集 → 结构化来源 → 共享领域规则与账本 → JSON / WebDAV → Android 阅读。", contentFor(modules[1]), contentFor(modules[3]), contentFor(modules[4])].join("\n\n") },
  { kind: "technology", content: [`# ${heading}：技术与维护`, "保留 Vue 3、TypeScript、Capacitor、.NET Framework / WinForms / WebView2 和已有 WebDAV 桥接。Windows 采集按需运行；手机不新增常驻模型和服务。", contentFor(modules[2]), contentFor(modules[5])].join("\n\n") },
];
const documents = [{ key: "overview", title: heading, content: overview }, ...modules.map((item) => ({ key: item.code, title: `${item.code} ${item.name}（当前）`, content: contentFor(item) })), { key: "mobile-capture", title: "Android 直接采集（待真机验证）", content: mobileCaptureDesign }]
  .map((item) => ({ ...item, sourcePath: `salary://current/${item.key}`, originalFilename: `${item.key}.md`, contentType: "text/markdown" }));
let github;
if (includeGitHub) {
  const githubRoot = "https://api.github.com/repos/flycodeu/mysalary";
  async function publicGitHub(path, missingAllowed = false) {
    const response = await fetch(githubRoot + path, { redirect: "error", signal: AbortSignal.timeout(20000),
      headers: { Accept: "application/vnd.github+json", "User-Agent": "SalaryTrail-ForgeFlow" } });
    if (missingAllowed && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub readback HTTP_${response.status}`);
    return response.json();
  }
  const [head, release] = await Promise.all([publicGitHub("/commits/main"), publicGitHub("/releases/latest", true)]);
  if (!/^[a-f0-9]{40}$/.test(head.sha)) throw new Error("Invalid GitHub branch commit.");
  if (release && (release.draft || release.prerelease || !/^v\d+\.\d+\.\d+$/.test(release.tag_name))) throw new Error("Latest GitHub release is not a supported stable release.");
  const releaseCommit = release ? await publicGitHub(`/commits/${release.tag_name}`) : null;
  github = { mainCommit: head.sha, latestTag: release?.tag_name ?? null, releaseCommit: releaseCommit?.sha ?? null,
    releaseUrl: release?.html_url ?? null, targetPublished: release?.tag_name === `v${targetVersion}`,
    assets: release?.assets.map(({ name, size, digest, browser_download_url }) => ({ name, size, digest, url: browser_download_url })) ?? [] };
  documents.push({ key: "github", title: "GitHub 源码与安装包交付（当前）", sourcePath: "salary://current/github", originalFilename: "github.md", contentType: "text/markdown",
    content: ["# GitHub 源码与安装包交付", "仓库：https://github.com/flycodeu/mysalary", `main 已推送提交：${github.mainCommit}`,
      release ? `最新正式发行版：${github.latestTag}\n\n地址：${github.releaseUrl}\n\n发行提交：${github.releaseCommit}` : "尚无公开正式发行版。",
      `当前工作版本：${targetVersion}；该版本${github.targetPublished ? "已发布" : "尚未登记为最新公开发行版"}。`,
      "## 已上传附件", ...github.assets.map((asset) => `- ${asset.name} · ${asset.size} bytes · ${asset.digest ?? "未返回摘要"}\n  ${asset.url}`),
      "## 更新方式", "打开设置时匿名查询 GitHub 最新正式 Release，也可主动重新检查。Android 在应用内下载并校验，再交由系统安装器确认；Windows 从 0.5.1 起在应用内显示下载进度、支持取消重试、核对 SHA-256 后退出旧程序并打开安装器，由用户确认。0.5.0 缺少该流程，首次升级到 0.5.1 需要手动安装。没有后台轮询或静默安装。",
      "本记录直接读取公开 GitHub API；下载字节和原生更新请求验证另见分层测试。发布不等于 Android 真机或 Owner 验收。",
    ].join("\n\n") });
}
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
  limits: ["Project description and tree names have no supported CAS update route; current design heads explicitly replace the historical catalog.", "This sync performs no task confirmation, status promotion, Run rewrite, database write or GitHub publication; GitHub facts are recorded from read-only API calls."],
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
const desiredSource = {alias:source.alias,displayName:"薪迹 Windows 与 Android 工程",purpose:"Windows 采集、共享工资与原图档案、双端看板设置、JSON/WebDAV 同步及安装升级",
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
  content:`当前范围：Windows 采集/核算/整合，双端工资档案、原始截图与看板，共享 JSON/WebDAV，设置、居中退出及覆盖升级。\n\n${evidence?.summary ?? "本轮同步当前设计边界；最终实现与测试证据后续独立登记。Android 真机覆盖升级及真实坚果云原图双端往返尚未验证，Owner 未验收。"}\n\n保留 ${before.runs.length} 条历史 Run、${before.tasks.length} 项历史 Task；旧设计与过时文档通过新修订取代，未删除不可变证据。元数据 API 不支持版本保护的项目描述与旧树标题未强行改写；当前正文明确其历史性质。\n\n${ownership}`,
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
  verification:{apiReadback:"PASS",serverVersionChecks:["expectedHeadRevisionId","expectedRevisionId","expectedUpdatedAt"],directDatabaseWrite:false,ownerAccepted:false,githubPublished:github?.targetPublished ?? null,github:github ?? null},limits:plan.limits};
await writeFile(join(output,"sync-receipt.json"),JSON.stringify(receipt,null,2)+"\n");
await writeFile(join(output,`after-${snapshotId}.json`),JSON.stringify(archiveAfter,null,2)+"\n");
console.log(JSON.stringify({targetVersion,mutations,evidenceIncluded:Boolean(evidence),preservation:receipt.preservation,verification:receipt.verification,receipt:join(output,"sync-receipt.json")},null,2));
