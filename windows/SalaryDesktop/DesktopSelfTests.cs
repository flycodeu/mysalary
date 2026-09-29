using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace SalaryDesktop
{
    internal static class DesktopSelfTests
    {
        public static int Run()
        {
            try
            {
                if (SalaryCollector.SelfTests.Run() != 0) throw new Exception();
                Storage();
                Protocol().GetAwaiter().GetResult();
                SnapshotSelfTests.RunAsync().GetAwaiter().GetResult();
                ReleaseSelfTests.RunAsync().GetAwaiter().GetResult();
                Assert(DesktopForm.IsAppOrigin("https://salary.local/index.html") && !DesktopForm.IsAppOrigin("http://salary.local/index.html") && !DesktopForm.IsAppOrigin("https://salary.local.evil.test") && !DesktopForm.IsAppOrigin("https://salary.local:444") && !DesktopForm.IsAppOrigin("https://user@salary.local"));
                Console.WriteLine("desktop-self-test=pass;checks=atomic-ledger,corruption-stop,backup-retention,explicit-restore,restore-copy-failure,size-limit,dpapi,credential-clear,origin,webdav-404,missing-parent-409,existing-parent-409,conditional-create,conditional-update,weak-etag,conflict,redirect,auth,rate-limit,response-limit");
                return 0;
            }
            catch (Exception) { Console.WriteLine("desktop-self-test=fail"); return 1; }
        }
        private static void Storage()
        {
            var directory = Path.Combine(Path.GetTempPath(), "salary-desktop-tests-" + Guid.NewGuid().ToString("N"));
            try
            {
                var store = new LocalStore(directory);
                Assert(store.LoadLedger() == null);
                store.SaveLedger("{\"version\":1}");
                store.SaveLedger("{\"version\":2}");
                Assert(store.LoadLedger() == "{\"version\":2}" && File.ReadAllText(Path.Combine(directory, "archive-v1.json.bak")) == "{\"version\":1}");
                File.WriteAllText(Path.Combine(directory, "archive-v1.json"), "invalid");
                Assert(Rejects(() => store.LoadLedger()) && File.ReadAllText(Path.Combine(directory, "archive-v1.json.bak")) == "{\"version\":1}");
                File.Delete(Path.Combine(directory, "archive-v1.json"));
                Assert(Rejects(() => store.LoadLedger()));
                File.WriteAllText(Path.Combine(directory, "archive-v1.json"), "corrupt-primary");
                const string emptyArchive = "{\"format\":\"salary-archive\",\"version\":1,\"entries\":[]}";
                Assert(Rejects(() => store.RestoreLedger("{}")) && File.ReadAllText(Path.Combine(directory, "archive-v1.json")) == "corrupt-primary");
                store.RestoreLedger(emptyArchive);
                var preserved = Directory.GetDirectories(Path.Combine(directory, "Recovery")).Single();
                Assert(store.LoadLedger() == emptyArchive && File.ReadAllText(Path.Combine(preserved, "archive-v1.json")) == "corrupt-primary" && File.ReadAllText(Path.Combine(preserved, "archive-v1.json.bak")) == "{\"version\":1}");
                using (var lockedBackup = new FileStream(Path.Combine(directory, "archive-v1.json.bak"), FileMode.Open, FileAccess.Read, FileShare.None))
                {
                    var aborted = false;
                    try { store.RestoreLedger(emptyArchive); }
                    catch (IOException) { aborted = true; }
                    Assert(aborted && File.ReadAllText(Path.Combine(directory, "archive-v1.json")) == emptyArchive);
                }
                Assert(Rejects(() => store.SaveLedger(new string('x', JsonData.MaxBytes + 1))));
                store.SaveCredentials("synthetic@example.invalid", "synthetic-password");
                var raw = File.ReadAllBytes(Path.Combine(directory, "sync-credentials.bin"));
                Assert(!Encoding.UTF8.GetString(raw).Contains("synthetic-password"));
                var credentials = store.ReadCredentials();
                Assert(credentials.Username == "synthetic@example.invalid" && credentials.Password == "synthetic-password");
                Assert(Rejects(() => store.SaveCredentials("invalid:username", "test")));
                store.ClearCredentials();
                Assert(store.ReadCredentials() == null);
                store.SaveSource("{\"format\":\"synthetic-test\"}");
                Assert(Directory.GetFiles(Path.Combine(directory, "Sources")).Length == 1);
            }
            finally { if (Directory.Exists(directory)) Directory.Delete(directory, true); }
        }
        private static async Task Protocol()
        {
            var credential = new SyncCredentials { Username = "synthetic", Password = "never-sent" };
            var missing = new MockHandler((request, index) => Reply(404));
            using (var dav = new WebDavClient(credential, missing)) Assert((bool)(await dav.GetAsync())["missing"]);
            Assert(missing.Urls.All(url => url == WebDavClient.FileUrl));
            var missingParent = new MockHandler((request, index) =>
            {
                Assert(request.Method == HttpMethod.Get && request.RequestUri.AbsoluteUri == (index == 0 ? WebDavClient.FileUrl : WebDavClient.FolderUrl));
                return Reply(index == 0 ? 409 : 404);
            });
            using (var dav = new WebDavClient(credential, missingParent)) Assert((bool)(await dav.GetAsync())["missing"]);
            Assert(missingParent.Count == 2);
            foreach (var parentStatus in new[] { 200, 409, 401, 403, 302, 429, 500 })
            {
                var parentExistsOrUnknown = new MockHandler((request, index) => Reply(index == 0 ? 409 : parentStatus));
                using (var dav = new WebDavClient(credential, parentExistsOrUnknown)) Assert(await RejectsAsync(() => dav.GetAsync()));
                Assert(parentExistsOrUnknown.Count == 2);
            }
            var create = new MockHandler((request, index) =>
            {
                if (index == 0) { Assert(request.Method.Method == "MKCOL" && request.RequestUri.AbsoluteUri == WebDavClient.FolderUrl); return Reply(201); }
                Assert(request.Method == HttpMethod.Put && request.Headers.GetValues("If-None-Match").Single() == "*" && !request.Headers.Contains("If-Match"));
                return Reply(201, null, "\"new\"");
            });
            using (var dav = new WebDavClient(credential, create)) Assert((string)(await dav.PutAsync("{}", null, true))["etag"] == "\"new\"");
            var update = new MockHandler((request, index) =>
            {
                if (index == 0) return Reply(405);
                Assert(request.Headers.GetValues("If-Match").Single() == "\"known\"" && !request.Headers.Contains("If-None-Match"));
                return Reply(412);
            });
            using (var dav = new WebDavClient(credential, update)) Assert((bool)(await dav.PutAsync("{}", "\"known\"", false))["conflict"]);
            var weak = new MockHandler((request, index) => Reply(200, "{}", "W/\"weak\""));
            using (var dav = new WebDavClient(credential, weak))
            {
                Assert(!(await dav.GetAsync()).ContainsKey("etag"));
                var requests = weak.Count;
                Assert(await RejectsAsync(() => dav.PutAsync("{}", "W/\"weak\"", false)) && weak.Count == requests);
            }
            foreach (var status in new[] { 301, 302, 307, 401, 403, 429, 500 })
            {
                var failure = new MockHandler((request, index) => Reply(status));
                using (var dav = new WebDavClient(credential, failure)) Assert(await RejectsAsync(() => dav.GetAsync()));
                Assert(failure.Count == 1);
            }
            var tooLarge = new MockHandler((request, index) => Reply(200, new string('x', JsonData.MaxBytes + 1)));
            using (var dav = new WebDavClient(credential, tooLarge)) Assert(await RejectsAsync(() => dav.GetAsync()));
            var folderMissing = new MockHandler((request, index) => Reply(404));
            using (var dav = new WebDavClient(credential, folderMissing)) Assert(await RejectsAsync(() => dav.PutAsync("{}", null, true)));
            Assert(folderMissing.Count == 1);
            Assert(WebDavClient.IsStrongEtag("\"abc\"") && !WebDavClient.IsStrongEtag("W/\"abc\"") && !WebDavClient.IsStrongEtag("\"bad\r\nvalue\""));
        }
        private static HttpResponseMessage Reply(int status, string content = null, string etag = null)
        {
            var response = new HttpResponseMessage((HttpStatusCode)status) { Content = new StringContent(content ?? "", Encoding.UTF8, "application/json") };
            if (etag != null) response.Headers.TryAddWithoutValidation("ETag", etag);
            return response;
        }
        private static void Assert(bool condition) { if (!condition) throw new Exception("test_failed"); }
        private static bool Rejects(Action action) { try { action(); return false; } catch (UserError) { return true; } }
        private static async Task<bool> RejectsAsync(Func<Task<Dictionary<string, object>>> action) { try { await action(); return false; } catch (UserError) { return true; } }
        private sealed class MockHandler : HttpMessageHandler
        {
            private readonly Func<HttpRequestMessage, int, HttpResponseMessage> responder;
            public readonly List<string> Urls = new List<string>();
            public int Count;
            public MockHandler(Func<HttpRequestMessage, int, HttpResponseMessage> responder) { this.responder = responder; }
            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
            {
                Assert(request.Headers.Authorization != null && request.Headers.Authorization.Scheme == "Basic");
                Urls.Add(request.RequestUri.AbsoluteUri);
                return Task.FromResult(responder(request, Count++));
            }
        }
    }
}
