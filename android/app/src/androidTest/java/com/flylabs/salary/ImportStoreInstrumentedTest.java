package com.flylabs.salary;

import android.content.Context;
import android.content.ContextWrapper;
import android.content.Intent;
import android.content.ClipData;
import android.app.Activity;
import android.net.Uri;
import androidx.activity.result.ActivityResult;
import android.graphics.Bitmap;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.File;
import java.io.ByteArrayInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import static org.junit.Assert.*;

/** Synthetic sources only. Each test uses a separate cache directory, never the user's archive. */
@RunWith(AndroidJUnit4.class)
public class ImportStoreInstrumentedTest {
    private File testFiles;
    private ImportStore store;

    @Before
    public void setUp() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        testFiles = new File(context.getCacheDir(), "import-test-" + UUID.randomUUID());
        store = new ImportStore(new ContextWrapper(context) {
            @Override public File getFilesDir() { return testFiles; }
        });
    }

    @After
    public void tearDown() { removeTestFiles(testFiles); }

    @Test
    public void damagedMetadataDoesNotHideAnotherOriginal() throws Exception {
        String broken = createDirectory();
        write(new File(directory(broken), "item.json"), "{broken");
        String healthy = createDirectory();
        createImage(new File(directory(healthy), "original.image"));
        JSONArray items = store.list();
        assertEquals(2, items.length());
        assertEquals("error", find(items, broken).getString("status"));
        assertEquals("complete", find(items, healthy).getString("copyState"));
    }

    @Test
    public void completeOriginalWithMissingMetadataCanBeRecovered() throws Exception {
        String id = createDirectory();
        createImage(new File(directory(id), "original.image"));
        JSONObject item = store.list().getJSONObject(0);
        assertEquals(id, item.getString("id"));
        assertEquals("complete", item.getString("copyState"));
        assertTrue(new File(directory(id), "preview.png").isFile());
        assertEquals("error", item.getString("status"));
        assertTrue(item.getString("error").contains("重新整理"));
    }

    @Test
    public void partialCopyCannotBecomeAReviewedSalary() throws Exception {
        String id = createDirectory();
        write(new File(directory(id), "original.part"), "partial");
        JSONObject item = store.list().getJSONObject(0);
        assertEquals("copying", item.getString("copyState"));
        try {
            store.saveDraft(id, new JSONObject().put("reviewStatus", "reviewed"));
            fail("Incomplete originals must not be saved as reviewed");
        } catch (ImportStore.UserInputException expected) {
            assertTrue(new File(directory(id), "original.part").isFile());
        }
    }

    @Test
    public void emptyCrashDirectoryDoesNotCreateAFalseRecord() throws Exception {
        createDirectory();
        assertEquals(0, store.list().length());
    }

    @Test
    public void deleteAndRestorePreserveOriginalOcrAndDraftAcrossStoreRestart() throws Exception {
        String id = createDirectory();
        File original = new File(directory(id), "original.image");
        createImage(original);
        store.list();
        store.saveOcr(id, new JSONObject().put("engine", "synthetic"));
        store.saveDraft(id, new JSONObject().put("reviewStatus", "reviewed").put("statedNetMinor", 12345));
        long bytes = original.length();
        String deletedAt = store.deleteImport(id).getString("deletedAt");
        assertEquals(deletedAt, store.deleteImport(id).getString("deletedAt"));
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        ImportStore reopened = new ImportStore(new ContextWrapper(context) {
            @Override public File getFilesDir() { return testFiles; }
        });
        assertTrue(find(reopened.list(), id).has("deletedAt"));
        JSONObject restored = reopened.restoreImport(id);
        assertFalse(restored.has("deletedAt"));
        assertEquals("reviewed", restored.getString("status"));
        assertEquals(12345, restored.getJSONObject("draft").getInt("statedNetMinor"));
        assertEquals("synthetic", restored.getJSONObject("ocr").getString("engine"));
        assertEquals(bytes, reopened.original(id).length());
        assertFalse(reopened.restoreImport(id).has("deletedAt"));
    }

    @Test
    public void aLateSaveOrOcrResultCannotReviveDeletedArchive() throws Exception {
        String id = createDirectory();
        createImage(new File(directory(id), "original.image"));
        store.list();
        store.deleteImport(id);
        try {
            store.saveDraft(id, new JSONObject().put("reviewStatus", "reviewed"));
            fail("A late draft must not revive a deleted archive");
        } catch (ImportStore.UserInputException expected) { }
        try {
            store.saveOcr(id, new JSONObject().put("engine", "synthetic"));
            fail("A late OCR result must not revive a deleted archive");
        } catch (ImportStore.UserInputException expected) { }
        store.recordOcrError(id, "synthetic failure");
        assertTrue(find(store.list(), id).has("deletedAt"));
        assertTrue(new File(directory(id), "original.image").isFile());
    }

    @Test
    public void captureSplitsMonthsIntoDurableIndependentArchives() throws Exception {
        JSONObject pack = syntheticPackage();
        JSONObject second = new JSONObject(pack.getJSONArray("records").getJSONObject(0).toString()).put("payrollMonth", "2026-08");
        pack.getJSONArray("records").put(second);
        JSONArray imported = importPackage(pack);
        assertEquals(2, imported.length());
        String firstId = imported.getJSONObject(0).getString("id");
        String secondId = imported.getJSONObject(1).getString("id");
        assertNotEquals(firstId, secondId);
        assertEquals("feishu-text", imported.getJSONObject(0).getString("sourceKind"));
        assertEquals(1, new JSONObject(imported.getJSONObject(0).getString("captureJson")).getJSONArray("records").length());
        assertTrue(new File(directory(firstId), "original.salary.json").isFile());
        assertFalse(new File(directory(firstId), "original.image").exists());
        store.saveDraft(firstId, new JSONObject().put("reviewStatus", "reviewed").put("statedNetMinor", 90000));
        store.deleteImport(firstId);
        assertTrue(find(store.list(), firstId).has("deletedAt"));
        assertFalse(find(store.list(), secondId).has("deletedAt"));
        assertEquals(90000, store.restoreImport(firstId).getJSONObject("draft").getInt("statedNetMinor"));
    }

    @Test
    public void repeatedCaptureIgnoresTimestampAndRestoresTheExistingDraft() throws Exception {
        JSONObject pack = syntheticPackage();
        String id = importPackage(pack).getJSONObject(0).getString("id");
        store.saveDraft(id, new JSONObject().put("reviewStatus", "reviewed").put("statedNetMinor", 90000));
        store.deleteImport(id);
        pack.getJSONObject("source").put("capturedAt", "2026-09-29T10:00:00.000Z");
        JSONObject repeated = importPackage(pack).getJSONObject(0);
        assertEquals(id, repeated.getString("id"));
        assertFalse(repeated.has("deletedAt"));
        assertEquals(90000, repeated.getJSONObject("draft").getInt("statedNetMinor"));
        assertEquals(1, store.list().length());
    }

    @Test
    public void changedSalaryForSameMonthPreservesBothVersions() throws Exception {
        JSONObject pack = syntheticPackage();
        String first = importPackage(pack).getJSONObject(0).getString("id");
        pack.getJSONArray("records").getJSONObject(0).getJSONArray("fields").getJSONObject(2).put("amountText", "1100.00");
        String changed = importPackage(pack).getJSONObject(0).getString("id");
        assertNotEquals(first, changed);
        assertEquals(2, store.list().length());
    }

    @Test
    public void reimportAfterTruncatedSourceCreatesHealthyArchiveAndPreservesTheDamagedOne() throws Exception {
        JSONObject pack = syntheticPackage();
        String damagedId = importPackage(pack).getJSONObject(0).getString("id");
        File damagedSource = new File(directory(damagedId), "original.salary.json");
        write(damagedSource, "{truncated");
        JSONObject restored = importPackage(pack).getJSONObject(0);
        assertNotEquals(damagedId, restored.getString("id"));
        assertEquals(1, CapturePackage.parse(restored.getString("captureJson")).getJSONArray("records").length());
        assertEquals(2, store.list().length());
        assertEquals("{truncated".getBytes(StandardCharsets.UTF_8).length, damagedSource.length());
        assertEquals(restored.getString("id"), importPackage(pack).getJSONObject(0).getString("id"));
        assertEquals(2, store.list().length());
    }

    @Test
    public void reimportChecksSourceContentInsteadOfTrustingTheSavedHash() throws Exception {
        JSONObject pack = syntheticPackage();
        String damagedId = importPackage(pack).getJSONObject(0).getString("id");
        JSONObject changedSource = syntheticPackage();
        changedSource.getJSONArray("records").getJSONObject(0).getJSONArray("fields").getJSONObject(2).put("amountText", "2000.00");
        File damagedSource = new File(directory(damagedId), "original.salary.json");
        write(damagedSource, changedSource.toString());
        long preservedLength = damagedSource.length();
        JSONObject restored = importPackage(pack).getJSONObject(0);
        assertNotEquals(damagedId, restored.getString("id"));
        JSONObject restoredPack = CapturePackage.parse(restored.getString("captureJson"));
        assertEquals("1000.00", restoredPack.getJSONArray("records").getJSONObject(0).getJSONArray("fields").getJSONObject(2).getString("amountText"));
        assertEquals(2, store.list().length());
        assertEquals(preservedLength, damagedSource.length());
    }

    @Test
    public void deletedCaptureRejectsLateDraftAndCanBeReadAfterRestart() throws Exception {
        String id = importPackage(syntheticPackage()).getJSONObject(0).getString("id");
        store.deleteImport(id);
        try {
            store.saveDraft(id, new JSONObject().put("reviewStatus", "reviewed"));
            fail("Late capture draft revived a deleted month");
        } catch (ImportStore.UserInputException expected) { }
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        ImportStore reopened = new ImportStore(new ContextWrapper(context) {
            @Override public File getFilesDir() { return testFiles; }
        });
        JSONObject restored = reopened.restoreImport(id);
        assertEquals("feishu-text", restored.getString("sourceKind"));
        assertEquals("2026-09", new JSONObject(restored.getString("captureJson")).getJSONArray("records").getJSONObject(0).getString("payrollMonth"));
    }

    @Test
    public void malformedPackagePreservesReceivedBytesWithoutCreatingSalary() throws Exception {
        byte[] bytes = "{invalid-json".getBytes(StandardCharsets.UTF_8);
        try {
            store.importCapture(new ByteArrayInputStream(bytes), "invalid.salary.json");
            fail("Malformed package accepted");
        } catch (ImportStore.UserInputException expected) { }
        assertEquals(0, store.list().length());
        File[] preserved = new File(new File(testFiles, "salary-imports"), "capture-inbox").listFiles();
        assertNotNull(preserved);
        assertEquals(1, preserved.length);
        assertEquals(bytes.length, preserved[0].length());
    }

    @Test
    public void missingTotalsAndDuplicateMonthCannotBecomePartialArchives() throws Exception {
        JSONObject pack = syntheticPackage();
        pack.getJSONArray("records").put(pack.getJSONArray("records").getJSONObject(0));
        try { importPackage(pack); fail("Duplicate month accepted"); }
        catch (ImportStore.UserInputException expected) { }
        assertEquals(0, store.list().length());
        pack = syntheticPackage();
        pack.getJSONArray("records").getJSONObject(0).getJSONArray("fields").getJSONObject(0).put("label", "其他奖金");
        try { importPackage(pack); fail("Missing total accepted"); }
        catch (ImportStore.UserInputException expected) { }
        assertEquals(0, store.list().length());
    }

    @Test
    public void metadataRecoveryRecognizesTextSourceAndDoesNotCreateAnImagePreview() throws Exception {
        String id = importPackage(syntheticPackage()).getJSONObject(0).getString("id");
        write(new File(directory(id), "item.json"), "{broken");
        JSONObject recovered = find(store.list(), id);
        assertEquals("feishu-text", recovered.getString("sourceKind"));
        assertEquals("complete", recovered.getString("copyState"));
        assertTrue(recovered.has("captureJson"));
        assertFalse(new File(directory(id), "preview.png").exists());
    }

    @Test
    public void cancelledPickerAndShareVariantsUseOnlyExplicitContentUris() {
        Uri uri = Uri.parse("content://synthetic/month.salary.json");
        Intent selected = new Intent().setData(uri);
        assertNull(SalaryNativePlugin.selectedUri(new ActivityResult(Activity.RESULT_CANCELED, selected)));
        assertNull(SalaryNativePlugin.selectedUri(new ActivityResult(Activity.RESULT_OK, null)));
        assertEquals(uri, SalaryNativePlugin.selectedUri(new ActivityResult(Activity.RESULT_OK, selected)));
        assertEquals(uri, SalaryNativePlugin.sharedUri(new Intent(Intent.ACTION_VIEW).setData(uri)));
        assertEquals(uri, SalaryNativePlugin.sharedUri(new Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_STREAM, uri)));
        Intent clip = new Intent(Intent.ACTION_SEND);
        clip.setClipData(ClipData.newRawUri("synthetic salary", uri));
        assertEquals(uri, SalaryNativePlugin.sharedUri(clip));
        assertNull(SalaryNativePlugin.sharedUri(new Intent(Intent.ACTION_MAIN).setData(uri)));
    }

    private JSONArray importPackage(JSONObject pack) throws Exception {
        return store.importCapture(new ByteArrayInputStream(pack.toString().getBytes(StandardCharsets.UTF_8)), "synthetic.salary.json");
    }

    private static JSONObject syntheticPackage() throws Exception {
        JSONArray fields = new JSONArray().put(new JSONObject().put("label", "应发工资").put("amountText", "1000.00"))
            .put(new JSONObject().put("label", "实发工资").put("amountText", "900.00"))
            .put(new JSONObject().put("label", "岗位（基本）薪水").put("amountText", "1000.00"))
            .put(new JSONObject().put("label", "个得税（计算）").put("amountText", "100.00"));
        return new JSONObject().put("format", "salary-capture").put("version", 1)
            .put("source", new JSONObject().put("kind", "feishu-text").put("page", "https://hr.hmifo.com/test/#/wages")
                .put("capturedAt", "2026-09-28T10:00:00.000Z"))
            .put("records", new JSONArray().put(new JSONObject().put("payrollMonth", "2026-09").put("fields", fields)));
    }

    private String createDirectory() {
        String id = UUID.randomUUID().toString();
        assertTrue(directory(id).mkdirs());
        return id;
    }

    private File directory(String id) { return new File(new File(testFiles, "salary-imports"), id); }

    private static JSONObject find(JSONArray items, String id) throws Exception {
        for (int i = 0; i < items.length(); i++) if (id.equals(items.getJSONObject(i).getString("id"))) return items.getJSONObject(i);
        throw new AssertionError("Missing test item");
    }

    private static void createImage(File file) throws Exception {
        Bitmap image = Bitmap.createBitmap(32, 64, Bitmap.Config.ARGB_8888);
        try (FileOutputStream output = new FileOutputStream(file)) { assertTrue(image.compress(Bitmap.CompressFormat.PNG, 100, output)); }
        finally { image.recycle(); }
    }

    private static void write(File file, String value) throws Exception {
        try (FileOutputStream output = new FileOutputStream(file)) { output.write(value.getBytes(StandardCharsets.UTF_8)); }
    }

    private static void removeTestFiles(File file) {
        if (file == null || !file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) for (File child : children) removeTestFiles(child);
        assertTrue(file.delete());
    }
}
