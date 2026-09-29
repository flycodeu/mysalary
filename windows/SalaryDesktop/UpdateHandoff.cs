using System;
using System.Diagnostics;
using System.IO;
using System.Text.RegularExpressions;
using System.Windows.Forms;

namespace SalaryDesktop
{
    internal static class UpdateHandoff
    {
        private static readonly Regex Version = new Regex(@"\A[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}\z");
        private static readonly Regex Digest = new Regex(@"\A[0-9a-f]{64}\z");

        // A copy outside the installation directory remains runnable while Inno replaces Salary.exe.
        internal static Process Start(UpdateMetadata metadata, string installerPath, string dataDirectory)
        {
            WindowsUpdateManager.VerifyFile(installerPath, metadata);
            var helper = Path.Combine(dataDirectory, "Updates", "SalaryUpdater-" + metadata.Version + ".exe");
            foreach (var dependency in new[] { "Microsoft.Web.WebView2.Core.dll", "Microsoft.Web.WebView2.WinForms.dll", "WebView2Loader.dll" })
                File.Copy(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, dependency), Path.Combine(dataDirectory, "Updates", dependency), true);
            File.Copy(Application.ExecutablePath, helper, true);
            var args = string.Format("--install-update {0} {1} {2} {3}", metadata.Version, metadata.Digest, metadata.Size, Process.GetCurrentProcess().Id);
            var process = Process.Start(new ProcessStartInfo(helper, args) { UseShellExecute = false, CreateNoWindow = true });
            if (process == null) throw new UserError("无法启动更新助手，请重试。");
            return process;
        }

        internal static int Run(string[] args)
        {
            try
            {
                long size; int parentId;
                if (args.Length != 5 || !Version.IsMatch(args[1]) || !Digest.IsMatch(args[2]) ||
                    !long.TryParse(args[3], out size) || size <= 0 || size > WindowsUpdateManager.MaxInstallerBytes ||
                    !int.TryParse(args[4], out parentId) || parentId <= 0) return 2;
                var dataDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SalaryTrail", "Desktop");
                var installer = Path.Combine(dataDirectory, "Updates", "salary-" + args[1] + "-windows-setup.exe");
                try
                {
                    using (var parent = Process.GetProcessById(parentId)) if (!parent.WaitForExit(60000)) throw new UserError("薪迹仍在运行，无法开始安装。");
                }
                catch (ArgumentException) { /* Parent exited before the helper started. */ }
                WindowsUpdateManager.VerifyFile(installer, new UpdateMetadata(args[1], "", size, args[2]));
                var started = Process.Start(new ProcessStartInfo(installer) { UseShellExecute = true });
                if (started == null) throw new UserError("无法打开安装包，请在应用中重新下载。");
                started.Dispose();
                return 0;
            }
            catch (Exception)
            {
                MessageBox.Show("安装未启动。请重新打开薪迹，在设置中重试更新。", "薪迹更新", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
        }
    }
}
