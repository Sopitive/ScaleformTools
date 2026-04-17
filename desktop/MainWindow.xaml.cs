using System.IO;
using System.Windows;
using ScaleformTools.Bridge;
using Microsoft.Web.WebView2.Core;

namespace ScaleformTools;

public partial class MainWindow : Window
{
    private NativeBridge? _bridge;

    // Set to true to navigate to the Vite dev server instead of the bundled wwwroot.
    // For distribution builds: set to false so the app runs fully offline.
    private static readonly bool DevMode = false;
    private const string DevServerUrl = "http://localhost:5173";

    public MainWindow()
    {
        InitializeComponent();
        Loaded       += OnLoaded;
        Closing      += OnClosing;
        StateChanged += OnStateChanged;
    }

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        await webView.EnsureCoreWebView2Async();

        var core = webView.CoreWebView2;

        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.AreBrowserAcceleratorKeysEnabled = true; // F12 for DevTools

        // Inject the native flag before any page script runs.
        await core.AddScriptToExecuteOnDocumentCreatedAsync("window.__isNativeApp = true;");

        _bridge = new NativeBridge(core, Dispatcher);

        if (DevMode)
        {
            core.Navigate(DevServerUrl);
        }
        else
        {
            var wwwroot = Path.Combine(AppContext.BaseDirectory, "wwwroot");
            core.SetVirtualHostNameToFolderMapping(
                "scaleformtools.local", wwwroot,
                CoreWebView2HostResourceAccessKind.Allow);
            core.Navigate("https://scaleformtools.local/index.html");
        }

        core.NavigationCompleted += (s, args) =>
        {
            Dispatcher.Invoke(() => loadingOverlay.Visibility = Visibility.Collapsed);
        };
    }

    private void OnClosing(object? sender, System.ComponentModel.CancelEventArgs e)
    {
        _bridge?.Dispose();
    }

    private void OnStateChanged(object? sender, EventArgs e)
    {
        btnMaximize.Content = WindowState == WindowState.Maximized ? "❐" : "□";
        Padding = WindowState == WindowState.Maximized
            ? new Thickness(8)
            : new Thickness(0);
    }

    private void BtnMinimize_Click(object sender, RoutedEventArgs e)
        => WindowState = WindowState.Minimized;

    private void BtnMaximize_Click(object sender, RoutedEventArgs e)
        => WindowState = WindowState == WindowState.Maximized
            ? WindowState.Normal
            : WindowState.Maximized;

    private void BtnClose_Click(object sender, RoutedEventArgs e)
        => Close();
}
