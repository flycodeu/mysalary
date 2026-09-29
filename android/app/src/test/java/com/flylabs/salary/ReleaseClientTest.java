package com.flylabs.salary;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Protocol;
import okhttp3.Response;
import okhttp3.ResponseBody;
import org.junit.Test;
import java.io.IOException;
import static org.junit.Assert.*;

public class ReleaseClientTest {
    @Test
    public void onlyCanonicalRepositoryReleaseLinksCanOpen() {
        String root = "https://github.com/flycodeu/mysalary/releases";
        for (String url : new String[]{root, root + "/latest", root + "/tag/v0.4.0", root + "/download/v0.4.0/salary-0.4.0-windows-setup.exe", root + "/download/v0.4.0/salary-0.4.0-debug.apk"}) assertTrue(url, ReleaseClient.isReleaseUrl(url));
        for (String url : new String[]{null, root + "?redirect=evil", root + "/tag/v0.4.0\n", root + "/tag/v0.4.0#unsafe", root + "/download/v0.4.0/salary-0.5.0-debug.apk", root + "/download/v0.4.0/../../evil.exe", "http://github.com/flycodeu/mysalary/releases", "https://github.com.evil.test/flycodeu/mysalary/releases", "https://user@github.com/flycodeu/mysalary/releases", "file:///tmp/unsafe", "javascript:alert(1)"}) assertFalse(url, ReleaseClient.isReleaseUrl(url));
    }

    @Test
    public void publicChecksUseFixedEndpointAndNeverCredentials() throws Exception {
        for (int status : new int[]{200, 404, 302, 403, 429, 500}) {
            ReleaseClient.Result result = client(status, "{\"tag_name\":\"v0.4.0\"}").check();
            assertEquals(status, result.status);
            assertEquals(status == 200 ? "{\"tag_name\":\"v0.4.0\"}" : null, result.content);
        }
    }

    @Test
    public void oversizedMetadataIsRejected() throws Exception {
        char[] content = new char[ReleaseClient.MAX_BYTES + 1];
        java.util.Arrays.fill(content, 'x');
        try { client(200, new String(content)).check(); fail("Oversized metadata accepted"); }
        catch (IOException expected) { }
    }

    private ReleaseClient client(int status, String content) {
        return new ReleaseClient(new OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).addInterceptor(chain -> {
            assertEquals(ReleaseClient.LATEST_URL, chain.request().url().toString());
            assertEquals("GET", chain.request().method());
            assertNull(chain.request().header("Authorization"));
            assertNull(chain.request().header("Cookie"));
            return new Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(status)
                .message("synthetic").body(ResponseBody.create(content, MediaType.get("application/json"))).build();
        }).build());
    }
}
