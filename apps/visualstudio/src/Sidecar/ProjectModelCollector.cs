using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using EnvDTE;
using EnvDTE80;
using Microsoft.VisualStudio.Shell;

namespace SocklessNpm.VisualStudio.Sidecar
{
    /// <summary>The roots + init offers the sidecar should be configured with for a given entry point.</summary>
    public sealed class NpmScope
    {
        public List<string> Roots { get; } = new List<string>();
        public List<InitializableDir> InitializableDirs { get; } = new List<InitializableDir>();
        public List<string> OpenScope { get; } = new List<string>();
    }

    public sealed class InitializableDir
    {
        public string Dir { get; set; }
        public string Name { get; set; }
    }

    /// <summary>
    /// Resolves a right-clicked Solution Explorer node into a scope for the manager:
    ///
    ///  * a single project     -> that project's directory only
    ///  * a solution            -> every project directory in the solution
    ///  * a project with no
    ///    package.json          -> that directory, flagged for "Create package.json"
    /// </summary>
    public static class ProjectModelCollector
    {
        public static NpmScope ForProject(Project project)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var scope = new NpmScope();
            var dir = DirectoryOf(project);
            if (dir == null) return scope;

            scope.Roots.Add(dir);
            var packageJson = Path.Combine(dir, "package.json");
            if (File.Exists(packageJson))
                scope.OpenScope.Add(packageJson);
            else
                scope.InitializableDirs.Add(new InitializableDir { Dir = dir, Name = project.Name });

            return scope;
        }

        public static NpmScope ForSolution(Solution solution)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var scope = new NpmScope();
            var solutionDir = string.IsNullOrEmpty(solution.FullName)
                ? null
                : Path.GetDirectoryName(solution.FullName);
            if (solutionDir != null) scope.Roots.Add(solutionDir);

            foreach (var project in EnumerateProjects(solution))
            {
                var dir = DirectoryOf(project);
                if (dir != null && !scope.Roots.Any(r => PathsEqual(r, dir)))
                    scope.Roots.Add(dir);
            }

            return scope;
        }

        private static IEnumerable<Project> EnumerateProjects(Solution solution)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            foreach (Project project in solution.Projects)
            {
                foreach (var p in Flatten(project))
                    yield return p;
            }
        }

        private static IEnumerable<Project> Flatten(Project project)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            // Solution folders report a null/empty Kind guid for a real project;
            // recurse through their ProjectItems.
            if (project.Kind == ProjectKinds.vsProjectKindSolutionFolder)
            {
                foreach (ProjectItem item in project.ProjectItems)
                {
                    if (item.SubProject != null)
                        foreach (var p in Flatten(item.SubProject))
                            yield return p;
                }
            }
            else
            {
                yield return project;
            }
        }

        private static string DirectoryOf(Project project)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            try
            {
                var full = project.FullName;
                if (string.IsNullOrEmpty(full)) return null;
                return File.Exists(full) ? Path.GetDirectoryName(full) : full.TrimEnd('\\', '/');
            }
            catch
            {
                return null;
            }
        }

        private static bool PathsEqual(string a, string b) =>
            string.Equals(
                Path.GetFullPath(a).TrimEnd('\\', '/'),
                Path.GetFullPath(b).TrimEnd('\\', '/'),
                StringComparison.OrdinalIgnoreCase);
    }
}
