using System;
using System.ComponentModel.Design;
using System.Linq;
using EnvDTE;
using EnvDTE80;
using Microsoft.VisualStudio.Shell;
using SocklessNpm.VisualStudio.Sidecar;
using SocklessNpm.VisualStudio.ToolWindows;
using Task = System.Threading.Tasks.Task;

namespace SocklessNpm.VisualStudio.Commands
{
    /// <summary>"Manage npm Packages..." on a project node — scopes the manager to that project.</summary>
    internal sealed class OpenFromProjectCommand
    {
        private static readonly Guid CommandSet = new Guid("f0b8c1e2-4c1a-4b8e-9d2a-000000000011");
        private const int CommandId = 0x0100;

        private readonly AsyncPackage _package;

        private OpenFromProjectCommand(AsyncPackage package, OleMenuCommandService commandService)
        {
            _package = package;
            var menuItem = new MenuCommand(Execute, new CommandID(CommandSet, CommandId));
            commandService.AddCommand(menuItem);
        }

        public static async Task InitializeAsync(AsyncPackage package)
        {
            await package.JoinableTaskFactory.SwitchToMainThreadAsync();
            var commandService = (OleMenuCommandService)await package.GetServiceAsync(typeof(IMenuCommandService));
            _ = new OpenFromProjectCommand(package, commandService);
        }

        private void Execute(object sender, EventArgs e)
        {
            _package.JoinableTaskFactory.RunAsync(async () =>
            {
                await _package.JoinableTaskFactory.SwitchToMainThreadAsync();

                var dte = (DTE2)await _package.GetServiceAsync(typeof(DTE));
                var project = (dte?.ToolWindows.SolutionExplorer.SelectedItems as object[])
                    ?.OfType<UIHierarchyItem>()
                    .Select(i => i.Object as Project)
                    .FirstOrDefault(p => p != null)
                    ?? dte?.SelectedItems.Cast<SelectedItem>().Select(s => s.Project).FirstOrDefault(p => p != null);

                if (project == null) return;

                var scope = ProjectModelCollector.ForProject(project);
                await ToolWindowLauncher.ShowAsync(_package, scope);
            });
        }
    }
}
