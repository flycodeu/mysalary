package com.flylabs.salary;

import org.json.JSONException;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

final class LedgerFile {
    static final int MAX_BYTES = 8 * 1024 * 1024;

    static byte[] bytes(String content) throws IOException {
        if (content == null || content.isEmpty() || content.length() > MAX_BYTES) throw invalidSize();
        byte[] bytes = content.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_BYTES) throw invalidSize();
        return bytes;
    }

    static byte[] read(InputStream input) throws IOException {
        if (input == null) throw new ImportStore.UserInputException("工资文件无法读取，请重新选择");
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        byte[] buffer = new byte[16384];
        int count;
        while ((count = input.read(buffer)) != -1) {
            if (bytes.size() + count > MAX_BYTES) throw invalidSize();
            bytes.write(buffer, 0, count);
        }
        if (bytes.size() == 0) throw invalidSize();
        return bytes.toByteArray();
    }

    static String format(String content) throws IOException {
        try {
            JSONObject document = new JSONObject(content.startsWith("\uFEFF") ? content.substring(1) : content);
            if (!(document.opt("version") instanceof Number) || document.getDouble("version") != 1) throw unsupported();
            String format = document.optString("format");
            if ("salary-archive".equals(format) && document.optJSONArray("entries") != null) return format;
            if ("salary-capture".equals(format)) {
                if (bytes(content).length > CaptureFile.MAX_BYTES) throw new ImportStore.UserInputException("工资采集文件超过 1 MiB");
                CapturePackage.parse(content);
                return format;
            }
            throw unsupported();
        } catch (JSONException error) { throw unsupported(); }
    }

    static byte[] archiveBytes(String content) throws IOException {
        byte[] bytes = bytes(content);
        if (!"salary-archive".equals(format(content))) throw unsupported();
        return bytes;
    }

    private static ImportStore.UserInputException invalidSize() {
        return new ImportStore.UserInputException("工资数据为空或超过 8 MiB，无法处理");
    }

    private static ImportStore.UserInputException unsupported() {
        return new ImportStore.UserInputException("工资文件格式或版本不受支持，现有账本未改动");
    }
}
