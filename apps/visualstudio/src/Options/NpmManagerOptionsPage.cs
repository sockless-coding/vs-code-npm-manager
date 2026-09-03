using System.Collections.Generic;
using System.ComponentModel;
using Microsoft.VisualStudio.Shell;
using Newtonsoft.Json.Linq;

namespace SocklessNpm.VisualStudio.Options
{
    /// <summary>
    /// The same settings surface as the VS Code extension's <c>npmManager.*</c>
    /// configuration. <see cref="ToConfig"/> produces the object handed to the
    /// sidecar in the <c>configure</c> message.
    /// </summary>
    public class NpmManagerOptionsPage : DialogPage
    {
        [Category("General")]
        [DisplayName("Include prerelease by default")]
        [Description("Include prerelease (-beta, -rc) versions in search results by default.")]
        public bool DefaultIncludePrerelease { get; set; } = false;

        [Category("General")]
        [DisplayName("Package manager path")]
        [Description("Path to the npm/yarn/pnpm executable. Leave empty to auto-detect from lockfiles and PATH.")]
        public string PackageManagerPath { get; set; } = "";

        [Category("General")]
        [DisplayName("Auto-install after changes")]
        [Description("Run an install automatically after adding, updating or removing packages.")]
        public bool AutoInstall { get; set; } = true;

        [Category("General")]
        [DisplayName("Minimum package age (days)")]
        [Description("Newer published versions are flagged and held back from Update All. 0 disables the check.")]
        public int MinimumPackageAgeDays { get; set; } = 7;

        [Category("General")]
        [DisplayName("Reconcile with npm audit")]
        [Description("Reconcile the Installed view with 'npm audit --json' after the fast on-disk scan (npm projects only).")]
        public bool UsePackageManagerForEnumeration { get; set; } = false;

        [Category("General")]
        [DisplayName("Additional registries (name=url, one per line)")]
        [Description("Extra npm registries to query, merged with any discovered from .npmrc.")]
        public string AdditionalRegistries { get; set; } = "";

        public JObject ToConfig()
        {
            var registries = new JArray();
            foreach (var line in AdditionalRegistries.Split('\n'))
            {
                var trimmed = line.Trim();
                var eq = trimmed.IndexOf('=');
                if (eq <= 0) continue;
                registries.Add(new JObject
                {
                    ["name"] = trimmed.Substring(0, eq).Trim(),
                    ["url"] = trimmed.Substring(eq + 1).Trim()
                });
            }

            return new JObject
            {
                ["defaultIncludePrerelease"] = DefaultIncludePrerelease,
                ["packageManagerPath"] = PackageManagerPath ?? "",
                ["autoInstall"] = AutoInstall,
                ["minimumPackageAgeDays"] = MinimumPackageAgeDays,
                ["usePackageManagerForEnumeration"] = UsePackageManagerForEnumeration,
                ["additionalRegistries"] = registries
            };
        }
    }
}
