using System;
using System.Collections.Generic;
using System.Drawing;
using System.Text;
using Microsoft.VisualStudio.PlatformUI;
using Microsoft.VisualStudio.Shell;

namespace SocklessNpm.VisualStudio.ToolWindows
{
    /// <summary>
    /// Bridges the current Visual Studio color theme into the webview.
    ///
    /// The shared React UI styles itself with the <c>--vscode-*</c> CSS custom
    /// properties that the VS Code webview host injects. Visual Studio's WebView2
    /// injects nothing, so we synthesize an equivalent <c>:root {}</c> block from
    /// the live VS theme — real theme colors where a key exists, a coherent
    /// derived palette for the rest — and (re-)inject it on load and whenever the
    /// user switches theme.
    /// </summary>
    internal static class VsThemeBridge
    {
        public static bool IsDark
        {
            get
            {
                var bg = Probe(EnvironmentColors.ToolWindowBackgroundColorKey);
                if (bg == null) return false; // no signal -> assume the default (light)
                var c = bg.Value;
                return (c.R * 0.299 + c.G * 0.587 + c.B * 0.114) < 128.0;
            }
        }

        public static string ThemeKind => IsDark ? "vscode-dark" : "vscode-light";

        /// <summary>A `:root { … }` rule defining every `--vscode-*` property the webview CSS reads.</summary>
        public static string BuildRootCss()
        {
            bool dark = IsDark;

            string bg = Hex(Probe(EnvironmentColors.ToolWindowBackgroundColorKey), dark ? "#1e1e1e" : "#ffffff");
            string fg = Hex(Probe(EnvironmentColors.ToolWindowTextColorKey), dark ? "#cccccc" : "#1e1e1e");
            string border = Hex(Probe(EnvironmentColors.ToolWindowBorderColorKey), dark ? "#3f3f46" : "#dddddd");
            string inputBg = Hex(Probe(EnvironmentColors.ComboBoxBackgroundColorKey), dark ? "#3c3c3c" : "#ffffff");
            string inputFg = Hex(Probe(EnvironmentColors.ComboBoxTextColorKey), fg);
            string inputBd = Hex(Probe(EnvironmentColors.ComboBoxBorderColorKey), dark ? "#3f3f46" : "#cecece");
            string selBg = Hex(Probe(EnvironmentColors.SystemHighlightColorKey), dark ? "#094771" : "#0060c0");
            string selFg = Hex(Probe(EnvironmentColors.SystemHighlightTextColorKey), "#ffffff");
            string link = Hex(Probe(EnvironmentColors.ControlLinkTextColorKey), dark ? "#3794ff" : "#006ab1");

            string subtle = dark ? "#9d9d9d" : "#6a6a6a";
            string hover = dark ? "#2a2d2e" : "#e8e8e8";
            string widget = dark ? "#252526" : "#f3f3f3";
            string codeBg = dark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)";
            string btnBg = dark ? "#0e639c" : "#005fb8";
            string btnHov = dark ? "#1177bb" : "#0258a8";
            string btn2Bg = dark ? "#3a3d41" : "#e4e6eb";
            string btn2Hov = dark ? "#45494e" : "#d5d8de";
            string badgeBg = dark ? "#4d4d4d" : "#c4c4c4";
            string badgeFg = dark ? "#ffffff" : "#333333";
            string err = dark ? "#f14c4c" : "#e51400";
            string warn = dark ? "#cca700" : "#bf8803";
            string errBg = dark ? "#5a1d1d" : "#f2dede";
            string warnBg = dark ? "#5a4a1d" : "#f8efc0";

            var vars = new Dictionary<string, string>
            {
                ["--vscode-font-family"] = "\"Segoe UI\", -apple-system, system-ui, sans-serif",
                ["--vscode-font-size"] = "13px",
                ["--vscode-foreground"] = fg,
                ["--vscode-descriptionForeground"] = subtle,
                ["--vscode-errorForeground"] = err,
                ["--vscode-focusBorder"] = selBg,
                ["--vscode-editor-background"] = bg,
                ["--vscode-editorWidget-background"] = widget,
                ["--vscode-panel-border"] = border,
                ["--vscode-textLink-foreground"] = link,
                ["--vscode-textCodeBlock-background"] = codeBg,
                ["--vscode-toolbar-hoverBackground"] = hover,
                ["--vscode-input-background"] = inputBg,
                ["--vscode-input-foreground"] = inputFg,
                ["--vscode-input-border"] = inputBd,
                ["--vscode-dropdown-background"] = inputBg,
                ["--vscode-dropdown-foreground"] = inputFg,
                ["--vscode-dropdown-border"] = inputBd,
                ["--vscode-list-hoverBackground"] = hover,
                ["--vscode-list-activeSelectionBackground"] = selBg,
                ["--vscode-list-activeSelectionForeground"] = selFg,
                ["--vscode-button-background"] = btnBg,
                ["--vscode-button-foreground"] = "#ffffff",
                ["--vscode-button-hoverBackground"] = btnHov,
                ["--vscode-button-secondaryBackground"] = btn2Bg,
                ["--vscode-button-secondaryForeground"] = fg,
                ["--vscode-button-secondaryHoverBackground"] = btn2Hov,
                ["--vscode-badge-background"] = badgeBg,
                ["--vscode-badge-foreground"] = badgeFg,
                ["--vscode-activityBarBadge-background"] = btnBg,
                ["--vscode-activityBarBadge-foreground"] = "#ffffff",
                ["--vscode-editorError-foreground"] = err,
                ["--vscode-editorWarning-foreground"] = warn,
                ["--vscode-inputValidation-errorBackground"] = errBg,
                ["--vscode-inputValidation-errorForeground"] = fg,
                ["--vscode-inputValidation-warningBackground"] = warnBg,
                ["--vscode-inputValidation-warningForeground"] = fg,
                ["--vscode-notifications-background"] = widget,
                ["--vscode-notifications-foreground"] = fg,
                ["--vscode-charts-blue"] = dark ? "#3794ff" : "#1976d2",
                ["--vscode-charts-orange"] = "#d18616",
                ["--vscode-charts-yellow"] = warn
            };

            var sb = new StringBuilder(":root{color-scheme:").Append(dark ? "dark" : "light").Append(';');
            foreach (var kv in vars) sb.Append(kv.Key).Append(':').Append(kv.Value).Append(';');
            return sb.Append('}').ToString();
        }

        /// <summary>The themed color for <paramref name="key"/>, or null if it is unavailable/unset.</summary>
        private static Color? Probe(ThemeResourceKey key)
        {
            try
            {
                var c = VSColorTheme.GetThemedColor(key);
                if (c.R != 0 || c.G != 0 || c.B != 0 || c.A != 0) return c;
            }
            catch { /* key not present on this VS build */ }
            return null;
        }

        private static string Hex(Color? color, string fallback) =>
            color == null ? fallback : $"#{color.Value.R:x2}{color.Value.G:x2}{color.Value.B:x2}";
    }
}
