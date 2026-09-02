using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;

namespace SocklessNpm.VisualStudio.Sidecar
{
    /// <summary>
    /// Owns the Node child process running <c>sidecar.js</c> and the
    /// newline-delimited JSON protocol over its stdio. Everything package-manager
    /// related happens in that process; this class only marshals messages and
    /// answers the sidecar's IDE control requests.
    /// </summary>
    public sealed class SidecarProcess : IDisposable
    {
        private readonly Process _process;
        private readonly Func<string, JObject, Task<object>> _onCall;
        private readonly Action<JToken> _onWebMessage;
        private readonly object _writeLock = new object();

        public event Action Ready;

        public SidecarProcess(
            string nodeExe,
            string sidecarJsPath,
            Func<string, JObject, Task<object>> onCall,
            Action<JToken> onWebMessage)
        {
            _onCall = onCall;
            _onWebMessage = onWebMessage;

            _process = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = nodeExe,
                    Arguments = "\"" + sidecarJsPath + "\"",
                    WorkingDirectory = Path.GetDirectoryName(sidecarJsPath) ?? Environment.CurrentDirectory,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardInput = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    StandardOutputEncoding = Encoding.UTF8,
                    //StandardInputEncoding = Encoding.UTF8
                },
                EnableRaisingEvents = true
            };

            _process.OutputDataReceived += (_, e) => { if (e.Data != null) HandleLine(e.Data); };
            _process.ErrorDataReceived += (_, e) => { if (e.Data != null) Debug.WriteLine("[npm-sidecar] " + e.Data); };
        }

        public void Start()
        {
            _process.Start();
            _process.BeginOutputReadLine();
            _process.BeginErrorReadLine();
        }

        /// <summary>Push (or re-push) the roots + flat config the engine should use.</summary>
        public void Configure(string[] roots, JObject config)
        {
            Write(new JObject
            {
                ["t"] = "configure",
                ["roots"] = new JArray(roots),
                ["config"] = config
            });
        }

        public void SetScope(string[] openScope, JArray initializableDirs)
        {
            Write(new JObject
            {
                ["t"] = "scope",
                ["openScope"] = new JArray(openScope ?? Array.Empty<string>()),
                ["initializableDirs"] = initializableDirs ?? new JArray()
            });
        }

        /// <summary>Forward a message received from WebView2 to the engine.</summary>
        public void PostFromWebView(JToken data) =>
            Write(new JObject { ["t"] = "web", ["data"] = data });

        private void HandleLine(string line)
        {
            JObject msg;
            try { msg = JObject.Parse(line); }
            catch { return; }

            switch ((string)msg["t"])
            {
                case "ready":
                    Ready?.Invoke();
                    break;

                case "web":
                    _onWebMessage(msg["data"]);
                    break;

                case "call":
                    _ = AnswerCallAsync(msg);
                    break;
            }
        }

        private async Task AnswerCallAsync(JObject msg)
        {
            var id = (int)msg["id"];
            object value = null;
            try
            {
                value = await _onCall((string)msg["method"], (JObject)msg["payload"] ?? new JObject());
            }
            catch (Exception ex)
            {
                Debug.WriteLine("[npm-sidecar] call failed: " + ex);
            }

            Write(new JObject
            {
                ["t"] = "callResult",
                ["id"] = id,
                ["value"] = value == null ? JValue.CreateNull() : JToken.FromObject(value)
            });
        }

        private void Write(JObject obj)
        {
            lock (_writeLock)
            {
                if (_process.HasExited) return;
                _process.StandardInput.Write(obj.ToString(Newtonsoft.Json.Formatting.None) + "\n");
                _process.StandardInput.Flush();
            }
        }

        public void Dispose()
        {
            try
            {
                if (!_process.HasExited)
                {
                    _process.StandardInput.Close();
                    if (!_process.WaitForExit(2000)) _process.Kill();
                }
            }
            catch { /* best effort */ }
            _process.Dispose();
        }
    }
}
