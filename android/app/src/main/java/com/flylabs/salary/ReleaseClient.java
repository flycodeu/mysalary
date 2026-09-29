package com.flylabs.salary;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

/** Release checks never attach salary credentials and can reach only the public repository API. */
final class ReleaseClient {
    static final String LATEST_URL = "https://api.github.com/repos/flycodeu/mysalary/releases/latest";
    static final int MAX_BYTES = 1024 * 1024;
    private static final String RELEASE_ROOT = "https://github.com/flycodeu/mysalary/releases";
    private final OkHttpClient client;

    ReleaseClient() {
        this(new OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
            .retryOnConnectionFailure(false).connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS).callTimeout(20, TimeUnit.SECONDS).build());
    }
    ReleaseClient(OkHttpClient client) { this.client = client; }

    Result check() throws IOException {
        Request request = new Request.Builder().url(LATEST_URL).get()
            .header("User-Agent", "SalaryTrail/1.0").header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28").build();
        try (Response response = client.newCall(request).execute()) {
            if (response.code() != 200) return new Result(response.code(), null);
            ResponseBody body = response.body();
            if (body == null || body.contentLength() > MAX_BYTES) throw new IOException("Invalid release response size");
            try (InputStream input = body.byteStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[8192];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    if (output.size() + count > MAX_BYTES) throw new IOException("Release response too large");
                    output.write(buffer, 0, count);
                }
                String content = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(output.toByteArray())).toString();
                return new Result(200, content);
            }
        }
    }

    static boolean isReleaseUrl(String url) {
        if (url == null) return false;
        if (url.equals(RELEASE_ROOT) || url.equals(RELEASE_ROOT + "/") || url.equals(RELEASE_ROOT + "/latest")) return true;
        String root = Pattern.quote(RELEASE_ROOT);
        return url.matches(root + "/tag/v\\d+\\.\\d+\\.\\d+")
            || url.matches(root + "/download/v(\\d+\\.\\d+\\.\\d+)/salary-\\1-(windows-setup\\.exe|debug\\.apk)");
    }

    static final class Result {
        final int status;
        final String content;
        Result(int status, String content) { this.status = status; this.content = content; }
    }
}
