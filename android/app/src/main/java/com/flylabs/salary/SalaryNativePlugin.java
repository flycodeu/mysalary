package com.flylabs.salary;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import java.io.File;
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
    private EvidenceStore evidence;
    private SyncCredentialStore credentials;
    private WebDavClient webdav;
    private final ReleaseClient releases = new ReleaseClient();
    private UpdateDownloadManager updateDownloads;
    private volatile String pendingInstallVersion;
    private final ExecutorService storageExecutor = Executors.newSingleThreadExecutor();
    private final ExecutorService networkExecutor = Executors.newSingleThreadExecutor();
    private final AtomicBoolean pickerOpen = new AtomicBoolean(false);

    @Override
    public void load() {
        store = new ImportStore(getContext().getApplicationContext());
        ledger = new LedgerStore(getContext().getApplicationContext());
        credentials = new SyncCredentialStore(getContext().getApplicationContext());
        webdav = new WebDavClient();
        updateDownloads = new UpdateDownloadManager(getContext(), new okhttp3.OkHttpClient.Builder()
            .followRedirects(true).followSslRedirects(true).retryOnConnectionFailure(false)
            .connectTimeout(15, java.util.concurrent.TimeUnit.SECONDS)
            .readTimeout(30, java.util.concurrent.TimeUnit.SECONDS)
            .callTimeout(6, java.util.concurrent.TimeUnit.MINUTES).build());
        // BridgeActivity delivers the cold-start intent through handleOnNewIntent after plugin loading.
    }

    @PluginMethod
    public void getAppSettings(PluginCall call) {
        storageExecutor.execute(() -> {
            try {
                android.content.SharedPreferences settings = getContext().getSharedPreferences("app-settings", android.content.Context.MODE_PRIVATE);
                // A malformed older preference keeps confirmation enabled.
                Object stored = settings.getAll().get("confirmExit");
                boolean confirmExit = stored instanceof Boolean ? (Boolean)stored : true;
                call.resolve(new JSObject().put("confirmExit", confirmExit));
            } catch (RuntimeException error) { reject(call, "设置暂时无法读取", "SETTINGS_READ_FAILED"); }
        });
    }

    @PluginMethod
    public void setAppSettings(PluginCall call) {
        Boolean confirmExit = call.getBoolean("confirmExit");
        if (confirmExit == null) { reject(call, "设置内容无效", "SETTINGS_INVALID"); return; }
        storageExecutor.execute(() -> {
            try {
                boolean saved = getContext().getSharedPreferences("app-settings", android.content.Context.MODE_PRIVATE)
                    .edit().putBoolean("confirmExit", confirmExit).commit();
                if (saved) call.resolve();
                else reject(call, "设置未保存，请重试", "SETTINGS_SAVE_FAILED");
            } catch (RuntimeException error) { reject(call, "设置未保存，请重试", "SETTINGS_SAVE_FAILED"); }
        });
    }

    @PluginMethod
    public void exitApp(PluginCall call) {
        // A confirmed exit waits for already queued private file writes to finish.
        storageExecutor.execute(() -> getActivity().runOnUiThread(() -> {
            call.resolve();
            getActivity().finish();
        }));
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
    public void getUpdateDownloadStatus(PluginCall call) {
        call.resolve(updateState(updateDownloads.status()));
    }

    @PluginMethod
    public void downloadUpdate(PluginCall call) {
        String version = call.getString("version");
        networkExecutor.execute(() -> {
            try { call.resolve(updateState(updateDownloads.downloadBlocking(version))); }
            catch (Exception error) { call.resolve(updateState(UpdateDownloadManager.DownloadState.error("更新下载或校验失败，请重试"))); }
        });
    }

    @PluginMethod
    public void cancelUpdateDownload(PluginCall call) {
        updateDownloads.cancel();
        call.resolve();
    }

    @PluginMethod
    public void installUpdate(PluginCall call) {
        String version = call.getString("version");
        File apk = updateDownloads.readyFile(version);
        if (apk == null) { call.reject("请先下载并校验更新包", "UPDATE_NOT_READY"); return; }
        if (Build.VERSION.SDK_INT >= 26 && !getContext().getPackageManager().canRequestPackageInstalls()) {
            pendingInstallVersion = version;
            Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + getContext().getPackageName()));
            try { getActivity().startActivity(settings); } catch (RuntimeException ignored) { }
            call.resolve(new JSObject().put("state", "permission-required"));
            return;
        }
        try {
            openInstaller(apk);
            call.resolve(new JSObject().put("state", "installer-opened"));
        } catch (Exception error) { call.reject("无法打开系统安装器，请重试", "INSTALLER_UNAVAILABLE"); }
    }

    private JSObject updateState(UpdateDownloadManager.DownloadState value) {
        JSObject result = new JSObject().put("state", value.state);
        if (value.version != null) result.put("version", value.version);
        if (value.totalBytes > 0) result.put("totalBytes", value.totalBytes);
        if (value.receivedBytes > 0) result.put("receivedBytes", value.receivedBytes);
        if (value.error != null) result.put("error", value.error);
        return result;
    }

    private void openInstaller(File apk) {
        Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".update-provider", apk);
        Intent intent = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        getActivity().startActivity(intent);
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        String version = pendingInstallVersion;
        if (version == null || Build.VERSION.SDK_INT < 26 || !getContext().getPackageManager().canRequestPackageInstalls()) return;
        File apk = updateDownloads.readyFile(version);
        pendingInstallVersion = null;
        if (apk == null) return;
        try { openInstaller(apk); } catch (RuntimeException ignored) { }
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

    private synchronized EvidenceStore evidence() throws java.io.IOException {
        if (evidence == null) evidence = new EvidenceStore(getContext().getFilesDir());
        return evidence;
    }

    @PluginMethod
    public void webdavListEvidence(PluginCall call) {
        networkExecutor.execute(() -> {
            try {
                SyncCredentialStore.Credentials value = requireCredentials();
                JSONArray items = new JSONArray();
                for (WebDavClient.RemoteEvidence item : webdav.listEvidence(value.username, value.password))
                    items.put(new JSONObject().put("recordId", item.recordId).put("id", item.id).put("mimeType", item.mimeType));
                JSONArray deleted = new JSONArray();
                for (WebDavClient.RemoteDeletion item : webdav.listDeletedEvidence(value.username, value.password))
                    deleted.put(new JSONObject().put("recordId", item.recordId).put("id", item.id));
                call.resolve(new JSObject().put("items", items).put("deleted", deleted));
            } catch (Exception error) { rejectSafe(call, error, "读取云端原图失败，请重试", "EVIDENCE_SYNC_READ_FAILED"); }
        });
    }

    @PluginMethod
    public void webdavGetEvidence(PluginCall call) {
        networkExecutor.execute(() -> {
            try {
                SyncCredentialStore.Credentials value = requireCredentials();
                String recordId = call.getString("recordId"), id = call.getString("id"), mimeType = call.getString("mimeType");
                byte[] bytes = webdav.getEvidence(recordId, id, mimeType, value.username, value.password);
                validateEvidenceImage(bytes, mimeType);
                call.resolve(new JSObject().put("item", evidence().add(recordId, bytes, mimeType)));
            } catch (Exception error) { rejectSafe(call, error, "下载原图失败，本机原图已保留", "EVIDENCE_SYNC_READ_FAILED"); }
        });
    }

    @PluginMethod
    public void webdavPutEvidence(PluginCall call) {
        networkExecutor.execute(() -> {
            try {
                SyncCredentialStore.Credentials value = requireCredentials();
                String recordId = call.getString("recordId"), id = call.getString("id");
                webdav.putEvidence(recordId, id, evidence().read(recordId, id), value.username, value.password);
                call.resolve();
            } catch (Exception error) { rejectSafe(call, error, "上传原图失败，本机原图已保留", "EVIDENCE_SYNC_WRITE_FAILED"); }
        });
    }

    @PluginMethod
    public void webdavPutEvidenceDeletion(PluginCall call) {
        networkExecutor.execute(() -> {
            try {
                SyncCredentialStore.Credentials value = requireCredentials();
                webdav.putEvidenceDeletion(call.getString("recordId"), call.getString("id"), value.username, value.password);
                call.resolve();
            } catch (Exception error) { rejectSafe(call, error, "同步截图删除记录失败，请重试", "EVIDENCE_SYNC_WRITE_FAILED"); }
        });
    }

    @PluginMethod
    public void webdavDeleteEvidence(PluginCall call) {
        networkExecutor.execute(() -> {
            try {
                SyncCredentialStore.Credentials value = requireCredentials();
                webdav.deleteEvidence(call.getString("recordId"), call.getString("id"), call.getString("mimeType"), value.username, value.password);
                call.resolve();
            } catch (Exception error) { rejectSafe(call, error, "清理云端截图失败，请重试", "EVIDENCE_SYNC_WRITE_FAILED"); }
        });
    }

    @PluginMethod
    public void listEvidence(PluginCall call) {
        storageExecutor.execute(() -> {
            try { call.resolve(new JSObject().put("items", evidence().list(call.getString("recordId")))); }
            catch (Exception error) { rejectSafe(call, error, "读取原图失败，已有文件已保留", "EVIDENCE_READ_FAILED"); }
        });
    }

    @PluginMethod
    public void listDeletedEvidence(PluginCall call) {
        storageExecutor.execute(() -> {
            try { call.resolve(new JSObject().put("ids", evidence().listDeleted(call.getString("recordId")))); }
            catch (Exception error) { rejectSafe(call, error, "读取截图删除记录失败", "EVIDENCE_READ_FAILED"); }
        });
    }

    @PluginMethod
    public void deleteEvidence(PluginCall call) {
        storageExecutor.execute(() -> {
            try { evidence().delete(call.getString("recordId"), call.getString("id")); call.resolve(); }
            catch (Exception error) { rejectSafe(call, error, "删除截图失败，请重试", "EVIDENCE_DELETE_FAILED"); }
        });
    }

    @PluginMethod
    public void readEvidence(PluginCall call) {
        storageExecutor.execute(() -> {
            try {
                EvidenceStore.ReadResult result = evidence().read(call.getString("recordId"), call.getString("id"));
                call.resolve(new JSObject().put("base64", android.util.Base64.encodeToString(result.bytes, android.util.Base64.NO_WRAP)).put("mimeType", result.mimeType));
            } catch (Exception error) { rejectSafe(call, error, "读取原图失败，已有文件已保留", "EVIDENCE_READ_FAILED"); }
        });
    }

    @PluginMethod
    public void addEvidence(PluginCall call) {
        storageExecutor.execute(() -> {
            try {
                String base64 = call.getString("base64");
                String mimeType = call.getString("mimeType");
                if (base64 == null || base64.length() == 0 || base64.length() > ((EvidenceStore.MAX_BYTES + 2) / 3) * 4)
                    throw new ImportStore.UserInputException("每张原图不能超过 20 MiB");
                if (!("image/png".equals(mimeType) || "image/jpeg".equals(mimeType)))
                    throw new ImportStore.UserInputException("请选择 PNG 或 JPEG 原图");
                byte[] bytes;
                try { bytes = android.util.Base64.decode(base64, android.util.Base64.DEFAULT); }
                catch (IllegalArgumentException error) { throw new ImportStore.UserInputException("原图内容无效"); }
                validateEvidenceImage(bytes, mimeType);
                call.resolve(new JSObject().put("item", evidence().add(call.getString("recordId"), bytes, mimeType)));
            } catch (Exception error) { rejectSafe(call, error, "保存原图失败，请检查空间后重试", "EVIDENCE_SAVE_FAILED"); }
        });
    }

    @PluginMethod
    public void pickEvidence(PluginCall call) {
        try { EvidenceStore.validateRecordId(call.getString("recordId")); }
        catch (Exception error) { rejectSafe(call, error, "工资记录标识无效", "EVIDENCE_PICK_FAILED"); return; }
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("image/*");
        intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"image/png", "image/jpeg"});
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        openPicker(call, intent, "evidenceSelected");
    }

    @ActivityCallback
    private void evidenceSelected(PluginCall call, ActivityResult result) {
        pickerOpen.set(false);
        if (call == null) { emitImportError("原图添加已中断，请重新选择截图", "EVIDENCE_PICK_INTERRUPTED"); return; }
        Uri uri = selectedUri(result);
        if (uri == null) { call.resolve(new JSObject().put("cancelled", true).put("items", new JSONArray())); return; }
        storageExecutor.execute(() -> {
            try {
                if (!"content".equals(uri.getScheme())) throw new ImportStore.UserInputException("请从系统相册或文件中选择原图");
                byte[] bytes;
                // Copy while the temporary grant is valid; retaining a URI would lose the proof later.
                try (java.io.InputStream input = getContext().getContentResolver().openInputStream(uri)) { bytes = EvidenceStore.readInput(input); }
                validateEvidenceImage(bytes, null);
                JSONObject item = evidence().add(call.getString("recordId"), bytes, null);
                call.resolve(new JSObject().put("cancelled", false).put("items", new JSONArray().put(item)));
            } catch (Exception error) { rejectSafe(call, error, "保存原图失败，请检查空间后重试", "EVIDENCE_SAVE_FAILED"); }
        });
    }

    private static void validateEvidenceImage(byte[] bytes, String mimeType) throws java.io.IOException {
        EvidenceStore.ImageInfo expected = EvidenceStore.inspect(bytes, mimeType);
        android.graphics.BitmapFactory.Options bounds = new android.graphics.BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);
        if (bounds.outWidth != expected.width || bounds.outHeight != expected.height)
            throw new ImportStore.UserInputException("图片损坏或格式不受支持，请重新选择原图");
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
        if (updateDownloads != null) updateDownloads.cancel();
    }
}
