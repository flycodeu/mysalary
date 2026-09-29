using System;
using System.Windows.Forms;

namespace SalaryDesktop
{
    internal static class ClosePolicySelfTests
    {
        internal static void Run()
        {
            foreach (var reason in new[] { CloseReason.UserClosing, CloseReason.ApplicationExitCall, CloseReason.FormOwnerClosing, CloseReason.None })
            {
                Assert(ClosePolicy.Decide(reason, false, false, false) == CloseAction.Confirm);
                Assert(ClosePolicy.Decide(reason, false, false, true) == CloseAction.Allow);
                // Busy work must win even after the user already confirmed exit.
                Assert(ClosePolicy.Decide(reason, true, false, false) == CloseAction.Busy);
                Assert(ClosePolicy.Decide(reason, true, false, true) == CloseAction.Busy);
                Assert(ClosePolicy.Decide(reason, false, true, false) == CloseAction.KeepOpen);
                Assert(ClosePolicy.Decide(reason, true, true, false) == CloseAction.KeepOpen);
                Assert(ClosePolicy.Decide(reason, false, false, false, false) == CloseAction.Allow);
                Assert(ClosePolicy.Decide(reason, true, false, false, false) == CloseAction.Busy);
                Assert(ClosePolicy.Decide(reason, false, true, false, false) == CloseAction.KeepOpen);
            }
            foreach (var reason in new[] { CloseReason.WindowsShutDown, CloseReason.TaskManagerClosing })
            {
                Assert(ClosePolicy.Decide(reason, false, false, false) == CloseAction.Allow);
                Assert(ClosePolicy.Decide(reason, true, true, false) == CloseAction.Allow);
            }
        }
        private static void Assert(bool condition) { if (!condition) throw new Exception("close_policy_test_failed"); }
    }
}
