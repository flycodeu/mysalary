using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using SalaryCollector;

namespace SalaryDesktop
{
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            if (args.Contains("--self-test")) return DesktopSelfTests.Run();
            bool created;
            using (var mutex = new Mutex(true, "Local\\SalaryTrail.Desktop", out created))
            {
                if (!created) { MessageBox.Show("薪迹已经打开，请切换到现有窗口。", "薪迹"); return 0; }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new DesktopForm());
                return 0;
            }
        }
    }

    internal sealed class DesktopForm : Form
    {
        private readonly WebView2 web = new WebView2();
        private readonly LocalStore store;
        private readonly SemaphoreSlim writeGate = new SemaphoreSlim(1, 1);
        private bool captureRunning;
        private bool browserReady;
        private bool windowActive;
        private int activeOperations;
        private bool applicationBusy;
        private bool closeDialogOpen;
        private CoreWebView2MemoryUsageTargetLevel? memoryTarget;
        public DesktopForm()
        {
            Text = "薪迹 " + Application.ProductVersion;
            Icon = System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            ClientSize = new System.Drawing.Size(1120, 820);
            MinimumSize = new System.Drawing.Size(460, 640);
            StartPosition = FormStartPosition.CenterScreen;
            store = new LocalStore(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SalaryTrail", "Desktop"));
            web.Dock = DockStyle.Fill;
            Controls.Add(web);
            Shown += async (s, e) => await InitializeAsync();
            Activated += (s, e) => { windowActive = true; UpdateResourceUsage(); };
            Deactivate += (s, e) => { windowActive = false; UpdateResourceUsage(); };
            Resize += (s, e) => UpdateResourceUsage();
        }
        public static bool IsAppOrigin(string source)
        {
            Uri uri;
            return Uri.TryCreate(source, UriKind.Absolute, out uri) && uri.Scheme == "https" && uri.Host == "salary.local" && uri.Port == 443 && string.IsNullOrEmpty(uri.UserInfo);
        }
        private bool HasPendingWork { get { return applicationBusy || activeOperations > 0 || captureRunning; } }
        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            base.OnFormClosing(e);
            if (e.Cancel) return;
            var action = ClosePolicy.Decide(e.CloseReason, HasPendingWork, closeDialogOpen, false);
            if (action == CloseAction.Allow) return;
            e.Cancel = true;
            if (action == CloseAction.KeepOpen) return;
            closeDialogOpen = true;
            try
            {
                if (action == CloseAction.Busy)
                {
                    ShowBusyBeforeExit();
                    return;
                }
                var response = MessageBox.Show(this, "退出薪迹？", "薪迹", MessageBoxButtons.OKCancel,
                    MessageBoxIcon.Question, MessageBoxDefaultButton.Button2);
                if (response != DialogResult.OK) return;
                // Native dialogs run a message loop: a pending web request may arrive while one is open.
                action = ClosePolicy.Decide(e.CloseReason, HasPendingWork, false, true);
                if (action == CloseAction.Allow) e.Cancel = false;
                else ShowBusyBeforeExit();
            }
            finally { closeDialogOpen = false; }
        }
        private void ShowBusyBeforeExit()
        {
            MessageBox.Show(this, "正在处理数据，请稍后再退出。", "薪迹", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        private async Task InitializeAsync()
        {
            try
            {
                var assets = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "app");
                if (!File.Exists(Path.Combine(assets, "index.html"))) throw new UserError("应用文件不完整，请重新安装薪迹后再试。");
                var environment = await CoreWebView2Environment.CreateAsync(null, Path.Combine(store.DirectoryPath, "WebView2"));
                if (IsDisposed || Disposing) return;
                await web.EnsureCoreWebView2Async(environment);
                if (IsDisposed || Disposing) return;
                var core = web.CoreWebView2;
                await core.AddScriptToExecuteOnDocumentCreatedAsync("Object.defineProperty(window, '__salaryDesktop', { value: true });");
                if (IsDisposed || Disposing) return;
                core.SetVirtualHostNameToFolderMapping("salary.local", assets, CoreWebView2HostResourceAccessKind.DenyCors);
                core.Settings.AreDevToolsEnabled = false;
                core.Settings.AreDefaultContextMenusEnabled = false;
                core.Settings.AreHostObjectsAllowed = false;
                core.Settings.IsStatusBarEnabled = false;
                core.Settings.IsBuiltInErrorPageEnabled = false;
                core.Settings.IsPasswordAutosaveEnabled = false;
                core.Settings.IsGeneralAutofillEnabled = false;
                core.NavigationStarting += (s, e) => { if (!IsAppOrigin(e.Uri)) e.Cancel = true; };
                core.FrameNavigationStarting += (s, e) => { e.Cancel = true; };
                core.NewWindowRequested += (s, e) => { e.Handled = true; };
                core.PermissionRequested += (s, e) => { e.State = CoreWebView2PermissionState.Deny; };
                core.DownloadStarting += (s, e) => { e.Cancel = true; };
                core.WebMessageReceived += Receive;
                core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
                core.WebResourceRequested += (s, e) =>
                {
                    if (!IsAppOrigin(e.Request.Uri)) e.Response = core.Environment.CreateWebResourceResponse(null, 403, "Blocked", "Content-Type: text/plain");
                };
                browserReady = true;
                UpdateResourceUsage();
                core.Navigate("https://salary.local/index.html");
            }
            catch (WebView2RuntimeNotFoundException) { ShowStartupError("需要 Microsoft Edge WebView2 运行时。请安装微软官方 Evergreen WebView2 Runtime 后重新打开薪迹。"); }
            catch (UserError error) { ShowStartupError(error.Message); }
            catch (Exception) { ShowStartupError("薪迹启动失败，请重新安装薪迹后再试。"); }
        }
        private void ShowStartupError(string message)
        {
            if (IsDisposed || Disposing) return;
            browserReady = false;
            web.Visible = false;
            Controls.Add(new Label { Text = message, Dock = DockStyle.Fill, Padding = new Padding(32), Font = new System.Drawing.Font("Microsoft YaHei UI", 12) });
        }
        private void UpdateResourceUsage()
        {
            if (!browserReady || IsDisposed || web.CoreWebView2 == null) return;
            var minimized = WindowState == FormWindowState.Minimized;
            web.Visible = !minimized;
            var target = windowActive && !minimized ? CoreWebView2MemoryUsageTargetLevel.Normal : CoreWebView2MemoryUsageTargetLevel.Low;
            if (memoryTarget == target) return;
            memoryTarget = target;
            try
            {
                // Low keeps scripts running, so an in-flight save or sync can still finish.
                web.CoreWebView2.MemoryUsageTargetLevel = target;
            }
            catch (NotImplementedException) { }
            catch (System.Runtime.InteropServices.COMException) { }
        }
        private async void Receive(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            if (IsDisposed || Disposing || !IsAppOrigin(e.Source)) return;
            string id = null;
            var operationStarted = false;
            try
            {
                if (Encoding.UTF8.GetByteCount(e.WebMessageAsJson) > JsonData.MaxBytes * 2 + 8192) throw new UserError("请求数据过大。");
                var request = JsonData.Serializer().DeserializeObject(e.WebMessageAsJson) as Dictionary<string, object>;
                if (request == null) return;
                object value;
                if (!request.TryGetValue("id", out value) || !(value is string) || ((string)value).Length > 100) return;
                id = (string)value;
                var method = StringArg(request, "method");
                var arguments = request.TryGetValue("args", out value) ? value as Dictionary<string, object> : null;
                activeOperations++;
                operationStarted = true;
                var result = await Dispatch(method, arguments ?? new Dictionary<string, object>());
                Respond(new { id = id, result = result });
            }
            catch (UserError error) { if (id != null) Respond(new { id = id, error = error.Message }); }
            catch (Exception) { if (id != null) Respond(new { id = id, error = "操作未完成，请重试。" }); }
            finally { if (operationStarted) activeOperations--; }
        }
        private void Respond(object response)
        {
            if (!IsDisposed && web.CoreWebView2 != null && IsAppOrigin(web.CoreWebView2.Source)) web.CoreWebView2.PostWebMessageAsJson(JsonData.Serializer().Serialize(response));
        }
        private async Task<object> Dispatch(string method, Dictionary<string, object> args)
        {
            switch (method)
            {
                case "setAppBusy":
                    object busy;
                    if (!args.TryGetValue("busy", out busy) || !(busy is bool)) throw new UserError("操作参数不完整。");
                    applicationBusy = (bool)busy;
                    return new { };
                case "loadLedger": return new { content = await Task.Run(() => store.LoadLedger()) };
                case "saveLedger":
                    var content = StringArg(args, "content");
                    await writeGate.WaitAsync();
                    try { await Task.Run(() => store.SaveLedger(content)); }
                    finally { writeGate.Release(); }
                    return new { };
                case "restoreLedger":
                    var restoredContent = StringArg(args, "content");
                    await writeGate.WaitAsync();
                    try { await Task.Run(() => store.RestoreLedger(restoredContent)); }
                    finally { writeGate.Release(); }
                    return new { };
                case "captureFeishu": return await CapturePageAsync();
                case "pickDataFile": return PickFile();
                case "exportDataFile": return ExportFile(args);
                case "checkForUpdates":
                    using (var updates = new ReleaseClient()) return await updates.CheckAsync();
                case "openExternal":
                    ReleaseClient.OpenExternal(StringArg(args, "url"));
                    return new { };
                case "getSyncSettings":
                    var credentials = await Task.Run(() => store.ReadCredentials());
                    return new { configured = credentials != null, username = credentials == null ? "" : credentials.Username };
                case "setSyncSettings":
                    var username = StringArg(args, "username"); var password = StringArg(args, "password");
                    await Task.Run(() => store.SaveCredentials(username, password)); return new { };
                case "clearSyncSettings": await Task.Run(() => store.ClearCredentials()); return new { };
                case "webdavPull":
                    using (var dav = new WebDavClient(store.ReadCredentials(), null, Path.Combine(store.DirectoryPath, "SyncCache"))) return await dav.PullAsync();
                case "webdavPublish":
                    using (var dav = new WebDavClient(store.ReadCredentials(), null, Path.Combine(store.DirectoryPath, "SyncCache"))) return await dav.PublishAsync(StringArg(args, "content"));
                default: throw new UserError("此操作不受支持。");
            }
        }
        private async Task<object> CapturePageAsync()
        {
            if (captureRunning) throw new UserError("正在读取工资页，请稍候。");
            captureRunning = true;
            var task = Task.Run(() => PageCollector.Collect());
            try
            {
                if (await Task.WhenAny(task, Task.Delay(35000)) != task) throw new UserError("读取超时，请确认飞书工资页已展开。");
                var result = await task;
                if (result.Records.Count == 0) throw new UserError(result.Error == "feishu_not_running" ? "请先打开电脑飞书中的工资页。" : "请展开工资明细并等待页面加载后重试。");
                var package = new CapturePackage { Records = result.Records };
                package.Source.CapturedAt = result.CapturedAt;
                CaptureValidation.ValidateRecords(result.Records);
                string text;
                using (var memory = new MemoryStream())
                {
                    new System.Runtime.Serialization.Json.DataContractJsonSerializer(typeof(CapturePackage)).WriteObject(memory, package);
                    if (memory.Length > CaptureValidation.MaxBytes) throw new UserError("工资来源文件超过 1 MiB。");
                    text = Encoding.UTF8.GetString(memory.ToArray());
                }
                await Task.Run(() => store.SaveSource(text));
                return new { content = text, diagnostics = new { months = result.Records.Count, fields = result.Records.Sum(r => r.Fields.Count) } };
            }
            finally
            {
                if (task.IsCompleted) captureRunning = false;
                else ResetCaptureWhenReady(task);
            }
        }
        private async void ResetCaptureWhenReady(Task task)
        {
            try { await task; }
            catch (Exception) { }
            finally { captureRunning = false; }
        }
        private object PickFile()
        {
            using (var dialog = new OpenFileDialog { Filter = "工资数据 (*.json)|*.json", Multiselect = false, CheckFileExists = true })
            {
                if (dialog.ShowDialog(this) != DialogResult.OK) return new { cancelled = true };
                return new { content = JsonData.Read(dialog.FileName) };
            }
        }
        private object ExportFile(Dictionary<string, object> args)
        {
            var content = StringArg(args, "content"); JsonData.Validate(content);
            var name = OptionalString(args, "fileName") ?? "salary-archive.json";
            if (name.Length > 100 || Path.GetFileName(name) != name || name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || !name.EndsWith(".json", StringComparison.OrdinalIgnoreCase)) name = "salary-archive.json";
            using (var dialog = new SaveFileDialog { Filter = "工资数据 (*.json)|*.json", FileName = name, InitialDirectory = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), OverwritePrompt = true })
            {
                if (dialog.ShowDialog(this) != DialogResult.OK) return new { cancelled = true };
                JsonData.WriteAtomic(dialog.FileName, Encoding.UTF8.GetBytes(content), null);
                return new { };
            }
        }
        private static string StringArg(Dictionary<string, object> args, string key)
        {
            var value = OptionalString(args, key);
            if (value == null) throw new UserError("操作参数不完整。");
            return value;
        }
        private static string OptionalString(Dictionary<string, object> args, string key)
        {
            object value;
            return args.TryGetValue(key, out value) ? value as string : null;
        }
    }
}
