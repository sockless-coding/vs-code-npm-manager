using System;
using System.ComponentModel.Design;
using EnvDTE;
using EnvDTE80;
using Microsoft.VisualStudio.Shell;
using SocklessNpm.VisualStudio.Sidecar;
using SocklessNpm.VisualStudio.ToolWindows;
using Task = System.Threading.Tasks.Task;

namespace SocklessNpm.VisualStudio.Commands
{
    /// <summary>"Manage npm Packages (Solution)..." — aggregates every project in the solution.</summary>
    internal sealed class OpenFromSolutionCommand
    {
        private static readonly Guid CommandSet = new Guid("f0b8c1e2-4c1a-4b8e-9d2a-000000000011");
        private const int CommandId = 0x0101;

        private readonly AsyncPackage _package;

        private OpenFromSolutionCommand(AsyncPackage package, OleMenuCommandService commandService)
        {
            _package = package;
            commandService.AddCommand(new MenuCommand(Execute, new CommandID(CommandSet, CommandId)));
        }

        public static async Task InitializeAsync(AsyncPackage package)
        {
            await package.JoinableTaskFactory.SwitchToMainThreadAsync();
            var commandService = (OleMenuCommandService)await package.GetServiceAsync(typeof(IMenuCommandService));
            _ = new OpenFromSolutionCommand(package, commandService);
        }

        private void Execute(object sender, EventArgs e)
        {
            _package.JoinableTaskFactory.RunAsync(async () =>
            {
                await _package.JoinableTaskFactory.SwitchToMainThreadAsync();

                var dte = (DTE2)await _package.GetServiceAsync(typeof(DTE));
                if (dte?.Solution == null || string.IsNullOrEmpty(dte.Solution.FullName)) return;

                var scope = ProjectModelCollector.ForSolution(dte.Solution);
                await ToolWindowLauncher.ShowAsync(_package, scope);
            });
        }
    }
}
