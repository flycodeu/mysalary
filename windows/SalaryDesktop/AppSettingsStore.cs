using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace SalaryDesktop
{
    internal sealed class AppSettingsStore
    {
        private readonly string path;
        internal bool ConfirmExit { get; private set; }

        internal AppSettingsStore(string directory)
        {
            Directory.CreateDirectory(directory);
            path = Path.Combine(directory, "app-settings.json");
            ConfirmExit = true;
            if (!File.Exists(path)) return;
            try
            {
                if (new FileInfo(path).Length > 2048) return;
                var settings = JsonData.Serializer().DeserializeObject(File.ReadAllText(path)) as Dictionary<string, object>;
                object value;
                if (settings != null && settings.TryGetValue("confirmExit", out value) && value is bool) ConfirmExit = (bool)value;
            }
            catch (Exception) { /* An unreadable preference must retain the safe default. */ }
        }

        internal void Save(bool confirmExit)
        {
            var content = JsonData.Serializer().Serialize(new { confirmExit = confirmExit });
            JsonData.WriteAtomic(path, Encoding.UTF8.GetBytes(content), null);
            ConfirmExit = confirmExit;
        }
    }
}
