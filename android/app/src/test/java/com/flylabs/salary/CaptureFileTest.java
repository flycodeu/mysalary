package com.flylabs.salary;

import org.junit.Test;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import static org.junit.Assert.*;

public class CaptureFileTest {
    @Test
    public void byteLimitPreventsOversizedProviderContent() throws Exception {
        assertEquals(CaptureFile.MAX_BYTES, CaptureFile.readBytes(new ByteArrayInputStream(new byte[CaptureFile.MAX_BYTES])).length);
        try {
            CaptureFile.readBytes(new ByteArrayInputStream(new byte[CaptureFile.MAX_BYTES + 1]));
            fail("Oversized payload accepted");
        } catch (ImportStore.UserInputException expected) { }
    }

    @Test
    public void rejectsEmptyAndMalformedUtf8RatherThanReplacingAmounts() throws Exception {
        try {
            CaptureFile.readBytes(new ByteArrayInputStream(new byte[0]));
            fail("Empty payload accepted");
        } catch (ImportStore.UserInputException expected) { }
        try {
            CaptureFile.decode(new byte[]{(byte) 0xc3, (byte) 0x28});
            fail("Malformed UTF-8 accepted");
        } catch (ImportStore.UserInputException expected) { }
        assertEquals("{\"amountText\":\"-12.30\"}", CaptureFile.decode("\uFEFF{\"amountText\":\"-12.30\"}".getBytes(StandardCharsets.UTF_8)));
    }

    @Test
    public void mimeFallbackRequiresTheDedicatedFileExtension() {
        assertTrue(CaptureFile.accepts("application/json", "monthly.salary.json"));
        assertTrue(CaptureFile.accepts("text/plain; charset=utf-8", "monthly.salary.json"));
        assertTrue(CaptureFile.accepts("application/octet-stream", "MONTHLY.SALARY.JSON"));
        assertTrue(CaptureFile.accepts(null, "monthly.salary.json"));
        assertFalse(CaptureFile.accepts("application/octet-stream", "other.json"));
        assertFalse(CaptureFile.accepts("image/png", "monthly.salary.json"));
        assertFalse(CaptureFile.accepts(null, null));
    }

    @Test
    public void localIdsRejectTraversalAndPaths() {
        assertTrue(ImportStore.validId("13c6ec09-6efb-4f26-8b4a-f1d825b306f7"));
        assertFalse(ImportStore.validId("../../data/secret"));
        assertFalse(ImportStore.validId("file:///data/private.png"));
        assertFalse(ImportStore.validId(null));
    }

    @Test
    public void legacyPreviewSamplingRemainsBounded() {
        int sample = ImportStore.previewSample(1800, 100000);
        assertTrue((long) Math.ceil(1800.0 / sample) * Math.ceil(100000.0 / sample) <= 4L * 1024 * 1024);
        assertTrue(Math.ceil(100000.0 / sample) <= 8192);
        assertEquals(1, ImportStore.previewSample(1080, 2400));
    }
}
