package com.flylabs.salary;

import android.content.ContentResolver;
import android.content.Context;
import android.database.Cursor;
import android.graphics.BitmapFactory;
import android.graphics.Bitmap;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.AtomicFile;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import java.io.File;
import java.io.ByteArrayInputStream;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;
import java.util.UUID;

/** Owns original files and atomic metadata. No caller-controlled paths enter this store. */
final class ImportStore {
    static final long MAX_FILE_BYTES = 20L * 1024 * 1024;
    static final int MAX_WIDTH = 8192;
    static final int MAX_HEIGHT = 100000;
    private final File root;
    private final ContentResolver resolver;

    ImportStore(Context context) {
        root = new File(context.getFilesDir(), "salary-imports");
        resolver = context.getContentResolver();
    }

    synchronized JSONArray importCapture(Uri uri) throws IOException, JSONException {
        if (uri == null || !"content".equals(uri.getScheme())) {
            throw new UserInputException("请选择系统文件中的工资文件");
        }
        String fileName = displayName(uri);
        if (!CaptureFile.accepts(resolver.getType(uri), fileName)) {
            throw new UserInputException("请选择电脑采集工具导出的 .salary.json 文件");
        }
        try (InputStream input = resolver.openInputStream(uri)) {
            return importCapture(input, fileName);
        }
    }

    synchronized JSONArray importCaptureText(String text) throws IOException, JSONException {
        if (text == null || text.length() > CaptureFile.MAX_BYTES) {
            throw new UserInputException("工资内容为空或超过 1 MiB");
        }
        return importCapture(new ByteArrayInputStream(text.getBytes(StandardCharsets.UTF_8)), "分享的工资.salary.json");
    }

    synchronized JSONArray importCapture(InputStream input, String fileName) throws IOException, JSONException {
        byte[] bytes = CaptureFile.readBytes(input);
        File inbox = new File(root, "capture-inbox");
        ensureDirectory(inbox);
        AtomicFile received = new AtomicFile(new File(inbox, UUID.randomUUID() + ".salary.json"));
        writeBytes(received, bytes);
        // Keep the complete received file until all monthly snapshots are durable. Retries are idempotent.
        JSONObject pack = CapturePackage.parse(CaptureFile.decode(bytes));
        JSONArray records = pack.getJSONArray("records");
        JSONArray result = new JSONArray();
        for (int i = 0; i < records.length(); i++) {
            JSONObject record = records.getJSONObject(i);
            String hash = hex(sha256().digest(CapturePackage.identity(pack, record).getBytes(StandardCharsets.UTF_8)));
            JSONObject duplicate = findCaptureDuplicate(hash);
            if (duplicate != null) {
                result.put(restoreImport(duplicate.getString("id")));
                continue;
            }
            String id = UUID.randomUUID().toString();
            File directory = directory(id);
            ensureDirectory(directory);
            JSONObject item = new JSONObject().put("id", id).put("fileName", fileName)
                .put("sourceKind", "feishu-text").put("imagePath", "").put("width", 0).put("height", 0)
                .put("createdAt", now()).put("sha256", hash).put("status", "pending").put("copyState", "copying");
            write(item);
            byte[] snapshot = CapturePackage.single(pack, record).toString().getBytes(StandardCharsets.UTF_8);
            File original = new File(directory, "original.salary.json");
            writeBytes(new AtomicFile(original), snapshot);
            item.put("sizeBytes", snapshot.length).put("mimeType", "application/json").put("copyState", "complete");
            write(item);
            result.put(withCapture(item));
        }
        received.delete();
        return result;
    }

    synchronized JSONObject importImage(Uri uri) throws IOException, JSONException {
        if (uri == null || !"content".equals(uri.getScheme())) {
            throw new UserInputException("请选择系统相册或文件中的图片");
        }
        ensureDirectory(root);
        String id = UUID.randomUUID().toString();
        File directory = directory(id);
        ensureDirectory(directory);
        JSONObject item = new JSONObject()
            .put("id", id).put("fileName", displayName(uri))
            .put("imagePath", "").put("width", 0).put("height", 0)
            .put("createdAt", now()).put("sha256", "").put("status", "pending")
            .put("copyState", "copying");
        write(item);

        File staging = new File(directory, "original.part");
        try {
            String hash = copy(uri, staging);
            BitmapFactory.Options bounds = inspect(staging);
            File original = new File(directory, "original.image");
            if (!staging.renameTo(original)) throw new IOException("Original rename failed");
            fillImageMetadata(item, original, bounds, hash);
            addPreview(item, original);
            // The durable original lands first. Recovery repairs the small metadata gap after a crash.
            write(item);
            JSONObject duplicate = findDuplicate(hash, id);
            if (duplicate != null) {
                // Re-import restores the existing record, including the user's reviewed draft.
                duplicate = restoreImport(duplicate.getString("id"));
                item.put("duplicateOf", duplicate.getString("id"));
                write(item);
                // Only remove the newly completed duplicate; the existing original is never touched.
                original.delete();
                new AtomicFile(new File(directory, "preview.png")).delete();
                new AtomicFile(new File(directory, "item.json")).delete();
                directory.delete();
                return duplicate;
            }
            return item;
        } catch (IOException | JSONException error) {
            item.put("status", "error").put("error", friendlyImportError(error));
            write(item);
            throw error;
        }
    }

    synchronized JSONArray list() throws IOException, JSONException {
        ensureDirectory(root);
        List<JSONObject> items = new ArrayList<>();
        File[] directories = root.listFiles(File::isDirectory);
        if (directories == null) throw new IOException("Import directory unavailable");
        for (File directory : directories) {
            if (!validId(directory.getName())) continue;
            String[] contents = directory.list();
            if (contents != null && contents.length == 0) continue;
            try {
                JSONObject item = read(directory.getName());
                if (item.has("duplicateOf")) continue;
                recover(item);
                items.add(withCapture(item));
            } catch (IOException | JSONException error) {
                // One damaged item must not hide the rest of the archive or stop duplicate detection.
                items.add(withCapture(recoverUnreadable(directory)));
            }
        }
        items.sort((left, right) -> right.optString("createdAt").compareTo(left.optString("createdAt")));
        JSONArray result = new JSONArray();
        for (JSONObject item : items) result.put(item);
        return result;
    }

    synchronized File original(String id) throws IOException, JSONException {
        JSONObject item = read(id);
        requireActive(item);
        File original = new File(directory(id), "original.image");
        if (!"complete".equals(item.optString("copyState")) || !original.isFile()) {
            throw new UserInputException("原图尚未完整保存，请重新分享图片");
        }
        return original;
    }

    synchronized JSONObject saveOcr(String id, JSONObject ocr) throws IOException, JSONException {
        JSONObject item = read(id);
        // OCR runs outside the storage lock; deletion during inference must still win.
        requireActive(item);
        item.put("ocr", ocr);
        JSONObject draft = item.optJSONObject("draft");
        item.put("status", draft != null && "reviewed".equals(draft.optString("reviewStatus"))
            ? "reviewed" : "recognized");
        item.remove("error");
        write(item);
        return item;
    }

    synchronized JSONObject saveDraft(String id, JSONObject draft) throws IOException, JSONException {
        if (draft == null || draft.toString().length() > 1_000_000) {
            throw new UserInputException("工资内容无效或过大");
        }
        JSONObject item = read(id);
        requireActive(item);
        File source = sourceFile(item);
        if (!"complete".equals(item.optString("copyState")) || !source.isFile()) {
            throw new UserInputException("来源文件尚未完整保存，请重新导入");
        }
        item.put("draft", draft).put("status", "reviewed".equals(draft.optString("reviewStatus"))
            ? "reviewed" : item.has("ocr") ? "recognized" : "pending");
        write(item);
        return withCapture(item);
    }

    synchronized void recordOcrError(String id, String message) throws IOException, JSONException {
        JSONObject item = read(id);
        if (item.has("deletedAt")) return;
        // A failed re-recognition must not demote an already reviewed salary or erase its edits.
        if (!"reviewed".equals(item.optString("status"))) item.put("status", "error");
        item.put("error", message);
        write(item);
    }

    synchronized JSONObject deleteImport(String id) throws IOException, JSONException {
        JSONObject item = read(id);
        if (!item.has("deletedAt")) {
            item.put("deletedAt", now());
            write(item);
        }
        return withCapture(item);
    }

    synchronized JSONObject restoreImport(String id) throws IOException, JSONException {
        JSONObject item = read(id);
        if (item.has("deletedAt")) {
            item.remove("deletedAt");
            write(item);
        }
        return withCapture(item);
    }

    private static void requireActive(JSONObject item) throws UserInputException {
        if (item.has("deletedAt")) throw new UserInputException("这条档案已删除，请先恢复");
    }

    private void recover(JSONObject item) throws IOException, JSONException {
        if ("feishu-text".equals(item.optString("sourceKind"))) {
            File original = sourceFile(item);
            if (original.isFile()) {
                if (!"complete".equals(item.optString("copyState"))) {
                    JSONObject pack = CapturePackage.parse(readCapture(original));
                    String identity = CapturePackage.identity(pack, pack.getJSONArray("records").getJSONObject(0));
                    item.put("sha256", hex(sha256().digest(identity.getBytes(StandardCharsets.UTF_8))))
                        .put("sizeBytes", original.length()).put("copyState", "complete").remove("error");
                    write(item);
                }
            } else {
                item.put("status", "error").put("error", "本机工资文件缺失，请重新导入");
                write(item);
            }
            return;
        }
        File original = new File(directory(item.getString("id")), "original.image");
        if ("complete".equals(item.optString("copyState"))) {
            if (!original.isFile()) {
                item.put("status", "error").put("error", "本机原图缺失，请重新导入");
                write(item);
            } else if (!new File(directory(item.getString("id")), "preview.png").isFile()) {
                addPreview(item, original);
                write(item);
            }
            return;
        }
        if (original.isFile()) {
            fillImageMetadata(item, original, inspect(original), digest(original));
            addPreview(item, original);
            item.remove("error");
        } else {
            item.put("status", "error").put("error", "原图接收未完成，请重新分享图片");
        }
        write(item);
    }

    private JSONObject findDuplicate(String hash, String excludeId) throws IOException, JSONException {
        JSONArray items = list();
        for (int index = 0; index < items.length(); index++) {
            JSONObject item = items.getJSONObject(index);
            if (!excludeId.equals(item.getString("id")) && hash.equals(item.optString("sha256"))
                && new File(directory(item.getString("id")), "original.image").isFile()) return item;
        }
        return null;
    }

    private JSONObject findCaptureDuplicate(String hash) throws IOException, JSONException {
        JSONArray items = list();
        for (int i = 0; i < items.length(); i++) {
            JSONObject item = items.getJSONObject(i);
            if ("feishu-text".equals(item.optString("sourceKind")) && hash.equals(item.optString("sha256"))
                && sourceFile(item).isFile()) {
                try {
                    JSONObject pack = CapturePackage.parse(readCapture(sourceFile(item)));
                    JSONArray records = pack.getJSONArray("records");
                    if (records.length() != 1) continue;
                    String identity = CapturePackage.identity(pack, records.getJSONObject(0));
                    String storedHash = hex(sha256().digest(identity.getBytes(StandardCharsets.UTF_8)));
                    if (hash.equals(storedHash)) return item;
                } catch (IOException | JSONException error) {
                    // Preserve damaged sources; a fresh import must create a healthy monthly archive.
                }
            }
        }
        return null;
    }

    private JSONObject recoverUnreadable(File directory) throws JSONException {
        JSONObject item = new JSONObject().put("id", directory.getName()).put("fileName", "待恢复的截图")
            .put("imagePath", "").put("width", 0).put("height", 0).put("createdAt", now())
            .put("sha256", "").put("status", "error").put("copyState", "copying")
            .put("error", "这条记录读取失败，原有文件已保留");
        File original = new File(directory, "original.image");
        try {
            File capture = new File(directory, "original.salary.json");
            if (capture.isFile()) {
                JSONObject pack = CapturePackage.parse(readCapture(capture));
                String identity = CapturePackage.identity(pack, pack.getJSONArray("records").getJSONObject(0));
                item.put("sourceKind", "feishu-text").put("fileName", "恢复的工资.salary.json")
                    .put("sha256", hex(sha256().digest(identity.getBytes(StandardCharsets.UTF_8))))
                    .put("sizeBytes", capture.length()).put("copyState", "complete")
                    .put("error", "工资文件已恢复，原有核对内容需要重新整理");
            } else if (original.isFile()) {
                fillImageMetadata(item, original, inspect(original), digest(original));
                addPreview(item, original);
                item.put("status", "error").put("error", "原图已恢复，核对内容需要重新整理");
            }
            // Keep unreadable metadata intact before creating a usable minimum record.
            for (String suffix : new String[]{"", ".bak"}) {
                File metadata = new File(directory, "item.json" + suffix);
                if (metadata.isFile() && !metadata.renameTo(new File(directory,
                    "item.recovery-" + System.currentTimeMillis() + suffix + ".json"))) {
                    throw new IOException("Cannot preserve unreadable metadata");
                }
            }
            write(item);
        } catch (IOException error) {
            // Storage errors remain visible on this item; list() can still return healthy items.
            item.put("error", "这条记录暂时无法恢复，原有文件已保留");
        }
        return item;
    }

    private void addPreview(JSONObject item, File original) throws IOException, JSONException {
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inSampleSize = previewSample(item.getInt("width"), item.getInt("height"));
        options.inPreferredConfig = Bitmap.Config.ARGB_8888;
        Bitmap preview = BitmapFactory.decodeFile(original.getAbsolutePath(), options);
        if (preview == null) throw new UserInputException("图片像素无法读取，原文件已保留，请重新截图");
        File directory = directory(item.getString("id"));
        AtomicFile output = new AtomicFile(new File(directory, "preview.png"));
        FileOutputStream stream = null;
        try {
            stream = output.startWrite();
            if (!preview.compress(Bitmap.CompressFormat.PNG, 100, stream)) throw new IOException("Preview encoding failed");
            stream.getFD().sync();
            output.finishWrite(stream);
            item.put("previewPath", Uri.fromFile(output.getBaseFile()).toString())
                .put("previewWidth", preview.getWidth()).put("previewHeight", preview.getHeight()).put("copyState", "complete");
        } catch (IOException error) {
            if (stream != null) output.failWrite(stream);
            throw error;
        } finally {
            preview.recycle();
        }
    }

    static int previewSample(int width, int height) {
        int sample = 1;
        while ((long) Math.ceil((double) width / sample) * Math.ceil((double) height / sample) > 4L * 1024 * 1024
            || Math.ceil((double) width / sample) > 2048 || Math.ceil((double) height / sample) > 8192) sample *= 2;
        return sample;
    }

    private String copy(Uri uri, File output) throws IOException {
        MessageDigest digest = sha256();
        try (InputStream input = resolver.openInputStream(uri); FileOutputStream stream = new FileOutputStream(output)) {
            if (input == null) throw new IOException("Source unavailable");
            byte[] buffer = new byte[64 * 1024];
            long count = 0;
            int read;
            while ((read = input.read(buffer)) != -1) {
                count += read;
                if (count > MAX_FILE_BYTES) throw new UserInputException("图片超过20 MiB，请分段截图后导入");
                digest.update(buffer, 0, read);
                stream.write(buffer, 0, read);
            }
            stream.getFD().sync();
            return hex(digest.digest());
        }
    }

    private static BitmapFactory.Options inspect(File file) throws IOException {
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(file.getAbsolutePath(), options);
        if (!"image/png".equals(options.outMimeType) && !"image/jpeg".equals(options.outMimeType)) {
            throw new UserInputException("仅支持PNG或JPEG图片");
        }
        if (options.outWidth < 1 || options.outHeight < 1 || options.outWidth > MAX_WIDTH
            || options.outHeight > MAX_HEIGHT || (long) options.outWidth * options.outHeight > 180_000_000) {
            throw new UserInputException("图片尺寸过大或无法读取，请分段截图后导入");
        }
        return options;
    }

    private static void fillImageMetadata(JSONObject item, File image, BitmapFactory.Options bounds, String hash)
        throws JSONException {
        item.put("imagePath", Uri.fromFile(image).toString()).put("width", bounds.outWidth)
            .put("height", bounds.outHeight).put("sha256", hash).put("status", "pending")
            .put("mimeType", bounds.outMimeType).put("sizeBytes", image.length()).put("copyState", "copying");
    }

    private String displayName(Uri uri) {
        try (Cursor cursor = resolver.query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                String name = cursor.getString(0);
                if (name != null && !name.trim().isEmpty()) return name.replaceAll("[\\\\/\\p{Cntrl}]", "_").substring(0, Math.min(name.length(), 120));
            }
        } catch (RuntimeException ignored) { /* Providers may omit a display name. */ }
        return "工资截图";
    }

    private JSONObject read(String id) throws IOException, JSONException {
        AtomicFile file = new AtomicFile(new File(directory(id), "item.json"));
        if (!file.getBaseFile().isFile() && !new File(file.getBaseFile() + ".bak").isFile()) {
            throw new UserInputException("未找到这条导入记录");
        }
        JSONObject item = new JSONObject(new String(file.readFully(), StandardCharsets.UTF_8));
        if (!id.equals(item.optString("id"))) throw new UserInputException("这条记录的索引不完整");
        return item;
    }

    private void write(JSONObject item) throws IOException, JSONException {
        JSONObject metadata = new JSONObject(item.toString());
        metadata.remove("captureJson");
        AtomicFile file = new AtomicFile(new File(directory(item.getString("id")), "item.json"));
        writeBytes(file, metadata.toString().getBytes(StandardCharsets.UTF_8));
    }

    private static void writeBytes(AtomicFile file, byte[] bytes) throws IOException {
        FileOutputStream output = null;
        try {
            output = file.startWrite();
            output.write(bytes);
            output.getFD().sync();
            file.finishWrite(output);
        } catch (IOException error) {
            if (output != null) file.failWrite(output);
            throw error;
        }
    }

    private File sourceFile(JSONObject item) throws IOException, JSONException {
        return new File(directory(item.getString("id")), "feishu-text".equals(item.optString("sourceKind"))
            ? "original.salary.json" : "original.image");
    }

    private JSONObject withCapture(JSONObject item) throws JSONException {
        if ("feishu-text".equals(item.optString("sourceKind")) && "complete".equals(item.optString("copyState"))) {
            try { item.put("captureJson", readCapture(sourceFile(item))); }
            catch (IOException error) {
                item.put("status", "error").put("error", "本机工资文件读取失败，请重新导入");
            }
        }
        return item;
    }

    private static String readCapture(File file) throws IOException {
        try (InputStream input = new FileInputStream(file)) { return CaptureFile.decode(CaptureFile.readBytes(input)); }
    }

    private File directory(String id) throws IOException {
        if (!validId(id)) throw new UserInputException("导入记录编号无效");
        return new File(root, id);
    }

    static boolean validId(String id) {
        return id != null && id.matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");
    }

    private static void ensureDirectory(File directory) throws IOException {
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Storage unavailable");
    }

    private static String digest(File file) throws IOException {
        MessageDigest digest = sha256();
        try (InputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) != -1) digest.update(buffer, 0, read);
        }
        return hex(digest.digest());
    }

    private static MessageDigest sha256() {
        try { return MessageDigest.getInstance("SHA-256"); }
        catch (NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }

    private static String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) result.append(String.format(Locale.ROOT, "%02x", value & 0xff));
        return result.toString();
    }

    private static String now() {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format.format(new Date());
    }

    static String friendlyImportError(Exception error) {
        return error instanceof UserInputException ? error.getMessage() : "保存未完成，请检查文件访问权限和存储空间后重试";
    }

    static final class UserInputException extends IOException {
        UserInputException(String message) { super(message); }
    }
}
