# 薪迹

轻量的个人工资档案应用。Windows 从已打开的飞书工资页读取数据，Android 查看同一份月度明细与汇总；支持 JSON 和坚果云同步。当前版本 **0.4.2**。

## 安装与使用

安装包放在 [GitHub Releases](https://github.com/flycodeu/mysalary/releases)。

| 平台 | 文件 | 要求 |
| --- | --- | --- |
| Windows | `salary-0.4.2-windows-setup.exe` | Windows 10 1809+/11 x64、.NET Framework 4.8、WebView2 Evergreen |
| Windows 便携版 | `salary-0.4.2-windows.zip` | 完整解压，打开 `Salary.exe`，保留同目录资源 |
| Android | `salary-0.4.2-debug.apk` | Android 7+；当前为自用调试签名发行线 |

1. Windows 安装时可选择位置，安装完成后从开始菜单打开“薪迹”。
2. 在电脑飞书的“智慧 HR → 工资查询”展开月份，回到薪迹点击“抓取飞书工资”。
3. 选择月份查看实发工资、应发构成及扣款。来源与核对详情按需展开；金额可隐藏，删除的档案可恢复。

仅采集已展开且字段完整的月份。程序默认只读展示，不再执行截图 OCR。旧设备中的截图、已保存 OCR 和人工草稿仍可查看。

手机系统返回或从屏幕两侧边缘向内滑动，先关闭当前弹窗，再返回月份列表；主页返回会确认退出。Windows 点击关闭或按 Alt+F4 也会确认，正在处理数据时暂缓退出。

### 数据与同步

Windows 工资数据位于 `%LOCALAPPDATA%\SalaryTrail\Desktop`，与程序安装目录分离。升级、移动程序和普通卸载保留该目录。Android 数据在应用私有目录；**卸载 Android 会删除本机档案**，更换手机前应导出或同步。

- **坚果云**：两端填写相同账号及第三方应用密码。电脑采集后“立即同步”，手机再“立即同步”。应用密码见[坚果云说明](https://help.jianguoyun.com/?p=2064)。当前是主动同步。
- **JSON**：“更多 → 导出 JSON 档案”，另一端导入后合并去重。同月不同来源保留多份，汇总仅计最新一份；删除及恢复状态也会同步。

JSON 是明文工资档案，不含同步密码。同步密码由 Windows DPAPI / Android Keystore 本机保护。云端使用 `SalaryTrail` 下按内容摘要命名的增量文件，兼容旧 `archive-v1.json`。旧截图、OCR 与手工草稿仅保留在原设备，不进入新账本同步。

金额以整数分保存，未知为 `null`。来源总额、明细计算和核对结果分别保存；负补发从应发中扣减，真实差额不自动补平。读取失败时可重试，损坏账本支持从 JSON 备份显式恢复。

“扣款（推算）”来自原载应发减原载实发。出现差额时，展开核对可查看已识别扣款及未解释金额；汇总与子项不会重复计算，系统不会猜测缺失扣项或修改原载实发。

## 更新

打开“更多 → 检查更新”。应用查询本仓库最新正式 Release；发现新版后获取对应安装包，由系统完成安装。更新检查不上传工资或同步凭据，启动时不自动联网。

- Windows 使用固定 `AppId=FlyLabs.SalaryTrail`，沿用上次安装目录和卸载项，覆盖升级后继续读取原数据目录。
- Android 保持 `com.flylabs.salary`、相同签名证书和递增的 `versionCode`。直接安装新 APK，不要先卸载旧版。
- 当前 Android 更新只选择 `debug.apk` 发行线。现有调试密钥必须妥善备份；换机器自动生成的新密钥无法覆盖旧安装。将来改为正式签名需要单独迁移方案。

没有公开 Release、网络失败、已是最新版分别提示。缺少当前平台安装包时跳转发行页面，不代选其他平台或签名发行线的包。

## 开发

单个 Vue 3 / TypeScript / Capacitor 工程；Windows 使用 .NET Framework WinForms + 系统 WebView2，不附带完整浏览器。界面间距与响应式层次参考 [Fluent 2](https://fluent2.microsoft.design/layout)，双端图标统一生成自 `public/brand.svg`。

需要 Node.js 22.12+、pnpm 10.28.0。原生构建另需 JDK 21、Android SDK 36；Windows 安装包需 Inno Setup 6.4+。

```powershell
pnpm install --frozen-lockfile
pnpm dev
pnpm test
pnpm build
```

浏览器预览支持 JSON、合成示例和本机浏览器存储。Windows/Android 的原生存储与飞书采集以安装版为准。

```powershell
# Windows
pnpm windows:build -Test
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows-installer.ps1 -SkipBuild

# Android：设置 JAVA_HOME / ANDROID_SDK_ROOT，或传入 -JdkPath / -SdkPath
pnpm android:build -JdkPath 'D:\Tools\jdk-21'

# 生成双端图标
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/generate-icons.ps1
```

浏览器回归使用独立合成数据，需要安装 Playwright 并可用 Edge，或设置 `SALARY_PLAYWRIGHT_MODULE` 指向已有 Playwright 模块；启动 `pnpm dev` 后运行 `pnpm verify:browser`。原生构建不等同于真机验收。

### 发布新版

1. 运行 `pnpm version:set 0.4.2`（替换为下一版本），同步前端、Windows、Android 的显示版本，并递增 Android `versionCode`。
2. 用原签名密钥构建；脚本对比上一版 APK 的身份、签名及版本，发现换签或降级会停止：

   ```powershell
   pnpm release:build -JdkPath 'D:\Tools\jdk-21' -PreviousApk '.\releases\salary-0.4.1-debug.apk'
   ```

3. 记录自动化及设备验证结果，提交并推送代码，创建对应的正式 GitHub Release；发布说明须列出未验证项。上传同版本 `windows-setup.exe`、`windows.zip`、`debug.apk` 和 `SHA256SUMS.txt`。文件名须保持 `salary-版本-平台后缀`。

构建命令不会自动提交、推送或发布。源码 CI 只运行前端测试与构建。安装包应放 Releases，不放 Git；密钥、工资文件和凭据均不进入仓库。

### 代码入口

| 路径 | 职责 |
| --- | --- |
| `src/App.vue`、`src/components/` | 共享页面、详情、同步与更新弹窗 |
| `src/composables/useArchive.ts` | 档案读取、导入、删除、恢复和启动状态 |
| `src/domain/` | 纯工资规则、核对、账本合并和版本判断 |
| `src/platform/` | 原生桥接、持久化、同步和更新请求 |
| `windows/SalaryDesktop/`、`SalaryCollector/` | Windows 宿主、文件和飞书可访问文本读取 |
| `android/app/src/main/java/com/flylabs/salary/` | Android 文件、凭据、网络与桥接 |
| `scripts/`、`tests/` | 构建、升级校验和合成回归 |

ForgeFlow 维护设计及交付事实，通过 `scripts/forgeflow-sync.mjs` 的 API 与版本校验同步；默认只生成计划，`--apply` 才写入。`--github` 读取公开的 main 提交、最新正式 Release 和安装包信息，`--evidence .artifacts/forgeflow/验证文件.json` 登记本次验证。用 `FORGEFLOW_REPO` 指定 ForgeFlow 本地源码位置。历史阶段文档及私有验证留在被忽略的 `.artifacts`，仓库 Markdown 仅维护此 README。

## 验证边界

0.4.2 已通过 249 项 Vitest、TypeScript 类型检查、Android JVM 更新校验（4 项）、Android debug 构建和 lint；APK 与 0.4.1 的签名连续性由发布脚本检查。Windows 安装包和浏览器回归由发布脚本生成；Android 真机安装器流程仍未实测。GitHub Release 更新检查从该仓库查询，Android 可在应用内下载、校验并打开系统安装器。

Android 真机覆盖升级、真实坚果云双端同步及 Owner 最终验收仍待完成。识别归类仍保留无法确认的项目，不将差额消除视为正确性证明。

Android 直接读取其他应用中的工资页仍处于可行性验证，当前 APK 尚无该入口。可控 HR 页面优先提供结构化 JSON 分享；飞书页面需要先用真机验证可访问内容是否完整，不能将 Windows 可读取作为 Android 同样可行的证明。
