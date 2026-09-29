using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace SalaryDesktop
{
    // The renderer never supplies an installer URL or a local executable path.
    internal sealed class WindowsUpdateManager : IDisposable
    {
        internal const long MaxInstallerBytes = 150L * 1024 * 1024;
        private const string Root = "https://github.com/flycodeu/mysalary/releases";
        private static readonly Regex VersionPattern = new Regex(@"\A[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}\z", RegexOptions.Compiled);
        private static readonly Regex DigestPattern = new Regex(@"\Asha256:([0-9a-fA-F]{64})\z", RegexOptions.Compiled);
        private readonly HttpClient client;
        private readonly string directory;
        private readonly object gate = new object();
        private CancellationTokenSource cancellation;
        private bool cancelledByUser;
        private UpdateStatus status = UpdateStatus.Idle();
        private UpdateMetadata ready;

        internal WindowsUpdateManager(string dataDirectory) : this(dataDirectory,
            new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false, UseDefaultCredentials = false }) { }

        internal WindowsUpdateManager(string dataDirectory, HttpMessageHandler handler)
        {
            directory = Path.Combine(dataDirectory, "Updates");
            ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
            client = new HttpClient(handler) { Timeout = Timeout.InfiniteTimeSpan };
            client.DefaultRequestHeaders.UserAgent.ParseAdd("SalaryTrail/1.0");
        }

        internal UpdateStatus Status { get { lock (gate) return status; } }
        internal void Cancel()
        {
            CancellationTokenSource source;
            lock (gate) { source = cancellation; if (source != null) cancelledByUser = true; }
            if (source != null) try { source.Cancel(); } catch (ObjectDisposedException) { }
        }

        internal async Task<UpdateStatus> DownloadAsync(string version)
        {
            if (!ValidVersion(version)) throw new UserError("更新版本号无效。");
            var requested = new Version(version);
            if (requested <= typeof(WindowsUpdateManager).Assembly.GetName().Version) throw new UserError("更新版本必须高于当前版本。");
            CancellationTokenSource source;
            lock (gate)
            {
                if (cancellation != null) throw new UserError("更新正在下载，请稍候。");
                if (ready != null && ready.Version == version && File.Exists(Target(version))) return status;
                cancellation = source = new CancellationTokenSource(TimeSpan.FromMinutes(5));
                cancelledByUser = false;
                status = UpdateStatus.Downloading(version, 0, 0);
            }
            try
            {
                var metadata = await FetchMetadataAsync(version, source.Token);
                Directory.CreateDirectory(directory);
                var partial = Target(version) + ".part";
                try
                {
                    await DownloadFileAsync(metadata, partial, source.Token);
                    Set(UpdateStatus.Verifying(version, metadata.Size));
                    await Task.Run(() => VerifyFile(partial, metadata), source.Token);
                    source.Token.ThrowIfCancellationRequested();
                    if (File.Exists(Target(version))) File.Delete(Target(version));
                    File.Move(partial, Target(version));
                    lock (gate) { ready = metadata; status = UpdateStatus.Ready(version, metadata.Size); return status; }
                }
                finally { if (File.Exists(partial)) File.Delete(partial); }
            }
            catch (OperationCanceledException)
            {
                lock (gate) { status = cancelledByUser ? UpdateStatus.Idle() : UpdateStatus.Error("下载超时，请重试。"); return status; }
            }
            catch (Exception error)
            {
                lock (gate)
                {
                    status = UpdateStatus.Error(error is UserError ? error.Message : "更新下载或校验失败，请重试。");
                    return status;
                }
            }
            finally { lock (gate) { cancellation = null; source.Dispose(); } }
        }

        internal UpdateMetadata Ready(string version)
        {
            lock (gate)
            {
                if (ready == null || ready.Version != version || status.State != "ready") throw new UserError("请先下载并校验当前版本。");
                try { VerifyFile(Target(version), ready); }
                catch
                {
                    ready = null;
                    status = UpdateStatus.Error("安装包校验失败，请重新下载。");
                    throw new UserError("安装包校验失败，请重新下载。");
                }
                return ready;
            }
        }

        internal string ReadyPath(string version) { return Target(version); }
        private string Target(string version) { return Path.Combine(directory, "salary-" + version + "-windows-setup.exe"); }
        private void Set(UpdateStatus next) { lock (gate) status = next; }

        private async Task<UpdateMetadata> FetchMetadataAsync(string version, CancellationToken token)
        {
            using (var response = await SendAsync(ReleaseClient.LatestUrl, token, false))
            {
                if (response.StatusCode != HttpStatusCode.OK) throw new UserError("更新信息暂不可用，请重试。");
                var content = await ReadBoundedAsync(response, ReleaseClient.MaxBytes, token);
                return ParseMetadata(content, version);
            }
        }

        private async Task DownloadFileAsync(UpdateMetadata metadata, string partial, CancellationToken token)
        {
            using (var response = await SendAsync(metadata.Url, token, true))
            {
                if (response.StatusCode != HttpStatusCode.OK) throw new UserError("安装包下载失败，请重试。");
                if (response.Content == null || (response.Content.Headers.ContentLength.HasValue && response.Content.Headers.ContentLength.Value != metadata.Size))
                    throw new UserError("安装包大小与发行信息不符。");
                using (var input = await response.Content.ReadAsStreamAsync())
                using (var output = new FileStream(partial, FileMode.Create, FileAccess.Write, FileShare.None, 65536, true))
                {
                    var buffer = new byte[65536];
                    long received = 0;
                    int count;
                    while ((count = await input.ReadAsync(buffer, 0, buffer.Length, token)) != 0)
                    {
                        received += count;
                        if (received > metadata.Size || received > MaxInstallerBytes) throw new UserError("安装包超过大小限制。");
                        await output.WriteAsync(buffer, 0, count, token);
                        Set(UpdateStatus.Downloading(metadata.Version, received, metadata.Size));
                    }
                    if (received != metadata.Size) throw new UserError("安装包下载不完整。");
                    output.Flush(true);
                }
            }
        }

        private async Task<HttpResponseMessage> SendAsync(string url, CancellationToken token, bool download)
        {
            for (var hop = 0; hop <= 5; hop++)
            {
                using (var request = new HttpRequestMessage(HttpMethod.Get, url))
                {
                    if (!download)
                    {
                        request.Headers.Accept.ParseAdd("application/vnd.github+json");
                        request.Headers.Add("X-GitHub-Api-Version", "2022-11-28");
                    }
                    var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token);
                    if (!download || !IsRedirect(response.StatusCode)) return response;
                    var next = response.Headers.Location;
                    response.Dispose();
                    if (next == null || !next.IsAbsoluteUri || !AllowedRedirect(next)) throw new UserError("安装包下载地址不受支持。");
                    url = next.AbsoluteUri;
                }
            }
            throw new UserError("安装包重定向次数过多。");
        }

        private static bool IsRedirect(HttpStatusCode code) { return code == HttpStatusCode.MovedPermanently || code == HttpStatusCode.Redirect || code == HttpStatusCode.RedirectMethod || code == HttpStatusCode.TemporaryRedirect || (int)code == 308; }
        internal static bool AllowedRedirect(Uri uri)
        {
            if (uri == null || uri.Scheme != Uri.UriSchemeHttps || uri.Port != 443 || uri.UserInfo.Length != 0 || uri.Fragment.Length != 0) return false;
            var host = uri.Host.ToLowerInvariant();
            return host == "github.com" || host == "objects.githubusercontent.com" || host == "release-assets.githubusercontent.com" || host == "github-releases.githubusercontent.com";
        }

        private static async Task<string> ReadBoundedAsync(HttpResponseMessage response, int max, CancellationToken token)
        {
            if (response.Content == null || response.Content.Headers.ContentLength > max) throw new UserError("更新信息过大。");
            using (var input = await response.Content.ReadAsStreamAsync())
            using (var output = new MemoryStream())
            {
                var buffer = new byte[8192]; int count;
                while ((count = await input.ReadAsync(buffer, 0, buffer.Length, token)) != 0)
                {
                    if (output.Length + count > max) throw new UserError("更新信息过大。");
                    output.Write(buffer, 0, count);
                }
                return new UTF8Encoding(false, true).GetString(output.ToArray());
            }
        }

        internal static UpdateMetadata ParseMetadata(string content, string version)
        {
            if (!ValidVersion(version)) throw new UserError("更新版本号无效。");
            var document = new JavaScriptSerializer { MaxJsonLength = ReleaseClient.MaxBytes }.DeserializeObject(content) as Dictionary<string, object>;
            if (document == null || !Equals(Field(document, "draft"), false) || !Equals(Field(document, "prerelease"), false) || !Equals(Field(document, "tag_name"), "v" + version))
                throw new UserError("发行版已变化，请重新检查。");
            var assets = Field(document, "assets") as object[];
            var name = "salary-" + version + "-windows-setup.exe";
            var url = Root + "/download/v" + version + "/" + name;
            if (assets != null) foreach (var value in assets)
            {
                var asset = value as Dictionary<string, object>;
                if (asset == null || !Equals(Field(asset, "name"), name)) continue;
                long size;
                if (!long.TryParse(Convert.ToString(Field(asset, "size")), out size) || size <= 0 || size > MaxInstallerBytes || !Equals(Field(asset, "browser_download_url"), url)) break;
                var match = DigestPattern.Match(Convert.ToString(Field(asset, "digest")) ?? "");
                if (!match.Success) break;
                return new UpdateMetadata(version, url, size, match.Groups[1].Value.ToLowerInvariant());
            }
            throw new UserError("没有可用的 Windows 安装包或校验信息。");
        }
        private static object Field(Dictionary<string, object> value, string name) { object field; return value.TryGetValue(name, out field) ? field : null; }
        private static bool ValidVersion(string value) { return value != null && VersionPattern.IsMatch(value); }

        internal static void VerifyFile(string path, UpdateMetadata metadata)
        {
            var info = new FileInfo(path);
            if (!info.Exists || info.Length != metadata.Size) throw new UserError("安装包大小校验失败，请重新下载。");
            using (var hash = SHA256.Create())
            using (var input = File.OpenRead(path))
            {
                var actual = BitConverter.ToString(hash.ComputeHash(input)).Replace("-", "").ToLowerInvariant();
                if (!string.Equals(actual, metadata.Digest, StringComparison.Ordinal)) throw new UserError("安装包摘要校验失败，请重新下载。");
            }
        }
        public void Dispose() { Cancel(); client.Dispose(); }
    }

    internal sealed class UpdateMetadata
    {
        internal readonly string Version, Url, Digest;
        internal readonly long Size;
        internal UpdateMetadata(string version, string url, long size, string digest) { Version = version; Url = url; Size = size; Digest = digest; }
    }
    internal sealed class UpdateStatus
    {
        public string state { get { return State; } }
        public string version { get { return Version; } }
        public long receivedBytes { get { return ReceivedBytes; } }
        public long totalBytes { get { return TotalBytes; } }
        public string error { get { return ErrorMessage; } }
        internal readonly string State, Version, ErrorMessage;
        internal readonly long ReceivedBytes, TotalBytes;
        private UpdateStatus(string state, string version, long received, long total, string error) { State = state; Version = version; ReceivedBytes = received; TotalBytes = total; ErrorMessage = error; }
        internal static UpdateStatus Idle() { return new UpdateStatus("idle", null, 0, 0, null); }
        internal static UpdateStatus Downloading(string version, long received, long total) { return new UpdateStatus("downloading", version, received, total, null); }
        internal static UpdateStatus Verifying(string version, long total) { return new UpdateStatus("verifying", version, total, total, null); }
        internal static UpdateStatus Ready(string version, long total) { return new UpdateStatus("ready", version, total, total, null); }
        internal static UpdateStatus Error(string message) { return new UpdateStatus("error", null, 0, 0, message); }
    }
}
