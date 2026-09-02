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
    // Style = MDI docks the window in the main document area (the editor tab well),
    // like the VS Code webview panel — not beside Solution Explorer.
    [ProvideToolWindow(typeof(NpmManagerToolWindow), Style = VsDockStyle.MDI, MultiInstances = false, Transient = false)]
    [ProvideOptionPage(typeof(NpmManagerOptionsPage), "npm Package Manager", "General", 0, 0, true)]
    public sealed class SocklessNpmPackage : AsyncPackage
    {
        public const string PackageGuidString = "f0b8c1e2-4c1a-4b8e-9d2a-000000000010";

        /// <summary>The loaded package instance — used by the tool window to read options.</summary>
        public static SocklessNpmPackage Instance { get; private set; }

        protected override async Task InitializeAsync(CancellationToken cancellationToken, IProgress<ServiceProgressData> progress)
        {
            await base.InitializeAsync(cancellationToken, progress);
            await this.JoinableTaskFactory.SwitchToMainThreadAsync(cancellationToken);

            Instance = this;
            await OpenFromProjectCommand.InitializeAsync(this);
            await OpenFromSolutionCommand.InitializeAsync(this);
        }

        /// <summary>Reads the current option values as the flat config the sidecar expects.</summary>
        public NpmManagerOptionsPage Options =>
            (NpmManagerOptionsPage)GetDialogPage(typeof(NpmManagerOptionsPage));
    }
}
