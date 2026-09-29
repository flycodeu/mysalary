using System.Windows.Forms;

namespace SalaryDesktop
{
    internal enum CloseAction { Allow, Confirm, Busy, KeepOpen }

    internal static class ClosePolicy
    {
        internal static CloseAction Decide(CloseReason reason, bool busy, bool dialogOpen, bool confirmed)
        {
            // Windows owns session termination. A confirmation dialog must not block shutdown;
            // atomic ledger writes retain the previous complete file if termination interrupts a save.
            if (reason == CloseReason.WindowsShutDown || reason == CloseReason.TaskManagerClosing) return CloseAction.Allow;
            if (dialogOpen) return CloseAction.KeepOpen;
            if (busy) return CloseAction.Busy;
            return confirmed ? CloseAction.Allow : CloseAction.Confirm;
        }
    }
}
