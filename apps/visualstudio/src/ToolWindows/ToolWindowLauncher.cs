using System;
using Microsoft.VisualStudio;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;
using SocklessNpm.VisualStudio.Sidecar;
using Task = System.Threading.Tasks.Task;

namespace SocklessNpm.VisualStudio.ToolWindows
{
    internal static class ToolWindowLauncher
    {
        /// <summary>Show (creating if needed) the npm manager tool window and point it at <paramref name="scope"/>.</summary>
        public static async Task ShowAsync(AsyncPackage package, NpmScope scope)
        {
            await package.JoinableTaskFactory.SwitchToMainThreadAsync();

            var window = await package.ShowToolWindowAsync(
                typeof(NpmManagerToolWindow), 0, create: true, cancellationToken: package.DisposalToken)
                as NpmManagerToolWindow;

            if (window?.Frame is IVsWindowFrame frame)
                ErrorHandler.ThrowOnFailure(frame.Show());

            window?.ApplyScope(scope);
        }
    }
}
