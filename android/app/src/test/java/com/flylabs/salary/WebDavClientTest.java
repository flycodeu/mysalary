package com.flylabs.salary;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Protocol;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;
import org.junit.Test;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import static org.junit.Assert.*;

public class WebDavClientTest {
    @Test
    public void newArchiveUsesCreateOnlyConditionAndFixedLocation() throws Exception {
        List<Request> requests = new ArrayList<>();
        WebDavClient client = client(requests, new int[]{201, 201}, new String[]{null, "\"v1\""});
        WebDavClient.Result result = client.put("{}".getBytes(StandardCharsets.UTF_8), null, true, "synthetic", "synthetic-password");
        assertEquals("MKCOL", requests.get(0).method());
        assertEquals(WebDavClient.DIRECTORY, requests.get(0).url().toString());
        assertEquals(WebDavClient.ARCHIVE, requests.get(1).url().toString());
        assertEquals("*", requests.get(1).header("If-None-Match"));
        assertNull(requests.get(1).header("If-Match"));
        assertEquals("\"v1\"", result.etag);
    }

    @Test
    public void updateKeepsStrongVersionAndReportsPreconditionConflict() throws Exception {
        List<Request> requests = new ArrayList<>();
        WebDavClient client = client(requests, new int[]{405, 412}, new String[]{null, null});
        assertTrue(client.put("{}".getBytes(StandardCharsets.UTF_8), "\"v1\"", false, "synthetic", "synthetic-password").conflict);
        assertEquals("\"v1\"", requests.get(1).header("If-Match"));
        assertNull(requests.get(1).header("If-None-Match"));
        assertEquals(2, requests.size());
    }

    @Test
    public void missingOrWeakUpdateVersionCannotIssueAnyRequest() throws Exception {
        List<Request> requests = new ArrayList<>();
        WebDavClient client = client(requests, new int[]{201}, new String[]{null});
        for (String etag : new String[]{null, "W/\"v1\"", "*", "\"bad\r\nheader\""}) {
            try { client.put(new byte[]{1}, etag, false, "synthetic", "synthetic-password"); fail("Unsafe update accepted"); }
            catch (ImportStore.UserInputException expected) { }
        }
        assertEquals(0, requests.size());
    }

    @Test
    public void readDistinguishesMissingAndImportsContentWithoutAWriteVersion() throws Exception {
        assertTrue(client(new ArrayList<>(), new int[]{404}, new String[]{null}).get("synthetic", "synthetic-password").missing);
        for (String etag : new String[]{null, "W/\"v1\"", "invalid"}) {
            List<Request> requests = new ArrayList<>();
            WebDavClient client = client(requests, new int[]{200}, new String[]{etag});
            WebDavClient.Result result = client.get("synthetic", "synthetic-password");
            assertEquals("{}", result.content);
            assertNull(result.etag);
            assertFalse(result.missing);
            try { client.put(new byte[]{1}, result.etag, false, "synthetic", "synthetic-password"); fail("Read without a version enabled an unsafe update"); }
            catch (ImportStore.UserInputException expected) { }
            assertEquals(1, requests.size());
        }
        WebDavClient.Result strong = client(new ArrayList<>(), new int[]{200}, new String[]{"\"v1\""}).get("synthetic", "synthetic-password");
        assertEquals("{}", strong.content);
        assertEquals("\"v1\"", strong.etag);
    }

    @Test
    public void duplicateVersionHeadersDoNotProduceAWriteToken() throws Exception {
        WebDavClient client = new WebDavClient(new OkHttpClient.Builder().addInterceptor(chain ->
            new Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1)
                .code(200).message("synthetic").addHeader("ETag", "\"v1\"").addHeader("ETag", "\"v2\"")
                .body(ResponseBody.create("{}", MediaType.get("application/json"))).build()).build());
        WebDavClient.Result result = client.get("synthetic", "synthetic-password");
        assertEquals("{}", result.content);
        assertNull(result.etag);
    }

    @Test
    public void fileConflictWithMissingParentAllowsOnlyTheExistingConditionalCreationFlow() throws Exception {
        List<Request> requests = new ArrayList<>();
        WebDavClient client = client(requests, new int[]{409, 404, 201, 201}, new String[]{null, null, null, "\"v1\""});
        assertTrue(client.get("synthetic", "synthetic-password").missing);
        assertEquals(2, requests.size());
        assertEquals("GET", requests.get(0).method());
        assertEquals(WebDavClient.ARCHIVE, requests.get(0).url().toString());
        assertEquals("GET", requests.get(1).method());
        assertEquals(WebDavClient.DIRECTORY, requests.get(1).url().toString());
        client.put("{}".getBytes(StandardCharsets.UTF_8), null, true, "synthetic", "synthetic-password");
        assertEquals("MKCOL", requests.get(2).method());
        assertEquals("PUT", requests.get(3).method());
        assertEquals("*", requests.get(3).header("If-None-Match"));
        assertNull(requests.get(3).header("If-Match"));
    }

    @Test
    public void fileConflictDoesNotTreatExistingOrInaccessibleParentAsMissing() throws Exception {
        for (int parentStatus : new int[]{200, 204, 207, 409, 401, 403, 500, 307}) {
            List<Request> requests = new ArrayList<>();
            WebDavClient client = client(requests, new int[]{409, parentStatus}, new String[]{null, null});
            try { client.get("synthetic", "synthetic-password"); fail("Unconfirmed absence accepted"); }
            catch (ImportStore.UserInputException expected) {
                assertTrue(expected.getMessage().contains("HTTP " + (parentStatus >= 300 ? parentStatus : 409)));
                assertFalse(expected.getMessage().contains("synthetic-password"));
            }
            assertEquals(2, requests.size());
            for (Request request : requests) assertEquals("GET", request.method());
        }
    }

    @Test
    public void otherFileErrorsDoNotProbeOrCreateTheParent() throws Exception {
        List<Request> requests = new ArrayList<>();
        try { client(requests, new int[]{400}, new String[]{null}).get("synthetic", "synthetic-password"); fail("File error accepted"); }
        catch (ImportStore.UserInputException expected) { assertTrue(expected.getMessage().contains("HTTP 400")); }
        assertEquals(1, requests.size());
    }

    @Test
    public void authenticationRateLimitsAndRedirectsDoNotReachPut() throws Exception {
        for (int status : new int[]{401, 403, 429, 302, 307}) {
            List<Request> requests = new ArrayList<>();
            try {
                client(requests, new int[]{status}, new String[]{null}).put(new byte[]{1}, null, true, "synthetic", "synthetic-password");
                fail("Server rejection accepted");
            } catch (ImportStore.UserInputException expected) {
                assertFalse(expected.getMessage().contains("synthetic-password"));
                assertEquals(1, requests.size());
            }
        }
    }

    @Test
    public void byteLimitsApplyToUtf8AndStreamingInput() throws Exception {
        assertEquals(LedgerFile.MAX_BYTES, LedgerFile.read(new ByteArrayInputStream(new byte[LedgerFile.MAX_BYTES])).length);
        try { LedgerFile.read(new ByteArrayInputStream(new byte[LedgerFile.MAX_BYTES + 1])); fail("Oversized stream accepted"); }
        catch (ImportStore.UserInputException expected) { }
        StringBuilder value = new StringBuilder();
        for (int i = 0; i <= LedgerFile.MAX_BYTES / 3; i++) value.append('薪');
        try { LedgerFile.bytes(value.toString()); fail("Oversized UTF-8 accepted"); }
        catch (ImportStore.UserInputException expected) { }
    }

    private static WebDavClient client(List<Request> requests, int[] statuses, String[] etags) {
        return new WebDavClient(new OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
            .addInterceptor(chain -> {
                int index = requests.size();
                requests.add(chain.request());
                if (index >= statuses.length) throw new IOException("Unexpected additional request");
                Response.Builder response = new Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1)
                    .code(statuses[index]).message("synthetic")
                    .body(ResponseBody.create("{}", MediaType.get("application/json")));
                if (etags[index] != null) response.header("ETag", etags[index]);
                if (statuses[index] >= 300 && statuses[index] < 400) response.header("Location", "https://untrusted.invalid/elsewhere");
                return response.build();
            }).build());
    }
}
