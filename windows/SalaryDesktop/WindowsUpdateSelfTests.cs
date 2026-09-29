using System;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace SalaryDesktop
{
    internal static class WindowsUpdateSelfTests
    {
        private const string Version = "9.9.9";
        private const string Installer = "salary-9.9.9-windows-setup.exe";
        private const string Url = "https://github.com/flycodeu/mysalary/releases/download/v9.9.9/" + Installer;
        private const string Cdn = "https://release-assets.githubusercontent.com/synthetic-installer";
        internal static async Task RunAsync()
        {
            var bytes = Encoding.UTF8.GetBytes("synthetic Windows installer bytes, never executed");
            string digest;
            using (var sha = SHA256.Create()) digest = BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
            var metadata = Metadata(bytes.Length, digest);
            Assert(WindowsUpdateManager.ParseMetadata(metadata, Version).Digest == digest);
            Assert(Rejects(() => WindowsUpdateManager.ParseMetadata(metadata, "9.9.8")));
            Assert(Rejects(() => WindowsUpdateManager.ParseMetadata(metadata.Replace("sha256:" + digest, "md5:" + digest), Version)));
            Assert(Rejects(() => WindowsUpdateManager.ParseMetadata(metadata.Replace(Url, "https://other.example/installer.exe"), Version)));
            Assert(WindowsUpdateManager.AllowedRedirect(new Uri(Cdn)));
            Assert(!WindowsUpdateManager.AllowedRedirect(new Uri("https://release-assets.githubusercontent.com.evil.test/installer")));
            Assert(!WindowsUpdateManager.AllowedRedirect(new Uri("http://release-assets.githubusercontent.com/installer")));

            var root = Path.Combine(Path.GetTempPath(), "salary-update-test-" + Guid.NewGuid().ToString("N"));
            try
            {
                var handler = new Handler((request, token) =>
                {
                    Assert(request.Headers.Authorization == null && !request.Headers.Contains("Cookie"));
                    if (request.RequestUri.AbsoluteUri == ReleaseClient.LatestUrl) return Task.FromResult(Reply(200, Encoding.UTF8.GetBytes(metadata)));
                    if (request.RequestUri.AbsoluteUri == Url) return Task.FromResult(new HttpResponseMessage(HttpStatusCode.Redirect) { Headers = { Location = new Uri(Cdn) } });
                    Assert(request.RequestUri.AbsoluteUri == Cdn);
                    return Task.FromResult(Reply(200, bytes));
                });
                using (var manager = new WindowsUpdateManager(root, handler))
                {
                    var state = await manager.DownloadAsync(Version);
                    Assert(state.State == "ready" && state.TotalBytes == bytes.Length && handler.Count == 3);
                    Assert(File.ReadAllBytes(manager.ReadyPath(Version)).Length == bytes.Length);
                    Assert(manager.Ready(Version).Digest == digest);
                    File.WriteAllText(manager.ReadyPath(Version), "tampered");
                    Assert(Rejects(() => manager.Ready(Version)));
                }

                using (var manager = new WindowsUpdateManager(root, new Handler((request, token) =>
                    Task.FromResult(request.RequestUri.AbsoluteUri == ReleaseClient.LatestUrl ?
                        Reply(200, Encoding.UTF8.GetBytes(metadata)) : Reply(200, Encoding.UTF8.GetBytes("wrong bytes"))))))
                {
                    Assert((await manager.DownloadAsync(Version)).State == "error");
                    Assert(!File.Exists(manager.ReadyPath(Version) + ".part"));
                }

                var waiting = new TaskCompletionSource<bool>();
                using (var manager = new WindowsUpdateManager(root, new Handler(async (request, token) =>
                {
                    waiting.TrySetResult(true);
                    await Task.Delay(Timeout.Infinite, token);
                    return Reply(200, bytes);
                })))
                {
                    var pending = manager.DownloadAsync(Version);
                    await waiting.Task;
                    manager.Cancel();
                    Assert((await pending).State == "idle");
                }
            }
            finally { if (Directory.Exists(root)) Directory.Delete(root, true); }
        }

        private static string Metadata(int size, string digest)
        {
            return "{\"tag_name\":\"v" + Version + "\",\"draft\":false,\"prerelease\":false,\"assets\":[{" +
                "\"name\":\"" + Installer + "\",\"size\":" + size + ",\"browser_download_url\":\"" + Url + "\",\"digest\":\"sha256:" + digest + "\"}]}";
        }
        private static HttpResponseMessage Reply(int status, byte[] content) { return new HttpResponseMessage((HttpStatusCode)status) { Content = new ByteArrayContent(content) }; }
        private static bool Rejects(Action action) { try { action(); return false; } catch (UserError) { return true; } }
        private static void Assert(bool value) { if (!value) throw new Exception("windows_update_test_failed"); }
        private sealed class Handler : HttpMessageHandler
        {
            private readonly Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> response;
            internal int Count;
            internal Handler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> response) { this.response = response; }
            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) { Count++; return response(request, token); }
        }
    }
}
