using System.IO;

namespace ScaleformTools.Bridge;

/// <summary>
/// Writes the compiled GFX bytes directly to a game file, creating a
/// timestamped backup on the first write of each session.
/// </summary>
public sealed class LiveEditService : IDisposable
{
    private string? _sourcePath;
    private string? _backupDir;
    private bool _backedUp;

    public event Action<LiveEditStatus>? StatusChanged;

    public bool IsActive => _sourcePath != null;
    public string? SourcePath => _sourcePath;
    public string? BackupDir => _backupDir;
    public string? LastMessage { get; private set; }

    public async Task WriteAsync(string sourcePath, string backupDir, byte[] data)
    {
        _sourcePath = sourcePath;
        _backupDir  = backupDir;

        Directory.CreateDirectory(backupDir);

        await Task.Run(() =>
        {
            EnsureBackup(sourcePath, backupDir);
            File.WriteAllBytes(sourcePath, data);
        });

        var kb = data.Length / 1024.0;
        LastMessage = $"Saved {Path.GetFileName(sourcePath)} ({kb:F1} KB) at {DateTime.Now:HH:mm:ss}";
        StatusChanged?.Invoke(new LiveEditStatus(true, LastMessage, null));
    }

    public void Dispose() { }

    private void EnsureBackup(string sourcePath, string backupDir)
    {
        if (_backedUp || !File.Exists(sourcePath)) { _backedUp = true; return; }

        try
        {
            var ext  = Path.GetExtension(sourcePath);
            var name = Path.GetFileNameWithoutExtension(sourcePath);
            var ts   = DateTime.Now.ToString("yyyy-MM-dd_HH-mm-ss");
            var dest = Path.Combine(backupDir, $"{name}_backup_{ts}{ext}");
            File.Copy(sourcePath, dest, overwrite: false);
            _backedUp = true;
        }
        catch (Exception ex)
        {
            StatusChanged?.Invoke(new LiveEditStatus(false, null, $"Backup failed: {ex.Message}"));
        }
    }
}

public record LiveEditStatus(bool Ok, string? Message, string? Error);
