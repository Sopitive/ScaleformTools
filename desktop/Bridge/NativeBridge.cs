using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Core;
using Microsoft.Win32;

namespace ScaleformTools.Bridge;

/// <summary>
/// Message-based bridge between the React/JS layer and C#.
///
/// JS → C#  :  window.chrome.webview.postMessage(JSON.stringify({id, type, args}))
/// C# → JS  :  ExecuteScriptAsync("window.__nativeBridge.resolve(id, result)")
///              or                ("window.__nativeBridge.reject(id, errorMessage)")
///
/// The JS side (native.ts) wraps these in Promises so callers use async/await.
/// </summary>
public sealed class NativeBridge : IDisposable
{
    private readonly CoreWebView2 _wv;
    private readonly Dispatcher   _dispatcher;
    private readonly LiveEditService _liveEdit = new();

    private string? _lastOpenedPath;
    private string? _liveSourcePath;
    private string  _liveBackupDir = DefaultBackupDir;

    /// Directory currently serving pack files via the localpack:// resource handler.
    private string? _packDirectory;

    // URL prefix intercepted by WebResourceRequested — not a real domain, never resolves.
    private const string PackFilePrefix = "https://localpack.invalid/";

    private static string DefaultBackupDir =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
                     "ScaleformTools", "Backups");

    public NativeBridge(CoreWebView2 webView, Dispatcher dispatcher)
    {
        _wv         = webView;
        _dispatcher = dispatcher;

        _wv.WebMessageReceived += OnMessageReceived;

        // Intercept all requests to https://localpack.invalid/* and serve them from
        // _packDirectory on disk — avoids JSON/base64 size limits for large temp.bin files.
        _wv.AddWebResourceRequestedFilter(PackFilePrefix + "*", CoreWebView2WebResourceContext.All);
        _wv.WebResourceRequested += OnPackFileRequested;

        _liveEdit.StatusChanged += status =>
            _ = _wv.ExecuteScriptAsync(
                $"window.__nativeBridge?.onLiveEditStatus({JsonSerializer.Serialize(status)});");
    }

    private void OnPackFileRequested(object? sender, CoreWebView2WebResourceRequestedEventArgs e)
    {
        if (_packDirectory == null) return;
        try
        {
            var uri      = new Uri(e.Request.Uri);
            var fileName = Uri.UnescapeDataString(uri.AbsolutePath.TrimStart('/'));

            // Safety: reject any path traversal
            var fullPath = Path.GetFullPath(Path.Combine(_packDirectory, fileName));
            var fullDir  = Path.GetFullPath(_packDirectory);
            if (!fullPath.StartsWith(fullDir + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) return;
            if (!File.Exists(fullPath)) return;

            // Stream the file directly — no in-memory copy needed even for large files.
            var stream   = File.OpenRead(fullPath);
            e.Response   = _wv.Environment.CreateWebResourceResponse(
                stream, 200, "OK",
                "Content-Type: application/octet-stream\r\nAccess-Control-Allow-Origin: *\r\n");
        }
        catch { /* silently ignore; JS fetch will receive a network error */ }
    }

    private async void OnMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        string id = "?";
        try
        {
            string rawMessage;
            using (var wrapper = JsonDocument.Parse(e.WebMessageAsJson))
            {
                rawMessage = wrapper.RootElement.ValueKind == JsonValueKind.String
                    ? wrapper.RootElement.GetString()!
                    : e.WebMessageAsJson;
            }
            using var doc  = JsonDocument.Parse(rawMessage);
            var root = doc.RootElement;
            id   = root.GetProperty("id").GetString() ?? "?";
            var type = root.GetProperty("type").GetString() ?? "";
            var args = root.TryGetProperty("args", out var a) ? a : default;

            object? result = type switch
            {
                "openFile"        => await HandleOpenFile(args),
                "openTexturePack" => HandleOpenTexturePack(),
                "saveFile"        => await HandleSaveFile(args),
                "saveFileDialog"  => HandleSaveFileDialog(args),
                "pickDirectory"   => HandlePickDirectory(),
                "liveEditWrite"   => await HandleLiveEditWrite(args),
                "setLiveSource"   => HandleSetLiveSource(args),
                "getLiveStatus"   => GetLiveStatus(),
                _                 => throw new InvalidOperationException($"Unknown bridge type: {type}"),
            };

            await Resolve(id, result);
        }
        catch (Exception ex)
        {
            await Reject(id, ex.Message);
        }
    }

    private Task<object> HandleOpenFile(JsonElement args)
    {
        string filter = TryGetString(args, "filter") ?? "Scaleform Files|*.gfx;*.GFX;*.swf|All Files|*.*";

        return _dispatcher.InvokeAsync<object>(() =>
        {
            var dlg = new OpenFileDialog
            {
                Filter = filter,
                Title  = "Open File",
                InitialDirectory = _lastOpenedPath != null
                    ? Path.GetDirectoryName(_lastOpenedPath) : null,
            };

            if (dlg.ShowDialog(MainWin) != true)
                return (object)new { cancelled = true };

            _lastOpenedPath = dlg.FileName;
            var bytes = File.ReadAllBytes(dlg.FileName);
            return new
            {
                cancelled = false,
                name      = Path.GetFileName(dlg.FileName),
                path      = dlg.FileName,
                dataBase64= Convert.ToBase64String(bytes),
            };
        }).Task;
    }

    private object HandleOpenTexturePack()
    {
        return _dispatcher.Invoke<object>(() =>
        {
            var dlg = new OpenFileDialog
            {
                Filter = "Texture Pack|*.perm.bin|All Files|*.*",
                Title  = "Open Texture Pack — select the .perm.bin file",
                InitialDirectory = _lastOpenedPath != null
                    ? Path.GetDirectoryName(_lastOpenedPath) : null,
            };

            if (dlg.ShowDialog(MainWin) != true)
                return (object)new { cancelled = true };

            _lastOpenedPath  = dlg.FileName;
            _packDirectory   = Path.GetDirectoryName(dlg.FileName)!;

            var dir      = _packDirectory;
            var fileName = Path.GetFileName(dlg.FileName);   // "foo.perm.bin"
            var baseName = fileName[..^9];                    // "foo"

            var tempName = baseName + ".temp.bin";
            var idxName  = baseName + ".perm.idx";

            return new
            {
                cancelled = false,
                host      = "localpack.invalid",
                permName  = fileName,
                tempName  = File.Exists(Path.Combine(dir, tempName)) ? tempName : (string?)null,
                idxName   = File.Exists(Path.Combine(dir, idxName))  ? idxName  : (string?)null,
            };
        });
    }

    private async Task<object> HandleSaveFile(JsonElement args)
    {
        string? path       = TryGetString(args, "path");
        string? b64        = TryGetString(args, "dataBase64");
        string? suggestName= TryGetString(args, "suggestedName");

        if (string.IsNullOrWhiteSpace(b64))
            throw new ArgumentException("dataBase64 is required");

        if (string.IsNullOrWhiteSpace(path))
        {
            path = await _dispatcher.InvokeAsync<string?>(() =>
            {
                var dlg = new SaveFileDialog
                {
                    Filter          = "GFX File|*.gfx;*.GFX|All Files|*.*",
                    Title           = "Save File",
                    FileName        = suggestName ?? "file.gfx",
                    InitialDirectory= _lastOpenedPath != null
                        ? Path.GetDirectoryName(_lastOpenedPath) : null,
                };
                return dlg.ShowDialog(MainWin) == true ? dlg.FileName : null;
            }).Task;

            if (path == null)
                return new { cancelled = true };
        }

        var data = Convert.FromBase64String(b64);
        await File.WriteAllBytesAsync(path, data);
        _lastOpenedPath = path;
        return new { cancelled = false, path };
    }

    private object HandleSaveFileDialog(JsonElement args)
    {
        string? suggested = TryGetString(args, "suggestedName");

        return _dispatcher.Invoke<object>(() =>
        {
            var dlg = new SaveFileDialog
            {
                Filter   = "GFX File|*.gfx;*.GFX|All Files|*.*",
                Title    = "Choose export location",
                FileName = suggested ?? "file.gfx",
                InitialDirectory = _lastOpenedPath != null
                    ? Path.GetDirectoryName(_lastOpenedPath) : null,
            };
            if (dlg.ShowDialog(MainWin) != true)
                return (object)new { cancelled = true };
            return new { cancelled = false, path = dlg.FileName };
        });
    }

    private object HandlePickDirectory()
    {
        return _dispatcher.Invoke<object>(() =>
        {
            using var dlg = new System.Windows.Forms.FolderBrowserDialog
            {
                Description         = "Select backup folder",
                UseDescriptionForTitle = true,
                ShowNewFolderButton = true,
            };
            var result = dlg.ShowDialog();
            if (result != System.Windows.Forms.DialogResult.OK)
                return (object)new { cancelled = true };
            return new { cancelled = false, path = dlg.SelectedPath };
        });
    }

    private async Task<object> HandleLiveEditWrite(JsonElement args)
    {
        string? sourcePath = TryGetString(args, "sourcePath") ?? _liveSourcePath;
        string? b64        = TryGetString(args, "dataBase64");
        string? backupDir  = TryGetString(args, "backupDir") ?? _liveBackupDir;

        if (string.IsNullOrWhiteSpace(sourcePath))
            throw new InvalidOperationException("No source path set. Call setLiveSource first.");
        if (string.IsNullOrWhiteSpace(b64))
            throw new ArgumentException("dataBase64 is required");

        var data = Convert.FromBase64String(b64);
        await _liveEdit.WriteAsync(sourcePath, backupDir!, data);

        return new { ok = true, message = _liveEdit.LastMessage };
    }

    private object HandleSetLiveSource(JsonElement args)
    {
        string? path      = TryGetString(args, "sourcePath");
        string? backupDir = TryGetString(args, "backupDir");

        if (string.IsNullOrWhiteSpace(path))
        {
            path = _dispatcher.Invoke<string?>(() =>
            {
                var dlg = new OpenFileDialog
                {
                    Filter = "GFX File|*.gfx;*.GFX|All Files|*.*",
                    Title  = "Select game GFX file for Live Edit",
                    InitialDirectory = _lastOpenedPath != null
                        ? Path.GetDirectoryName(_lastOpenedPath) : null,
                };
                return dlg.ShowDialog(MainWin) == true ? dlg.FileName : null;
            });
        }

        if (path == null)
            return new { cancelled = true };

        _liveSourcePath = path;
        if (!string.IsNullOrWhiteSpace(backupDir))
            _liveBackupDir = backupDir;

        return new
        {
            cancelled  = false,
            sourcePath = _liveSourcePath,
            backupDir  = _liveBackupDir,
        };
    }

    private object GetLiveStatus() => new
    {
        active      = _liveEdit.IsActive,
        sourcePath  = _liveSourcePath,
        backupDir   = _liveBackupDir,
        lastMessage = _liveEdit.LastMessage,
    };

    private static System.Windows.Window MainWin =>
        System.Windows.Application.Current.MainWindow;

    private static string? TryGetString(JsonElement el, string key)
    {
        if (el.ValueKind == JsonValueKind.Object &&
            el.TryGetProperty(key, out var v) &&
            v.ValueKind == JsonValueKind.String)
            return v.GetString();
        return null;
    }

    private Task Resolve(string id, object? result)
    {
        var json = JsonSerializer.Serialize(result ?? new object());
        return _wv.ExecuteScriptAsync(
            $"window.__nativeBridge?.resolve({JsonSerializer.Serialize(id)},{json});");
    }

    private Task Reject(string id, string message)
    {
        return _wv.ExecuteScriptAsync(
            $"window.__nativeBridge?.reject({JsonSerializer.Serialize(id)},{JsonSerializer.Serialize(message)});");
    }

    public void Dispose()
    {
        _wv.WebResourceRequested -= OnPackFileRequested;
        _liveEdit.Dispose();
    }
}
