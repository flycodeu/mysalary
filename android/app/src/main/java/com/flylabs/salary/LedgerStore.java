package com.flylabs.salary;

import android.content.Context;
import android.net.Uri;
import android.util.AtomicFile;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.Arrays;
import java.util.Comparator;
import java.util.UUID;

/** An independent ledger never rewrites the legacy image and capture archives. */
final class LedgerStore {
    private final Context context;
    private final File root;

    LedgerStore(Context context) {
        this.context = context;
        root = new File(context.getFilesDir(), "salary-ledger");
    }

    synchronized String load() throws IOException {
        AtomicFile ledger = ledger();
        if (!exists(ledger)) {
            if (exists(new AtomicFile(new File(root, "archive-v1.previous.json")))) {
                throw new ImportStore.UserInputException("本机主账本缺失，已有备份已保留，请先恢复账本");
            }
            return null;
        }
        try {
            String content = read(ledger);
            LedgerFile.archiveBytes(content);
            return content;
        } catch (IOException error) {
            throw new ImportStore.UserInputException("本机账本无法读取，原文件与已有备份已保留，请先恢复账本");
        }
    }

    synchronized void save(String content) throws IOException {
        byte[] next = LedgerFile.archiveBytes(content);
        ensure(root);
        String previous = load();
        if (previous != null) write(new AtomicFile(new File(root, "archive-v1.previous.json")), LedgerFile.bytes(previous));
        write(ledger(), next);
    }

    synchronized void restore(String content) throws IOException {
        byte[] next = LedgerFile.archiveBytes(content);
        ensure(root);
        File recovery = new File(root, "recovery-" + System.currentTimeMillis() + "-" + UUID.randomUUID());
        ensure(recovery);
        // Preserve every AtomicFile state before replacement, including an interrupted earlier write.
        for (String name : new String[]{"archive-v1.json", "archive-v1.previous.json"}) {
            for (String suffix : new String[]{"", ".bak", ".new"}) {
                File source = new File(root, name + suffix);
                if (!source.exists()) continue;
                if (!source.isFile()) throw new IOException("Recovery source is not a file");
                try (FileInputStream input = new FileInputStream(source);
                     FileOutputStream output = new FileOutputStream(new File(recovery, name + suffix))) {
                    byte[] buffer = new byte[16384];
                    int count;
                    while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
                    output.getFD().sync();
                }
            }
        }
        write(ledger(), next);
    }

    String readUri(Uri uri) throws IOException {
        if (uri == null || !"content".equals(uri.getScheme())) throw new ImportStore.UserInputException("请选择系统文件中的 JSON 工资文件");
        try (InputStream input = context.getContentResolver().openInputStream(uri)) {
            return CaptureFile.decode(LedgerFile.read(input));
        }
    }

    synchronized JSONObject pending(String content) throws IOException, JSONException {
        byte[] bytes = LedgerFile.bytes(content);
        LedgerFile.format(content);
        File pending = new File(root, "pending");
        ensure(pending);
        String id = UUID.randomUUID().toString();
        write(new AtomicFile(new File(pending, id + ".json")), bytes);
        return new JSONObject().put("content", content).put("pendingId", id);
    }

    synchronized JSONArray listPending() throws IOException, JSONException {
        File pending = new File(root, "pending");
        ensure(pending);
        File[] files = pending.listFiles((directory, name) -> name.endsWith(".json"));
        if (files == null) throw new IOException("Pending directory unavailable");
        Arrays.sort(files, Comparator.comparingLong(File::lastModified));
        JSONArray result = new JSONArray();
        for (File file : files) {
            String id = file.getName().substring(0, file.getName().length() - 5);
            if (!ImportStore.validId(id)) continue;
            result.put(new JSONObject().put("pendingId", id).put("content", read(new AtomicFile(file))));
        }
        return result;
    }

    synchronized void acknowledge(String id) throws IOException {
        if (!ImportStore.validId(id)) throw new ImportStore.UserInputException("待导入文件编号无效");
        if (load() == null) throw new ImportStore.UserInputException("请先保存账本，再确认文件导入完成");
        AtomicFile file = new AtomicFile(new File(new File(root, "pending"), id + ".json"));
        file.delete();
        if (exists(file)) throw new IOException("Pending deletion failed");
    }

    void export(Uri uri, String content) throws IOException {
        byte[] bytes = LedgerFile.archiveBytes(content);
        if (uri == null || !"content".equals(uri.getScheme())) throw new ImportStore.UserInputException("导出位置无效，请重新选择");
        try (java.io.OutputStream output = context.getContentResolver().openOutputStream(uri, "wt")) {
            if (output == null) throw new IOException("Export destination unavailable");
            output.write(bytes);
            output.flush();
        }
    }

    private AtomicFile ledger() { return new AtomicFile(new File(root, "archive-v1.json")); }

    static boolean exists(AtomicFile file) {
        return file.getBaseFile().isFile() || new File(file.getBaseFile() + ".bak").isFile();
    }

    static String read(AtomicFile file) throws IOException {
        try (FileInputStream input = file.openRead()) { return CaptureFile.decode(LedgerFile.read(input)); }
    }

    static void write(AtomicFile file, byte[] bytes) throws IOException {
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

    static void ensure(File directory) throws IOException {
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Private storage unavailable");
    }
}
