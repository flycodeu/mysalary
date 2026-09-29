using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Xml;
using System.Xml.Linq;

namespace SalaryDesktop
{
    internal sealed partial class WebDavClient
    {
        private static readonly Regex DeltaName = new Regex(@"^changes-[a-f0-9]{64}\.json$");
        private const int MaxListingBytes = 1024 * 1024;
        private const int MaxTotalBytes = 16 * 1024 * 1024;
        private const int MaxDeltaFiles = 1200;
        public async Task<Dictionary<string, object>> PullAsync()
        {
            using (var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(75)))
            {
                List<string> names;
                using (var request = Request(new HttpMethod("PROPFIND"), FolderUrl))
                {
                    request.Headers.TryAddWithoutValidation("Depth", "1");
                    request.Headers.Accept.Clear();
                    request.Content = new StringContent("<d:propfind xmlns:d=\"DAV:\"><d:prop><d:resourcetype/></d:prop></d:propfind>", Encoding.UTF8, "application/xml");
                    using (var response = await SendAsync(request, timeout.Token))
                    {
                        if (response.StatusCode == HttpStatusCode.NotFound) return FilesResult(new List<Dictionary<string, object>>());
                        if (response.StatusCode == HttpStatusCode.Conflict)
                        {
                            using (var parent = Request(HttpMethod.Get, FolderUrl))
                            using (var confirmation = await SendAsync(parent, timeout.Token))
                            {
                                if (confirmation.StatusCode == HttpStatusCode.NotFound) return FilesResult(new List<Dictionary<string, object>>());
                                CheckStatus(confirmation);
                            }
                        }
                        if ((int)response.StatusCode != 207) CheckStatus(response, false);
                        names = ParseListing(await ReadBounded(response.Content, timeout.Token, MaxListingBytes));
                    }
                }
                var files = new List<Dictionary<string, object>>();
                long totalBytes = 0;
                foreach (var name in names)
                {
                    var content = name == "archive-v1.json" ? null : ReadCache(name);
                    if (content == null)
                    {
                        using (var request = Request(HttpMethod.Get, FolderUrl + name))
                        using (var response = await SendAsync(request, timeout.Token))
                        {
                            if (response.StatusCode != HttpStatusCode.OK) CheckStatus(response, false);
                            content = await ReadBounded(response.Content, timeout.Token);
                        }
                        JsonData.Validate(content);
                        if (DeltaName.IsMatch(name))
                        {
                            if (NameFor(content) != name) throw new UserError("云端增量文件校验不一致，已停止同步。");
                            WriteCache(name, content);
                        }
                    }
                    totalBytes += Encoding.UTF8.GetByteCount(content);
                    if (totalBytes > MaxTotalBytes) throw new UserError("云端档案总量超过 16 MiB，请先整理备份。");
                    files.Add(new Dictionary<string, object> { { "name", name }, { "content", content } });
                }
                return FilesResult(files);
            }
        }
        public async Task<Dictionary<string, object>> PublishAsync(string content)
        {
            JsonData.Validate(content);
            var name = NameFor(content);
            using (var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(45)))
            {
                using (var request = Request(new HttpMethod("MKCOL"), FolderUrl))
                using (var response = await SendAsync(request, timeout.Token))
                {
                    if (response.StatusCode != HttpStatusCode.Created && response.StatusCode != HttpStatusCode.MethodNotAllowed) CheckStatus(response, false);
                }
                using (var request = Request(HttpMethod.Put, FolderUrl + name))
                {
                    // The complete UTF-8 payload determines this name; different content never shares a target.
                    request.Content = new StringContent(content, Encoding.UTF8, "application/json");
                    using (var response = await SendAsync(request, timeout.Token))
                    {
                        if (response.StatusCode != HttpStatusCode.OK && response.StatusCode != HttpStatusCode.Created && response.StatusCode != HttpStatusCode.NoContent) CheckStatus(response, false);
                    }
                }
                using (var request = Request(HttpMethod.Get, FolderUrl + name))
                using (var response = await SendAsync(request, timeout.Token))
                {
                    if (response.StatusCode != HttpStatusCode.OK) CheckStatus(response, false);
                    var downloaded = await ReadBounded(response.Content, timeout.Token);
                    if (NameFor(downloaded) != name || !string.Equals(downloaded, content, StringComparison.Ordinal)) throw new UserError("云端保存后的校验不一致，请重试同步。");
                    WriteCache(name, downloaded);
                }
                return new Dictionary<string, object>();
            }
        }
        internal static string NameFor(string content)
        {
            using (var sha = SHA256.Create()) return "changes-" + BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(content))).Replace("-", "").ToLowerInvariant() + ".json";
        }
        internal static List<string> ParseListing(string content)
        {
            var names = ParseListingNames(content, name => name == "archive-v1.json" || DeltaName.IsMatch(name));
            if (names.Count(n => DeltaName.IsMatch(n)) > MaxDeltaFiles) throw new UserError("云端增量超过 1200 个，请先整理备份。");
            return names;
        }
        private static List<string> ParseListingNames(string content, Func<string, bool> include)
        {
            try
            {
                using (var reader = XmlReader.Create(new StringReader(content), new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = MaxListingBytes }))
                {
                    var document = XDocument.Load(reader);
                    XNamespace dav = "DAV:";
                    if (document.Root == null || document.Root.Name != dav + "multistatus") throw new UserError("坚果云文件列表格式无效。");
                    var names = new HashSet<string>(StringComparer.Ordinal);
                    foreach (var response in document.Root.Elements(dav + "response"))
                    {
                        var hrefs = response.Elements(dav + "href").ToList();
                        if (hrefs.Count != 1) throw new UserError("云端文件地址不明确，已停止同步。");
                        var name = ListingName(hrefs[0].Value);
                        if (name == null) continue;
                        if (!include(name)) continue;
                        var valid = response.Elements(dav + "propstat").Where(p => Regex.IsMatch((string)p.Element(dav + "status") ?? "", @"^HTTP/[0-9.]+ 200(?: |$)")).ToList();
                        if (valid.Count == 0 || valid.Any(p => p.Descendants(dav + "collection").Any())) throw new UserError("云端档案属性无法读取，已停止同步。");
                        if (!names.Add(name)) throw new UserError("云端档案列表重复，已停止同步。");
                    }
                    return names.OrderBy(n => n, StringComparer.Ordinal).ToList();
                }
            }
            catch (XmlException) { throw new UserError("坚果云文件列表格式无效。"); }
        }
        private static string ListingName(string href)
        {
            if (string.IsNullOrWhiteSpace(href) || href.Length > 2048) throw new UserError("云端文件地址无效。");
            var decoded = Uri.UnescapeDataString(href);
            if (decoded.IndexOf('\\') >= 0 || Regex.IsMatch(decoded, @"(?:^|/)\.{1,2}(?:/|$)") || decoded.Any(c => char.IsControl(c))) throw new UserError("云端文件地址越界，已停止同步。");
            Uri uri;
            if (!Uri.TryCreate(new Uri(FolderUrl), href, out uri) || uri.Scheme != "https" || uri.Host != "dav.jianguoyun.com" || uri.Port != 443 || uri.UserInfo.Length != 0 || uri.Query.Length != 0 || uri.Fragment.Length != 0) throw new UserError("云端文件地址越界，已停止同步。");
            var path = Uri.UnescapeDataString(uri.AbsolutePath);
            const string prefix = "/dav/SalaryTrail/";
            if (path == prefix.TrimEnd('/') || path == prefix) return null;
            if (!path.StartsWith(prefix, StringComparison.Ordinal)) throw new UserError("云端文件地址越界，已停止同步。");
            var name = path.Substring(prefix.Length).TrimEnd('/');
            if (name.Length == 0 || name.IndexOf('/') >= 0 || name.IndexOf('\\') >= 0 || name == "." || name == "..") throw new UserError("云端文件包含嵌套路径，已停止同步。");
            return name;
        }
        private static Dictionary<string, object> FilesResult(List<Dictionary<string, object>> files) { return new Dictionary<string, object> { { "files", files } }; }
        private string ReadCache(string name)
        {
            if (cacheDirectory == null) return null;
            var path = Path.Combine(cacheDirectory, name);
            if (!File.Exists(path)) return null;
            try
            {
                var content = JsonData.Read(path);
                return NameFor(content) == name ? content : null;
            }
            catch (Exception) { return null; }
        }
        private void WriteCache(string name, string content)
        {
            if (cacheDirectory == null) return;
            try
            {
                Directory.CreateDirectory(cacheDirectory);
                JsonData.WriteAtomic(Path.Combine(cacheDirectory, name), Encoding.UTF8.GetBytes(content), null);
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }
}
