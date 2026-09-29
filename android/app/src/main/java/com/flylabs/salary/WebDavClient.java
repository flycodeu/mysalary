package com.flylabs.salary;

import okhttp3.Credentials;
import okhttp3.Call;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;
import java.io.IOException;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.TimeUnit;
import java.util.Arrays;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** The host and path are fixed; callers can never send saved credentials to another endpoint. */
final class WebDavClient {
    static final String DIRECTORY = "https://dav.jianguoyun.com/dav/SalaryTrail/";
    static final String ARCHIVE = DIRECTORY + "archive-v1.json";
    private static final MediaType JSON = MediaType.get("application/json; charset=utf-8");
    private static final MediaType XML = MediaType.get("application/xml; charset=utf-8");
    private static final byte[] LIST_BODY = ("<?xml version=\"1.0\" encoding=\"utf-8\"?>"
        + "<d:propfind xmlns:d=\"DAV:\"><d:prop><d:resourcetype/></d:prop></d:propfind>").getBytes(StandardCharsets.UTF_8);
    private static final int MAX_PULL_BYTES = 16 * 1024 * 1024;
    private final OkHttpClient client;
    private static final Pattern EVIDENCE_NAME = Pattern.compile("evidence-([A-Za-z0-9_-]{1,96})-([a-f0-9]{64})\\.(png|jpg)");

    WebDavClient() {
        this(new OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
            .retryOnConnectionFailure(false).connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS).writeTimeout(20, TimeUnit.SECONDS)
            .callTimeout(30, TimeUnit.SECONDS).build());
    }

    WebDavClient(OkHttpClient client) { this.client = client; }

    static boolean evidenceName(String name) { return name != null && EVIDENCE_NAME.matcher(name).matches(); }

    static String evidenceNameFor(String recordId, String id, String mimeType) throws IOException {
        EvidenceStore.validateRecordId(recordId);
        if (id == null || !id.matches("[a-f0-9]{64}")) throw new ImportStore.UserInputException("原图标识无效");
        if (!("image/png".equals(mimeType) || "image/jpeg".equals(mimeType))) throw new ImportStore.UserInputException("原图格式无效");
        return "evidence-" + recordId + "-" + id + ("image/png".equals(mimeType) ? ".png" : ".jpg");
    }

    List<RemoteEvidence> listEvidence(String username, String password) throws IOException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        Request listing = request(DIRECTORY, username, password).header("Accept", "application/xml").header("Depth", "1")
            .method("PROPFIND", RequestBody.create(LIST_BODY, XML)).build();
        List<RemoteEvidence> result = new ArrayList<>();
        try (Response response = execute(listing, deadline)) {
            if (response.code() == 404) return result;
            if (response.code() == 409) {
                response.close();
                missingIfParentAbsent(username, password, deadline);
                return result;
            }
            if (response.code() != 207) throw statusError(response.code());
            ResponseBody body = response.body();
            if (body == null || body.contentLength() > WebDavListing.MAX_BYTES) throw new ImportStore.UserInputException("云端目录响应超过 1 MiB 或不完整");
            for (String name : WebDavListing.parseEvidence(decode(readBounded(body.byteStream(), WebDavListing.MAX_BYTES)))) {
                Matcher match = EVIDENCE_NAME.matcher(name);
                if (!match.matches()) throw new ImportStore.UserInputException("云端原图名称无效");
                result.add(new RemoteEvidence(match.group(1), match.group(2), "png".equals(match.group(3)) ? "image/png" : "image/jpeg"));
            }
        }
        requireTimeRemaining(deadline);
        return result;
    }

    byte[] getEvidence(String recordId, String id, String mimeType, String username, String password) throws IOException {
        String name = evidenceNameFor(recordId, id, mimeType);
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(90);
        byte[] bytes = readEvidence(name, username, password, deadline, false);
        if (!EvidenceStore.hash(bytes).equals(id)) throw new ImportStore.UserInputException("云端原图校验不一致，未保存到本机");
        EvidenceStore.inspect(bytes, mimeType);
        requireTimeRemaining(deadline);
        return bytes;
    }

    void putEvidence(String recordId, String id, EvidenceStore.ReadResult original, String username, String password) throws IOException {
        String name = evidenceNameFor(recordId, id, original.mimeType);
        if (!EvidenceStore.hash(original.bytes).equals(id)) throw new ImportStore.UserInputException("本机原图校验失败，原文件已保留");
        EvidenceStore.inspect(original.bytes, original.mimeType);
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(90);
        Request collection = request(DIRECTORY, username, password).method("MKCOL", RequestBody.create(new byte[0], null)).build();
        try (Response response = execute(collection, deadline)) {
            if (response.code() != 201 && response.code() != 405) throw statusError(response.code());
        }
        byte[] existing = readEvidence(name, username, password, deadline, true);
        if (existing != null) {
            verifyEvidence(existing, original.bytes, id);
            return;
        }
        // Original bytes are immutable. A racing identical upload is accepted only after read-back verification.
        Request upload = request(DIRECTORY + name, username, password).header("If-None-Match", "*")
            .put(RequestBody.create(original.bytes, MediaType.get(original.mimeType))).build();
        try (Response response = execute(upload, deadline)) {
            if (response.code() != 200 && response.code() != 201 && response.code() != 204 && response.code() != 412) throw statusError(response.code());
        }
        verifyEvidence(readEvidence(name, username, password, deadline, false), original.bytes, id);
        requireTimeRemaining(deadline);
    }

    private byte[] readEvidence(String name, String username, String password, long deadline, boolean allowMissing) throws IOException {
        if (!evidenceName(name)) throw new ImportStore.UserInputException("云端原图名称无效");
        Request download = request(DIRECTORY + name, username, password).header("Accept", "application/octet-stream").get().build();
        try (Response response = execute(download, deadline)) {
            if (allowMissing && response.code() == 404) return null;
            if (response.code() != 200) throw statusError(response.code());
            ResponseBody body = response.body();
            if (body == null || body.contentLength() > EvidenceStore.MAX_BYTES) throw new ImportStore.UserInputException("云端原图超过 20 MiB 或不完整");
            byte[] bytes = readBounded(body.byteStream(), EvidenceStore.MAX_BYTES);
            if (bytes.length == 0) throw new ImportStore.UserInputException("云端原图为空，已停止同步");
            return bytes;
        }
    }

    private static void verifyEvidence(byte[] downloaded, byte[] original, String id) throws IOException {
        if (!EvidenceStore.hash(downloaded).equals(id) || !Arrays.equals(downloaded, original))
            throw new ImportStore.UserInputException("云端已有原图与本机不一致，已停止同步，原文件未覆盖");
    }

    static final class RemoteEvidence {
        final String recordId;
        final String id;
        final String mimeType;
        RemoteEvidence(String recordId, String id, String mimeType) { this.recordId = recordId; this.id = id; this.mimeType = mimeType; }
    }

    List<RemoteFile> pull(String username, String password) throws IOException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(75);
        List<RemoteFile> files = new ArrayList<>();
        List<String> names = list(username, password, deadline);
        int total = 0;
        for (String name : names) {
            byte[] bytes = readRemote(name, username, password, deadline);
            total += bytes.length;
            if (total > MAX_PULL_BYTES) throw new ImportStore.UserInputException("云端工资数据超过 16 MiB，请先整理备份后再同步");
            if (WebDavListing.deltaName(name) && !deltaFileName(bytes).equals(name)) {
                throw new ImportStore.UserInputException("云端工资文件校验失败，本机数据未改动");
            }
            files.add(new RemoteFile(name, decode(bytes)));
        }
        requireTimeRemaining(deadline);
        return files;
    }

    void publish(byte[] content, String username, String password) throws IOException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(45);
        if (content.length == 0 || content.length > LedgerFile.MAX_BYTES) throw new ImportStore.UserInputException("工资数据为空或超过 8 MiB");
        String name = deltaFileName(content);
        Request collection = request(DIRECTORY, username, password).method("MKCOL", RequestBody.create(new byte[0], null)).build();
        try (Response response = execute(collection, deadline)) {
            if (response.code() != 201 && response.code() != 405) throw statusError(response.code());
        }
        // A path is derived only from these exact bytes, so repeat publication cannot replace another version.
        Request publish = request(DIRECTORY + name, username, password).put(RequestBody.create(content, JSON)).build();
        try (Response response = execute(publish, deadline)) {
            if (response.code() != 200 && response.code() != 201 && response.code() != 204) throw statusError(response.code());
        }
        byte[] stored = readRemote(name, username, password, deadline);
        if (!name.equals(deltaFileName(stored))) throw new ImportStore.UserInputException("云端保存后的内容校验失败，请重新同步确认");
        requireTimeRemaining(deadline);
    }

    private List<String> list(String username, String password, long deadline) throws IOException {
        Request request = request(DIRECTORY, username, password).header("Accept", "application/xml").header("Depth", "1")
            .method("PROPFIND", RequestBody.create(LIST_BODY, XML)).build();
        try (Response response = execute(request, deadline)) {
            if (response.code() == 404) return new ArrayList<>();
            if (response.code() == 409) {
                response.close();
                missingIfParentAbsent(username, password, deadline);
                return new ArrayList<>();
            }
            if (response.code() != 207) throw statusError(response.code());
            ResponseBody body = response.body();
            if (body == null || body.contentLength() > WebDavListing.MAX_BYTES) throw new ImportStore.UserInputException("云端目录响应超过 1 MiB 或不完整");
            return WebDavListing.parse(decode(readBounded(body.byteStream(), WebDavListing.MAX_BYTES)));
        }
    }

    private byte[] readRemote(String name, String username, String password, long deadline) throws IOException {
        if (!"archive-v1.json".equals(name) && !WebDavListing.deltaName(name)) throw new ImportStore.UserInputException("不支持的云端工资文件名");
        Request request = request(DIRECTORY + name, username, password).get().build();
        try (Response response = execute(request, deadline)) {
            if (response.code() != 200) throw statusError(response.code());
            ResponseBody body = response.body();
            if (body == null || body.contentLength() > LedgerFile.MAX_BYTES) throw new ImportStore.UserInputException("云端工资文件超过 8 MiB 或不完整");
            return readBounded(body.byteStream(), LedgerFile.MAX_BYTES);
        }
    }

    private static byte[] readBounded(InputStream input, int maximum) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[16384];
        int count;
        while ((count = input.read(buffer)) != -1) {
            if (output.size() + count > maximum) throw new ImportStore.UserInputException("云端响应超过允许的大小，已停止同步");
            output.write(buffer, 0, count);
        }
        return output.toByteArray();
    }

    private static String decode(byte[] bytes) throws IOException {
        try { return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString(); }
        catch (java.nio.charset.CharacterCodingException error) { throw new ImportStore.UserInputException("云端工资文件编码无效"); }
    }

    static String deltaFileName(byte[] content) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(content);
            StringBuilder name = new StringBuilder("changes-");
            for (byte value : digest) name.append(String.format(Locale.ROOT, "%02x", value & 0xff));
            return name.append(".json").toString();
        } catch (java.security.NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }

    Result get(String username, String password) throws IOException {
        Request request = request(ARCHIVE, username, password).get().build();
        try (Response response = client.newCall(request).execute()) {
            if (response.code() == 404) return Result.missing();
            if (response.code() == 409) {
                response.close();
                return missingIfParentAbsent(username, password);
            }
            if (response.code() != 200) throw statusError(response.code());
            String etag = response.header("ETag");
            // Reading remains useful without a safe write token; put() still forbids an unguarded update.
            if (response.headers("ETag").size() != 1 || !strongEtag(etag)) etag = null;
            ResponseBody body = response.body();
            if (body == null || body.contentLength() > LedgerFile.MAX_BYTES) throw new ImportStore.UserInputException("云端账本为空或超过 8 MiB");
            String content = CaptureFile.decode(LedgerFile.read(body.byteStream()));
            return new Result(content, etag, false, false);
        }
    }

    private Result missingIfParentAbsent(String username, String password) throws IOException {
        return missingIfParentAbsent(username, password, System.nanoTime() + TimeUnit.SECONDS.toNanos(30));
    }

    private Result missingIfParentAbsent(String username, String password, long deadline) throws IOException {
        // Nutstore can return file 409 before the parent exists; other conflicts must remain failures.
        Request parent = request(DIRECTORY, username, password).get().build();
        try (Response response = execute(parent, deadline)) {
            if (response.code() == 404) return Result.missing();
            if (response.code() >= 300) throw statusError(response.code());
            throw statusError(409);
        }
    }

    private Response execute(Request request, long deadline) throws IOException {
        long remaining = requireTimeRemaining(deadline);
        Call call = client.newCall(request);
        call.timeout().timeout(Math.min(remaining, TimeUnit.SECONDS.toNanos(30)), TimeUnit.NANOSECONDS);
        return call.execute();
    }

    private static long requireTimeRemaining(long deadline) throws IOException {
        long remaining = deadline - System.nanoTime();
        if (remaining <= 0) throw new ImportStore.UserInputException("同步超时，请稍后重试，本机数据已保留");
        return remaining;
    }

    Result put(byte[] content, String etag, boolean create, String username, String password) throws IOException {
        if (content.length == 0 || content.length > LedgerFile.MAX_BYTES) throw new ImportStore.UserInputException("工资数据为空或超过 8 MiB");
        if ((create && etag != null) || (!create && !strongEtag(etag))) {
            throw new ImportStore.UserInputException("缺少有效的云端版本，请先读取并合并云端数据");
        }
        Request collection = request(DIRECTORY, username, password)
            .method("MKCOL", RequestBody.create(new byte[0], null)).build();
        try (Response response = client.newCall(collection).execute()) {
            if (response.code() != 201 && response.code() != 405) throw statusError(response.code());
        }
        Request.Builder builder = request(ARCHIVE, username, password).put(RequestBody.create(content, JSON));
        if (create) builder.header("If-None-Match", "*");
        else builder.header("If-Match", etag);
        try (Response response = client.newCall(builder.build()).execute()) {
            if (response.code() == 412) return Result.conflict();
            if (response.code() != 200 && response.code() != 201 && response.code() != 204) throw statusError(response.code());
            String returnedEtag = response.header("ETag");
            if (returnedEtag != null && !strongEtag(returnedEtag)) {
                throw new ImportStore.UserInputException("云端返回的版本标识无效，请重新读取确认保存结果");
            }
            return new Result(null, returnedEtag, false, false);
        }
    }

    private static Request.Builder request(String url, String username, String password) {
        return new Request.Builder().url(url).header("Authorization", Credentials.basic(username, password, StandardCharsets.UTF_8))
            .header("Accept", "application/json").header("Cache-Control", "no-store");
    }

    static boolean strongEtag(String value) {
        if (value == null || value.length() < 2 || value.length() > 1024 || value.charAt(0) != '"'
            || value.charAt(value.length() - 1) != '"') return false;
        for (int i = 1; i < value.length() - 1; i++) {
            char character = value.charAt(i);
            if (character < 0x21 || character == '"' || character > 0x7e) return false;
        }
        return true;
    }

    private static ImportStore.UserInputException statusError(int status) {
        String message;
        if (status == 401) message = "坚果云账号或应用密码不正确，请检查同步设置";
        else if (status == 403) message = "坚果云拒绝访问，请检查 WebDAV 权限与应用密码";
        else if (status == 429) message = "坚果云请求过于频繁，请稍后重试";
        else if (status >= 300 && status < 400) message = "云端要求跳转，已停止请求以保护同步凭据";
        else message = "坚果云暂时无法完成请求，请稍后重试";
        return new ImportStore.UserInputException(message + "（HTTP " + status + "）");
    }

    static final class Result {
        final String content;
        final String etag;
        final boolean missing;
        final boolean conflict;
        Result(String content, String etag, boolean missing, boolean conflict) {
            this.content = content; this.etag = etag; this.missing = missing; this.conflict = conflict;
        }
        static Result missing() { return new Result(null, null, true, false); }
        static Result conflict() { return new Result(null, null, false, true); }
    }

    static final class RemoteFile {
        final String name;
        final String content;
        RemoteFile(String name, String content) { this.name = name; this.content = content; }
    }
}
