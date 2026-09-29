using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace SalaryDesktop
{
    /// <summary>Public release metadata is fetched separately from private salary synchronization.</summary>
    internal sealed class ReleaseClient : IDisposable
    {
        internal const string LatestUrl = "https://api.github.com/repos/flycodeu/mysalary/releases/latest";
        internal const int MaxBytes = 1024 * 1024;
        private const string ReleaseRoot = "https://github.com/flycodeu/mysalary/releases";
        private readonly HttpClient client;

        public ReleaseClient() : this(new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false, UseDefaultCredentials = false }) { }
        internal ReleaseClient(HttpMessageHandler handler)
        {
            ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
            client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(20) };
            client.DefaultRequestHeaders.UserAgent.ParseAdd("SalaryTrail/1.0");
            client.DefaultRequestHeaders.Accept.ParseAdd("application/vnd.github+json");
            client.DefaultRequestHeaders.Add("X-GitHub-Api-Version", "2022-11-28");
        }

        public async Task<Dictionary<string, object>> CheckAsync()
        {
            // One deadline bounds headers and streaming content, even if a server stalls mid-body.
            using (var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(20)))
            using (var response = await client.GetAsync(LatestUrl, HttpCompletionOption.ResponseHeadersRead, deadline.Token))
            {
                var status = (int)response.StatusCode;
                if (status != 200) return new Dictionary<string, object> { { "status", status }, { "content", null } };
                if (response.Content == null || response.Content.Headers.ContentLength > MaxBytes) throw new UserError("更新信息过大或不完整，请稍后重试。");
                using (var stream = await response.Content.ReadAsStreamAsync())
                using (var output = new MemoryStream())
                {
                    var buffer = new byte[8192];
                    int count;
                    while ((count = await stream.ReadAsync(buffer, 0, buffer.Length, deadline.Token)) > 0)
                    {
                        if (output.Length + count > MaxBytes) throw new UserError("更新信息过大，请稍后重试。");
                        output.Write(buffer, 0, count);
                    }
                    return new Dictionary<string, object> { { "status", status }, { "content", new UTF8Encoding(false, true).GetString(output.ToArray()) } };
                }
            }
        }

        internal static bool IsReleaseUrl(string url)
        {
            if (url == ReleaseRoot || url == ReleaseRoot + "/" || url == ReleaseRoot + "/latest") return true;
            // Match exact canonical URLs: encoded separators, credentials, queries, and redirects are excluded.
            if (url == null) return false;
            if (Regex.IsMatch(url, "^" + Regex.Escape(ReleaseRoot) + @"/tag/v[0-9]+\.[0-9]+\.[0-9]+\z")) return true;
            var match = Regex.Match(url, "^" + Regex.Escape(ReleaseRoot) + @"/download/v([0-9]+\.[0-9]+\.[0-9]+)/salary-\1-(windows-setup\.exe|debug\.apk)\z");
            return match.Success;
        }

        internal static void OpenExternal(string url)
        {
            if (!IsReleaseUrl(url)) throw new UserError("此更新地址不受支持。");
            Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
        }
        public void Dispose() { client.Dispose(); }
    }
}
