package com.flylabs.salary;

import org.json.JSONObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Arrays;
import java.util.Base64;
import java.util.zip.CRC32;
import static org.junit.Assert.*;

public class EvidenceStoreTest {
    // Generated solid-color images contain no salary or other user data.
    private static final String PNG = "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAQSURBVBhXY2BoaPgPx8gcAJLVC/vCrA+JAAAAAElFTkSuQmCC";
    private static final String JPEG = "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAACAAMDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDxqiiivuz+VD//2Q==";
    @Rule public TemporaryFolder temporary = new TemporaryFolder();

    @Test public void originalsSurviveRestartAndDuplicateAddIsIdempotent() throws Exception {
        File root = temporary.newFolder();
        EvidenceStore store = new EvidenceStore(root);
        byte[] bytes = png();
        JSONObject first = store.add("ledger-record_1", bytes, "image/png");
        JSONObject again = store.add("ledger-record_1", bytes, "image/png");
        assertEquals(EvidenceStore.hash(bytes), first.getString("id"));
        assertEquals(first.getString("createdAt"), again.getString("createdAt"));
        assertEquals(3, first.getInt("width"));
        assertEquals(2, first.getInt("height"));
        assertEquals(bytes.length, first.getInt("sizeBytes"));
        EvidenceStore reopened = new EvidenceStore(root);
        assertEquals(1, reopened.list("ledger-record_1").length());
        assertArrayEquals(bytes, reopened.read("ledger-record_1", first.getString("id")).bytes);
        assertFalse(first.has("path"));
        assertFalse(first.has("uri"));
    }

    @Test public void pngAndJpegKeepOriginalBytesAndRequireMatchingMime() throws Exception {
        EvidenceStore store = new EvidenceStore(temporary.newFolder());
        byte[] bytes = Base64.getDecoder().decode(JPEG);
        JSONObject item = store.add("legacy-guid", bytes, "image/jpeg");
        assertEquals("image/jpeg", store.read("legacy-guid", item.getString("id")).mimeType);
        assertArrayEquals(bytes, store.read("legacy-guid", item.getString("id")).bytes);
        rejects(() -> store.add("legacy-guid", bytes, "image/png"));
        rejects(() -> store.add("legacy-guid", png(), "text/plain"));
    }

    @Test public void deletionRemovesOriginalAndPersistsMarkerAcrossRestart() throws Exception {
        File root = temporary.newFolder();
        EvidenceStore store = new EvidenceStore(root);
        byte[] original = png();
        String id = store.add("record", original, "image/png").getString("id");
        store.delete("record", id);
        EvidenceStore reopened = new EvidenceStore(root);
        assertEquals(0, reopened.list("record").length());
        assertEquals(id, reopened.listDeleted("record").getString(0));
        assertFalse(new File(recordDirectory(root, "record"), id + ".png").exists());
        rejects(() -> reopened.read("record", id));
        rejects(() -> reopened.add("record", original, "image/png"));
        reopened.delete("record", id);
        assertEquals(1, reopened.listDeleted("record").length());
    }

    @Test public void identifiersCannotTraverseAndRecordsDoNotShareMetadata() throws Exception {
        EvidenceStore store = new EvidenceStore(temporary.newFolder());
        for (String record : new String[]{"../../outside", "a/b", "a\\b", "", null, "a.b", "a ", new String(new char[97]).replace('\0', 'a')})
            rejects(() -> store.list(record));
        JSONObject lower = store.add("record-1", png(), "image/png");
        store.add("RECORD-1", png(), "image/png");
        store.add("CON", png(), "image/png");
        assertEquals(1, store.list("record-1").length());
        assertEquals(1, store.list("RECORD-1").length());
        assertEquals(1, store.list("CON").length());
        rejects(() -> store.read("unrelated", lower.getString("id")));
        rejects(() -> store.read("record-1", "../image"));
        rejects(() -> store.read("record-1", lower.getString("id").toUpperCase()));
    }

    @Test public void corruptionIsReportedWithoutOverwritingOriginalOrMetadata() throws Exception {
        File root = temporary.newFolder();
        EvidenceStore store = new EvidenceStore(root);
        JSONObject item = store.add("record", png(), "image/png");
        File directory = recordDirectory(root, "record");
        File original = new File(directory, item.getString("id") + ".png");
        byte[] corrupted = new byte[png().length];
        Files.write(original.toPath(), corrupted);
        rejects(() -> store.read("record", item.getString("id")));
        rejects(() -> store.add("record", png(), "image/png"));
        assertArrayEquals(corrupted, Files.readAllBytes(original.toPath()));
        assertTrue(new File(directory, item.getString("id") + ".json").isFile());
    }

    @Test public void interruptedMetadataWriteCanRecoverFromOriginalBytes() throws Exception {
        File root = temporary.newFolder();
        EvidenceStore store = new EvidenceStore(root);
        JSONObject first = store.add("record", png(), "image/png");
        File metadata = new File(recordDirectory(root, "record"), first.getString("id") + ".json");
        assertTrue(metadata.delete());
        assertEquals(0, store.list("record").length());
        JSONObject recovered = store.add("record", png(), "image/png");
        assertEquals(first.getString("id"), recovered.getString("id"));
        assertArrayEquals(png(), store.read("record", first.getString("id")).bytes);
    }

    @Test public void providerReadsAreBoundedAndTruncatedImagesAreRejected() throws Exception {
        assertArrayEquals(png(), EvidenceStore.readInput(new ByteArrayInputStream(png())));
        rejects(() -> EvidenceStore.readInput(new ByteArrayInputStream(new byte[0])));
        rejects(() -> EvidenceStore.readInput(new ByteArrayInputStream(new byte[EvidenceStore.MAX_BYTES + 1])));
        rejects(() -> EvidenceStore.inspect(Arrays.copyOf(png(), 40), "image/png"));
        byte[] jpeg = Base64.getDecoder().decode(JPEG);
        rejects(() -> EvidenceStore.inspect(Arrays.copyOf(jpeg, jpeg.length - 2), "image/jpeg"));
        byte[] crcMismatch = png();
        crcMismatch[crcMismatch.length - 17] ^= 1;
        rejects(() -> EvidenceStore.inspect(crcMismatch, "image/png"));
        rejects(() -> EvidenceStore.inspect(new byte[EvidenceStore.MAX_BYTES + 1], "image/png"));
    }

    @Test public void oversizedDimensionsAreRejectedBeforeImageDecoding() throws Exception {
        byte[] hugeWidth = png();
        write32(hugeWidth, 16, 32769);
        recalculateHeaderCrc(hugeWidth);
        rejects(() -> EvidenceStore.inspect(hugeWidth, "image/png"));
        byte[] hugeArea = png();
        write32(hugeArea, 16, 10000);
        write32(hugeArea, 20, 10000);
        recalculateHeaderCrc(hugeArea);
        rejects(() -> EvidenceStore.inspect(hugeArea, "image/png"));
    }

    @Test public void changingOrRemovingLedgerDoesNotTouchEvidence() throws Exception {
        File root = temporary.newFolder();
        EvidenceStore store = new EvidenceStore(root);
        JSONObject item = store.add("record", png(), "image/png");
        File ledger = new File(root, "archive-v1.json");
        try (FileOutputStream output = new FileOutputStream(ledger)) { output.write("{\"entries\":[]}".getBytes(StandardCharsets.UTF_8)); }
        assertTrue(ledger.delete());
        assertArrayEquals(png(), new EvidenceStore(root).read("record", item.getString("id")).bytes);
    }

    private static byte[] png() { return Base64.getDecoder().decode(PNG); }
    private static File recordDirectory(File root, String recordId) { return new File(new File(root, "evidence"), "record-" + EvidenceStore.hash(recordId.getBytes(StandardCharsets.UTF_8))); }
    private static void write32(byte[] bytes, int offset, long value) {
        bytes[offset] = (byte) (value >>> 24); bytes[offset + 1] = (byte) (value >>> 16); bytes[offset + 2] = (byte) (value >>> 8); bytes[offset + 3] = (byte) value;
    }
    private static void recalculateHeaderCrc(byte[] bytes) {
        CRC32 crc = new CRC32(); crc.update(bytes, 12, 17); write32(bytes, 29, crc.getValue());
    }
    private interface Action { void run() throws Exception; }
    private static void rejects(Action action) throws Exception {
        try { action.run(); fail("Invalid evidence accepted"); } catch (ImportStore.UserInputException expected) { }
    }
}
