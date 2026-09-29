using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace SalaryDesktop
{
    // Image bytes live outside the ledger so record edits, trash and upgrades cannot replace the evidence.
    internal sealed class EvidenceStore
    {
        internal const int MaxBytes = 20 * 1024 * 1024;
        internal const int MaxDimension = 32768;
        internal const long MaxPixels = 40000000;
        private readonly string root;
        private readonly object gate = new object();

        internal EvidenceStore(string dataDirectory) { root = Path.GetFullPath(Path.Combine(dataDirectory, "evidence")); }

        internal static void ValidateRecordId(string recordId)
        {
            if (recordId == null || !Regex.IsMatch(recordId, "\\A[A-Za-z0-9_-]{1,96}\\z")) throw new UserError("工资记录标识无效。");
        }

        private static void ValidateId(string id)
        {
            if (id == null || !Regex.IsMatch(id, "\\A[a-f0-9]{64}\\z")) throw new UserError("原图标识无效。");
        }

        internal static byte[] Decode(string base64)
        {
            if (base64 == null || base64.Length == 0 || base64.Length > ((MaxBytes + 2) / 3) * 4) throw new UserError("每张原图不能超过 20 MiB。");
            byte[] bytes;
            try { bytes = Convert.FromBase64String(base64); }
            catch (FormatException) { throw new UserError("原图内容无效。"); }
            if (bytes.Length == 0 || bytes.Length > MaxBytes) throw new UserError("每张原图不能超过 20 MiB。");
            return bytes;
        }

        internal Dictionary<string, object> Add(string recordId, byte[] bytes, string mimeType)
        {
            ValidateRecordId(recordId);
            var image = Inspect(bytes, mimeType);
            var id = Hash(bytes);
            lock (gate)
            {
                var directory = RecordDirectory(recordId, true);
                var metadata = Child(directory, id + ".json");
                if (File.Exists(Child(directory, id + ".deleted"))) throw new UserError("这张截图已删除，不能重复添加。");
                if (File.Exists(metadata))
                {
                    var existing = ReadItem(directory, recordId, id);
                    ReadBytes(directory, existing);
                    return existing;
                }
                var item = new Dictionary<string, object> {
                    { "id", id }, { "recordId", recordId }, { "createdAt", DateTime.UtcNow.ToString("o") },
                    { "mimeType", image.MimeType }, { "sizeBytes", bytes.Length }, { "width", image.Width }, { "height", image.Height }
                };
                var path = Child(directory, id + Extension(image.MimeType));
                if (File.Exists(path))
                {
                    // A crash can leave bytes before metadata; reuse only a complete matching copy.
                    if (Hash(ReadLimited(path, MaxBytes)) != id) throw new UserError("已有原图无法校验，原文件已保留。");
                }
                else JsonData.WriteAtomic(path, bytes, null);
                JsonData.WriteAtomic(metadata, Encoding.UTF8.GetBytes(JsonData.Serializer().Serialize(item)), null);
                return item;
            }
        }

        internal Dictionary<string, object> AddFile(string recordId, string path)
        {
            ValidateRecordId(recordId);
            return Add(recordId, ReadLimited(path, MaxBytes), null);
        }

        internal IList<Dictionary<string, object>> List(string recordId)
        {
            ValidateRecordId(recordId);
            lock (gate)
            {
                var directory = RecordDirectory(recordId, false);
                if (!Directory.Exists(directory)) return new List<Dictionary<string, object>>();
                var result = new List<Dictionary<string, object>>();
                foreach (var path in Directory.GetFiles(directory, "*.json"))
                {
                    var id = Path.GetFileNameWithoutExtension(path);
                    ValidateId(id);
                    if (File.Exists(Child(directory, id + ".deleted"))) continue;
                    var item = ReadItem(directory, recordId, id);
                    var imagePath = Child(directory, id + Extension((string)item["mimeType"]));
                    if (!File.Exists(imagePath) || new FileInfo(imagePath).Length != (int)item["sizeBytes"]) throw new UserError("部分原图无法读取，已有文件已保留。");
                    result.Add(item);
                }
                return result.OrderBy(item => (string)item["createdAt"], StringComparer.Ordinal).ThenBy(item => (string)item["id"], StringComparer.Ordinal).ToList();
            }
        }

        internal object Read(string recordId, string id)
        {
            var image = ReadOriginal(recordId, id);
            return new { base64 = Convert.ToBase64String(image.Bytes), mimeType = image.MimeType };
        }

        internal EvidencePayload ReadOriginal(string recordId, string id)
        {
            ValidateRecordId(recordId);
            ValidateId(id);
            lock (gate)
            {
                var directory = RecordDirectory(recordId, false);
                if (File.Exists(Child(directory, id + ".deleted"))) throw new UserError("这张截图已删除。");
                var item = ReadItem(directory, recordId, id);
                return new EvidencePayload(ReadBytes(directory, item), (string)item["mimeType"]);
            }
        }

        internal IList<string> ListDeleted(string recordId)
        {
            ValidateRecordId(recordId);
            lock (gate)
            {
                var directory = RecordDirectory(recordId, false);
                if (!Directory.Exists(directory)) return new List<string>();
                return Directory.GetFiles(directory, "*.deleted").Select(path => {
                    var id = Path.GetFileNameWithoutExtension(path);
                    ValidateId(id);
                    if (File.ReadAllText(path, Encoding.UTF8) != "deleted-v1\n") throw new UserError("截图删除记录损坏，已停止同步。");
                    return id;
                }).OrderBy(id => id, StringComparer.Ordinal).ToList();
            }
        }

        internal void Delete(string recordId, string id)
        {
            ValidateRecordId(recordId); ValidateId(id);
            lock (gate)
            {
                var directory = RecordDirectory(recordId, true);
                var marker = Child(directory, id + ".deleted");
                if (!File.Exists(marker)) JsonData.WriteAtomic(marker, Encoding.UTF8.GetBytes("deleted-v1\n"), null);
                var metadata = Child(directory, id + ".json");
                File.Delete(Child(directory, id + ".png"));
                File.Delete(Child(directory, id + ".jpg"));
                File.Delete(metadata);
            }
        }

        private byte[] ReadBytes(string directory, Dictionary<string, object> item)
        {
            var bytes = ReadLimited(Child(directory, (string)item["id"] + Extension((string)item["mimeType"])), MaxBytes);
            if (bytes.Length != (int)item["sizeBytes"] || Hash(bytes) != (string)item["id"]) throw new UserError("原图校验失败，原文件已保留。");
            return bytes;
        }

        private Dictionary<string, object> ReadItem(string directory, string recordId, string id)
        {
            try
            {
                var text = new UTF8Encoding(false, true).GetString(ReadLimited(Child(directory, id + ".json"), 4096));
                var item = JsonData.Serializer().DeserializeObject(text) as Dictionary<string, object>;
                DateTime created;
                if (item == null || item.Count != 7 || (string)item["id"] != id || (string)item["recordId"] != recordId
                    || !DateTime.TryParse((string)item["createdAt"], null, System.Globalization.DateTimeStyles.RoundtripKind, out created)
                    || ((string)item["mimeType"] != "image/png" && (string)item["mimeType"] != "image/jpeg")
                    || (int)item["sizeBytes"] <= 0 || (int)item["sizeBytes"] > MaxBytes) throw new Exception();
                ValidateDimensions((int)item["width"], (int)item["height"]);
                return item;
            }
            catch (Exception) { throw new UserError("原图档案无法读取，原文件已保留。"); }
        }

        private string RecordDirectory(string recordId, bool create)
        {
            CheckPath(root);
            if (create) Directory.CreateDirectory(root);
            // Hashing record IDs also avoids case-insensitive collisions and Windows reserved file names.
            var path = Child(root, "record-" + Hash(Encoding.UTF8.GetBytes(recordId)));
            if (create) Directory.CreateDirectory(path);
            CheckPath(path);
            return path;
        }

        private static string Child(string directory, string name)
        {
            var path = Path.GetFullPath(Path.Combine(directory, name));
            if (!path.StartsWith(Path.GetFullPath(directory) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new UserError("原图路径无效。");
            CheckPath(path);
            return path;
        }

        private static void CheckPath(string path)
        {
            for (var current = new DirectoryInfo(Path.GetDirectoryName(path)); current != null; current = current.Parent)
                if (current.Exists && (current.Attributes & FileAttributes.ReparsePoint) != 0) throw new UserError("原图目录不能使用链接。");
            if ((File.Exists(path) || Directory.Exists(path)) && (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new UserError("原图目录不能使用链接。");
        }

        internal static byte[] ReadLimited(string path, int maximum)
        {
            using (var input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                if (input.Length <= 0 || input.Length > maximum) throw new UserError("原图为空或超过 20 MiB。");
                var bytes = new byte[(int)input.Length];
                var count = 0;
                while (count < bytes.Length)
                {
                    var read = input.Read(bytes, count, bytes.Length - count);
                    if (read == 0) throw new UserError("原图未完整读取。");
                    count += read;
                }
                if (input.ReadByte() != -1) throw new UserError("原图在读取时发生变化，请重试。");
                return bytes;
            }
        }

        internal static string Hash(byte[] bytes)
        {
            using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
        }

        private static string Extension(string mimeType) { return mimeType == "image/png" ? ".png" : ".jpg"; }

        internal static ImageInfo Inspect(byte[] bytes, string expectedMimeType)
        {
            if (bytes == null || bytes.Length == 0 || bytes.Length > MaxBytes) throw new UserError("每张原图不能超过 20 MiB。");
            ImageInfo result;
            if (bytes.Length >= 24 && bytes.Take(8).SequenceEqual(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 })
                && bytes[12] == 73 && bytes[13] == 72 && bytes[14] == 68 && bytes[15] == 82)
                result = new ImageInfo("image/png", BigEndian32(bytes, 16), BigEndian32(bytes, 20));
            else if (bytes.Length >= 4 && bytes[0] == 255 && bytes[1] == 216)
                result = JpegInfo(bytes);
            else throw new UserError("请选择 PNG 或 JPEG 格式的真实截图。");
            ValidateDimensions(result.Width, result.Height);
            if (expectedMimeType != null && expectedMimeType != result.MimeType) throw new UserError("原图格式与文件内容不一致。");
            try
            {
                using (var input = new MemoryStream(bytes, false))
                using (var image = Image.FromStream(input, false, true))
                    if (image.Width != result.Width || image.Height != result.Height) throw new Exception();
            }
            catch (Exception) { throw new UserError("图片损坏或格式不受支持，请重新选择原图。"); }
            return result;
        }

        private static int BigEndian32(byte[] bytes, int offset)
        {
            var value = ((long)bytes[offset] << 24) | ((long)bytes[offset + 1] << 16) | ((long)bytes[offset + 2] << 8) | bytes[offset + 3];
            if (value > int.MaxValue) throw new UserError("图片尺寸过大。");
            return (int)value;
        }

        private static ImageInfo JpegInfo(byte[] bytes)
        {
            var position = 2;
            while (position + 4 <= bytes.Length)
            {
                if (bytes[position++] != 255) break;
                while (position < bytes.Length && bytes[position] == 255) position++;
                if (position >= bytes.Length) break;
                var marker = bytes[position++];
                if (marker == 217 || marker == 218) break;
                if (marker == 1 || marker >= 208 && marker <= 215) continue;
                if (position + 2 > bytes.Length) break;
                var length = bytes[position] * 256 + bytes[position + 1];
                if (length < 2 || position + length > bytes.Length) break;
                if (new[] { 192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207 }.Contains(marker))
                {
                    if (length < 8) break;
                    return new ImageInfo("image/jpeg", bytes[position + 5] * 256 + bytes[position + 6], bytes[position + 3] * 256 + bytes[position + 4]);
                }
                position += length;
            }
            throw new UserError("JPEG 原图无法读取。");
        }

        private static void ValidateDimensions(int width, int height)
        {
            if (width < 1 || height < 1 || width > MaxDimension || height > MaxDimension || (long)width * height > MaxPixels)
                throw new UserError("图片尺寸过大，请分段截图后添加。");
        }

        internal sealed class ImageInfo
        {
            public readonly string MimeType;
            public readonly int Width;
            public readonly int Height;
            internal ImageInfo(string mimeType, int width, int height) { MimeType = mimeType; Width = width; Height = height; }
        }

        internal sealed class EvidencePayload
        {
            internal readonly byte[] Bytes;
            internal readonly string MimeType;
            internal EvidencePayload(byte[] bytes, string mimeType) { Bytes = bytes; MimeType = mimeType; }
        }
    }
}
