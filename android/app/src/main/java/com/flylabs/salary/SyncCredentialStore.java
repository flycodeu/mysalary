package com.flylabs.salary;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import android.util.Base64;
import org.json.JSONObject;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Only encrypted credentials leave memory; the AES key stays inside AndroidKeyStore. */
final class SyncCredentialStore {
    private static final String DEFAULT_ALIAS = "salary-trail-webdav-v1";
    private static final byte[] AAD = "salary-trail-webdav-v1".getBytes(StandardCharsets.UTF_8);
    private final AtomicFile file;
    private final String alias;

    SyncCredentialStore(Context context) { this(context, DEFAULT_ALIAS); }

    SyncCredentialStore(Context context, String alias) {
        file = new AtomicFile(new File(context.getFilesDir(), "salary-sync/credentials.enc.json"));
        this.alias = alias;
    }

    synchronized Credentials load() throws Exception {
        if (!LedgerStore.exists(file)) return null;
        JSONObject encrypted = new JSONObject(LedgerStore.read(file));
        if (encrypted.getInt("version") != 1) throw new IllegalStateException("Unsupported credential storage");
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        SecretKey key = (SecretKey) store.getKey(alias, null);
        if (key == null) throw new IllegalStateException("Credential key unavailable");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, Base64.decode(encrypted.getString("iv"), Base64.NO_WRAP)));
        cipher.updateAAD(AAD);
        byte[] plaintext = cipher.doFinal(Base64.decode(encrypted.getString("ciphertext"), Base64.NO_WRAP));
        try {
            JSONObject value = new JSONObject(new String(plaintext, StandardCharsets.UTF_8));
            return new Credentials(value.getString("username"), value.getString("password"));
        } finally { java.util.Arrays.fill(plaintext, (byte) 0); }
    }

    synchronized void save(String username, String password) throws Exception {
        if (username == null || username.trim().isEmpty() || username.length() > 320
            || username.matches("(?s).*[\\p{Cntrl}:].*") || password == null || password.isEmpty()
            || password.length() > 1024 || password.matches("(?s).*[\\p{Cntrl}].*")) {
            throw new ImportStore.UserInputException("请输入坚果云账号和应用密码");
        }
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        SecretKey key = (SecretKey) store.getKey(alias, null);
        if (key == null) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256).setRandomizedEncryptionRequired(true).build());
            key = generator.generateKey();
        }
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key);
        cipher.updateAAD(AAD);
        byte[] plaintext = new JSONObject().put("username", username.trim()).put("password", password).toString().getBytes(StandardCharsets.UTF_8);
        byte[] ciphertext;
        try { ciphertext = cipher.doFinal(plaintext); }
        finally { java.util.Arrays.fill(plaintext, (byte) 0); }
        JSONObject encrypted = new JSONObject().put("version", 1)
            .put("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
            .put("ciphertext", Base64.encodeToString(ciphertext, Base64.NO_WRAP));
        LedgerStore.ensure(file.getBaseFile().getParentFile());
        LedgerStore.write(file, encrypted.toString().getBytes(StandardCharsets.UTF_8));
    }

    synchronized void clear() throws Exception {
        file.delete();
        if (LedgerStore.exists(file)) throw new IllegalStateException("Credential deletion failed");
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(alias)) store.deleteEntry(alias);
    }

    static final class Credentials {
        final String username;
        final String password;
        Credentials(String username, String password) { this.username = username; this.password = password; }
    }
}
