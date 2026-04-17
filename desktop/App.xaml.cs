using System.Windows;

namespace ScaleformTools;

public partial class App : Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        DispatcherUnhandledException += (s, ex) =>
        {
            MessageBox.Show(
                $"Unexpected error:\n\n{ex.Exception.Message}",
                "Scaleform Tools — Error",
                MessageBoxButton.OK,
                MessageBoxImage.Error);
            ex.Handled = true;
        };
    }
}
