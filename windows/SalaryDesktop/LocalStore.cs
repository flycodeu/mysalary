using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

namespace SalaryDesktop
{
    internal static class JsonData
    {
        public const int MaxBytes = 8 * 1024 * 1024;
        public static JavaScriptSerializer Serializer() { return new JavaScriptSerializer { MaxJsonLength = MaxBytes * 5, RecursionLimit = 128 }; }
        public static void Validate(string content)
        {
            if (content == null || Encoding.UTF8.GetByteCount(content) > MaxBytes) throw new UserError("文件不能超过 8 MiB。");
            try { if (!(Serializer().DeserializeObject(content) is Dictionary<string, object>)) throw new Exception(); }
            catch (Exception) { throw new UserError("文件不是有效的数据档案。"); }
        }
        public static string Read(string path)
        {
            using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                if (stream.Length > MaxBytes) throw new UserError("文件不能超过 8 MiB。");
                using (var reader = new StreamReader(stream, new UTF8Encoding(false, true), true))
                {
                    var content = reader.ReadToEnd();
                    Validate(content);
                    return content;
                }
            }
        }
        public static void WriteAtomic(string path, byte[] bytes, string backup)
        {
            var temp = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                using (var stream = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    stream.Write(bytes, 0, bytes.Length);
                    stream.Flush(true);
                }
                if (File.Exists(path)) File.Replace(temp, path, backup);
                else File.Move(temp, path);
            }
            finally { if (File.Exists(temp)) File.Delete(temp); }
        }
    }

    internal sealed class UserError : Exception
    {
        public UserError(string message) : base(message) { }
    }

    internal sealed class SyncCredentials
    {
        public string Username { get; set; }
        public string Password { get; set; }
    }

    internal sealed class LocalStore
    {
        public readonly string DirectoryPath;
        private readonly object gate = new object();
        private readonly byte[] entropy = Encoding.UTF8.GetBytes("SalaryTrail.Desktop.WebDAV.v1");
        public LocalStore(string directory)
        {
            DirectoryPath = directory;
            Directory.CreateDirectory(directory);
        }
        public string LoadLedger()
        {
            lock (gate)
            {
                var path = Path.Combine(DirectoryPath, "archive-v1.json");
                var backup = path + ".bak";
                if (!File.Exists(path))
                {
                    if (File.Exists(backup)) throw new UserError("本机档案无法读取，备份仍保留，请保留数据文件后检查。");
                    return null;
                }
                try { return JsonData.Read(path); }
                catch (Exception)
                {
                    throw new UserError("本机档案无法读取，请保留数据文件及备份后检查。");
                }
            }
        }
        public void SaveLedger(string content)
        {
            JsonData.Validate(content);
            lock (gate)
            {
                var path = Path.Combine(DirectoryPath, "archive-v1.json");
                JsonData.WriteAtomic(path, Encoding.UTF8.GetBytes(content), path + ".bak");
            }
        }
        public void RestoreLedger(string content)
        {
            JsonData.Validate(content);
            var data = JsonData.Serializer().DeserializeObject(content) as Dictionary<string, object>;
            object format, version, entries;
            if (data == null || data.Count != 3 || !data.TryGetValue("format", out format) || !(format is string) || (string)format != "salary-archive"
                || !data.TryGetValue("version", out version) || !(version is int) || (int)version != 1
                || !data.TryGetValue("entries", out entries) || !(entries is object[]) || ((object[])entries).Length > 1200)
                throw new UserError("恢复文件不是受支持的薪迹档案备份。");
            foreach (var entry in (object[])entries) if (!(entry is Dictionary<string, object>)) throw new UserError("恢复文件中的档案条目不完整。");
            lock (gate)
            {
                var path = Path.Combine(DirectoryPath, "archive-v1.json");
                var backup = path + ".bak";
                var recovery = Path.Combine(DirectoryPath, "Recovery", DateTime.UtcNow.ToString("yyyyMMdd-HHmmss-fff") + "-" + Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(recovery);
                // Both old files must be durably preserved before replacing the current ledger.
                foreach (var existing in new[] { path, backup })
                {
                    if (!File.Exists(existing)) continue;
                    var preserved = Path.Combine(recovery, Path.GetFileName(existing));
                    File.Copy(existing, preserved, false);
                    using (var stream = new FileStream(preserved, FileMode.Open, FileAccess.Write, FileShare.None)) stream.Flush(true);
                }
                JsonData.WriteAtomic(path, Encoding.UTF8.GetBytes(content), null);
            }
        }
        public void SaveSource(string content)
        {
            JsonData.Validate(content);
            lock (gate)
            {
                var directory = Path.Combine(DirectoryPath, "Sources");
                Directory.CreateDirectory(directory);
                var path = Path.Combine(directory, "feishu-" + DateTime.UtcNow.ToString("yyyyMMdd-HHmmss-fff") + "-" + Guid.NewGuid().ToString("N") + ".salary.json");
                JsonData.WriteAtomic(path, Encoding.UTF8.GetBytes(content), null);
            }
        }
        public void SaveCredentials(string username, string password)
        {
            username = (username ?? "").Trim();
            if (username.Length == 0 || username.Length > 320 || username.IndexOf(':') >= 0 || HasControls(username) || string.IsNullOrEmpty(password) || password.Length > 1024 || HasControls(password))
                throw new UserError("请填写有效的坚果云账号和应用密码。");
            var plaintext = Encoding.UTF8.GetBytes(JsonData.Serializer().Serialize(new SyncCredentials { Username = username, Password = password }));
            try
            {
                var encrypted = ProtectedData.Protect(plaintext, entropy, DataProtectionScope.CurrentUser);
                lock (gate) JsonData.WriteAtomic(Path.Combine(DirectoryPath, "sync-credentials.bin"), encrypted, null);
            }
            finally { Array.Clear(plaintext, 0, plaintext.Length); }
        }
        public SyncCredentials ReadCredentials()
        {
            lock (gate)
            {
                var path = Path.Combine(DirectoryPath, "sync-credentials.bin");
                if (!File.Exists(path)) return null;
                try
                {
                    if (new FileInfo(path).Length > 65536) throw new InvalidDataException();
                    var plaintext = ProtectedData.Unprotect(File.ReadAllBytes(path), entropy, DataProtectionScope.CurrentUser);
                    try { return JsonData.Serializer().Deserialize<SyncCredentials>(Encoding.UTF8.GetString(plaintext)); }
                    finally { Array.Clear(plaintext, 0, plaintext.Length); }
                }
                catch (Exception) { throw new UserError("同步凭据无法解密，请重新设置坚果云账号。"); }
            }
        }
        public void ClearCredentials()
        {
            lock (gate)
            {
                var path = Path.Combine(DirectoryPath, "sync-credentials.bin");
                if (File.Exists(path)) File.Delete(path);
            }
        }
        private static bool HasControls(string value)
        {
            foreach (var c in value) if (char.IsControl(c)) return true;
            return false;
        }
    }
}
