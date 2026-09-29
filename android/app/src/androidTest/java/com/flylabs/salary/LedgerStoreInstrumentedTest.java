package com.flylabs.salary;

import android.content.Context;
import android.content.ContextWrapper;
import android.util.AtomicFile;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public class LedgerStoreInstrumentedTest {
    private File testFiles;
    private Context testContext;
    private LedgerStore ledger;
    private SyncCredentialStore credentials;
    private static final String EMPTY = "{\"format\":\"salary-archive\",\"version\":1,\"entries\":[]}";

    @Before
    public void setUp() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        testFiles = new File(context.getCacheDir(), "ledger-test-" + UUID.randomUUID());
        testContext = new ContextWrapper(context) { @Override public File getFilesDir() { return testFiles; } };
        ledger = new LedgerStore(testContext);
        credentials = new SyncCredentialStore(testContext, "salary-test-" + UUID.randomUUID());
    }

    @After
    public void tearDown() throws Exception { credentials.clear(); remove(testFiles); }

    @Test
    public void firstLoadIsEmptyAndNextSaveKeepsThePreviousLedger() throws Exception {
        assertNull(ledger.load());
        ledger.save(EMPTY);
        String next = new JSONObject(EMPTY).put("revision", "synthetic-v2").toString();
        ledger.save(next);
        assertEquals(next, new LedgerStore(testContext).load());
        assertEquals(EMPTY, LedgerStore.read(new AtomicFile(new File(testFiles, "salary-ledger/archive-v1.previous.json"))));
    }

    @Test
    public void unsupportedVersionCannotReplaceExistingLedger() throws Exception {
        ledger.save(EMPTY);
        try { ledger.save(new JSONObject(EMPTY).put("version", 2).toString()); fail("Unknown version accepted"); }
        catch (ImportStore.UserInputException expected) { }
        assertEquals(EMPTY, ledger.load());
    }

    @Test
    public void missingPrimaryWithExistingBackupIsNotTreatedAsFirstLaunch() throws Exception {
        ledger.save(EMPTY);
        ledger.save(new JSONObject(EMPTY).put("revision", "synthetic-v2").toString());
        new AtomicFile(new File(testFiles, "salary-ledger/archive-v1.json")).delete();
        try { ledger.load(); fail("Missing primary ignored an existing backup"); }
        catch (ImportStore.UserInputException expected) { }
        assertEquals(EMPTY, LedgerStore.read(new AtomicFile(new File(testFiles, "salary-ledger/archive-v1.previous.json"))));
    }

    @Test
    public void corruptLedgerNeverSilentlyLoadsOrOverwritesItsBackup() throws Exception {
        ledger.save(EMPTY);
        ledger.save(new JSONObject(EMPTY).put("revision", "synthetic-v2").toString());
        LedgerStore.write(new AtomicFile(new File(testFiles, "salary-ledger/archive-v1.json")), "{damaged".getBytes(StandardCharsets.UTF_8));
        try { ledger.load(); fail("Damaged ledger loaded as empty"); }
        catch (ImportStore.UserInputException expected) { }
        try { ledger.save(EMPTY); fail("Damaged ledger overwritten without recovery"); }
        catch (ImportStore.UserInputException expected) { }
        assertEquals(EMPTY, LedgerStore.read(new AtomicFile(new File(testFiles, "salary-ledger/archive-v1.previous.json"))));
    }

    @Test
    public void pendingFileSurvivesRestartUntilLedgerIsSavedAndAcknowledged() throws Exception {
        JSONObject pending = ledger.pending(EMPTY);
        String id = pending.getString("pendingId");
        LedgerStore reopened = new LedgerStore(testContext);
        assertEquals(id, reopened.listPending().getJSONObject(0).getString("pendingId"));
        assertEquals(EMPTY, reopened.listPending().getJSONObject(0).getString("content"));
        try { reopened.acknowledge(id); fail("Uncommitted import acknowledged"); }
        catch (ImportStore.UserInputException expected) { }
        reopened.save(EMPTY);
        reopened.acknowledge(id);
        assertEquals(0, reopened.listPending().length());
        reopened.acknowledge(id);
    }

    @Test
    public void explicitRestorePreservesCorruptSourceAndPreviousBackupBeforeReplacement() throws Exception {
        ledger.save(EMPTY);
        ledger.save(new JSONObject(EMPTY).put("revision", "synthetic-v2").toString());
        File root = new File(testFiles, "salary-ledger");
        LedgerStore.write(new AtomicFile(new File(root, "archive-v1.json")), "{damaged".getBytes(StandardCharsets.UTF_8));
        ledger.restore(EMPTY);
        assertEquals(EMPTY, ledger.load());
        assertEquals(EMPTY, LedgerStore.read(new AtomicFile(new File(root, "archive-v1.previous.json"))));
        File[] snapshots = root.listFiles((directory, name) -> name.startsWith("recovery-"));
        assertNotNull(snapshots);
        assertEquals(1, snapshots.length);
        assertEquals("{damaged", LedgerStore.read(new AtomicFile(new File(snapshots[0], "archive-v1.json"))));
        assertEquals(EMPTY, LedgerStore.read(new AtomicFile(new File(snapshots[0], "archive-v1.previous.json"))));
    }

    @Test
    public void keystoreCredentialsRoundTripWithoutPlaintextOnDiskAndClearDoesNotTouchLedger() throws Exception {
        assertNull(credentials.load());
        credentials.save("synthetic-account", "synthetic-app-password");
        assertEquals("synthetic-account", credentials.load().username);
        assertEquals("synthetic-app-password", credentials.load().password);
        String stored = LedgerStore.read(new AtomicFile(new File(testFiles, "salary-sync/credentials.enc.json")));
        assertFalse(stored.contains("synthetic-account"));
        assertFalse(stored.contains("synthetic-app-password"));
        ledger.save(EMPTY);
        credentials.clear();
        assertNull(credentials.load());
        assertEquals(EMPTY, ledger.load());
    }

    @Test
    public void tamperedEncryptedCredentialsAreRejected() throws Exception {
        credentials.save("synthetic-account", "synthetic-app-password");
        AtomicFile file = new AtomicFile(new File(testFiles, "salary-sync/credentials.enc.json"));
        JSONObject stored = new JSONObject(LedgerStore.read(file)).put("ciphertext", "AA==");
        LedgerStore.write(file, stored.toString().getBytes(StandardCharsets.UTF_8));
        try { credentials.load(); fail("Tampered credentials decrypted"); }
        catch (Exception expected) { }
    }

    @Test
    public void androidXmlParserReadsScopedDavListingAndRejectsDtd() throws Exception {
        String name = WebDavClient.deltaFileName(EMPTY.getBytes(StandardCharsets.UTF_8));
        String xml = "<d:multistatus xmlns:d='DAV:'><d:response><d:href>/dav/SalaryTrail/" + name
            + "</d:href><d:propstat><d:prop><d:resourcetype/></d:prop></d:propstat></d:response></d:multistatus>";
        assertEquals(name, WebDavListing.parse(xml).get(0));
        try {
            WebDavListing.parse("<!DOCTYPE d:multistatus SYSTEM 'file:///synthetic'>" + xml);
            fail("Android parser accepted external DTD");
        } catch (ImportStore.UserInputException expected) { }
    }

    private static void remove(File file) {
        if (file == null || !file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) for (File child : children) remove(child);
        assertTrue(file.delete());
    }
}
