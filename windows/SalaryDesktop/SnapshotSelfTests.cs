using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Xml.Linq;

namespace SalaryDesktop
{
    internal static class SnapshotSelfTests
    {
        internal static async Task RunAsync()
        {
            const string content = "{\"format\":\"salary-archive\",\"version\":1,\"entries\":[]}";
            var name = WebDavClient.NameFor(content);
            var names = WebDavClient.ParseListing(Listing(new[] { "", "archive-v1.json", name, "notes.txt" }));
            Assert(names.Count == 2 && names.Contains(name) && names.Contains("archive-v1.json"));
            foreach (var badHref in new[] { "https://example.invalid/dav/SalaryTrail/" + name, "/dav/Other/" + name, "/dav/SalaryTrail/nested/" + name, "/dav/SalaryTrail/../" + name, "/dav/SalaryTrail/%2e%2e/" + name, "/dav/SalaryTrail/" + name + "?download=1" })
                Assert(Rejects(() => WebDavClient.ParseListing(Listing(new[] { badHref }, true))));
            Assert(Rejects(() => WebDavClient.ParseListing("<!DOCTYPE x [<!ENTITY e SYSTEM 'file:///C:/private'>]><d:multistatus xmlns:d='DAV:'>&e;</d:multistatus>")));
            Assert(Rejects(() => WebDavClient.ParseListing(Listing(new[] { name, name }))));
            Assert(Rejects(() => WebDavClient.ParseListing(Listing(Enumerable.Range(0, 1201).Select(i => "changes-" + i.ToString("x64") + ".json")))));
            Assert(Rejects(() => WebDavClient.ParseListing(Listing(new[] { name }, false, true))));
            var credentials = new SyncCredentials { Username = "synthetic", Password = "not-sent" };
            var cache = Path.Combine(Path.GetTempPath(), "salary-sync-cache-test-" + Guid.NewGuid().ToString("N"));
            var deltaDownloads = 0;
            var legacyDownloads = 0;
            try
            {
                var handler = new Handler(request =>
                {
                    if (request.Method.Method == "PROPFIND")
                    {
                        Assert(request.RequestUri.AbsoluteUri == WebDavClient.FolderUrl && request.Headers.GetValues("Depth").Single() == "1");
                        return Reply(207, Listing(new[] { "", name, "archive-v1.json" }));
                    }
                    Assert(request.Method == HttpMethod.Get);
                    if (request.RequestUri.AbsoluteUri == WebDavClient.FileUrl) legacyDownloads++;
                    else { Assert(request.RequestUri.AbsoluteUri == WebDavClient.FolderUrl + name); deltaDownloads++; }
                    return Reply(200, content);
                });
                using (var dav = new WebDavClient(credentials, handler, cache))
                {
                    Assert(Files(await dav.PullAsync()).Count == 2);
                    Assert(Files(await dav.PullAsync()).Count == 2);
                    Assert(deltaDownloads == 1 && legacyDownloads == 2);
                    File.WriteAllText(Path.Combine(cache, name), "{}");
                    Assert(Files(await dav.PullAsync()).Count == 2 && deltaDownloads == 2 && legacyDownloads == 3);
                }
                var mismatch = new Handler(request => request.Method.Method == "PROPFIND" ? Reply(207, Listing(new[] { name })) : Reply(200, "{}"));
                using (var dav = new WebDavClient(credentials, mismatch)) Assert(await RejectsAsync(() => dav.PullAsync()));
                var missing = new Handler(request => Reply(404));
                using (var dav = new WebDavClient(credentials, missing)) Assert(Files(await dav.PullAsync()).Count == 0);
                var firstTime = new Handler(request => Reply(request.Method.Method == "PROPFIND" ? 409 : 404));
                using (var dav = new WebDavClient(credentials, firstTime)) Assert(Files(await dav.PullAsync()).Count == 0);
                foreach (var parentStatus in new[] { 200, 401, 409 })
                {
                    var notMissing = new Handler(request => Reply(request.Method.Method == "PROPFIND" ? 409 : parentStatus));
                    using (var dav = new WebDavClient(credentials, notMissing)) Assert(await RejectsAsync(() => dav.PullAsync()));
                }
                var oversized = new Handler(request => Reply(207, new string('x', 1024 * 1024 + 1)));
                using (var dav = new WebDavClient(credentials, oversized)) Assert(await RejectsAsync(() => dav.PullAsync()));
                var largeFiles = Enumerable.Range(0, 3).Select(i => "{\"synthetic\":\"" + new string('x', 6 * 1024 * 1024) + "\",\"index\":" + i + "}").ToDictionary(WebDavClient.NameFor, value => value);
                var totalLimit = new Handler(request => request.Method.Method == "PROPFIND" ? Reply(207, Listing(largeFiles.Keys)) : Reply(200, largeFiles[request.RequestUri.AbsoluteUri.Substring(WebDavClient.FolderUrl.Length)]));
                using (var dav = new WebDavClient(credentials, totalLimit)) Assert(await RejectsAsync(() => dav.PullAsync()));
                var stages = new List<string>();
                var published = new Handler(request =>
                {
                    stages.Add(request.Method.Method);
                    if (request.Method.Method == "MKCOL") return Reply(405);
                    Assert(request.RequestUri.AbsoluteUri == WebDavClient.FolderUrl + name && request.RequestUri.AbsoluteUri != WebDavClient.FileUrl);
                    if (request.Method == HttpMethod.Put) { Assert(request.Content.ReadAsStringAsync().Result == content && !request.Headers.Contains("If-Match") && !request.Headers.Contains("If-None-Match")); return Reply(201); }
                    Assert(request.Method == HttpMethod.Get); return Reply(200, content);
                });
                using (var dav = new WebDavClient(credentials, published, cache)) { await dav.PublishAsync(content); await dav.PublishAsync(content); }
                Assert(string.Join(",", stages) == "MKCOL,PUT,GET,MKCOL,PUT,GET");
                var badReadback = new Handler(request => Reply(request.Method.Method == "MKCOL" ? 405 : request.Method == HttpMethod.Put ? 201 : 200, "{}"));
                using (var dav = new WebDavClient(credentials, badReadback)) Assert(await RejectsAsync(() => dav.PublishAsync(content)));
            }
            finally { if (Directory.Exists(cache)) Directory.Delete(cache, true); }
            Console.WriteLine("snapshot-self-test=pass;checks=listing,path-boundary,dtd-rejection,limits,hash,cache-reuse,cache-corruption,legacy-reread,missing-folder,repeat-publish,readback");
        }
        private static List<Dictionary<string, object>> Files(Dictionary<string, object> result) { return (List<Dictionary<string, object>>)result["files"]; }
        private static string Listing(IEnumerable<string> names, bool absolute = false, bool collection = false)
        {
            XNamespace dav = "DAV:";
            return new XDocument(new XElement(dav + "multistatus", names.Select(name =>
                new XElement(dav + "response", new XElement(dav + "href", absolute ? name : "/dav/SalaryTrail/" + name),
                    new XElement(dav + "propstat", new XElement(dav + "prop", new XElement(dav + "resourcetype", collection || name.Length == 0 ? new XElement(dav + "collection") : null)), new XElement(dav + "status", "HTTP/1.1 200 OK")))))).ToString();
        }
        private static HttpResponseMessage Reply(int status, string content = "") { return new HttpResponseMessage((HttpStatusCode)status) { Content = new StringContent(content, Encoding.UTF8, "application/json") }; }
        private static void Assert(bool value) { if (!value) throw new Exception("snapshot_test_failed"); }
        private static bool Rejects(Action action) { try { action(); return false; } catch (UserError) { return true; } }
        private static async Task<bool> RejectsAsync(Func<Task<Dictionary<string, object>>> action) { try { await action(); return false; } catch (UserError) { return true; } }
        private sealed class Handler : HttpMessageHandler
        {
            private readonly Func<HttpRequestMessage, HttpResponseMessage> respond;
            public Handler(Func<HttpRequestMessage, HttpResponseMessage> respond) { this.respond = respond; }
            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) { return Task.FromResult(respond(request)); }
        }
    }
}
