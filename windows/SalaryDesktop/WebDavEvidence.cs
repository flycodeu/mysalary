using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace SalaryDesktop
{
    internal sealed partial class WebDavClient
    {
        private static readonly Regex EvidenceName = new Regex(@"\Aevidence-([A-Za-z0-9_-]{1,96})-([a-f0-9]{64})\.(png|jpg)\z");
        private const int MaxEvidenceFiles = 1200;

        internal static string EvidenceNameFor(string recordId, string id, string mimeType)
        {
            EvidenceStore.ValidateRecordId(recordId);
            if (id == null || !Regex.IsMatch(id, @"\A[a-f0-9]{64}\z")) throw new UserError("原图标识无效。");
            if (mimeType != "image/png" && mimeType != "image/jpeg") throw new UserError("原图格式无效。");
            return "evidence-" + recordId + "-" + id + (mimeType == "image/png" ? ".png" : ".jpg");
        }

        internal static List<Dictionary<string, object>> ParseEvidenceListing(string content)
        {
            var names = ParseListingNames(content, name => EvidenceName.IsMatch(name));
            if (names.Count > MaxEvidenceFiles) throw new UserError("云端原图超过 1200 张，请先整理备份。");
            return names.Select(name =>
            {
                var match = EvidenceName.Match(name);
                return new Dictionary<string, object> {
                    { "recordId", match.Groups[1].Value }, { "id", match.Groups[2].Value },
                    { "mimeType", match.Groups[3].Value == "png" ? "image/png" : "image/jpeg" }
                };
            }).ToList();
        }

        public async Task<Dictionary<string, object>> ListEvidenceAsync()
        {
            using (var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30)))
            using (var request = Request(new HttpMethod("PROPFIND"), FolderUrl))
            {
                request.Headers.TryAddWithoutValidation("Depth", "1");
                request.Headers.Accept.Clear();
                request.Content = new StringContent("<d:propfind xmlns:d=\"DAV:\"><d:prop><d:resourcetype/></d:prop></d:propfind>", Encoding.UTF8, "application/xml");
                using (var response = await SendAsync(request, timeout.Token))
                {
                    if (response.StatusCode == HttpStatusCode.NotFound) return EvidenceItems(new List<Dictionary<string, object>>());
                    if (response.StatusCode == HttpStatusCode.Conflict)
                    {
                        using (var parent = Request(HttpMethod.Get, FolderUrl))
                        using (var confirmation = await SendAsync(parent, timeout.Token))
                        {
                            if (confirmation.StatusCode == HttpStatusCode.NotFound) return EvidenceItems(new List<Dictionary<string, object>>());
                            CheckStatus(confirmation);
                        }
                    }
                    if ((int)response.StatusCode != 207) CheckStatus(response, false);
                    return EvidenceItems(ParseEvidenceListing(await ReadBounded(response.Content, timeout.Token, MaxListingBytes)));
                }
            }
        }

        public async Task<Dictionary<string, object>> GetEvidenceAsync(EvidenceStore store, string recordId, string id, string mimeType)
        {
            var name = EvidenceNameFor(recordId, id, mimeType);
            using (var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(90)))
            {
                var bytes = await DownloadEvidence(name, timeout.Token, false);
                if (EvidenceStore.Hash(bytes) != id) throw new UserError("云端原图校验不一致，未保存到本机。");
                // Add validates the actual image and permanently copies it outside the ledger.
                return new Dictionary<string, object> { { "item", store.Add(recordId, bytes, mimeType) } };
            }
        }

        public async Task<Dictionary<string, object>> PutEvidenceAsync(EvidenceStore store, string recordId, string id)
        {
            var original = store.ReadOriginal(recordId, id);
            var name = EvidenceNameFor(recordId, id, original.MimeType);
            using (var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(90)))
            {
                using (var request = Request(new HttpMethod("MKCOL"), FolderUrl))
                using (var response = await SendAsync(request, timeout.Token))
                    if (response.StatusCode != HttpStatusCode.Created && response.StatusCode != HttpStatusCode.MethodNotAllowed) CheckStatus(response, false);

                var existing = await DownloadEvidence(name, timeout.Token, true);
                if (existing != null)
                {
                    VerifyEvidenceCopy(existing, original.Bytes, id);
                    return new Dictionary<string, object>();
                }
                using (var request = Request(HttpMethod.Put, FolderUrl + name))
                {
                    // Never replace an existing name. A racing identical upload is verified below.
                    request.Headers.TryAddWithoutValidation("If-None-Match", "*");
                    request.Content = new ByteArrayContent(original.Bytes);
                    request.Content.Headers.ContentType = new MediaTypeHeaderValue(original.MimeType);
                    using (var response = await SendAsync(request, timeout.Token))
                        if (response.StatusCode != HttpStatusCode.OK && response.StatusCode != HttpStatusCode.Created
                            && response.StatusCode != HttpStatusCode.NoContent && response.StatusCode != HttpStatusCode.PreconditionFailed)
                            CheckStatus(response, false);
                }
                var downloaded = await DownloadEvidence(name, timeout.Token, false);
                VerifyEvidenceCopy(downloaded, original.Bytes, id);
                return new Dictionary<string, object>();
            }
        }

        private async Task<byte[]> DownloadEvidence(string name, CancellationToken token, bool allowMissing)
        {
            using (var request = Request(HttpMethod.Get, FolderUrl + name))
            {
                request.Headers.Accept.Clear();
                request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/octet-stream"));
                using (var response = await SendAsync(request, token))
                {
                    if (allowMissing && response.StatusCode == HttpStatusCode.NotFound) return null;
                    if (response.StatusCode != HttpStatusCode.OK) CheckStatus(response, false);
                    if (response.Content.Headers.ContentLength > EvidenceStore.MaxBytes) throw new UserError("云端原图超过 20 MiB，已停止读取。");
                    using (var input = await response.Content.ReadAsStreamAsync())
                    using (var output = new MemoryStream())
                    {
                        var buffer = new byte[16384];
                        while (true)
                        {
                            int read;
                            try { read = await input.ReadAsync(buffer, 0, buffer.Length, token); }
                            catch (OperationCanceledException) { throw new UserError("原图同步超时，请稍后重试。"); }
                            if (read == 0) break;
                            if (output.Length + read > EvidenceStore.MaxBytes) throw new UserError("云端原图超过 20 MiB，已停止读取。");
                            output.Write(buffer, 0, read);
                        }
                        if (output.Length == 0) throw new UserError("云端原图为空，已停止同步。");
                        return output.ToArray();
                    }
                }
            }
        }

        private static void VerifyEvidenceCopy(byte[] downloaded, byte[] original, string id)
        {
            if (EvidenceStore.Hash(downloaded) != id || !downloaded.SequenceEqual(original))
                throw new UserError("云端已有原图与本机不一致，已停止同步，原文件未覆盖。");
        }
        private static Dictionary<string, object> EvidenceItems(List<Dictionary<string, object>> items)
        {
            return new Dictionary<string, object> { { "items", items } };
        }
    }
}
