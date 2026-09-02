using System;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.VisualStudio.Shell;
using SocklessNpm.VisualStudio.Commands;
using SocklessNpm.VisualStudio.Options;
using SocklessNpm.VisualStudio.ToolWindows;
using Task = System.Threading.Tasks.Task;

namespace SocklessNpm.VisualStudio
{
    /// <summary>
    /// Package entry point. Registers the npm manager tool window, the two
    /// context-menu commands (project node / solution node), and the options page
    /// that maps onto the same <c>npmManager.*</c> settings the VS Code extension
    /// exposes.
    /// </summary>
    [PackageRegistration(UseManagedResourcesOnly = true, AllowsBackgroundLoading = true)]
    [InstalledProductRegistration("Sockless npm Package Manager", "Visual npm package manager for Visual Studio.", "0.1.0")]
    [Guid(PackageGuidString)]
    [ProvideMenuResource("Menus.ctmenu", 1)]
    [ProvideToolWindow(typeof(NpmManagerToolWindow), Style = VsDockStyle.Tabbed, Window = "3ae79031-e1bc-11d0-8f78-00a0c9110057")]
    [ProvideOptionPage(typeof(NpmManagerOptionsPage), "npm Package Manager", "General", 0, 0, true)]
    public sealed class SocklessNpmPackage : AsyncPackage
    {
        public const string PackageGuidString = "f0b8c1e2-4c1a-4b8e-9d2a-000000000010";

        protected override async Task InitializeAsync(CancellationToken cancellationToken, IProgress<ServiceProgressData> progress)
        {
            await base.InitializeAsync(cancellationToken, progress);
            await this.JoinableTaskFactory.SwitchToMainThreadAsync(cancellationToken);

            await OpenFromProjectCommand.InitializeAsync(this);
            await OpenFromSolutionCommand.InitializeAsync(this);
        }

        /// <summary>Reads the current option values as the flat config the sidecar expects.</summary>
        public NpmManagerOptionsPage Options =>
            (NpmManagerOptionsPage)GetDialogPage(typeof(NpmManagerOptionsPage));
    }
}
