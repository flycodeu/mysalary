package com.flylabs.salary;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/** Limits apply to bytes before decoding so a provider cannot exhaust the app's memory. */
final class CaptureFile {
    static final int MAX_BYTES = 1024 * 1024;

    static boolean accepts(String mimeType, String name) {
        String mime = mimeType == null ? "" : mimeType.split(";", 2)[0].trim().toLowerCase(Locale.ROOT);
        if ("application/json".equals(mime) || "application/vnd.salary.capture+json".equals(mime)
            || "text/plain".equals(mime)) return true;
        return (mime.isEmpty() || "application/octet-stream".equals(mime))
            && name != null && name.toLowerCase(Locale.ROOT).endsWith(".salary.json");
    }

    static byte[] readBytes(InputStream input) throws IOException {
        if (input == null) throw new ImportStore.UserInputException("工资文件暂时无法读取，请重新选择");
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int read;
        while ((read = input.read(buffer)) != -1) {
            if (output.size() + read > MAX_BYTES) throw new ImportStore.UserInputException("工资文件超过 1 MiB，无法导入");
            output.write(buffer, 0, read);
        }
        if (output.size() == 0) throw new ImportStore.UserInputException("工资文件为空");
        return output.toByteArray();
    }

    static String decode(byte[] bytes) throws IOException {
        try {
            String text = StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes)).toString();
            return text.startsWith("\uFEFF") ? text.substring(1) : text;
        } catch (CharacterCodingException error) {
            throw new ImportStore.UserInputException("工资文件不是有效的 UTF-8 文本");
        }
    }
}
