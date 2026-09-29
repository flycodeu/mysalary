package com.flylabs.salary;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;
import java.util.UUID;
import java.util.zip.CRC32;

/** Immutable source images are independent from ledger edits, trash and app upgrades. */
final class EvidenceStore {
    static final int MAX_BYTES = 20 * 1024 * 1024;
    static final int MAX_DIMENSION = 32768;
    static final long MAX_PIXELS = 40000000L;
    private final File root;

    EvidenceStore(File filesDirectory) throws IOException {
        // Resolve the trusted app files directory once; descendants must never be links outside it.
        root = new File(filesDirectory.getCanonicalFile(), "evidence");
    }

    static void validateRecordId(String recordId) throws IOException {
        if (recordId == null || !recordId.matches("[A-Za-z0-9_-]{1,96}")) throw invalid("工资记录标识无效");
    }

    private static void validateId(String id) throws IOException {
        if (id == null || !id.matches("[a-f0-9]{64}")) throw invalid("原图标识无效");
    }

    synchronized JSONObject add(String recordId, byte[] bytes, String mimeType) throws IOException, JSONException {
        validateRecordId(recordId);
        ImageInfo info = inspect(bytes, mimeType);
        String id = hash(bytes);
        File directory = recordDirectory(recordId, true);
        File metadata = child(directory, id + ".json");
        if (child(directory, id + ".deleted").exists()) throw invalid("这张截图已删除，不能重复添加");
        if (metadata.exists()) {
            JSONObject previous = readItem(directory, recordId, id);
            readBytes(directory, previous);
            return previous;
        }
        JSONObject item = new JSONObject().put("id", id).put("recordId", recordId).put("createdAt", now())
            .put("mimeType", info.mimeType).put("sizeBytes", bytes.length).put("width", info.width).put("height", info.height);
        File original = child(directory, id + extension(info.mimeType));
        if (original.exists()) {
            // Bytes can survive a crash before metadata. Never overwrite a damaged existing original.
            if (!hash(readFile(original, MAX_BYTES)).equals(id)) throw invalid("已有原图无法校验，原文件已保留");
        } else writeNew(original, bytes);
        writeNew(metadata, item.toString().getBytes(StandardCharsets.UTF_8));
        return item;
    }

    synchronized JSONArray list(String recordId) throws IOException, JSONException {
        validateRecordId(recordId);
        File directory = recordDirectory(recordId, false);
        if (!directory.exists()) return new JSONArray();
        File[] files = directory.listFiles((parent, name) -> name.endsWith(".json"));
        if (files == null) throw new IOException("Evidence directory unavailable");
        List<JSONObject> items = new ArrayList<>();
        for (File file : files) {
            String id = file.getName().substring(0, file.getName().length() - 5);
            validateId(id);
            if (child(directory, id + ".deleted").exists()) continue;
            JSONObject item = readItem(directory, recordId, id);
            File original = child(directory, id + extension(item.getString("mimeType")));
            if (!original.isFile() || original.length() != item.getInt("sizeBytes")) throw invalid("部分原图无法读取，已有文件已保留");
            items.add(item);
        }
        items.sort(Comparator.comparing((JSONObject item) -> item.optString("createdAt")).thenComparing(item -> item.optString("id")));
        JSONArray result = new JSONArray();
        for (JSONObject item : items) result.put(item);
        return result;
    }

    synchronized ReadResult read(String recordId, String id) throws IOException, JSONException {
        validateRecordId(recordId);
        validateId(id);
        File directory = recordDirectory(recordId, false);
        if (child(directory, id + ".deleted").exists()) throw invalid("这张截图已删除");
        JSONObject item = readItem(directory, recordId, id);
        return new ReadResult(readBytes(directory, item), item.getString("mimeType"));
    }

    synchronized JSONArray listDeleted(String recordId) throws IOException {
        validateRecordId(recordId);
        File directory = recordDirectory(recordId, false);
        JSONArray result = new JSONArray();
        if (!directory.exists()) return result;
        File[] files = directory.listFiles((parent, name) -> name.endsWith(".deleted"));
        if (files == null) throw new IOException("Evidence directory unavailable");
        Arrays.sort(files, Comparator.comparing(File::getName));
        for (File file : files) {
            String id = file.getName().substring(0, file.getName().length() - 8);
            validateId(id);
            if (!Arrays.equals(readFile(child(directory, file.getName()), 64), "deleted-v1\n".getBytes(StandardCharsets.UTF_8)))
                throw invalid("截图删除记录损坏，已停止同步");
            result.put(id);
        }
        return result;
    }

    synchronized void delete(String recordId, String id) throws IOException, JSONException {
        validateRecordId(recordId); validateId(id);
        File directory = recordDirectory(recordId, true);
        File marker = child(directory, id + ".deleted");
        if (!marker.exists()) writeNew(marker, "deleted-v1\n".getBytes(StandardCharsets.UTF_8));
        File metadata = child(directory, id + ".json");
        for (String extension : new String[]{".png", ".jpg", ".json"}) {
            File file = child(directory, id + extension);
            if (file.exists() && !file.delete()) throw invalid("截图删除未完成，请重试");
        }
    }

    private byte[] readBytes(File directory, JSONObject item) throws IOException, JSONException {
        byte[] bytes = readFile(child(directory, item.getString("id") + extension(item.getString("mimeType"))), MAX_BYTES);
        if (bytes.length != item.getInt("sizeBytes") || !hash(bytes).equals(item.getString("id"))) throw invalid("原图校验失败，原文件已保留");
        return bytes;
    }

    private JSONObject readItem(File directory, String recordId, String id) throws IOException {
        try {
            JSONObject item = new JSONObject(new String(readFile(child(directory, id + ".json"), 4096), StandardCharsets.UTF_8));
            if (item.length() != 7 || !id.equals(item.getString("id")) || !recordId.equals(item.getString("recordId"))
                || !item.getString("createdAt").matches("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{1,7}Z")
                || !("image/png".equals(item.getString("mimeType")) || "image/jpeg".equals(item.getString("mimeType")))
                || item.getInt("sizeBytes") <= 0 || item.getInt("sizeBytes") > MAX_BYTES) throw new IOException("Invalid evidence metadata");
            validateDimensions(item.getInt("width"), item.getInt("height"));
            return item;
        } catch (Exception error) { throw invalid("原图档案无法读取，原文件已保留"); }
    }

    private File recordDirectory(String recordId, boolean create) throws IOException {
        safe(root);
        if (create) ensure(root);
        File directory = child(root, "record-" + hash(recordId.getBytes(StandardCharsets.UTF_8)));
        if (create) ensure(directory);
        return directory;
    }

    private static File child(File directory, String name) throws IOException {
        File file = new File(directory, name);
        safe(directory);
        safe(file);
        if (!file.getCanonicalPath().startsWith(directory.getCanonicalPath() + File.separator)) throw invalid("原图路径无效");
        return file;
    }

    private static void safe(File file) throws IOException {
        if (!file.getAbsolutePath().equals(file.getCanonicalPath())) throw invalid("原图目录不能使用链接");
    }

    private static void ensure(File directory) throws IOException {
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Cannot create evidence directory");
        safe(directory);
    }

    private static void writeNew(File target, byte[] bytes) throws IOException {
        File temporary = child(target.getParentFile(), target.getName() + "." + UUID.randomUUID() + ".tmp");
        try {
            try (FileOutputStream output = new FileOutputStream(temporary)) {
                output.write(bytes);
                output.getFD().sync();
            }
            if (target.exists() || !temporary.renameTo(target)) throw new IOException("Cannot commit evidence file");
        } finally {
            if (temporary.exists() && !temporary.delete()) temporary.deleteOnExit();
        }
    }

    static byte[] readInput(InputStream input) throws IOException { return readInput(input, MAX_BYTES); }

    private static byte[] readInput(InputStream input, int maximum) throws IOException {
        if (input == null) throw invalid("无法读取所选原图");
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[16384];
        int count;
        while ((count = input.read(buffer)) != -1) {
            if (output.size() + count > maximum) throw invalid("每张原图不能超过 20 MiB");
            output.write(buffer, 0, count);
        }
        if (output.size() == 0) throw invalid("所选原图为空");
        return output.toByteArray();
    }

    private static byte[] readFile(File file, int maximum) throws IOException {
        if (!file.isFile() || file.length() <= 0 || file.length() > maximum) throw invalid("原图无法读取或超过 20 MiB");
        try (InputStream input = new FileInputStream(file)) { return readInput(input, maximum); }
    }

    static String hash(byte[] bytes) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
            StringBuilder output = new StringBuilder(64);
            for (byte value : digest) output.append(String.format(Locale.ROOT, "%02x", value & 0xff));
            return output.toString();
        } catch (NoSuchAlgorithmException error) { throw new IllegalStateException("SHA-256 unavailable", error); }
    }

    static ImageInfo inspect(byte[] bytes, String expectedMime) throws IOException {
        if (bytes == null || bytes.length == 0 || bytes.length > MAX_BYTES) throw invalid("每张原图不能超过 20 MiB");
        ImageInfo info;
        if (bytes.length >= 33 && Arrays.equals(Arrays.copyOf(bytes, 8), new byte[]{(byte) 137, 80, 78, 71, 13, 10, 26, 10})) info = png(bytes);
        else if (bytes.length >= 4 && unsigned(bytes[0]) == 255 && unsigned(bytes[1]) == 216) info = jpeg(bytes);
        else throw invalid("请选择 PNG 或 JPEG 格式的真实截图");
        validateDimensions(info.width, info.height);
        if (expectedMime != null && !expectedMime.equals(info.mimeType)) throw invalid("原图格式与文件内容不一致");
        return info;
    }

    private static ImageInfo png(byte[] bytes) throws IOException {
        int position = 8;
        ImageInfo info = null;
        boolean data = false;
        while (position + 12 <= bytes.length) {
            long length = big32(bytes, position);
            if (length > bytes.length - position - 12) break;
            String type = new String(bytes, position + 4, 4, StandardCharsets.US_ASCII);
            CRC32 crc = new CRC32();
            crc.update(bytes, position + 4, (int) length + 4);
            if (crc.getValue() != big32(bytes, position + 8 + (int) length)) break;
            if (position == 8) {
                if (!"IHDR".equals(type) || length != 13) break;
                long width = big32(bytes, position + 8), height = big32(bytes, position + 12);
                if (width > Integer.MAX_VALUE || height > Integer.MAX_VALUE) throw invalid("图片尺寸过大，请分段截图后添加");
                info = new ImageInfo("image/png", (int) width, (int) height);
                validateDimensions(info.width, info.height);
            } else if ("IHDR".equals(type)) break;
            if ("IDAT".equals(type) && length > 0) data = true;
            if ("IEND".equals(type)) {
                if (length == 0 && info != null && data && position + 12 == bytes.length) return info;
                break;
            }
            position += (int) length + 12;
        }
        throw invalid("PNG 原图损坏或未完整保存");
    }

    private static ImageInfo jpeg(byte[] bytes) throws IOException {
        int position = 2;
        ImageInfo info = null;
        while (position + 4 <= bytes.length) {
            if (unsigned(bytes[position++]) != 255) break;
            while (position < bytes.length && unsigned(bytes[position]) == 255) position++;
            if (position >= bytes.length) break;
            int marker = unsigned(bytes[position++]);
            if (marker == 217) break;
            if (marker == 1 || marker >= 208 && marker <= 215) continue;
            if (position + 2 > bytes.length) break;
            int length = unsigned(bytes[position]) * 256 + unsigned(bytes[position + 1]);
            if (length < 2 || position + length > bytes.length) break;
            if (isFrame(marker)) {
                if (length < 8) break;
                info = new ImageInfo("image/jpeg", unsigned(bytes[position + 5]) * 256 + unsigned(bytes[position + 6]),
                    unsigned(bytes[position + 3]) * 256 + unsigned(bytes[position + 4]));
                validateDimensions(info.width, info.height);
            }
            if (marker == 218) {
                // Entropy-coded data may contain escaped FF bytes. A complete file still requires EOI.
                if (info == null) break;
                for (int index = position + length; index + 1 < bytes.length; index++)
                    if (unsigned(bytes[index]) == 255 && unsigned(bytes[index + 1]) == 217) return info;
                break;
            }
            position += length;
        }
        throw invalid("JPEG 原图损坏或未完整保存");
    }

    private static boolean isFrame(int marker) { return marker >= 192 && marker <= 207 && marker != 196 && marker != 200 && marker != 204; }
    private static int unsigned(byte value) { return value & 0xff; }
    private static long big32(byte[] bytes, int offset) {
        return ((long) unsigned(bytes[offset]) << 24) | ((long) unsigned(bytes[offset + 1]) << 16)
            | ((long) unsigned(bytes[offset + 2]) << 8) | unsigned(bytes[offset + 3]);
    }
    private static void validateDimensions(int width, int height) throws IOException {
        if (width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION || (long) width * height > MAX_PIXELS)
            throw invalid("图片尺寸过大，请分段截图后添加");
    }
    private static String extension(String mimeType) { return "image/png".equals(mimeType) ? ".png" : ".jpg"; }
    private static String now() {
        SimpleDateFormat formatter = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT);
        formatter.setTimeZone(TimeZone.getTimeZone("UTC"));
        return formatter.format(new Date());
    }
    private static IOException invalid(String message) { return new ImportStore.UserInputException(message); }

    static final class ImageInfo {
        final String mimeType;
        final int width;
        final int height;
        ImageInfo(String mimeType, int width, int height) { this.mimeType = mimeType; this.width = width; this.height = height; }
    }
    static final class ReadResult {
        final byte[] bytes;
        final String mimeType;
        ReadResult(byte[] bytes, String mimeType) { this.bytes = bytes; this.mimeType = mimeType; }
    }
}
