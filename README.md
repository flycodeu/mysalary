# 薪迹

轻量的个人工资档案应用。Windows 从已打开的飞书工资页读取数据，Windows 和 Android 共用工资明细、原始截图及年度看板，支持 JSON 和坚果云同步。当前版本 **0.5.0**。

## 安装与使用

安装包见 [GitHub Releases](https://github.com/flycodeu/mysalary/releases)。

| 平台 | 文件 | 要求 |
| --- | --- | --- |
| Windows | `salary-0.5.0-windows-setup.exe` | Windows 10 1809+/11 x64、.NET Framework 4.8、WebView2 Evergreen |
| Windows 便携版 | `salary-0.5.0-windows.zip` | 完整解压后打开 `Salary.exe` |
| Android | `salary-0.5.0-debug.apk` | Android 7+；当前为自用调试签名发行线 |

1. Windows 安装时可选择位置，之后从开始菜单打开“薪迹”。
2. 在电脑飞书的“智慧 HR → 工资查询”展开月份，回到薪迹点击“抓取飞书工资”。仅采集已展开、字段完整的月份。
3. 在工资档案中查看实发、应发构成和扣款，展开核对可查看差额；删除的档案可恢复。
4. 在“看板”按年查看汇总和月度趋势，点击月份进入原记录。同月多份档案只统计最近保存的一份；未知总额保留为空。

### 保存原始截图

每条工资记录都有“原始截图”入口，可添加多张 PNG/JPEG，重复原图不会重复保存。

- **Windows**：展开真实工资页，在记录中点击“截取工资页”，框选需要保存的区域；也可添加已有截图。
- **Android**：先在公司工资页使用系统截屏，再回到对应记录点击“添加截图”。原图会复制到薪迹的私有目录，不依赖相册临时地址。
- 原图保留原始字节，与该条记录关联；隐藏金额时同时隐藏原图。旧记录没有截图时保持为空，不生成凭证。

Android 当前不能直接读取或静默截取另一个应用的工资页，也不进行截图 OCR。已有 OCR 档案与人工草稿仅兼容读取。

### 设置与退出

“设置 → 退出前确认”控制 Windows 和 Android 的居中退出弹窗，默认开启。关闭该选项后，保存、采集、截图或同步进行中仍会阻止退出。

手机系统返回或两侧边缘返回手势先关闭当前弹窗，再从详情回到列表；主页返回按设置处理退出。Windows 点击关闭或按 Alt+F4 使用同一套确认流程。

## 数据与同步

Windows 数据位于 `%LOCALAPPDATA%\SalaryTrail\Desktop`，与安装目录分离，普通覆盖升级和卸载保留该目录。Android 数据在应用私有目录；**卸载 Android 会删除本机档案和原图**，换机前应完成备份或同步。

| 方式 | 内容 | 用法 |
| --- | --- | --- |
| JSON | 工资、来源、删除和恢复状态；不含截图 | “更多 → 导出 JSON 档案”，另一端导入后合并去重 |
| 坚果云 | 工资账本与已关联的原始截图 | 两端配置相同账号及[第三方应用密码](https://help.jianguoyun.com/?p=2064)，先在来源端同步，再在另一端同步 |

坚果云使用主动同步。工资 JSON 与原图分别存放在 `SalaryTrail` 目录，以内容哈希命名并追加保存；原图上传后回读校验。先合并工资，再同步关联原图；图片传输失败会明确提示并保留已保存的数据，重试可继续。删除工资不会自动清除原图。旧 OCR 和手工草稿不进入共享账本。

工资 JSON 和云端原图未做端到端加密；同步密码由 Windows DPAPI / Android Keystore 本机保护，不进入导出文件、日志或 Git。原图单张最多 20 MiB，最多 4000 万像素；当前云端截图清单上限为 1200 张。

金额按整数分保存，未知为 `null`。原载总额、明细计算和核对状态分开保存；负补发扣减应发，汇总与子项不重复计入。显示的“扣款（推算）”来自原载应发减实发，不能替代缺失的扣项证据。系统不会补零、猜测扣项或修改实发凑平。

## 更新

打开设置时自动查询本仓库最新正式 Release，发现新版本会显示版本提示，也可重新检查。启动时不自动联网，更新检查不上传工资或凭据。

- **Android**：点击“立即更新”，应用内下载并校验 APK，再打开系统安装器，由用户确认覆盖安装。不要先卸载旧版。
- **Windows**：点击“获取新版”，浏览器下载对应安装包，运行后覆盖升级；当前未实现应用内下载和自动安装。
- 进行保存或同步时不能开始安装；进入安装前等待账本写入完成。网络失败、无公开发行版和已是最新版分别提示，失败检查不会保留过期的更新提示。

Windows 固定 `AppId=FlyLabs.SalaryTrail`，沿用安装目录、卸载项和数据目录。Android 固定 `com.flylabs.salary`，保持签名并递增 `versionCode`。当前只选择 `debug.apk` 发行线，原调试密钥须备份；更换签名无法覆盖旧安装。

## 开发与发布

单个 Vue 3 / TypeScript / Capacitor 工程；Windows 使用 .NET Framework WinForms 和系统 WebView2，不附带完整浏览器。需要 Node.js 22.12+、pnpm 10.28.0；原生构建另需 JDK 21、Android SDK 36，Windows 安装包需 Inno Setup 6.4+。

```powershell
pnpm install --frozen-lockfile
pnpm dev
pnpm test
pnpm build

pnpm windows:build -Test
pnpm android:build -JdkPath 'D:\Tools\jdk-21'
```

浏览器预览支持 JSON、合成示例和浏览器本地存储，原生文件、系统截图与飞书采集以安装版为准。浏览器回归需要 Playwright 和 Edge；可设置 `SALARY_PLAYWRIGHT_MODULE` 指向已有模块。启动开发服务器后运行 `pnpm verify:browser`。

发布前运行 `pnpm version:set 下一版本`，同步双端版本并递增 Android `versionCode`。使用原签名密钥，提供上一版已发布 APK 校验身份、签名和版本连续性：

```powershell
pnpm release:build -JdkPath 'D:\Tools\jdk-21' -PreviousApk '.\releases\salary-0.4.2-debug.apk'
```

本地构建默认不发布。提交并推送源码后，准备版本说明文件，再使用 `scripts/release.ps1 -PublishGitHub -NotesFile <说明文件>` 构建并发布。脚本先创建草稿，下载四个附件校验哈希，然后标记为最新正式版；已发布的同版本附件不会被覆盖。文件名保持 `salary-版本-平台后缀`。密钥、工资、原图、构建产物和本地验证证据不进入 Git。

| 路径 | 职责 |
| --- | --- |
| `src/App.vue`、`src/components/` | 档案、看板、原图、设置、同步与更新界面 |
| `src/domain/` | 纯工资规则、核对、账本合并、年度统计和版本判断 |
| `src/composables/`、`src/platform/` | 状态管理、原生桥接、存储、同步和更新 |
| `windows/SalaryDesktop/`、`windows/SalaryCollector/` | Windows 宿主、截图、文件和飞书文本读取 |
| `android/app/src/main/java/com/flylabs/salary/` | Android 文件、图片选择、凭据、网络与安装器桥接 |
| `scripts/`、`tests/` | 构建、升级校验与合成回归 |

ForgeFlow 通过 `scripts/forgeflow-sync.mjs` 的 API 与版本校验维护设计和交付记录。默认生成计划，`--apply` 才写入；`--github` 读取公开交付事实，`--evidence .artifacts/forgeflow/验证文件.json` 登记分层证据。脚本保留历史 Run/Task，不修改 Owner 验收状态。仓库只维护此 README，私有证据保存在被忽略的 `.artifacts`。

## 完成度与后续重点

当前已具备采集、核算、持久化、导入导出、同步、原图留存、看板及更新入口。测试、构建和合成浏览器交互不能替代真机验收：**Android 真机覆盖升级、真实坚果云原图双端同步及 Owner 验收仍未完成**。本次具体自动化结果和安装包摘要以 Release 与 ForgeFlow 验证记录为准。

后续按以下顺序推进，均不算本版已实现：

1. **先验证数据连续性**：真实 Windows/Android 往返同步、弱网重试、重启及带截图的覆盖升级，自动比对原图哈希与工资记录。
2. **完整离线备份**：导出包含账本和原图的归档包，支持校验恢复及换机；目前 JSON 不能单独备份截图。
3. **简化 Windows 更新**：应用内下载、校验和启动安装器，保留用户确认与数据目录。
4. **提升对账效率**：增加缺少原图、缺少月份和未解释差额的筛选；看板可继续扩展同比与月度构成。
5. **再评估手机直接采集**：必须在目标真机验证 HR 页面可访问内容、字段完整性与授权流程；不以桌面可读取作为手机可行的依据。
