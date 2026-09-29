package com.flylabs.salary;

import org.junit.Test;

import static org.junit.Assert.*;

/** Pure contract tests keep the download verifier testable without a device or private salary data. */
public class UpdateDownloadManagerTest {
    private static final String ROOT = "https://github.com/flycodeu/mysalary/releases";
    private static final String DIGEST = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    @Test
    public void metadataRequiresExactOfficialApkAssetAndDigest() throws Exception {
        String content = release("salary-0.4.1-debug.apk", 1234, DIGEST,
            ROOT + "/download/v0.4.1/salary-0.4.1-debug.apk");
        UpdateDownloadManager.DownloadMetadata metadata = UpdateDownloadManager.parseMetadata(content, "0.4.1");
        assertEquals("0.4.1", metadata.version);
        assertEquals(1234, metadata.size);
        assertEquals(DIGEST, metadata.sha256);
        assertEquals(ROOT + "/download/v0.4.1/salary-0.4.1-debug.apk", metadata.url);
        for (String broken : new String[]{
            release("salary-0.4.1-windows-setup.exe", 1234, DIGEST, ROOT + "/download/v0.4.1/salary-0.4.1-windows-setup.exe"),
            release("salary-0.4.1-debug.apk", 0, DIGEST, ROOT + "/download/v0.4.1/salary-0.4.1-debug.apk"),
            release("salary-0.4.1-debug.apk", 1234, "sha256:not-a-digest", ROOT + "/download/v0.4.1/salary-0.4.1-debug.apk"),
            release("salary-0.4.1-debug.apk", 1234, DIGEST, "https://attacker.invalid/update.apk"),
            release("salary-0.4.1-debug.apk", 1234, DIGEST, ROOT + "/download/v0.4.0/salary-0.4.1-debug.apk")
        }) {
            try { UpdateDownloadManager.parseMetadata(broken, "0.4.1"); fail("unsafe metadata accepted"); }
            catch (Exception expected) { }
        }
    }

    @Test
    public void metadataRejectsDraftPrereleaseWrongTagAndVersion() throws Exception {
        for (String value : new String[]{
            releaseWithFlags(true, false), releaseWithFlags(false, true), releaseTag("v0.4.0"), releaseTag("latest")
        }) {
            try { UpdateDownloadManager.parseMetadata(value, "0.4.1"); fail("invalid release accepted"); }
            catch (Exception expected) { }
        }
        try { UpdateDownloadManager.parseMetadata(release("salary-0.4.1-debug.apk", 10, DIGEST, ROOT + "/download/v0.4.1/salary-0.4.1-debug.apk"), "0.4.1-rc1"); fail("channel version accepted"); }
        catch (Exception expected) { }
    }

    @Test
    public void redirectsAreLimitedToHttpsGithubCdnHosts() {
        assertTrue(UpdateDownloadManager.isAllowedRedirect("https://objects.githubusercontent.com/github-production-release-asset-2e65be/abc?X-Amz-Signature=x"));
        assertTrue(UpdateDownloadManager.isAllowedRedirect("https://release-assets.githubusercontent.com/github-production-release-asset/abc?token=x"));
        assertFalse(UpdateDownloadManager.isAllowedRedirect("http://objects.githubusercontent.com/asset"));
        assertFalse(UpdateDownloadManager.isAllowedRedirect("https://attacker.example/asset"));
        assertFalse(UpdateDownloadManager.isAllowedRedirect("https://objects.githubusercontent.com/asset#redirect"));
        assertFalse(UpdateDownloadManager.isAllowedRedirect("https://user:password@objects.githubusercontent.com/asset"));
    }

    @Test
    public void cancellationStateIsIdleAndDoesNotExposePrivateDetails() {
        UpdateDownloadManager.DownloadState state = UpdateDownloadManager.DownloadState.idle();
        assertEquals("idle", state.state);
        assertNull(state.version);
        assertNull(state.error);
    }

    private static String release(String name, long size, String digest, String url) {
        return "{\"tag_name\":\"v0.4.1\",\"draft\":false,\"prerelease\":false,\"assets\":[{\"name\":\"" + name + "\",\"size\":" + size + ",\"digest\":\"sha256:" + digest + "\",\"browser_download_url\":\"" + url + "\"}]}";
    }
    private static String releaseWithFlags(boolean draft, boolean prerelease) { return "{\"tag_name\":\"v0.4.1\",\"draft\":" + draft + ",\"prerelease\":" + prerelease + ",\"assets\":[]}"; }
    private static String releaseTag(String tag) { return "{\"tag_name\":\"" + tag + "\",\"draft\":false,\"prerelease\":false,\"assets\":[]}"; }
}
