package com.flylabs.salary;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Protocol;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;
import org.junit.Test;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import static org.junit.Assert.*;

public class WebDavDeltaTest {
    private static final String CONTENT = "{\"format\":\"salary-archive\",\"version\":1,\"entries\":[]}";

    @Test
    public void pullReadsOnlyKnownNamesAndVerifiesDeltaBytes() throws Exception {
        byte[] bytes = utf8(CONTENT);
        String name = WebDavClient.deltaFileName(bytes);
        List<Request> requests = new ArrayList<>();
        String xml = listing(response(WebDavClient.DIRECTORY, true) + response(WebDavClient.DIRECTORY + "notes.txt", false)
            + response(WebDavClient.DIRECTORY + name, false) + response(WebDavClient.DIRECTORY + "archive-v1.json", false));
        List<WebDavClient.RemoteFile> result = client(requests, wire(207, xml), wire(200, CONTENT), wire(200, CONTENT))
            .pull("synthetic", "synthetic-password");
        assertEquals(2, result.size());
        assertEquals("archive-v1.json", result.get(0).name);
        assertEquals(name, result.get(1).name);
        assertEquals(CONTENT, result.get(1).content);
        assertEquals("PROPFIND", requests.get(0).method());
        assertEquals("1", requests.get(0).header("Depth"));
        assertEquals(3, requests.size());
        assertEquals(WebDavClient.DIRECTORY + name, requests.get(2).url().toString());
    }

    @Test
    public void missingDirectoryAndConfirmedConflictReturnEmpty() throws Exception {
        assertTrue(client(new ArrayList<>(), wire(404, "")).pull("synthetic", "synthetic-password").isEmpty());
        List<Request> requests = new ArrayList<>();
        assertTrue(client(requests, wire(409, ""), wire(404, "")).pull("synthetic", "synthetic-password").isEmpty());
        assertEquals("GET", requests.get(1).method());
        assertEquals(WebDavClient.DIRECTORY, requests.get(1).url().toString());
        try { client(new ArrayList<>(), wire(409, ""), wire(200, "")).pull("synthetic", "synthetic-password"); fail("Existing directory treated as absent"); }
        catch (ImportStore.UserInputException expected) { assertTrue(expected.getMessage().contains("409")); }
    }

    @Test
    public void publishUsesOnlyTheContentHashPathAndVerifiesByReadingItBack() throws Exception {
        byte[] bytes = utf8(CONTENT);
        String name = WebDavClient.deltaFileName(bytes);
        List<Request> requests = new ArrayList<>();
        WebDavClient client = client(requests, wire(201, ""), wire(201, ""), wire(200, CONTENT),
            wire(405, ""), wire(204, ""), wire(200, CONTENT));
        client.publish(bytes, "synthetic", "synthetic-password");
        client.publish(bytes, "synthetic", "synthetic-password");
        assertEquals(6, requests.size());
        for (int position : new int[]{1, 4}) {
            Request publish = requests.get(position);
            assertEquals("PUT", publish.method());
            assertEquals(WebDavClient.DIRECTORY + name, publish.url().toString());
            assertNull(publish.header("If-Match"));
            assertNull(publish.header("If-None-Match"));
            assertEquals("GET", requests.get(position + 1).method());
            assertEquals(publish.url(), requests.get(position + 1).url());
        }
    }

    @Test
    public void publishDoesNotReportSuccessWhenReadbackDiffers() throws Exception {
        try { client(new ArrayList<>(), wire(405, ""), wire(204, ""), wire(200, CONTENT + " "))
            .publish(utf8(CONTENT), "synthetic", "synthetic-password"); fail("Different readback accepted"); }
        catch (ImportStore.UserInputException expected) { assertTrue(expected.getMessage().contains("校验")); }
    }

    @Test
    public void wrongDeltaDigestStopsThePull() throws Exception {
        String name = WebDavClient.deltaFileName(utf8(CONTENT));
        try { client(new ArrayList<>(), wire(207, listing(response(WebDavClient.DIRECTORY + name, false))), wire(200, CONTENT + " "))
            .pull("synthetic", "synthetic-password"); fail("Hash mismatch accepted"); }
        catch (ImportStore.UserInputException expected) { assertTrue(expected.getMessage().contains("校验")); }
    }

    @Test
    public void dtdAndExternalEntityDefinitionsAreRejectedBeforeAnyDownload() throws Exception {
        List<Request> requests = new ArrayList<>();
        String xml = "<!DOCTYPE d:multistatus [<!ENTITY source SYSTEM 'file:///private'>]>"
            + "<d:multistatus xmlns:d='DAV:'><d:response><d:href>&source;</d:href></d:response></d:multistatus>";
        try { client(requests, wire(207, xml)).pull("synthetic", "synthetic-password"); fail("DTD accepted"); }
        catch (ImportStore.UserInputException expected) { }
        assertEquals(1, requests.size());
    }

    @Test
    public void crossDomainNestedTraversalAndUntrustedUrlPartsAreRejected() throws Exception {
        for (String href : new String[]{"https://untrusted.invalid/dav/SalaryTrail/notes.txt",
            "http://dav.jianguoyun.com/dav/SalaryTrail/notes.txt", "https://dav.jianguoyun.com:444/dav/SalaryTrail/notes.txt",
            "/dav/SalaryTrail/../notes.txt", "/dav/SalaryTrail/%2e%2e/notes.txt", "/dav/SalaryTrail/nested/notes.txt",
            "/dav/Other/notes.txt", "/dav/SalaryTrail/notes.txt?token=synthetic", "/dav/SalaryTrail/notes.txt#fragment",
            "https://synthetic@dav.jianguoyun.com/dav/SalaryTrail/notes.txt", "/dav/SalaryTrail/name%2fnested.txt"}) {
            try { WebDavListing.parse(listing(response(href, false))); fail("Unsafe href accepted"); }
            catch (ImportStore.UserInputException expected) { }
        }
    }

    @Test
    public void knownNamesCannotBeCollectionsAndUnknownSameLevelNamesAreIgnored() throws Exception {
        try { WebDavListing.parse(listing(response("/dav/SalaryTrail/archive-v1.json", true))); fail("Archive collection accepted"); }
        catch (ImportStore.UserInputException expected) { }
        assertTrue(WebDavListing.parse(listing(response("/dav/SalaryTrail/unknown/", true)
            + response("/dav/SalaryTrail/readme.txt", false))).isEmpty());
    }

    @Test
    public void tooManyDeltaFilesRejectsTheWholeListingWithoutTruncating() throws Exception {
        StringBuilder responses = new StringBuilder();
        for (int i = 0; i <= WebDavListing.MAX_DELTAS; i++) {
            responses.append(response(WebDavClient.DIRECTORY + "changes-" + String.format(java.util.Locale.ROOT, "%064x", i) + ".json", false));
        }
        List<Request> requests = new ArrayList<>();
        try { client(requests, wire(207, listing(responses.toString()))).pull("synthetic", "synthetic-password"); fail("Excessive files truncated"); }
        catch (ImportStore.UserInputException expected) { assertTrue(expected.getMessage().contains("1200")); }
        assertEquals(1, requests.size());
    }

    @Test
    public void listingAndIndividualFileLimitsRejectOversizedResponses() throws Exception {
        try { client(new ArrayList<>(), new Wire(207, new byte[WebDavListing.MAX_BYTES + 1])).pull("synthetic", "synthetic-password"); fail("Oversized listing accepted"); }
        catch (ImportStore.UserInputException expected) { }
        String name = WebDavClient.deltaFileName(utf8(CONTENT));
        try { client(new ArrayList<>(), wire(207, listing(response(WebDavClient.DIRECTORY + name, false))), new Wire(200, new byte[LedgerFile.MAX_BYTES + 1]))
            .pull("synthetic", "synthetic-password"); fail("Oversized file accepted"); }
        catch (ImportStore.UserInputException expected) { }
    }

    @Test
    public void combinedFileLimitFailsInsteadOfReturningAPartialLedger() throws Exception {
        List<byte[]> bytes = new ArrayList<>();
        StringBuilder responses = new StringBuilder();
        java.util.TreeMap<String, byte[]> sorted = new java.util.TreeMap<>();
        for (int i = 0; i < 3; i++) {
            byte[] value = new byte[6 * 1024 * 1024];
            Arrays.fill(value, (byte) ('a' + i));
            sorted.put(WebDavClient.deltaFileName(value), value);
        }
        for (java.util.Map.Entry<String, byte[]> item : sorted.entrySet()) {
            responses.append(response(WebDavClient.DIRECTORY + item.getKey(), false));
            bytes.add(item.getValue());
        }
        try { client(new ArrayList<>(), wire(207, listing(responses.toString())), new Wire(200, bytes.get(0)),
            new Wire(200, bytes.get(1)), new Wire(200, bytes.get(2))).pull("synthetic", "synthetic-password"); fail("Partial ledger returned"); }
        catch (ImportStore.UserInputException expected) { assertTrue(expected.getMessage().contains("16 MiB")); }
    }

    private static String listing(String responses) { return "<d:multistatus xmlns:d='DAV:'>" + responses + "</d:multistatus>"; }
    private static String response(String href, boolean collection) {
        return "<d:response><d:href>" + href + "</d:href><d:propstat><d:prop><d:resourcetype>"
            + (collection ? "<d:collection/>" : "") + "</d:resourcetype></d:prop></d:propstat></d:response>";
    }
    private static byte[] utf8(String value) { return value.getBytes(StandardCharsets.UTF_8); }
    private static Wire wire(int status, String content) { return new Wire(status, utf8(content)); }
    private static final class Wire {
        final int status;
        final byte[] bytes;
        Wire(int status, byte[] bytes) { this.status = status; this.bytes = bytes; }
    }
    private static WebDavClient client(List<Request> requests, Wire... responses) {
        return new WebDavClient(new OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).addInterceptor(chain -> {
            int index = requests.size();
            requests.add(chain.request());
            if (index >= responses.length) throw new IOException("Unexpected additional request");
            Wire response = responses[index];
            return new Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(response.status)
                .message("synthetic").body(ResponseBody.create(response.bytes, MediaType.get("application/octet-stream"))).build();
        }).build());
    }
}
