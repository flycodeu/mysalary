using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace SalaryDesktop
{
    internal static class WebDavEvidenceSelfTests
    {
        internal static async Task RunAsync()
        {
            // Keep the synthetic root short: .NET Framework file APIs retain MAX_PATH limits.
            var directory = Path.Combine("C:\\sal-evidence", "sync-" + Guid.NewGuid().ToString("N"));
            try
            {
                var original = Png();
                var store = new EvidenceStore(directory);
                var item = store.Add("ledger-test", original, "image/png");
                var id = (string)item["id"];
                var name = WebDavClient.EvidenceNameFor("ledger-test", id, "image/png");
                var list = WebDavClient.ParseEvidenceListing(Xml(Item(name) + Item("archive-v1.json")));
                Assert(list.Count == 1 && (string)list[0]["id"] == id && (string)list[0]["recordId"] == "ledger-test");
                Assert(WebDavClient.ParseListing(Xml(Item(name) + Item("archive-v1.json"))).SequenceEqual(new[] { "archive-v1.json" }));
                foreach (var entry in new[] { Item("https://evil.invalid/" + name), Item("../" + name), Item("%2e%2e/" + name), Item(name) + Item(name), Item(name).Replace("200 OK", "403 Forbidden") })
                    Assert(Rejects(() => WebDavClient.ParseEvidenceListing(Xml(entry))));
                Assert(Rejects(() => WebDavClient.EvidenceNameFor("../record", id, "image/png")));
                var credentials = new SyncCredentials { Username = "synthetic", Password = "synthetic-password" };
                var upload = new Handler((request, index) => {
                    if (index == 0) { Assert(request.Method.Method == "MKCOL"); return Reply(405); }
                    Assert(request.RequestUri.AbsoluteUri == WebDavClient.FolderUrl + name);
                    if (index == 1) return Reply(404);
                    if (index == 2) {
                        Assert(request.Method == HttpMethod.Put && request.Headers.GetValues("If-None-Match").Single() == "*");
                        Assert(request.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult().SequenceEqual(original));
                        return Reply(201);
                    }
                    Assert(index == 3 && request.Method == HttpMethod.Get);
                    return Reply(200, original);
                });
                using (var dav = new WebDavClient(credentials, upload)) await dav.PutEvidenceAsync(store, "ledger-test", id);
                Assert(upload.Count == 4);
                var existing = new Handler((request, index) => Reply(index == 0 ? 405 : 200, original));
                using (var dav = new WebDavClient(credentials, existing)) await dav.PutEvidenceAsync(store, "ledger-test", id);
                Assert(existing.Count == 2);
                var corrupt = new Handler((request, index) => Reply(index == 0 ? 405 : 200, new byte[] { 1 }));
                using (var dav = new WebDavClient(credentials, corrupt)) Assert(await RejectsAsync(() => dav.PutEvidenceAsync(store, "ledger-test", id)));
                Assert(corrupt.Count == 2 && store.ReadOriginal("ledger-test", id).Bytes.SequenceEqual(original));
                var downloadStore = new EvidenceStore(Path.Combine(directory, "download"));
                using (var dav = new WebDavClient(credentials, new Handler((request, index) => Reply(200, original))))
                    await dav.GetEvidenceAsync(downloadStore, "ledger-test", id, "image/png");
                Assert(downloadStore.ReadOriginal("ledger-test", id).Bytes.SequenceEqual(original));
                foreach (var status in new[] { 302, 307, 401, 403, 429 }) {
                    var failure = new Handler((request, index) => Reply(status));
                    using (var dav = new WebDavClient(credentials, failure)) Assert(await RejectsAsync(() => dav.GetEvidenceAsync(downloadStore, "ledger-test", id, "image/png")));
                    Assert(failure.Count == 1);
                }
                using (var dav = new WebDavClient(credentials, new Handler((request, index) => Reply(200, new byte[EvidenceStore.MaxBytes + 1]))))
                    Assert(await RejectsAsync(() => dav.GetEvidenceAsync(downloadStore, "ledger-test", id, "image/png")));
                using (var dav = new WebDavClient(credentials, new Handler((request, index) => Reply(200, new byte[] { 1 }))))
                    Assert(await RejectsAsync(() => dav.GetEvidenceAsync(downloadStore, "ledger-test", id, "image/png")));
                Assert(downloadStore.ReadOriginal("ledger-test", id).Bytes.SequenceEqual(original));
                Console.WriteLine("evidence-webdav-self-test=pass;checks=safe-listing,fixed-location,original-bytes,create-only,idempotence,conflict-preservation,download-hash,redirect-auth-rate-limit,size-limit,ledger-separation");
            }
            finally { if (Directory.Exists(directory)) Directory.Delete(directory, true); }
        }
        private static byte[] Png()
        {
            using (var image = new Bitmap(8, 8))
            using (var graphics = Graphics.FromImage(image))
            using (var output = new MemoryStream()) { graphics.Clear(Color.Teal); image.Save(output, ImageFormat.Png); return output.ToArray(); }
        }
        private static string Item(string href) { return "<d:response><d:href>" + href + "</d:href><d:propstat><d:prop><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"; }
        private static string Xml(string body) { return "<d:multistatus xmlns:d='DAV:'>" + body + "</d:multistatus>"; }
        private static HttpResponseMessage Reply(int status, byte[] bytes = null) { return new HttpResponseMessage((HttpStatusCode)status) { Content = new ByteArrayContent(bytes ?? new byte[0]) }; }
        private static bool Rejects(Action action) { try { action(); return false; } catch (UserError) { return true; } }
        private static async Task<bool> RejectsAsync(Func<Task> action) { try { await action(); return false; } catch (UserError) { return true; } }
        private static void Assert(bool value) { if (!value) throw new Exception("Evidence WebDAV test failed"); }
        private sealed class Handler : HttpMessageHandler
        {
            private readonly Func<HttpRequestMessage, int, HttpResponseMessage> responder;
            public int Count { get; private set; }
            internal Handler(Func<HttpRequestMessage, int, HttpResponseMessage> responder) { this.responder = responder; }
            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
            { return Task.FromResult(responder(request, Count++)); }
        }
    }
}
