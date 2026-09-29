using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace SalaryDesktop
{
    internal static class EvidenceCapture
    {
        internal static async Task<object> CaptureAsync(Form owner, EvidenceStore store, string recordId)
        {
            EvidenceStore.ValidateRecordId(recordId);
            var previousState = owner.WindowState;
            owner.Hide();
            try
            {
                // Let the compositor remove our window before copying visible screen pixels.
                await Task.Delay(250);
                var bounds = SystemInformation.VirtualScreen;
                if (bounds.Width < 1 || bounds.Height < 1 || bounds.Width > 32768 || bounds.Height > 32768
                    || (long)bounds.Width * bounds.Height > 100000000) throw new UserError("屏幕范围过大，请使用系统截图后添加原图。");
                using (var screen = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format32bppArgb))
                {
                    using (var graphics = Graphics.FromImage(screen))
                        graphics.CopyFromScreen(bounds.Left, bounds.Top, 0, 0, bounds.Size, CopyPixelOperation.SourceCopy);
                    using (var selector = new RegionSelector(screen, bounds))
                    {
                        if (selector.ShowDialog() != DialogResult.OK) return new { cancelled = true, items = new object[0] };
                        var region = selector.Selection;
                        using (var result = screen.Clone(region, PixelFormat.Format32bppArgb))
                        using (var output = new MemoryStream())
                        {
                            result.Save(output, ImageFormat.Png);
                            var bytes = output.ToArray();
                            var item = await Task.Run(() => store.Add(recordId, bytes, "image/png"));
                            return new { cancelled = false, items = new[] { item } };
                        }
                    }
                }
            }
            finally
            {
                if (!owner.IsDisposed)
                {
                    owner.Show();
                    owner.WindowState = previousState;
                    owner.Activate();
                }
            }
        }

        internal static Rectangle SelectionBounds(Point start, Point end, Size limit)
        {
            var left = Math.Max(0, Math.Min(start.X, end.X));
            var top = Math.Max(0, Math.Min(start.Y, end.Y));
            var right = Math.Min(limit.Width, Math.Max(start.X, end.X));
            var bottom = Math.Min(limit.Height, Math.Max(start.Y, end.Y));
            return right > left && bottom > top ? Rectangle.FromLTRB(left, top, right, bottom) : Rectangle.Empty;
        }

        private sealed class RegionSelector : Form
        {
            private readonly Bitmap screen;
            private Point start;
            private bool selecting;
            internal Rectangle Selection { get; private set; }

            internal RegionSelector(Bitmap screen, Rectangle bounds)
            {
                this.screen = screen;
                AutoScaleMode = AutoScaleMode.None;
                FormBorderStyle = FormBorderStyle.None;
                StartPosition = FormStartPosition.Manual;
                Bounds = bounds;
                TopMost = true;
                ShowInTaskbar = false;
                Cursor = Cursors.Cross;
                KeyPreview = true;
                DoubleBuffered = true;
                BackColor = Color.Black;
                KeyDown += (sender, args) => { if (args.KeyCode == Keys.Escape) { DialogResult = DialogResult.Cancel; Close(); } };
                MouseDown += BeginSelection;
                MouseMove += MoveSelection;
                MouseUp += CompleteSelection;
            }

            private void BeginSelection(object sender, MouseEventArgs args)
            {
                if (args.Button == MouseButtons.Right) { DialogResult = DialogResult.Cancel; Close(); return; }
                if (args.Button != MouseButtons.Left) return;
                start = args.Location;
                selecting = true;
                Capture = true;
                Selection = Rectangle.Empty;
                Invalidate();
            }

            private void MoveSelection(object sender, MouseEventArgs args)
            {
                if (!selecting) return;
                Selection = SelectionBounds(start, args.Location, screen.Size);
                Invalidate();
            }

            private void CompleteSelection(object sender, MouseEventArgs args)
            {
                if (!selecting || args.Button != MouseButtons.Left) return;
                Selection = SelectionBounds(start, args.Location, screen.Size);
                selecting = false;
                Capture = false;
                if (Selection.Width < 2 || Selection.Height < 2) { Invalidate(); return; }
                if ((long)Selection.Width * Selection.Height > EvidenceStore.MaxPixels)
                {
                    Selection = Rectangle.Empty;
                    Invalidate();
                    MessageBox.Show(this, "选区太大，请分段截图。", "截图", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return;
                }
                DialogResult = DialogResult.OK;
                Close();
            }

            protected override void OnPaint(PaintEventArgs args)
            {
                args.Graphics.DrawImageUnscaled(screen, 0, 0);
                using (var shade = new SolidBrush(Color.FromArgb(125, 0, 0, 0))) args.Graphics.FillRectangle(shade, ClientRectangle);
                if (!Selection.IsEmpty)
                {
                    args.Graphics.DrawImage(screen, Selection, Selection, GraphicsUnit.Pixel);
                    using (var border = new Pen(Color.FromArgb(31, 199, 159), 2)) args.Graphics.DrawRectangle(border, Selection);
                }
                var message = "拖动框选工资区域 · 松开保存 · Esc / 右键取消";
                using (var font = new Font("Microsoft YaHei UI", 13))
                using (var text = new SolidBrush(Color.White))
                using (var background = new SolidBrush(Color.FromArgb(215, 25, 30, 40)))
                {
                    var size = args.Graphics.MeasureString(message, font);
                    var x = Math.Max(16, (Width - (int)size.Width) / 2);
                    args.Graphics.FillRectangle(background, x - 16, 20, size.Width + 32, size.Height + 24);
                    args.Graphics.DrawString(message, font, text, x, 32);
                }
            }
        }
    }
}
