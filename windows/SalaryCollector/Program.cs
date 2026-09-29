using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Automation;
using System.Windows.Forms;

namespace SalaryCollector
{
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            if (args.Contains("--self-test")) return SelfTests.Run();
            if (args.Contains("--probe") || args.Contains("--capture"))
            {
                var task = Task.Run(() => PageCollector.Collect());
                if (!task.Wait(TimeSpan.FromSeconds(35))) { Console.WriteLine("result=timeout"); return 2; }
                var result = task.Result;
                Console.WriteLine(result.Diagnostics());
                if (result.Records.Count == 0) return 1;
                if (args.Contains("--capture"))
                {
                    var folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SalaryTrail", "Captures");
                    Directory.CreateDirectory(folder);
                    var path = Path.Combine(folder, "salary-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".salary.json");
                    Exporter.Write(path, result.Records, result.CapturedAt);
                    Console.WriteLine("saved=" + path);
                }
                return 0;
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new CollectorForm());
            return 0;
        }
    }

    [DataContract]
    internal sealed class CapturePackage
    {
        [DataMember(Name = "format", Order = 0)] public string Format = "salary-capture";
        [DataMember(Name = "version", Order = 1)] public int Version = 1;
        [DataMember(Name = "source", Order = 2)] public CaptureSource Source = new CaptureSource();
        [DataMember(Name = "records", Order = 3)] public List<SalaryRecord> Records = new List<SalaryRecord>();
    }
    [DataContract]
    internal sealed class CaptureSource
    {
        [DataMember(Name = "kind", Order = 0)] public string Kind = "feishu-text";
        [DataMember(Name = "page", Order = 1)] public string Page = PageCollector.SourcePage;
        [DataMember(Name = "capturedAt", Order = 2)] public string CapturedAt = DateTime.UtcNow.ToString("o");
    }
    [DataContract]
    internal sealed class SalaryRecord
    {
        [DataMember(Name = "payrollMonth", Order = 0)] public string PayrollMonth;
        [DataMember(Name = "fields", Order = 1)] public List<SalaryField> Fields = new List<SalaryField>();
        public override string ToString() { return PayrollMonth + "  ·  " + Math.Max(0, Fields.Count - 2) + " 项明细"; }
    }
    [DataContract]
    internal sealed class SalaryField
    {
        [DataMember(Name = "label", Order = 0)] public string Label;
        [DataMember(Name = "amountText", Order = 1)] public string AmountText;
    }

    internal sealed class CollectionResult
    {
        public List<SalaryRecord> Records = new List<SalaryRecord>();
        public int Windows;
        public int Documents;
        public int TargetDocuments;
        public int TextNodes;
        public int SeenMonths;
        public int IncompleteMonths;
        public string CapturedAt = DateTime.UtcNow.ToString("o");
        public string Error = "none";
        public string Diagnostics()
        {
            return "result=" + (Records.Count > 0 ? "ok" : Error) + ";windows=" + Windows + ";documents=" + Documents + ";targetDocuments=" + TargetDocuments + ";textNodes=" + TextNodes + ";months=" + SeenMonths + ";expandedMonths=" + Records.Count + ";incompleteMonths=" + IncompleteMonths + ";fields=" + Records.Sum(r => r.Fields.Count) + ";negativeFields=" + Records.Sum(r => r.Fields.Count(f => f.AmountText.StartsWith("-") || f.AmountText.StartsWith("−")));
        }
    }

    internal static class SalaryParser
    {
        private static readonly Regex Month = new Regex(@"^\s*(20\d{2})\s*年\s*(\d{1,2})\s*月\s*$");

        public static List<SalaryRecord> Parse(IEnumerable<string> input, out int seen, out int incomplete)
        {
            var records = new List<SalaryRecord>();
            SalaryRecord current = null;
            string pending = null;
            bool skippedPrivateValue = false;
            bool hasDetail = false;
            bool incompleteRow = false;
            seen = 0;
            int incompleteCount = 0;
            Action finish = () =>
            {
                if (current == null) return;
                if (hasDetail && !incompleteRow && pending == null && CaptureValidation.IsValidRecord(current))
                    records.Add(current);
                else if (hasDetail) incompleteCount++;
            };
            foreach (var raw in input)
            {
                var token = (raw ?? "").Trim();
                if (token.Length == 0) continue;
                var month = Month.Match(token);
                if (month.Success)
                {
                    finish();
                    var monthNumber = int.Parse(month.Groups[2].Value, CultureInfo.InvariantCulture);
                    current = monthNumber >= 1 && monthNumber <= 12 ? new SalaryRecord { PayrollMonth = month.Groups[1].Value + "-" + monthNumber.ToString("00") } : null;
                    if (current != null) seen++;
                    pending = null;
                    skippedPrivateValue = false;
                    hasDetail = false;
                    incompleteRow = false;
                    continue;
                }
                if (current == null) continue;
                if (CaptureValidation.HasControlCharacters(raw)) { incompleteRow = true; continue; }
                if (token == "工资详细" || token == "工资详情")
                {
                    if (pending != null) incompleteRow = true;
                    pending = null;
                    continue;
                }
                var colon = Math.Max(token.IndexOf('：'), token.IndexOf(':'));
                if (colon >= 0)
                {
                    if (pending != null) incompleteRow = true;
                    var label = NormalizeLabel(token.Substring(0, colon));
                    var value = token.Substring(colon + 1).Trim();
                    if (CaptureValidation.IsPrivateLabel(label)) { pending = null; skippedPrivateValue = value.Length == 0; continue; }
                    skippedPrivateValue = false;
                    if (!CaptureValidation.IsValidLabel(label)) { incompleteRow = true; pending = null; continue; }
                    if (value.Length == 0) { pending = label; continue; }
                    if (CaptureValidation.IsAmount(value)) Add(current, label, value, ref hasDetail);
                    else incompleteRow = true;
                    pending = null;
                    continue;
                }
                if (skippedPrivateValue) { skippedPrivateValue = false; continue; }
                if (CaptureValidation.IsAmount(token))
                {
                    if (pending != null) Add(current, pending, token, ref hasDetail);
                    else incompleteRow = true;
                    pending = null;
                    continue;
                }
                var normalized = NormalizeLabel(token);
                if (CaptureValidation.IsPrivateLabel(normalized))
                {
                    if (pending != null) incompleteRow = true;
                    pending = null;
                    skippedPrivateValue = true;
                    continue;
                }
                if (Regex.IsMatch(token, @"^[·•●.…]+$")) continue;
                if (CaptureValidation.IsValidLabel(normalized) && Regex.IsMatch(normalized, @"\p{L}"))
                {
                    if (pending != null) incompleteRow = true;
                    pending = normalized;
                }
                else incompleteRow = true;
            }
            finish();
            incomplete = incompleteCount;
            return records;
        }
        private static string NormalizeLabel(string value) { return Regex.Replace(value.Trim().TrimEnd(':', '：'), @"\s+", ""); }
        private static void Add(SalaryRecord record, string label, string value, ref bool hasDetail)
        {
            record.Fields.Add(new SalaryField { Label = label, AmountText = value });
            if (CaptureValidation.TotalKind(label) == null) hasDetail = true;
        }
    }

    internal static class CaptureValidation
    {
        public const int MaxBytes = 1024 * 1024;
        public const int MaxRecords = 120;
        public const int MaxFields = 256;
        private static readonly Regex Controls = new Regex(@"[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]");
        private static readonly Regex Amount = new Regex(@"^[+\-]?(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)(?:\.[0-9]{1,2})?$");
        public static bool HasControlCharacters(string value) { return value != null && Controls.IsMatch(value); }
        public static string Compact(string value) { return Regex.Replace(value ?? "", @"[\s()（）：:]", ""); }
        public static string TotalKind(string value)
        {
            var compact = Compact(value);
            if (Regex.IsMatch(compact, @"^(?:应发工资|应发合计|应发总额|应发)$")) return "gross";
            if (Regex.IsMatch(compact, @"^(?:实发工资|实发合计|实发总额|实发)$")) return "net";
            return null;
        }
        public static bool IsPrivateLabel(string value)
        {
            var compact = Compact(value);
            if (compact == "岗位基本薪水") return false;
            return Regex.IsMatch(compact, @"^(?:姓名|员工姓名|工号|员工编号|人员编号|身份证|证件号|银行卡|银行账号|手机号|手机号码|联系电话|邮箱|住址|地址|部门|所属部门|职位|薪资发放公司|发放公司|所属公司|公司名称|出生日期|发放日期|发薪日期|账号|帐号|密码|凭据|令牌|token|cookie|authorization)", RegexOptions.IgnoreCase)
                || Regex.IsMatch(compact, @"^(?:岗位|职务|公司|手机|电话|开户行|工资查询|工资详情|工资明细|返回|关闭|智慧HR|展开|收起)$", RegexOptions.IgnoreCase);
        }
        public static bool IsValidLabel(string value)
        {
            return !string.IsNullOrEmpty(value) && value.Length <= 100 && Compact(value).Length > 0 && !HasControlCharacters(value);
        }
        public static bool IsAmount(string value)
        {
            if (string.IsNullOrEmpty(value) || value.Length > 64 || HasControlCharacters(value)) return false;
            var normalized = Regex.Replace(value, @"[０-９]", m => ((char)(m.Value[0] - 0xff10 + '0')).ToString())
                .Replace('．', '.').Replace('，', ',').Replace('−', '-').Replace('﹣', '-').Replace('－', '-').Replace('＋', '+').Trim();
            normalized = Regex.Replace(normalized, @"^([+\-]?)\s*[¥￥]\s*", "$1");
            normalized = Regex.Replace(normalized, @"\s*元$", "").Trim();
            if (!Amount.IsMatch(normalized)) return false;
            decimal amount;
            // The consumer stores fen as a JavaScript safe integer; decimal avoids rounding this boundary.
            return decimal.TryParse(normalized.Replace(",", ""), NumberStyles.AllowLeadingSign | NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture, out amount)
                && amount >= -90071992547409.91m && amount <= 90071992547409.91m;
        }
        public static bool IsValidRecord(SalaryRecord record)
        {
            if (record == null || !Regex.IsMatch(record.PayrollMonth ?? "", @"^(?!0000)[0-9]{4}-(?:0[1-9]|1[0-2])$") || record.Fields == null || record.Fields.Count < 3 || record.Fields.Count > MaxFields) return false;
            var labels = new HashSet<string>(StringComparer.Ordinal);
            var totals = new HashSet<string>(StringComparer.Ordinal);
            foreach (var field in record.Fields)
            {
                if (field == null || !IsValidLabel(field.Label) || IsPrivateLabel(field.Label) || !IsAmount(field.AmountText) || !labels.Add(Compact(field.Label))) return false;
                var kind = TotalKind(field.Label);
                if (kind != null && !totals.Add(kind)) return false;
            }
            return totals.Contains("gross") && totals.Contains("net");
        }
        public static void ValidateRecords(List<SalaryRecord> records)
        {
            if (records == null || records.Count < 1 || records.Count > MaxRecords || records.Any(r => !IsValidRecord(r)) || records.Select(r => r.PayrollMonth).Distinct().Count() != records.Count)
                throw new InvalidDataException("capture_contract_invalid");
        }
    }

    internal static class PageCollector
    {
        public const string SourcePage = "https://hr.hmifo.com/test/#/wages";
        public static CollectionResult Collect()
        {
            var result = new CollectionResult();
            try
            {
                var deadline = DateTime.UtcNow.AddSeconds(20);
                string previous = null;
                while (DateTime.UtcNow < deadline)
                {
                    var current = ReadOnce();
                    if (current.Records.Count > 0)
                    {
                        var fingerprint = string.Join("|", current.Records.Select(r => r.PayrollMonth + ":" + string.Join(";", r.Fields.Select(f => f.Label + "=" + f.AmountText))));
                        if (fingerprint == previous) return current;
                        previous = fingerprint;
                    }
                    else previous = null;
                    result = current;
                    Thread.Sleep(800);
                }
                result.Records.Clear();
                if (result.Error == "none") result.Error = "page_not_ready";
                return result;
            }
            catch (ElementNotAvailableException) { result.Error = "page_changed"; }
            catch (UnauthorizedAccessException) { result.Error = "access_denied"; }
            catch (Exception) { result.Error = "read_failed"; }
            return result;
        }
        private static CollectionResult ReadOnce()
        {
            var result = new CollectionResult();
            var processIds = new HashSet<int>(Process.GetProcessesByName("Feishu").Select(p => p.Id));
            if (processIds.Count == 0) { result.Error = "feishu_not_running"; return result; }
            var windows = AutomationElement.RootElement.FindAll(TreeScope.Children, Condition.TrueCondition);
            for (var w = 0; w < windows.Count; w++)
            {
                var window = windows[w];
                if (!processIds.Contains(window.Current.ProcessId)) continue;
                result.Windows++;
                var docs = window.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document));
                result.Documents += docs.Count;
                for (var d = 0; d < docs.Count; d++)
                {
                    var doc = docs[d];
                    if (!MatchesSource(doc)) continue;
                    result.TargetDocuments++;
                    var textNodes = doc.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Text));
                    var tokens = new List<string>();
                    for (var n = 0; n < textNodes.Count; n++) tokens.Add(textNodes[n].Current.Name);
                    result.TextNodes += tokens.Count;
                    int seen, incomplete;
                    var parsed = SalaryParser.Parse(tokens, out seen, out incomplete);
                    result.SeenMonths += seen;
                    result.IncompleteMonths += incomplete;
                    result.Records.AddRange(parsed);
                }
            }
            if (result.TargetDocuments == 0) result.Error = "wages_page_not_found";
            else if (result.Records.Count == 0) result.Error = "expand_month_details";
            var duplicateMonths = result.Records.GroupBy(r => r.PayrollMonth).Any(g => g.Count() > 1);
            if (duplicateMonths) { result.Records.Clear(); result.Error = "multiple_wages_pages"; }
            if (result.Records.Count > CaptureValidation.MaxRecords) { result.Records.Clear(); result.Error = "too_many_months"; }
            return result;
        }
        private static bool MatchesSource(AutomationElement doc)
        {
            object pattern;
            if (doc.TryGetCurrentPattern(ValuePattern.Pattern, out pattern))
            {
                var value = ((ValuePattern)pattern).Current.Value;
                Uri uri;
                if (Uri.TryCreate(value, UriKind.Absolute, out uri))
                    return uri.Scheme == "https" && uri.Host.Equals("hr.hmifo.com", StringComparison.OrdinalIgnoreCase) && uri.AbsolutePath.TrimEnd('/') == "/test" && uri.Fragment.TrimEnd('/') == "#/wages";
            }
            return false;
        }
    }

    internal static class Exporter
    {
        public static void Write(string path, List<SalaryRecord> records, string capturedAt = null)
        {
            CaptureValidation.ValidateRecords(records);
            var package = new CapturePackage { Records = records };
            if (capturedAt != null) package.Source.CapturedAt = capturedAt;
            byte[] bytes;
            using (var serialized = new MemoryStream())
            {
                new DataContractJsonSerializer(typeof(CapturePackage)).WriteObject(serialized, package);
                if (serialized.Length > CaptureValidation.MaxBytes) throw new InvalidDataException("capture_too_large");
                bytes = serialized.ToArray();
            }
            var temp = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                using (var stream = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    stream.Write(bytes, 0, bytes.Length);
                    stream.Flush(true);
                }
                if (File.Exists(path)) File.Replace(temp, path, null);
                else File.Move(temp, path);
            }
            finally { if (File.Exists(temp)) File.Delete(temp); }
        }
    }

    internal sealed class CollectorForm : Form
    {
        private readonly Label status = new Label();
        private readonly Button read = new Button();
        private readonly Button export = new Button();
        private readonly ComboBox months = new ComboBox();
        private readonly DataGridView preview = new DataGridView();
        private readonly Label totals = new Label();
        private CollectionResult collection;
        public CollectorForm()
        {
            Text = "薪迹 · 工资采集";
            Font = new System.Drawing.Font("Microsoft YaHei UI", 10F);
            StartPosition = FormStartPosition.CenterScreen;
            MinimumSize = new System.Drawing.Size(620, 600);
            ClientSize = new System.Drawing.Size(720, 680);
            BackColor = System.Drawing.Color.FromArgb(248, 250, 249);
            var layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(24), ColumnCount = 1, RowCount = 6 };
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 50));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 44));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 52));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 48));
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 58));
            layout.Controls.Add(new Label { Text = "薪迹", Dock = DockStyle.Fill, Font = new System.Drawing.Font(Font.FontFamily, 24, System.Drawing.FontStyle.Bold), ForeColor = System.Drawing.Color.FromArgb(28, 70, 59) }, 0, 0);
            status.Text = "在电脑飞书打开工资页，并展开需要采集的月份。";
            status.Dock = DockStyle.Fill;
            layout.Controls.Add(status, 0, 1);
            var toolbar = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false };
            read.Text = "读取工资页"; read.AutoSize = true; read.Height = 38; read.Padding = new Padding(10, 3, 10, 3); read.Click += async (s, e) => await ReadAsync();
            months.DropDownStyle = ComboBoxStyle.DropDownList; months.Width = 265; months.Margin = new Padding(16, 5, 0, 0); months.SelectedIndexChanged += (s, e) => ShowMonth();
            toolbar.Controls.Add(read); toolbar.Controls.Add(months); layout.Controls.Add(toolbar, 0, 2);
            totals.Dock = DockStyle.Fill; totals.Font = new System.Drawing.Font(Font.FontFamily, 11, System.Drawing.FontStyle.Bold); layout.Controls.Add(totals, 0, 3);
            preview.Dock = DockStyle.Fill; preview.ReadOnly = true; preview.AllowUserToAddRows = false; preview.AllowUserToDeleteRows = false; preview.RowHeadersVisible = false; preview.SelectionMode = DataGridViewSelectionMode.FullRowSelect; preview.MultiSelect = false; preview.BackgroundColor = System.Drawing.Color.White; preview.BorderStyle = BorderStyle.None; preview.AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill; preview.RowTemplate.Height = 36; preview.ColumnHeadersHeight = 36; preview.Columns.Add("label", "工资项目"); preview.Columns.Add("amount", "来源金额"); preview.Columns[1].DefaultCellStyle.Alignment = DataGridViewContentAlignment.MiddleRight; layout.Controls.Add(preview, 0, 4);
            var footer = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft, Padding = new Padding(0, 12, 0, 0) };
            export.Text = "导出所选月份"; export.AutoSize = true; export.Padding = new Padding(12, 3, 12, 3); export.Enabled = false; export.Click += (s, e) => Export(); footer.Controls.Add(export); layout.Controls.Add(footer, 0, 5);
            Controls.Add(layout);
        }
        private async Task ReadAsync()
        {
            read.Enabled = false; export.Enabled = false; months.Enabled = false;
            status.Text = "正在读取飞书中的工资页…";
            collection = null; preview.Rows.Clear(); months.Items.Clear(); totals.Text = "";
            try
            {
                var task = Task.Run(() => PageCollector.Collect());
                if (await Task.WhenAny(task, Task.Delay(35000)) != task) { status.Text = "读取超时，请确认飞书工资页仍然打开后重试。"; return; }
                collection = await task;
                foreach (var record in collection.Records.OrderByDescending(r => r.PayrollMonth)) months.Items.Add(record);
                if (months.Items.Count > 0) { months.SelectedIndex = 0; status.Text = "已读取 " + months.Items.Count + " 个月份，可直接导出。"; }
                else status.Text = collection.Error == "feishu_not_running" ? "请先打开电脑飞书。" : collection.Error == "multiple_wages_pages" ? "检测到多个相同月份的工资页，请保留一个后重试。" : "请在飞书打开工资页并展开明细，再重新读取。";
            }
            catch (Exception) { status.Text = "本次读取未完成，请重新打开工资页后重试。"; }
            finally { read.Enabled = true; months.Enabled = true; export.Enabled = months.SelectedItem != null; }
        }
        private void ShowMonth()
        {
            preview.Rows.Clear();
            var record = months.SelectedItem as SalaryRecord;
            if (record == null) return;
            foreach (var field in record.Fields.Where(f => CaptureValidation.TotalKind(f.Label) == null)) preview.Rows.Add(field.Label, field.AmountText);
            totals.Text = "应发  ¥ " + record.Fields.First(f => CaptureValidation.TotalKind(f.Label) == "gross").AmountText + "      实发  ¥ " + record.Fields.First(f => CaptureValidation.TotalKind(f.Label) == "net").AmountText;
            export.Enabled = true;
        }
        private void Export()
        {
            var record = months.SelectedItem as SalaryRecord;
            if (record == null) return;
            using (var dialog = new SaveFileDialog { Title = "导出工资文件", Filter = "薪迹工资文件 (*.salary.json)|*.salary.json", FileName = "salary-" + record.PayrollMonth + ".salary.json", InitialDirectory = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), OverwritePrompt = true })
            {
                if (dialog.ShowDialog(this) != DialogResult.OK) return;
                try { Exporter.Write(dialog.FileName, new List<SalaryRecord> { record }, collection.CapturedAt); status.Text = "已导出。将文件传到手机并用薪迹打开即可查看。"; }
                catch (Exception) { status.Text = "导出失败，请选择可写入的文件夹后重试。"; }
            }
        }
    }

    internal static class SelfTests
    {
        public static int Run()
        {
            int seen, incomplete;
            var rows = new[] { "2026年09月", "应发工资:", "1500", "实发工资:", "1400", "工资详细", "姓名:", "测试用户", "工号:", "12345", "身份证号:", "123456789012345678", "岗位:", "测试岗位", "岗位（基本）薪水:", "1000", "奖金合计:", "600", "月度奖惩:", "600", "补发合计:", "-100", "社保津贴补差:", "-100", "未知工资项目:", "20", "养老保险费:", "100", "2026年08月", "应发工资:", "1600", "实发工资:", "1500" };
            var records = SalaryParser.Parse(rows, out seen, out incomplete);
            var passed = records.Count == 1 && seen == 2 && incomplete == 0 && records[0].Fields.Count == 9 && records[0].Fields.Count(f => f.AmountText == "600") == 2 && records[0].Fields.Count(f => f.AmountText == "-100") == 2 && records[0].Fields.All(f => f.Label != "工号" && f.Label != "姓名" && f.Label != "身份证号") && records[0].Fields.Any(f => f.Label == "未知工资项目");
            var invalid = SalaryParser.Parse(new[] { "2026年09月", "应发工资:", "1500", "岗位（基本）薪水:", "1000" }, out seen, out incomplete);
            passed &= invalid.Count == 0 && incomplete == 1;
            var missing = SalaryParser.Parse(new[] { "2026年09月", "应发工资:1500", "实发工资:1400", "岗位（基本）薪水:1000", "医疗保险费:", "养老保险费:100" }, out seen, out incomplete);
            passed &= missing.Count == 0 && incomplete == 1;
            var noDetail = SalaryParser.Parse(new[] { "2026年09月", "应发工资:1500", "实发工资:1400", "工号:12345" }, out seen, out incomplete);
            passed &= noDetail.Count == 0;
            var validPrefix = new[] { "2026年09月", "应发工资:1500", "实发工资:1400", "岗位（基本）薪水:1000" };
            foreach (var invalidTail in new[] { "123.45", "invalid-value", "@", "-", "90071992547409.92", "工资项目\u202e:5", "工资项目\u0001:5", new string('薪', 101) + ":1" })
            {
                var rejected = SalaryParser.Parse(validPrefix.Concat(new[] { invalidTail }), out seen, out incomplete);
                passed &= rejected.Count == 0 && incomplete == 1;
            }
            var duplicate = SalaryParser.Parse(validPrefix.Concat(new[] { "岗 位 (基 本) 薪水:2" }), out seen, out incomplete);
            passed &= duplicate.Count == 0 && incomplete == 1;
            var longLabel = SalaryParser.Parse(validPrefix.Concat(new[] { new string('薪', 100) + ":1" }), out seen, out incomplete);
            passed &= longLabel.Count == 1;
            passed &= CaptureValidation.IsAmount("90071992547409.91") && CaptureValidation.IsAmount("-90071992547409.91")
                && !CaptureValidation.IsAmount("90071992547409.92") && !CaptureValidation.IsAmount("-90071992547409.92")
                && !CaptureValidation.IsAmount("99999999999999999999999999999999999") && !CaptureValidation.IsAmount("- 20")
                && CaptureValidation.IsAmount("－１，２３４．５０") && !CaptureValidation.IsAmount("1,23.45");
            passed &= CaptureValidation.IsValidRecord(MakeRecord(0, 254, "工资")) && !CaptureValidation.IsValidRecord(MakeRecord(0, 255, "工资"));
            var temp = Path.Combine(Path.GetTempPath(), "salary-collector-selftest-" + Guid.NewGuid().ToString("N") + ".json");
            try
            {
                Exporter.Write(temp, records);
                Exporter.Write(temp, records);
                using (var stream = File.OpenRead(temp))
                {
                    var restored = (CapturePackage)new DataContractJsonSerializer(typeof(CapturePackage)).ReadObject(stream);
                    passed &= restored.Format == "salary-capture" && restored.Version == 1 && restored.Records.Count == 1 && restored.Records[0].Fields.Count == 9;
                }
                var original = File.ReadAllBytes(temp);
                passed &= Rejects(() => Exporter.Write(temp, Enumerable.Range(0, 121).Select(n => MakeRecord(n, 1, "工资")).ToList()));
                passed &= Rejects(() => Exporter.Write(temp, new List<SalaryRecord> { MakeRecord(0, 255, "工资") }));
                passed &= Rejects(() => Exporter.Write(temp, Enumerable.Range(0, 16).Select(n => MakeRecord(n, 254, new string('薪', 96))).ToList()));
                passed &= File.ReadAllBytes(temp).SequenceEqual(original);
            }
            finally { if (File.Exists(temp)) File.Delete(temp); }
            Console.WriteLine(passed ? "self-test=pass;checks=privacy,month-boundaries,signed-values,equal-values,unknown-labels,required-totals,missing-amount,orphan-value,trailing-value,duplicate-label,unsafe-amount,control-characters,label-limit,field-limit,month-limit,file-size,collapsed-month,atomic-export" : "self-test=fail");
            return passed ? 0 : 1;
        }
        private static SalaryRecord MakeRecord(int offset, int details, string prefix)
        {
            var record = new SalaryRecord { PayrollMonth = new DateTime(2010, 1, 1).AddMonths(offset).ToString("yyyy-MM") };
            record.Fields.Add(new SalaryField { Label = "应发工资", AmountText = "1500" });
            record.Fields.Add(new SalaryField { Label = "实发工资", AmountText = "1400" });
            for (var i = 0; i < details; i++) record.Fields.Add(new SalaryField { Label = prefix + i.ToString("0000"), AmountText = "1" });
            return record;
        }
        private static bool Rejects(Action action)
        {
            try { action(); return false; }
            catch (InvalidDataException) { return true; }
        }
    }
}
