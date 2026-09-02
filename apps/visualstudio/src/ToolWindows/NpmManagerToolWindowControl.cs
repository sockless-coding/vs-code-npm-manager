using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;
using Microsoft.VisualStudio.Settings;
using Microsoft.VisualStudio.Shell.Settings;
using Microsoft.Web.WebView2.Wpf;
using Newtonsoft.Json.Linq;
using SocklessNpm.VisualStudio.Sidecar;

namespace SocklessNpm.VisualStudio.ToolWindows
{
    /// <summary>
    /// WebView2 host + bridge between the sidecar process and the React UI.
    /// Code-only WPF control (no XAML) to keep the VSIX build simple.
    /// </summary>
    public sealed class NpmManagerToolWindowControl : UserControl, IDisposable
    {
        private const string VirtualHost = "npm.manager";
        private const string SettingsCollection = "SocklessNpmPackageManager";

        private readonly WebView2 _webView = new WebView2();
        private SocklessNpmPackage _package;
        private SidecarProcess _sidecar;
        private bool _ready;
        private NpmScope _pendingScope;
        private bool _initialized;

        public NpmManagerToolWindowControl()
        {
            Content = _webView;
        }

        public void Attach(SocklessNpmPackage package)
        {
            _package = package;
            _ = InitializeAsync();
        }

        public void ApplyScope(NpmScope scope)
        {
            _pendingScope = scope;
            PushScopeIfReady();
        }

        private async Task InitializeAsync()
        {
            if (_initialized) return;
            _initialized = true;

            var extensionDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location) ?? "";
            var sidecarJs = Path.Combine(extensionDir, "Sidecar", "sidecar.js");
            var webviewDir = Path.Combine(extensionDir, "webview");
            var nodeExe = ResolveNode();

            if (nodeExe == null || !File.Exists(sidecarJs) || !File.Exists(Path.Combine(webviewDir, "index.html")))
            {
                _webView.Visibility = Visibility.Collapsed;
                Content = new TextBlock
                {
                    Margin = new Thickness(16),
                    TextWrapping = TextWrapping.Wrap,
                    Text = nodeExe == null
                        ? "Node.js was not found on PATH. Install Node.js to use the npm Package Manager."
                        : "The npm Package Manager assets are missing from the extension. Rebuild the VSIX."
                };
                return;
            }

            await _webView.EnsureCoreWebView2Async();
            _webView.CoreWebView2.SetVirtualHostNameToFolderMapping(
                VirtualHost, webviewDir, Microsoft.Web.WebView2.Core.CoreWebView2HostResourceAccessKind.Allow);
            _webView.CoreWebView2.WebMessageReceived += (_, e) =>
            {
                try { _sidecar?.PostFromWebView(JToken.Parse(e.WebMessageAsJson)); }
                catch (Exception ex) { Debug.WriteLine("[npm] bad web message: " + ex); }
            };

            _sidecar = new SidecarProcess(nodeExe, sidecarJs, OnSidecarCallAsync, OnSidecarWebMessage);
            _sidecar.Ready += () =>
            {
                _ready = true;
                _ = ThreadHelper.JoinableTaskFactory.RunAsync(async () =>
                {
                    await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                    PushScopeIfReady();
                });
            };
            _sidecar.Start();

            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
            _sidecar.Configure(CurrentRoots(), _package.Options.ToConfig());
            _webView.CoreWebView2.Navigate($"https://{VirtualHost}/index.html");
        }

        private string[] CurrentRoots()
        {
            return _pendingScope?.Roots?.ToArray() ?? Array.Empty<string>();
        }

        private void PushScopeIfReady()
        {
            if (!_ready || _sidecar == null || _pendingScope == null) return;
            _sidecar.Configure(_pendingScope.Roots.ToArray(), _package.Options.ToConfig());
            _sidecar.SetScope(
                _pendingScope.OpenScope.ToArray(),
                JArray.FromObject(_pendingScope.InitializableDirs.Select(d => new { dir = d.Dir, name = d.Name })));
        }

        private void OnSidecarWebMessage(JToken data)
        {
            _ = ThreadHelper.JoinableTaskFactory.RunAsync(async () =>
            {
                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                _webView.CoreWebView2?.PostWebMessageAsJson(data.ToString(Newtonsoft.Json.Formatting.None));
            });
        }

        private async Task<object> OnSidecarCallAsync(string method, JObject payload)
        {
            switch (method)
            {
                case "openExternal":
                    OpenExternal((string)payload["url"]);
                    return null;

                case "getSecret":
                    return ReadSecret((string)payload["key"]);

                case "setSecret":
                    WriteSecret((string)payload["key"], (string)payload["value"]);
                    return null;

                case "promptForSecret":
                    return await PromptForSecretAsync((string)payload["title"], (string)payload["prompt"]);

                default:
                    return null;
            }
        }

        private static void OpenExternal(string url)
        {
            if (string.IsNullOrWhiteSpace(url)) return;
            try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
            catch (Exception ex) { Debug.WriteLine("[npm] openExternal failed: " + ex); }
        }

        private WritableSettingsStore SettingsStore()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var manager = new ShellSettingsManager(ServiceProvider.GlobalProvider);
            var store = manager.GetWritableSettingsStore(SettingsScope.UserSettings);
            if (!store.CollectionExists(SettingsCollection)) store.CreateCollection(SettingsCollection);
            return store;
        }

        private string ReadSecret(string key)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var store = SettingsStore();
            return store.PropertyExists(SettingsCollection, key)
                ? Unprotect(store.GetString(SettingsCollection, key))
                : null;
        }

        private void WriteSecret(string key, string value)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var store = SettingsStore();
            if (string.IsNullOrEmpty(value))
            {
                if (store.PropertyExists(SettingsCollection, key)) store.DeleteProperty(SettingsCollection, key);
            }
            else
            {
                store.SetString(SettingsCollection, key, Protect(value));
            }
        }

        private static string Protect(string value)
        {
            var bytes = System.Security.Cryptography.ProtectedData.Protect(
                System.Text.Encoding.UTF8.GetBytes(value), null,
                System.Security.Cryptography.DataProtectionScope.CurrentUser);
            return Convert.ToBase64String(bytes);
        }

        private static string Unprotect(string stored)
        {
            try
            {
                var bytes = System.Security.Cryptography.ProtectedData.Unprotect(
                    Convert.FromBase64String(stored), null,
                    System.Security.Cryptography.DataProtectionScope.CurrentUser);
                return System.Text.Encoding.UTF8.GetString(bytes);
            }
            catch { return null; }
        }

        private async Task<string> PromptForSecretAsync(string title, string prompt)
        {
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
            return SecretInputDialog.Show(title, prompt);
        }

        private static string ResolveNode()
        {
            var pathVar = Environment.GetEnvironmentVariable("PATH") ?? "";
            var exeNames = new[] { "node.exe", "node" };
            foreach (var dir in pathVar.Split(Path.PathSeparator))
            {
                foreach (var name in exeNames)
                {
                    try
                    {
                        var candidate = Path.Combine(dir.Trim(), name);
                        if (File.Exists(candidate)) return candidate;
                    }
                    catch { /* malformed PATH entry */ }
                }
            }
            return null;
        }

        public void Dispose()
        {
            _sidecar?.Dispose();
            _webView?.Dispose();
        }
    }

    /// <summary>Tiny modal password prompt (code-only WPF) for registry credentials.</summary>
    internal static class SecretInputDialog
    {
        public static string Show(string title, string prompt)
        {
            var box = new System.Windows.Controls.PasswordBox { Margin = new Thickness(0, 8, 0, 0), MinWidth = 360 };
            var panel = new StackPanel { Margin = new Thickness(16) };
            panel.Children.Add(new TextBlock { Text = prompt, TextWrapping = TextWrapping.Wrap });
            panel.Children.Add(box);

            var ok = new Button { Content = "OK", IsDefault = true, Width = 80, Margin = new Thickness(0, 12, 8, 0) };
            var cancel = new Button { Content = "Cancel", IsCancel = true, Width = 80, Margin = new Thickness(0, 12, 0, 0) };
            var buttons = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right };
            buttons.Children.Add(ok);
            buttons.Children.Add(cancel);
            panel.Children.Add(buttons);

            var window = new Window
            {
                Title = title,
                Content = panel,
                SizeToContent = SizeToContent.WidthAndHeight,
                WindowStartupLocation = WindowStartupLocation.CenterScreen,
                ResizeMode = ResizeMode.NoResize
            };
            ok.Click += (_, __) => { window.DialogResult = true; };
            return window.ShowDialog() == true ? box.Password : null;
        }
    }
}
