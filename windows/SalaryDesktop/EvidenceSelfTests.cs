using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Text;

namespace SalaryDesktop
{
    internal static class EvidenceSelfTests
    {
        internal static void Run()
        {
            var directory = Path.Combine("C:\\sal-evidence", Guid.NewGuid().ToString("N"));
            try
            {
                var store = new EvidenceStore(directory);
                Assert(store.List("record-1").Count == 0);
                var png = ImageBytes(ImageFormat.Png);
                var first = store.Add("record-1", png, "image/png");
                Assert((string)first["id"] == EvidenceStore.Hash(png) && (int)first["width"] == 32 && (int)first["height"] == 24);
                var duplicate = store.Add("record-1", png, "image/png");
                Assert(store.List("record-1").Count == 1 && (string)duplicate["createdAt"] == (string)first["createdAt"]);
                var restarted = new EvidenceStore(directory);
                var read = AsDictionary(restarted.Read("record-1", (string)first["id"]));
                Assert(Convert.FromBase64String((string)read["base64"]).SequenceEqual(png) && (string)read["mimeType"] == "image/png");
                store.Add("RECORD-1", png, "image/png");
                store.Add("safe-reserved-name", png, "image/png");
                Assert(store.List("RECORD-1").Count == 1 && store.List("record-1").Count == 1);
                Assert(Rejects(() => store.Read("unrelated", (string)first["id"])));
                var jpeg = ImageBytes(ImageFormat.Jpeg);
                store.Add("record-1", jpeg, "image/jpeg");
                Assert(store.List("record-1").Count == 2);
                var jpegId = EvidenceStore.Hash(jpeg);
                store.Delete("record-1", jpegId);
                Assert(store.List("record-1").Count == 1 && store.ListDeleted("record-1").SequenceEqual(new[] { jpegId }));
                Assert(Rejects(() => store.Read("record-1", jpegId)) && Rejects(() => store.Add("record-1", jpeg, "image/jpeg")));
                restarted.Delete("record-1", jpegId);
                Assert(restarted.ListDeleted("record-1").Count == 1);
                Assert(Rejects(() => store.Add("record-1", jpeg, "image/png")));
                Assert(Rejects(() => store.Add("../outside", png, "image/png")) && Rejects(() => store.List("a/b")) && Rejects(() => store.Read("record-1", "../image")));
                Assert(Rejects(() => store.Add("record-1", new byte[EvidenceStore.MaxBytes + 1], "image/png")));
                Assert(Rejects(() => store.Add("record-1", new byte[] { 1, 2, 3 }, "image/png")) && Rejects(() => EvidenceStore.Decode("invalid!")));
                var huge = (byte[])png.Clone();
                huge[16] = 127;
                Assert(Rejects(() => store.Add("record-1", huge, "image/png")));
                var ledger = new LocalStore(directory);
                ledger.SaveLedger("{\"format\":\"salary-archive\",\"version\":1,\"entries\":[]}");
                Assert(new EvidenceStore(directory).List("record-1").Count == 1);
                var pngPath = Directory.GetFiles(Path.Combine(directory, "evidence"), (string)first["id"] + ".png", SearchOption.AllDirectories)
                    .First(path => path.Contains("record-" + EvidenceStore.Hash(Encoding.UTF8.GetBytes("record-1"))));
                File.WriteAllBytes(pngPath, new byte[png.Length]);
                Assert(Rejects(() => store.Read("record-1", (string)first["id"])) && Rejects(() => store.Add("record-1", png, "image/png")));
                Assert(File.ReadAllBytes(pngPath).All(value => value == 0));
                Assert(EvidenceCapture.SelectionBounds(new Point(10, 20), new Point(5, 40), new Size(30, 30)) == new Rectangle(5, 20, 5, 10));
                Assert(EvidenceCapture.SelectionBounds(new Point(-2, -3), new Point(4, 6), new Size(30, 30)) == new Rectangle(0, 0, 4, 6));
                Assert(EvidenceCapture.SelectionBounds(new Point(2, 3), new Point(2, 3), new Size(30, 30)).IsEmpty);
                Console.WriteLine("evidence-self-test=pass;checks=original-bytes,restart,deduplicate,record-isolation,png-jpeg,dimensions,size-limit,traversal,corruption-preservation,ledger-independent,selection-bounds");
            }
            finally { if (Directory.Exists(directory)) Directory.Delete(directory, true); }
        }

        private static byte[] ImageBytes(ImageFormat format)
        {
            using (var image = new Bitmap(32, 24))
            using (var graphics = Graphics.FromImage(image))
            using (var output = new MemoryStream())
            {
                graphics.Clear(Color.DarkCyan);
                image.Save(output, format);
                return output.ToArray();
            }
        }

        private static Dictionary<string, object> AsDictionary(object item)
        {
            return (Dictionary<string, object>)JsonData.Serializer().DeserializeObject(JsonData.Serializer().Serialize(item));
        }
        private static void Assert(bool condition) { if (!condition) throw new Exception("Evidence test failed"); }
        private static bool Rejects(Action action) { try { action(); return false; } catch (UserError) { return true; } }
    }
}
