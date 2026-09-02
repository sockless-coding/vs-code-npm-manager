using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using Microsoft.VisualStudio.PlatformUI;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;
using Microsoft.VisualStudio.Settings;
using Microsoft.VisualStudio.Shell.Settings;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using Newtonsoft.Json;
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

        private readonly Grid _root = new Grid();
        private readonly WebView2 _webView = new WebView2();
        private readonly TextBox _status = new TextBox
        {
            Margin = new Thickness(16),
            TextWrapping = TextWrapping.Wrap,
            IsReadOnly = true,
            BorderThickness = new Thickness(0),
            Background = System.Windows.Media.Brushes.Transparent,
            VerticalAlignment = VerticalAlignment.Top
        };
        private SocklessNpmPackage _package;
        private SidecarProcess _sidecar;
        private bool _ready;
        private NpmScope _pendingScope;
        private bool _initStarted;
        private bool _themeSubscribed;

        public NpmManagerToolWindowControl()
        {
            _status.Text = "Starting the npm Package Manager…";
            _root.Children.Add(_webView);
            _root.Children.Add(_status);
            Content = _root;
            Loaded += (_, __) => _ = InitializeAsync();
        }

        public void Attach(SocklessNpmPackage package)
        {
            _package = package;
            if (IsLoaded) _ = InitializeAsync();
        }

        public void ApplyScope(NpmScope scope)
        {
            _pendingScope = scope;
            // If the engine is already running (manager reopened from a different
            // project/solution), re-configure it with the new roots. The sidecar
            // handles a repeat `configure` without echoing `ready`, so this does
            // not loop.
            if (_ready && _sidecar != null)
            {
                _sidecar.Configure(scope.Roots.ToArray(), CurrentConfig());
                SendScope();
            }
        }

        private void ShowStatus(string text)
        {
            _status.Text = text;
            _status.Visibility = Visibility.Visible;
            _webView.Visibility = Visibility.Collapsed;
        }

        private JObject CurrentConfig() => _package?.Options?.ToConfig() ?? new JObject();

        private async Task InitializeAsync()
        {
            if (_initStarted) return;
            _initStarted = true;

            try
            {
                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();

                var extensionDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location) ?? "";
                var sidecarJs = Path.Combine(extensionDir, "Sidecar", "sidecar.js");
                var webviewDir = Path.Combine(extensionDir, "webview");
                var indexHtml = Path.Combine(webviewDir, "index.html");
                var nodeExe = ResolveNode();

                if (nodeExe == null)
                {
                    ShowStatus(
                        "Node.js was not found on PATH.\n\n" +
                        "Install Node.js (or add it to PATH) and reopen the npm Package Manager. " +
                        "Visual Studio must be restarted after changing PATH.");
                    return;
                }
                if (!File.Exists(sidecarJs) || !File.Exists(indexHtml))
                {
                    ShowStatus(
                        "The npm Package Manager assets are missing from the extension.\n\n" +
                        "Expected:\n  " + sidecarJs + "\n  " + indexHtml + "\n\n" +
                        "Run \"npm run build:vs\" at the repo root and rebuild the VSIX.");
                    return;
                }

                // WebView2's default user-data folder is the host process directory
                // (the read-only Visual Studio install), which makes CoreWebView2
                // init fail and the window render blank. Use a writable location.
                var userDataFolder = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "SocklessNpmPackageManager", "WebView2");
                Directory.CreateDirectory(userDataFolder);

                var env = await CoreWebView2Environment.CreateAsync(null, userDataFolder);
                await _webView.EnsureCoreWebView2Async(env);

                _webView.CoreWebView2.SetVirtualHostNameToFolderMapping(
                    VirtualHost, webviewDir, CoreWebView2HostResourceAccessKind.Allow);

                // Match the Visual Studio theme (light/dark) before the first paint,
                // and re-assert it once the page has loaded in case the
                // document-created hook raced the stylesheet.
                await _webView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(BuildThemeInitScript());
                ApplyPreferredColorScheme();
                _webView.CoreWebView2.NavigationCompleted += (_, __) => ReapplyTheme();
                if (!_themeSubscribed)
                {
                    VSColorTheme.ThemeChanged += OnVsThemeChanged;
                    _themeSubscribed = true;
                }

                _webView.CoreWebView2.WebMessageReceived += (_, e) =>
                {
                    try { _sidecar?.PostFromWebView(JToken.Parse(e.WebMessageAsJson)); }
                    catch (Exception ex) { Debug.WriteLine("[npm] bad web message: " + ex); }
                };

                _sidecar = new SidecarProcess(nodeExe, sidecarJs, OnSidecarCallAsync, OnSidecarWebMessage);
                _sidecar.Ready += OnSidecarReady;
                _sidecar.Exited += OnSidecarExited;
                _sidecar.Start();
                _sidecar.Configure(_pendingScope?.Roots?.ToArray() ?? Array.Empty<string>(), CurrentConfig());
                if (_pendingScope != null) SendScope();

                _status.Visibility = Visibility.Collapsed;
                _webView.Visibility = Visibility.Visible;
                _webView.Source = new Uri($"https://{VirtualHost}/index.html");
            }
            catch (Exception ex)
            {
                ShowStatus("The npm Package Manager failed to start:\n\n" + ex);
            }
        }

        private void OnSidecarReady()
        {
            _ = ThreadHelper.JoinableTaskFactory.RunAsync(async () =>
            {
                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                _ready = true;
                // Re-send only the scope (not `configure`) in case it arrived
                // after start-up. `configure` was already sent once by InitializeAsync.
                SendScope();
            });
        }

        private void OnSidecarExited(int code, string stderrTail)
        {
            _ = ThreadHelper.JoinableTaskFactory.RunAsync(async () =>
            {
                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                if (!_ready)
                {
                    ShowStatus(
                        "The npm Package Manager engine exited (code " + code + ") before it was ready.\n\n" +
                        (string.IsNullOrWhiteSpace(stderrTail) ? "" : stderrTail));
                }
            });
        }

        private void SendScope()
        {
            if (_sidecar == null || _pendingScope == null) return;
            _sidecar.SetScope(
                _pendingScope.OpenScope.ToArray(),
                JArray.FromObject(_pendingScope.InitializableDirs.Select(d => new { dir = d.Dir, name = d.Name })));
        }

        /* ------------------------------ theming ------------------------------ */

        private static string ThemeApplyScript()
        {
            var css = JsonConvert.ToString(VsThemeBridge.BuildRootCss());
            var kind = JsonConvert.ToString(VsThemeBridge.ThemeKind);
            return
                "(function(){var css=" + css + ",kind=" + kind + ";" +
                "var s=document.getElementById('vs-theme')||document.createElement('style');" +
                "s.id='vs-theme';s.textContent=css;(document.head||document.documentElement).appendChild(s);" +
                "document.documentElement.setAttribute('data-vscode-theme-kind',kind);})();";
        }

        private static string BuildThemeInitScript() =>
            // Run now (head may not exist yet -> attaches to <html>) and again once
            // the DOM is parsed so the <style> ends up after the page stylesheet.
            "(function(){var run=function(){" + ThemeApplyScript() + "};run();" +
            "document.addEventListener('DOMContentLoaded',run);})();";

        private void ApplyPreferredColorScheme()
        {
            try
            {
                _webView.CoreWebView2.Profile.PreferredColorScheme =
                    VsThemeBridge.IsDark ? CoreWebView2PreferredColorScheme.Dark : CoreWebView2PreferredColorScheme.Light;
            }
            catch { /* older WebView2 runtime without Profile — the injected CSS still themes the UI */ }
        }

        private void ReapplyTheme()
        {
            _ = ThreadHelper.JoinableTaskFactory.RunAsync(async () =>
            {
                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                if (_webView.CoreWebView2 == null) return;
                await _webView.CoreWebView2.ExecuteScriptAsync(ThemeApplyScript());
                ApplyPreferredColorScheme();
            });
        }

        private void OnVsThemeChanged(ThemeChangedEventArgs e) => ReapplyTheme();

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
            if (_themeSubscribed)
            {
                VSColorTheme.ThemeChanged -= OnVsThemeChanged;
                _themeSubscribed = false;
            }
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
