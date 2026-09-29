package com.flylabs.salary;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONObject;
import org.json.JSONArray;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

@CapacitorPlugin(name = "SalaryNative")
public class SalaryNativePlugin extends Plugin {
    private ImportStore store;
    private LedgerStore ledger;
    private SyncCredentialStore credentials;
    private WebDavClient webdav;
    private final ReleaseClient releases = new ReleaseClient();
    private final ExecutorService storageExecutor = Executors.newSingleThreadExecutor();
    private final ExecutorService networkExecutor = Executors.newSingleThreadExecutor();
    private final AtomicBoolean pickerOpen = new AtomicBoolean(false);

    @Override
    public void load() {
        store = new ImportStore(getContext().getApplicationContext());
        ledger = new LedgerStore(getContext().getApplicationContext());
        credentials = new SyncCredentialStore(getContext().getApplicationContext());
        webdav = new WebDavClient();
        // BridgeActivity delivers the cold-start intent through handleOnNewIntent after plugin loading.
    }

    @PluginMethod
    public void listImports(PluginCall call) {
        storageExecutor.execute(() -> {
            try { call.resolve(new JSObject().put("items", store.list())); }
            catch (Exception error) { reject(call, "读取本机档案失败，请重试", "READ_FAILED"); }
        });
    }

    @PluginMethod
    public void loadLedger(PluginCall call) {
        storageExecutor.execute(() -> {
            try {
                String content = ledger.load();
                call.resolve(new JSObject().put("content", content == null ? JSONObject.NULL : content));
            }
            catch (Exception error) { rejectSafe(call, error, "读取本机账本失败，原文件已保留", "LEDGER_READ_FAILED"); }
        });
    }

    @PluginMethod
    public void saveLedger(PluginCall call) {
        String content = call.getString("content");
        storageExecutor.execute(() -> {
            try { ledger.save(content); call.resolve(); }
            catch (Exception error) { rejectSafe(call, error, "保存账本失败，原文件已保留", "LEDGER_SAVE_FAILED"); }
        });
    }

    @PluginMethod
    public void restoreLedger(PluginCall call) {
        String content = call.getString("content");
        storageExecutor.execute(() -> {
            try { ledger.restore(content); call.resolve(); }
            catch (Exception error) { rejectSafe(call, error, "恢复账本未完成，原文件已保留", "LEDGER_RESTORE_FAILED"); }
        });
    }

    @PluginMethod
    public void getSyncSettings(PluginCall call) {
        storageExecutor.execute(() -> {
            try {
                SyncCredentialStore.Credentials value = credentials.load();
                call.resolve(new JSObject().put("configured", value != null).put("username", value == null ? "" : value.username));
            } catch (Exception error) { reject(call, "同步凭据无法读取，请重新配置", "SYNC_SETTINGS_FAILED"); }
        });
    }

    @PluginMethod
    public void setSyncSettings(PluginCall call) {
        String username = call.getString("username");
        String password = call.getString("password");
        storageExecutor.execute(() -> {
            try { credentials.save(username, password); call.resolve(); }
            catch (Exception error) { rejectSafe(call, error, "同步凭据保存失败，请重试", "SYNC_SETTINGS_FAILED"); }
        });
    }

    @PluginMethod
    public void clearSyncSettings(PluginCall call) {
        storageExecutor.execute(() -> {
            try { credentials.clear(); call.resolve(); }
            catch (Exception error) { reject(call, "同步凭据清除失败，请重试", "SYNC_SETTINGS_FAILED"); }
        });
    }

    @PluginMethod
    public void checkForUpdates(PluginCall call) {
        networkExecutor.execute(() -> {
            try {
                ReleaseClient.Result result = releases.check();
                call.resolve(new JSObject().put("status", result.status)
                    .put("content", result.content == null ? JSONObject.NULL : result.content));
            } catch (Exception error) { reject(call, "检查更新失败，请稍后重试", "UPDATE_CHECK_FAILED"); }
        });
    }

    @PluginMethod
    public void openExternal(PluginCall call) {
        String url = call.getString("url");
        if (!ReleaseClient.isReleaseUrl(url)) { reject(call, "此更新地址不受支持", "UPDATE_URL_INVALID"); return; }
        getActivity().runOnUiThread(() -> {
            try {
                getActivity().startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE));
                call.resolve();
            } catch (RuntimeException error) { reject(call, "无法打开浏览器，请检查是否已安装浏览器", "BROWSER_UNAVAILABLE"); }
        });
    }

    @PluginMethod
    public void webdavPull(PluginCall call) {
        networkExecutor.execute(() -> {
            try {
                SyncCredentialStore.Credentials value = requireCredentials();
                JSONArray files = new JSONArray();
                for (WebDavClient.RemoteFile file : webdav.pull(value.username, value.password)) {
                    LedgerFile.archiveBytes(file.content);
                    files.put(new JSONObject().put("name", file.name).put("content", file.content));
                }
                call.resolve(new JSObject().put("files", files));
            } catch (Exception error) { rejectSafe(call, error, "读取坚果云失败或超时，本机数据未改动", "SYNC_READ_FAILED"); }
        });
    }

    @PluginMethod
    public void webdavPublish(PluginCall call) {
        String content = call.getString("content");
        networkExecutor.execute(() -> {
            try {
                byte[] bytes = LedgerFile.archiveBytes(content);
                SyncCredentialStore.Credentials value = requireCredentials();
                webdav.publish(bytes, value.username, value.password);
                call.resolve();
            } catch (Exception error) { rejectSafe(call, error, "写入坚果云失败或超时，请重新同步确认", "SYNC_WRITE_FAILED"); }
        });
    }

    private SyncCredentialStore.Credentials requireCredentials() throws Exception {
        SyncCredentialStore.Credentials value = credentials.load();
        if (value == null) throw new ImportStore.UserInputException("请先配置坚果云账号和应用密码");
        return value;
    }

    @PluginMethod
    public void listPendingDataFiles(PluginCall call) {
        storageExecutor.execute(() -> {
            try { call.resolve(new JSObject().put("files", ledger.listPending())); }
            catch (Exception error) { rejectSafe(call, error, "读取待导入文件失败，原文件已保留", "PENDING_READ_FAILED"); }
        });
    }

    @PluginMethod
    public void ackDataFile(PluginCall call) {
        String id = call.getString("pendingId");
        storageExecutor.execute(() -> {
            try { ledger.acknowledge(id); call.resolve(); }
            catch (Exception error) { rejectSafe(call, error, "确认导入失败，原文件已保留", "PENDING_ACK_FAILED"); }
        });
    }

    @PluginMethod
    public void pickDataFile(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
        intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"application/json", "application/vnd.salary.archive+json",
            "application/vnd.salary.capture+json", "text/plain", "application/octet-stream"});
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        openPicker(call, intent, "dataSelected");
    }

    @ActivityCallback
    private void dataSelected(PluginCall call, ActivityResult result) {
        pickerOpen.set(false);
        Uri uri = selectedUri(result);
        if (uri == null) {
            if (call != null) call.resolve(new JSObject().put("cancelled", true));
            return;
        }
        storageExecutor.execute(() -> {
            try {
                JSONObject pending = ledger.pending(ledger.readUri(uri));
                if (call != null) call.resolve(JSObject.fromJSONObject(pending));
                else notifyImport(JSObject.fromJSONObject(pending));
            } catch (Exception error) {
                String message = safeMessage(error, "保存待导入文件失败，请重试");
                if (call != null) reject(call, message, "IMPORT_FAILED");
                else emitImportError(message, "IMPORT_FAILED");
            }
        });
    }

    @PluginMethod
    public void exportDataFile(PluginCall call) {
        storageExecutor.execute(() -> {
            try {
                LedgerFile.archiveBytes(call.getString("content"));
                String name = call.getString("fileName", "salary-archive.json");
                if (name == null || name.trim().isEmpty() || name.length() > 120 || name.matches("(?s).*[\\\\/\\p{Cntrl}].*")) name = "salary-archive.json";
                if (!name.toLowerCase(java.util.Locale.ROOT).endsWith(".json")) name += ".json";
                Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                    .setType("application/json").putExtra(Intent.EXTRA_TITLE, name);
                intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                openPicker(call, intent, "exportSelected");
            } catch (Exception error) { rejectSafe(call, error, "无法准备导出文件", "EXPORT_FAILED"); }
        });
    }

    @ActivityCallback
    private void exportSelected(PluginCall call, ActivityResult result) {
        pickerOpen.set(false);
        if (call == null) { emitImportError("导出已中断，请重新导出", "EXPORT_INTERRUPTED"); return; }
        Uri uri = selectedUri(result);
        if (uri == null) { call.resolve(new JSObject().put("cancelled", true)); return; }
        storageExecutor.execute(() -> {
            try { ledger.export(uri, call.getString("content")); call.resolve(); }
            catch (Exception error) { rejectSafe(call, error, "导出未完成，请检查文件访问权限和空间后重试", "EXPORT_FAILED"); }
        });
    }

    private void openPicker(PluginCall call, Intent intent, String callback) {
        if (!pickerOpen.compareAndSet(false, true)) { reject(call, "文件选择器已打开", "PICKER_BUSY"); return; }
        getActivity().runOnUiThread(() -> {
            try { startActivityForResult(call, intent, callback); }
            catch (RuntimeException error) {
                pickerOpen.set(false);
                reject(call, "无法打开系统文件选择器", "PICKER_UNAVAILABLE");
            }
        });
    }

    @PluginMethod
    public void pickCaptureFile(PluginCall call) {
        if (!pickerOpen.compareAndSet(false, true)) {
            reject(call, "文件选择器已打开", "PICKER_BUSY");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"application/json", "application/vnd.salary.capture+json", "text/plain", "application/octet-stream"});
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        getActivity().runOnUiThread(() -> {
            try { startActivityForResult(call, intent, "captureSelected"); }
            catch (RuntimeException error) {
                pickerOpen.set(false);
                reject(call, "无法打开系统文件选择器", "PICKER_UNAVAILABLE");
            }
        });
    }

    @ActivityCallback
    private void captureSelected(PluginCall call, ActivityResult result) {
        pickerOpen.set(false);
        Uri uri = selectedUri(result);
        if (uri == null) {
            if (call != null) call.resolve(new JSObject().put("cancelled", true));
            return;
        }
        // The callback can be restored after process recreation even when the original JS call is gone.
        importCapture(uri, null, call);
    }

    static Uri selectedUri(ActivityResult result) {
        return result.getResultCode() == Activity.RESULT_OK && result.getData() != null ? result.getData().getData() : null;
    }

    @PluginMethod
    public void saveDraft(PluginCall call) {
        String id = call.getString("id");
        JSONObject draft = call.getObject("draft");
        storageExecutor.execute(() -> {
            try { call.resolve(new JSObject().put("item", store.saveDraft(id, draft))); }
            catch (Exception error) { reject(call, ImportStore.friendlyImportError(error), "SAVE_FAILED"); }
        });
    }

    @PluginMethod
    public void deleteImport(PluginCall call) {
        String id = call.getString("id");
        storageExecutor.execute(() -> {
            try { call.resolve(new JSObject().put("item", store.deleteImport(id))); }
            catch (Exception error) { reject(call, ImportStore.friendlyImportError(error), "DELETE_FAILED"); }
        });
    }

    @PluginMethod
    public void restoreImport(PluginCall call) {
        String id = call.getString("id");
        storageExecutor.execute(() -> {
            try { call.resolve(new JSObject().put("item", store.restoreImport(id))); }
            catch (Exception error) { reject(call, ImportStore.friendlyImportError(error), "RESTORE_FAILED"); }
        });
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        receiveShare(intent);
    }

    private void receiveShare(Intent intent) {
        if (intent == null || (!Intent.ACTION_SEND.equals(intent.getAction()) && !Intent.ACTION_VIEW.equals(intent.getAction()))) return;
        Uri uri = sharedUri(intent);
        if (uri == null) {
            CharSequence text = Intent.ACTION_SEND.equals(intent.getAction()) ? intent.getCharSequenceExtra(Intent.EXTRA_TEXT) : null;
            if (text != null && (CaptureFile.accepts(intent.getType(), null) || "application/vnd.salary.archive+json".equals(intent.getType()))) {
                receiveData(null, text.toString());
                return;
            }
            emitImportError("没有收到工资文件，请重新分享", "SHARE_EMPTY");
            return;
        }
        // Start the private copy while the incoming URI grant is valid. Hashing makes redelivery idempotent.
        receiveData(uri, null);
    }

    private void receiveData(Uri uri, String text) {
        storageExecutor.execute(() -> {
            try {
                String content = uri != null ? ledger.readUri(uri) : text;
                LedgerFile.bytes(content);
                if ("salary-capture".equals(LedgerFile.format(content))) {
                    JSONArray items = store.importCaptureText(content);
                    JSONArray ids = new JSONArray();
                    for (int i = 0; i < items.length(); i++) ids.put(items.getJSONObject(i).getString("id"));
                    notifyImport(new JSObject().put("ids", ids).put("id", ids.optString(0)));
                } else notifyImport(JSObject.fromJSONObject(ledger.pending(content)));
            } catch (Exception error) { emitImportError(safeMessage(error, "保存工资文件失败，请重试"), "IMPORT_FAILED"); }
        });
    }

    private void notifyImport(JSObject value) {
        getActivity().runOnUiThread(() -> notifyListeners("importReceived", value, true));
    }

    static Uri sharedUri(Intent intent) {
        if (Intent.ACTION_VIEW.equals(intent.getAction())) return intent.getData();
        if (!Intent.ACTION_SEND.equals(intent.getAction())) return null;
        Uri uri = Build.VERSION.SDK_INT >= 33
            ? intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class)
            : intent.getParcelableExtra(Intent.EXTRA_STREAM);
        if (uri == null && intent.getClipData() != null && intent.getClipData().getItemCount() > 0) {
            uri = intent.getClipData().getItemAt(0).getUri();
        }
        return uri;
    }

    private void importCapture(Uri uri, String text, PluginCall call) {
        storageExecutor.execute(() -> {
            try {
                JSONArray items = uri != null ? store.importCapture(uri) : store.importCaptureText(text);
                JSONArray ids = new JSONArray();
                for (int i = 0; i < items.length(); i++) ids.put(items.getJSONObject(i).getString("id"));
                if (call != null) call.resolve(new JSObject().put("items", items));
                getActivity().runOnUiThread(() -> notifyListeners("importReceived", new JSObject()
                    .put("ids", ids).put("id", ids.optString(0)), true));
            } catch (Exception error) {
                String message = ImportStore.friendlyImportError(error);
                if (call != null) reject(call, message, "IMPORT_FAILED");
                emitImportError(message, "IMPORT_FAILED");
            }
        });
    }

    private void emitImportError(String message, String code) {
        getActivity().runOnUiThread(() -> notifyListeners("importReceived", new JSObject().put("error", message).put("errorCode", code), true));
    }

    private static void reject(PluginCall call, String message, String code) {
        // Do not attach provider exceptions: they can contain private paths or salary content.
        call.reject(message, code);
    }

    private static String safeMessage(Exception error, String fallback) {
        return error instanceof ImportStore.UserInputException ? error.getMessage() : fallback;
    }

    private static void rejectSafe(PluginCall call, Exception error, String fallback, String code) {
        reject(call, safeMessage(error, fallback), code);
    }

    @Override
    protected void handleOnDestroy() {
        // Allow a file copy already in progress to finish; private metadata makes it discoverable on restart.
        storageExecutor.shutdown();
        networkExecutor.shutdown();
    }
}
