using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace SalaryDesktop
{
    internal sealed partial class WebDavClient : IDisposable
    {
        public const string FileUrl = "https://dav.jianguoyun.com/dav/SalaryTrail/archive-v1.json";
        public const string FolderUrl = "https://dav.jianguoyun.com/dav/SalaryTrail/";
        private readonly HttpClient client;
        private readonly SyncCredentials credentials;
        private readonly string cacheDirectory;
        public WebDavClient(SyncCredentials credentials, HttpMessageHandler testHandler = null)
            : this(credentials, testHandler, null) { }
        public WebDavClient(SyncCredentials credentials, HttpMessageHandler testHandler, string cacheDirectory)
        {
            if (credentials == null) throw new UserError("请先设置坚果云账号和应用密码。");
            this.credentials = credentials;
            this.cacheDirectory = cacheDirectory;
            ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
            client = new HttpClient(testHandler ?? new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false }) { Timeout = TimeSpan.FromSeconds(30) };
        }
        public static bool IsStrongEtag(string value)
        {
            return !string.IsNullOrEmpty(value) && value.Length <= 256 && Regex.IsMatch(value, "^\"[!#-~]+\"$");
        }
        private HttpRequestMessage Request(HttpMethod method, string url)
        {
            if (url != FileUrl && url != FolderUrl && !(url.StartsWith(FolderUrl, StringComparison.Ordinal) && DeltaName.IsMatch(url.Substring(FolderUrl.Length)))) throw new UserError("同步地址不受支持。");
            var request = new HttpRequestMessage(method, url);
            request.Headers.Authorization = new AuthenticationHeaderValue("Basic", Convert.ToBase64String(Encoding.UTF8.GetBytes(credentials.Username + ":" + credentials.Password)));
            request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
            return request;
        }
        public async Task<Dictionary<string, object>> GetAsync()
        {
            using (var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30)))
            using (var request = Request(HttpMethod.Get, FileUrl))
            using (var response = await SendAsync(request, timeout.Token))
            {
                if (response.StatusCode == HttpStatusCode.NotFound) return new Dictionary<string, object> { { "missing", true } };
                if (response.StatusCode == HttpStatusCode.Conflict)
                {
                    // Jianguoyun returns 409 for a file whose parent collection does not exist.
                    // Confirm the fixed parent with a read before treating this as first-time sync.
                    using (var parentRequest = Request(HttpMethod.Get, FolderUrl))
                    using (var parentResponse = await SendAsync(parentRequest, timeout.Token))
                    {
                        if (parentResponse.StatusCode == HttpStatusCode.NotFound) return new Dictionary<string, object> { { "missing", true } };
                        CheckStatus(parentResponse);
                    }
                }
                if (response.StatusCode != HttpStatusCode.OK) CheckStatus(response, false);
                var content = await ReadBounded(response.Content, timeout.Token);
                JsonData.Validate(content);
                var result = new Dictionary<string, object> { { "content", content } };
                var etag = StrongEtag(response);
                if (etag != null) result["etag"] = etag;
                return result;
            }
        }
        public async Task<Dictionary<string, object>> PutAsync(string content, string etag, bool create)
        {
            JsonData.Validate(content);
            if (create && etag != null) throw new UserError("同步版本信息冲突，请重新同步。");
            if (!create && !IsStrongEtag(etag)) throw new UserError("云端未提供可靠的版本标识，已停止覆盖，请重新同步。");
            using (var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30)))
            {
                using (var folder = Request(new HttpMethod("MKCOL"), FolderUrl))
                using (var response = await SendAsync(folder, timeout.Token))
                {
                    if (response.StatusCode != HttpStatusCode.Created && response.StatusCode != HttpStatusCode.MethodNotAllowed) CheckStatus(response, false);
                }
                using (var request = Request(HttpMethod.Put, FileUrl))
                {
                    request.Headers.TryAddWithoutValidation(create ? "If-None-Match" : "If-Match", create ? "*" : etag);
                    request.Content = new StringContent(content, Encoding.UTF8, "application/json");
                    using (var response = await SendAsync(request, timeout.Token))
                    {
                        if (response.StatusCode == HttpStatusCode.PreconditionFailed) return new Dictionary<string, object> { { "conflict", true } };
                        if (response.StatusCode != HttpStatusCode.OK && response.StatusCode != HttpStatusCode.Created && response.StatusCode != HttpStatusCode.NoContent) CheckStatus(response, false);
                        var result = new Dictionary<string, object>();
                        var updated = StrongEtag(response);
                        if (updated != null) result["etag"] = updated;
                        return result;
                    }
                }
            }
        }
        private async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            try { return await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token); }
            catch (TaskCanceledException) { throw new UserError("同步超时，请稍后重试。"); }
            catch (HttpRequestException) { throw new UserError("无法连接坚果云，请检查网络后重试。"); }
        }
        private static string StrongEtag(HttpResponseMessage response)
        {
            IEnumerable<string> values;
            if (!response.Headers.TryGetValues("ETag", out values)) return null;
            string result = null;
            foreach (var value in values)
            {
                if (result != null || !IsStrongEtag(value)) return null;
                result = value;
            }
            return result;
        }
        private static void CheckStatus(HttpResponseMessage response, bool allowSuccess = true)
        {
            var status = (int)response.StatusCode;
            if (status == 401) throw new UserError("坚果云账号或应用密码不正确（HTTP 401）。");
            if (status == 403) throw new UserError("坚果云拒绝访问，请检查账号权限（HTTP 403）。");
            if (status == 409) throw new UserError("坚果云返回冲突（HTTP 409），未更改云端档案。");
            if (status == 429) throw new UserError("坚果云请求过于频繁，请稍后重试（HTTP 429）。");
            if (status >= 300 && status < 400) throw new UserError("同步地址发生重定向，已停止请求（HTTP " + status + "）。");
            if (!allowSuccess || !response.IsSuccessStatusCode) throw new UserError("坚果云暂时无法完成同步（HTTP " + status + "），请稍后重试。");
        }
        private static async Task<string> ReadBounded(HttpContent content, CancellationToken token, int maxBytes = JsonData.MaxBytes)
        {
            var sizeError = maxBytes == JsonData.MaxBytes ? "云端文件超过 8 MiB，已停止读取。" : "云端文件列表超过 1 MiB，已停止读取。";
            if (content.Headers.ContentLength > maxBytes) throw new UserError(sizeError);
            using (var input = await content.ReadAsStreamAsync())
            using (var output = new MemoryStream())
            {
                var buffer = new byte[16384];
                while (true)
                {
                    int read;
                    try { read = await input.ReadAsync(buffer, 0, buffer.Length, token); }
                    catch (OperationCanceledException) { throw new UserError("同步超时，请稍后重试。"); }
                    if (read == 0) break;
                    if (output.Length + read > maxBytes) throw new UserError(sizeError);
                    output.Write(buffer, 0, read);
                }
                try { return new UTF8Encoding(false, true).GetString(output.ToArray()); }
                catch (DecoderFallbackException) { throw new UserError("云端文件编码无效。"); }
            }
        }
        public void Dispose() { client.Dispose(); }
    }
}
