using System;
using System.Runtime.InteropServices;
using Microsoft.VisualStudio.Shell;
using SocklessNpm.VisualStudio.Sidecar;

namespace SocklessNpm.VisualStudio.ToolWindows
{
    /// <summary>
    /// The dockable npm Package Manager panel. Hosts a WebView2 running the shared
    /// React UI (<c>webview/index.html</c>) wired to the Node engine sidecar.
    /// </summary>
    [Guid(ToolWindowGuidString)]
    public sealed class NpmManagerToolWindow : ToolWindowPane
    {
        public const string ToolWindowGuidString = "f0b8c1e2-4c1a-4b8e-9d2a-000000000020";

        private readonly NpmManagerToolWindowControl _control;

        public NpmManagerToolWindow() : base(null)
        {
            Caption = "npm Package Manager";
            _control = new NpmManagerToolWindowControl();
            Content = _control;
        }

        protected override void Initialize()
        {
            base.Initialize();
            _control.Attach(SocklessNpmPackage.Instance);
        }

        /// <summary>Point the manager at a project / solution scope (called by the context-menu commands).</summary>
        public void ApplyScope(NpmScope scope)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            _control.ApplyScope(scope);
        }

        protected override void OnClose()
        {
            _control.Dispose();
            base.OnClose();
        }
    }
}
