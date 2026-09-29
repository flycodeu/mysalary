using System;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace SalaryDesktop
{
    internal static class ReleaseSelfTests
    {
        internal static async Task RunAsync()
        {
            const string root = "https://github.com/flycodeu/mysalary/releases";
            foreach (var url in new[] { root, root + "/latest", root + "/tag/v0.4.0", root + "/download/v0.4.0/salary-0.4.0-windows-setup.exe", root + "/download/v0.4.0/salary-0.4.0-debug.apk" }) Assert(ReleaseClient.IsReleaseUrl(url));
            foreach (var url in new[] { (string)null, root + "?redirect=evil", root + "/tag/v0.4.0\n", root + "/tag/v0.4.0#unsafe", root + "/download/v0.4.0/salary-0.5.0-debug.apk", root + "/download/v0.4.0/../../evil.exe", "http://github.com/flycodeu/mysalary/releases", "https://github.com.evil.test/flycodeu/mysalary/releases", "https://user@github.com/flycodeu/mysalary/releases", "file:///tmp/unsafe", "javascript:alert(1)" }) Assert(!ReleaseClient.IsReleaseUrl(url));
            foreach (var status in new[] { 200, 404, 302, 403, 429, 500 })
            {
                var handler = new PublicHandler(status, "{\"tag_name\":\"v0.4.0\"}");
                using (var client = new ReleaseClient(handler))
                {
                    var result = await client.CheckAsync();
                    Assert((int)result["status"] == status);
                    Assert(status == 200 ? (string)result["content"] == "{\"tag_name\":\"v0.4.0\"}" : result["content"] == null);
                    Assert(handler.Count == 1);
                }
            }
            using (var client = new ReleaseClient(new PublicHandler(200, new string('x', ReleaseClient.MaxBytes + 1))))
            {
                var rejected = false;
                try { await client.CheckAsync(); } catch (UserError) { rejected = true; }
                Assert(rejected);
            }
        }
        private static void Assert(bool condition) { if (!condition) throw new Exception("release_test_failed"); }
        private sealed class PublicHandler : HttpMessageHandler
        {
            private readonly int status;
            private readonly string body;
            internal int Count;
            internal PublicHandler(int status, string body) { this.status = status; this.body = body; }
            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
            {
                Count++;
                Assert(request.RequestUri.AbsoluteUri == ReleaseClient.LatestUrl && request.Method == HttpMethod.Get);
                Assert(request.Headers.Authorization == null && !request.Headers.Contains("Cookie"));
                return Task.FromResult(new HttpResponseMessage((HttpStatusCode)status) { Content = new StringContent(body, Encoding.UTF8, "application/json") });
            }
        }
    }
}
