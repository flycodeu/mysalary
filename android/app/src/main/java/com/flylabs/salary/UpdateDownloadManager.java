package com.flylabs.salary;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.SystemClock;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URI;
import java.net.URISyntaxException;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.CancellationException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Pattern;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okhttp3.Call;

/** Downloads only the exact APK described by the public latest release metadata. */
final class UpdateDownloadManager {
    static final long MAX_APK_BYTES = 64L * 1024L * 1024L;
    static final long MAX_METADATA_BYTES = 1024L * 1024L;
    static final long MAX_DURATION_MS = 5L * 60L * 1000L;
    private static final Pattern VERSION = Pattern.compile("\\d{1,6}\\.\\d{1,6}\\.\\d{1,6}");
    private static final Pattern SHA256 = Pattern.compile("[0-9a-fA-F]{64}");
    private static final String RELEASE_API = ReleaseClient.LATEST_URL;
    private static final String RELEASE_ROOT = "https://github.com/flycodeu/mysalary/releases";
    private static final String APK_PREFIX = "salary-";
    private static final String APK_SUFFIX = "-debug.apk";

    private final Context context;
    private final OkHttpClient client;
    private final Object lock = new Object();
    private final AtomicBoolean cancel = new AtomicBoolean(false);
    private volatile Call activeCall;
    private DownloadState state = DownloadState.idle();
    private String readyVersion;
    private File readyFile;

    UpdateDownloadManager(Context context, OkHttpClient client) {
        this.context = context.getApplicationContext();
        this.client = client.newBuilder()
            .followRedirects(true).followSslRedirects(true)
            .addNetworkInterceptor(chain -> {
                Response response = chain.proceed(chain.request());
                if (response.isRedirect()) {
                    String location = response.header("Location");
                    if (!isAllowedRedirect(location)) {
                        response.close();
                        throw new IOException("更新下载地址不受支持");
                    }
                }
                return response;
            }).build();
    }

    DownloadState status() {
        synchronized (lock) { return state; }
    }

    void cancel() {
        cancel.set(true);
        Call call = activeCall;
        if (call != null) call.cancel();
    }

    DownloadState download(String version) {
        if (!validVersion(version)) return fail("更新版本号无效");
        synchronized (lock) {
            if (state.state.equals("downloading") || state.state.equals("verifying")) return state;
            if ("ready".equals(state.state) && version.equals(state.version) && readyFile != null && readyFile.isFile()) return state;
            state = DownloadState.downloading(version, 0, 0);
        }
        cancel.set(false);
        try {
            throwIfCancelled();
            DownloadMetadata metadata = fetchMetadata(version);
            File directory = new File(context.getCacheDir(), "updates");
            if (!directory.exists() && !directory.mkdirs()) throw new IOException("update cache unavailable");
            File partial = new File(directory, "salary-" + version + ".apk.part");
            File target = new File(directory, "salary-" + version + ".apk");
            if (target.isFile()) target.delete();
            downloadApk(metadata, partial);
            setState(DownloadState.verifying(version, metadata.size));
            verifyApk(metadata, partial);
            if (!partial.renameTo(target)) {
                copyAtomically(partial, target);
                partial.delete();
            }
            synchronized (lock) {
                readyVersion = version;
                readyFile = target;
                state = DownloadState.ready(version, metadata.size);
                return state;
            }
        } catch (CancellationException cancelled) {
            cleanVersion(version);
            synchronized (lock) { state = DownloadState.idle(); return state; }
        } catch (Exception error) {
            cleanVersion(version);
            return fail(safeError(error));
        }
    }

    DownloadState downloadBlocking(String version) { return download(version); }

    File readyFile(String version) {
        synchronized (lock) { return "ready".equals(state.state) && version.equals(readyVersion) ? readyFile : null; }
    }

    private DownloadMetadata fetchMetadata(String version) throws Exception {
        throwIfCancelled();
        Request request = new Request.Builder().url(RELEASE_API).get()
            .header("User-Agent", "SalaryTrail/1.0").header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28").build();
        try (Response response = execute(request)) {
            if (response.code() != 200) throw new IOException("更新信息暂不可用");
            ResponseBody body = response.body();
            if (body == null || (body.contentLength() >= 0 && body.contentLength() > MAX_METADATA_BYTES)) throw new IOException("更新信息过大");
            String content = readUtf8Bounded(body.byteStream(), MAX_METADATA_BYTES);
            return parseMetadata(content, version);
        } finally { activeCall = null; }
    }

    private void downloadApk(DownloadMetadata metadata, File partial) throws Exception {
        Request request = new Request.Builder().url(metadata.url).get().header("User-Agent", "SalaryTrail/1.0").build();
        throwIfCancelled();
        try (Response response = execute(request)) {
            if (response.code() != 200) throw new IOException("安装包下载失败");
            ResponseBody body = response.body();
            if (body == null) throw new IOException("安装包响应为空");
            long declared = body.contentLength();
            if (declared >= 0 && declared != metadata.size) throw new IOException("安装包大小校验失败");
            try (InputStream input = body.byteStream(); OutputStream output = new FileOutputStream(partial, false)) {
                byte[] buffer = new byte[64 * 1024];
                long received = 0;
                long started = SystemClock.elapsedRealtime();
                int count;
                while ((count = input.read(buffer)) != -1) {
                    throwIfCancelled();
                    received += count;
                    if (received > metadata.size || received > MAX_APK_BYTES || SystemClock.elapsedRealtime() - started > MAX_DURATION_MS) throw new IOException("安装包下载超限");
                    output.write(buffer, 0, count);
                    setState(DownloadState.downloading(metadata.version, received, metadata.size));
                }
                if (received != metadata.size) throw new IOException("安装包大小校验失败");
            }
        } finally { activeCall = null; }
    }

    private void verifyApk(DownloadMetadata metadata, File file) throws Exception {
        if (!file.isFile() || file.length() != metadata.size) throw new IOException("安装包大小校验失败");
        if (!metadata.sha256.equals(sha256(file))) throw new IOException("安装包摘要校验失败");
        PackageManager manager = context.getPackageManager();
        int signingFlag = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo info = manager.getPackageArchiveInfo(file.getAbsolutePath(), signingFlag);
        if (info == null || !context.getPackageName().equals(info.packageName)) throw new IOException("安装包应用不匹配");
        long currentCode = currentVersionCode(manager);
        long nextCode = Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
        if (nextCode <= currentCode || !metadata.version.equals(info.versionName)) throw new IOException("安装包版本不匹配");
        String currentSignature = signingDigest(manager.getPackageInfo(context.getPackageName(), signingFlag));
        String newSignature = signingDigest(info);
        if (currentSignature == null || !currentSignature.equals(newSignature)) throw new IOException("安装包签名不匹配");
    }

    private long currentVersionCode(PackageManager manager) throws Exception {
        PackageInfo info = manager.getPackageInfo(context.getPackageName(), 0);
        return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
    }

    private static String signingDigest(PackageInfo info) throws Exception {
        if (Build.VERSION.SDK_INT >= 28 && info.signingInfo != null) {
            android.content.pm.Signature[] signatures = info.signingInfo.hasMultipleSigners() ? info.signingInfo.getApkContentsSigners() : info.signingInfo.getSigningCertificateHistory();
            if (signatures != null && signatures.length > 0) return safeSha256(signatures[0].toByteArray());
        }
        if (info.signatures != null && info.signatures.length > 0) return safeSha256(info.signatures[0].toByteArray());
        return null;
    }

    private static String safeSha256(byte[] bytes) { try { return sha256(bytes); } catch (Exception error) { return null; } }

    private static String sha256(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream input = new FileInputStream(file)) { byte[] buffer = new byte[64 * 1024]; int count; while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count); }
        return hex(digest.digest());
    }
    private static String sha256(byte[] bytes) throws Exception { return hex(MessageDigest.getInstance("SHA-256").digest(bytes)); }
    private static String hex(byte[] bytes) { StringBuilder value = new StringBuilder(bytes.length * 2); for (byte b : bytes) value.append(String.format(Locale.ROOT, "%02x", b & 0xff)); return value.toString(); }
    private static String readUtf8Bounded(InputStream input, long max) throws IOException { java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream(); byte[] buffer = new byte[8192]; int count; while ((count = input.read(buffer)) != -1) { if (output.size() + count > max) throw new IOException("response too large"); output.write(buffer, 0, count); } return new String(output.toByteArray(), java.nio.charset.StandardCharsets.UTF_8); }
    private static boolean validVersion(String value) { return value != null && VERSION.matcher(value).matches(); }
    static DownloadMetadata parseMetadata(String content, String version) throws Exception {
        if (!validVersion(version)) throw new IOException("更新版本号无效");
        JSONObject release = new JSONObject(content);
        if (!release.has("draft") || !release.has("prerelease") ||
            release.optBoolean("draft", true) || release.optBoolean("prerelease", true)) throw new IOException("当前发行版不可用");
        if (!("v" + version).equals(release.optString("tag_name"))) throw new IOException("发行版已变化，请重新检查");
        JSONArray assets = release.optJSONArray("assets");
        String expectedName = APK_PREFIX + version + APK_SUFFIX;
        String canonicalUrl = RELEASE_ROOT + "/download/v" + version + "/" + expectedName;
        if (assets == null) throw new IOException("发行包不完整");
        for (int i = 0; i < assets.length(); i++) {
            JSONObject asset = assets.optJSONObject(i);
            if (asset == null || !expectedName.equals(asset.optString("name"))) continue;
            long size = asset.optLong("size", -1);
            String url = asset.optString("browser_download_url");
            String digest = asset.optString("digest");
            if (size <= 0 || size > MAX_APK_BYTES || !canonicalUrl.equals(url) || !digest.startsWith("sha256:") || !SHA256.matcher(digest.substring(7)).matches()) throw new IOException("安装包信息无效");
            return new DownloadMetadata(version, size, digest.substring(7).toLowerCase(Locale.ROOT), url);
        }
        throw new IOException("没有可用的 Android 安装包");
    }

    static boolean isAllowedRedirect(String value) { return isCdnUrl(value, true); }
    private static boolean isCdnUrl(String value) { return isCdnUrl(value, false); }
    private static boolean isCdnUrl(String value, boolean allowQuery) { try { URI uri = new URI(value); String host = uri.getHost(); return "https".equalsIgnoreCase(uri.getScheme()) && host != null && (host.equalsIgnoreCase("github.com") || host.equalsIgnoreCase("objects.githubusercontent.com") || host.equalsIgnoreCase("release-assets.githubusercontent.com") || host.equalsIgnoreCase("github-releases.githubusercontent.com") || host.endsWith(".githubusercontent.com")) && uri.getUserInfo() == null && (allowQuery || uri.getQuery() == null) && uri.getFragment() == null; } catch (URISyntaxException error) { return false; } }

    private Response execute(Request request) throws IOException {
        throwIfCancelled();
        Call call = client.newCall(request);
        activeCall = call;
        Response response = call.execute();
        throwIfCancelled();
        return response;
    }
    private void throwIfCancelled() { if (cancel.get() || Thread.currentThread().isInterrupted()) throw new CancellationException(); }
    private static void copyAtomically(File source, File target) throws IOException { File temporary = new File(target.getParentFile(), target.getName() + ".tmp"); try (InputStream input = new FileInputStream(source); OutputStream output = new FileOutputStream(temporary)) { byte[] buffer = new byte[64 * 1024]; int count; while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count); } if (!temporary.renameTo(target)) throw new IOException("update cache unavailable"); }
    private void cleanVersion(String version) { File directory = new File(context.getCacheDir(), "updates"); new File(directory, "salary-" + version + ".apk.part").delete(); new File(directory, "salary-" + version + ".apk").delete(); synchronized (lock) { if (version.equals(readyVersion)) { readyVersion = null; readyFile = null; } } }
    private void setState(DownloadState next) { synchronized (lock) { state = next; } }
    private DownloadState fail(String message) { synchronized (lock) { state = DownloadState.error(message); return state; } }
    private static String safeError(Exception error) { return error instanceof IOException ? error.getMessage() : "更新下载或校验失败，请重试"; }

    static final class DownloadMetadata { final String version, sha256, url; final long size; DownloadMetadata(String version, long size, String sha256, String url) { this.version=version; this.size=size; this.sha256=sha256; this.url=url; } }
    static final class DownloadState { final String state, version, error; final long receivedBytes, totalBytes; private DownloadState(String s,String v,long r,long t,String e){state=s;version=v;receivedBytes=r;totalBytes=t;error=e;} static DownloadState idle(){return new DownloadState("idle",null,0,0,null);} static DownloadState downloading(String v,long r,long t){return new DownloadState("downloading",v,r,t,null);} static DownloadState verifying(String v,long t){return new DownloadState("verifying",v,t,t,null);} static DownloadState ready(String v,long t){return new DownloadState("ready",v,t,t,null);} static DownloadState error(String e){return new DownloadState("error",null,0,0,e);} }
}
