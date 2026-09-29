package com.flylabs.salary;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Protocol;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okio.Buffer;
import org.junit.Test;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import static org.junit.Assert.*;

public class WebDavEvidenceTest {
    private static final byte[] PNG = Base64.getDecoder().decode("iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAQSURBVBhXY2BoaPgPx8gcAJLVC/vCrA+JAAAAAElFTkSuQmCC");
    private static final String ID = EvidenceStore.hash(PNG);
    private static final String RECORD = "ledger-" + ID;
    private static final String NAME = "evidence-" + RECORD + "-" + ID + ".png";
    private static final String DELETED = "evidence-deleted-" + RECORD + "-" + ID + ".txt";

    @Test public void listingExtractsOnlySafeOriginalNamesWithMatchingFields() throws Exception {
        List<Request> requests = new ArrayList<>();
        byte[] listing = xml(item("/dav/SalaryTrail/" + NAME) + item("archive-v1.json") + item("notes.txt"));
        List<WebDavClient.RemoteEvidence> items = client(requests, new int[]{207}, listing).listEvidence("synthetic", "password");
        assertEquals(1, items.size()); assertEquals(RECORD, items.get(0).recordId); assertEquals(ID, items.get(0).id);
        assertEquals("image/png", items.get(0).mimeType);
        assertEquals("PROPFIND", requests.get(0).method()); assertEquals("1", requests.get(0).header("Depth"));
        assertTrue(WebDavListing.parse(new String(listing, StandardCharsets.UTF_8)).contains("archive-v1.json"));
        assertFalse(WebDavListing.parse(new String(listing, StandardCharsets.UTF_8)).contains(NAME));
    }

    @Test public void unsafeDuplicateAndUnreadableListingsCannotSelectAnOutsideUrl() throws Exception {
        String[] invalid = {item("https://evil.invalid/" + NAME), item("../" + NAME), item("%2e%2e/" + NAME),
            item(NAME) + item(NAME), item(NAME).replace("200 OK", "403 Forbidden"),
            item(NAME).replace("<d:resourcetype/>", "<d:resourcetype><d:collection/></d:resourcetype>")};
        for (String content : invalid) rejects(() -> WebDavListing.parseEvidence(new String(xml(content), StandardCharsets.UTF_8)));
        rejects(() -> WebDavListing.parseEvidence("<!DOCTYPE x><d:multistatus xmlns:d='DAV:'/>") );
    }

    @Test public void deletionMarkersAreListedAndCloudImageIsRemovedOnlyAfterVerifiedMarker() throws Exception {
        List<Request> listingRequests = new ArrayList<>();
        List<WebDavClient.RemoteDeletion> deleted = client(listingRequests, new int[]{207}, xml(item(DELETED) + item(NAME)))
            .listDeletedEvidence("synthetic", "password");
        assertEquals(1, deleted.size()); assertEquals(RECORD, deleted.get(0).recordId); assertEquals(ID, deleted.get(0).id);
        rejects(() -> WebDavListing.parseEvidenceDeleted(new String(xml(item(DELETED) + item(DELETED)), StandardCharsets.UTF_8)));

        byte[] marker = "deleted-v1\n".getBytes(StandardCharsets.UTF_8);
        List<Request> publish = new ArrayList<>();
        client(publish, new int[]{405, 404, 201, 200}, empty(), empty(), empty(), marker)
            .putEvidenceDeletion(RECORD, ID, "synthetic", "password");
        assertEquals("MKCOL", publish.get(0).method());
        assertEquals("PUT", publish.get(2).method());
        assertEquals("*", publish.get(2).header("If-None-Match"));
        List<Request> remove = new ArrayList<>();
        client(remove, new int[]{200, 204}, marker, empty())
            .deleteEvidence(RECORD, ID, "image/png", "synthetic", "password");
        assertEquals(WebDavClient.DIRECTORY + DELETED, remove.get(0).url().toString());
        assertEquals(WebDavClient.DIRECTORY + NAME, remove.get(1).url().toString());
        assertEquals("DELETE", remove.get(1).method());
        rejects(() -> client(new ArrayList<>(), new int[]{404}, empty())
            .deleteEvidence(RECORD, ID, "image/png", "synthetic", "password"));
    }

    @Test public void downloadKeepsExactBytesAndValidatesContentHashAndMime() throws Exception {
        List<Request> requests = new ArrayList<>();
        assertArrayEquals(PNG, client(requests, new int[]{200}, PNG).getEvidence(RECORD, ID, "image/png", "synthetic", "password"));
        assertEquals(WebDavClient.DIRECTORY + NAME, requests.get(0).url().toString());
        rejects(() -> client(new ArrayList<>(), new int[]{200}, new byte[]{1, 2}).getEvidence(RECORD, ID, "image/png", "synthetic", "password"));
        rejects(() -> client(new ArrayList<>(), new int[]{200}, PNG).getEvidence(RECORD, ID, "image/jpeg", "synthetic", "password"));
    }

    @Test public void invalidArgumentsMakeNoRequest() throws Exception {
        List<Request> requests = new ArrayList<>();
        WebDavClient dav = client(requests, new int[0]);
        rejects(() -> dav.getEvidence("../record", ID, "image/png", "synthetic", "password"));
        rejects(() -> dav.getEvidence(RECORD, "../outside", "image/png", "synthetic", "password"));
        rejects(() -> dav.getEvidence(RECORD, ID, "text/plain", "synthetic", "password"));
        assertTrue(requests.isEmpty());
    }

    @Test public void uploadIsCreateOnlyAndVerifiedByReadBack() throws Exception {
        List<Request> requests = new ArrayList<>();
        client(requests, new int[]{405, 404, 201, 200}, empty(), empty(), empty(), PNG)
            .putEvidence(RECORD, ID, new EvidenceStore.ReadResult(PNG, "image/png"), "synthetic", "password");
        assertEquals(4, requests.size()); assertEquals("MKCOL", requests.get(0).method());
        assertEquals("PUT", requests.get(2).method()); assertEquals("*", requests.get(2).header("If-None-Match"));
        Buffer body = new Buffer(); requests.get(2).body().writeTo(body); assertArrayEquals(PNG, body.readByteArray());
        assertEquals("GET", requests.get(3).method());
        for (Request request : requests) assertTrue(request.url().toString().startsWith(WebDavClient.DIRECTORY));
    }

    @Test public void repeatedAndRacingUploadsNeverOverwriteAnExistingOriginal() throws Exception {
        List<Request> requests = new ArrayList<>();
        client(requests, new int[]{405, 200}, empty(), PNG).putEvidence(RECORD, ID, new EvidenceStore.ReadResult(PNG, "image/png"), "synthetic", "password");
        assertEquals(2, requests.size());
        List<Request> race = new ArrayList<>();
        client(race, new int[]{405, 404, 412, 200}, empty(), empty(), empty(), PNG)
            .putEvidence(RECORD, ID, new EvidenceStore.ReadResult(PNG, "image/png"), "synthetic", "password");
        assertEquals(4, race.size());
        List<Request> corrupt = new ArrayList<>();
        rejects(() -> client(corrupt, new int[]{405, 200}, empty(), new byte[]{1})
            .putEvidence(RECORD, ID, new EvidenceStore.ReadResult(PNG, "image/png"), "synthetic", "password"));
        assertEquals(2, corrupt.size()); assertEquals("GET", corrupt.get(1).method());
    }

    @Test public void failedReadBackIsNotReportedAsSuccess() throws Exception {
        rejects(() -> client(new ArrayList<>(), new int[]{201, 404, 201, 200}, empty(), empty(), empty(), new byte[]{1})
            .putEvidence(RECORD, ID, new EvidenceStore.ReadResult(PNG, "image/png"), "synthetic", "password"));
    }

    @Test public void redirectsAuthAndRateLimitStopWithoutFollowingLocation() throws Exception {
        for (int status : new int[]{302, 307, 401, 403, 429}) {
            List<Request> requests = new ArrayList<>();
            rejects(() -> client(requests, new int[]{status}, empty()).getEvidence(RECORD, ID, "image/png", "synthetic", "password"));
            assertEquals(1, requests.size());
        }
    }

    @Test public void listingRequiresConfirmedMissingParent() throws Exception {
        assertTrue(client(new ArrayList<>(), new int[]{404}, empty()).listEvidence("synthetic", "password").isEmpty());
        assertTrue(client(new ArrayList<>(), new int[]{409, 404}, empty(), empty()).listEvidence("synthetic", "password").isEmpty());
        rejects(() -> client(new ArrayList<>(), new int[]{409, 200}, empty(), empty()).listEvidence("synthetic", "password"));
    }

    @Test public void downloadedImagesAndListingsAreBounded() throws Exception {
        rejects(() -> client(new ArrayList<>(), new int[]{200}, new byte[EvidenceStore.MAX_BYTES + 1]).getEvidence(RECORD, ID, "image/png", "synthetic", "password"));
        rejects(() -> client(new ArrayList<>(), new int[]{200}, empty()).getEvidence(RECORD, ID, "image/png", "synthetic", "password"));
        rejects(() -> client(new ArrayList<>(), new int[]{207}, new byte[WebDavListing.MAX_BYTES + 1]).listEvidence("synthetic", "password"));
    }

    private static String item(String href) { return "<d:response><d:href>" + href + "</d:href><d:propstat><d:prop><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"; }
    private static byte[] xml(String content) { return ("<d:multistatus xmlns:d='DAV:'>" + content + "</d:multistatus>").getBytes(StandardCharsets.UTF_8); }
    private static byte[] empty() { return new byte[0]; }
    private static WebDavClient client(List<Request> requests, int[] statuses, byte[]... bodies) {
        return new WebDavClient(new OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).addInterceptor(chain -> {
            int index = requests.size(); requests.add(chain.request());
            if (index >= statuses.length) throw new IOException("Unexpected request");
            return new Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(statuses[index]).message("synthetic")
                .header("Location", "https://evil.invalid/").body(ResponseBody.create(bodies[index], MediaType.get("application/octet-stream"))).build();
        }).build());
    }
    private interface Action { void run() throws Exception; }
    private static void rejects(Action action) throws Exception {
        try { action.run(); fail("Unsafe evidence sync accepted"); } catch (ImportStore.UserInputException expected) { assertFalse(expected.getMessage().contains("password")); }
    }
}
