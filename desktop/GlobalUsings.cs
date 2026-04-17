// Resolve WPF/WinForms ambiguity: prefer WPF/Win32 types globally.
global using Application      = System.Windows.Application;
global using MessageBox       = System.Windows.MessageBox;
global using MessageBoxButton = System.Windows.MessageBoxButton;
global using MessageBoxImage  = System.Windows.MessageBoxImage;
global using OpenFileDialog   = Microsoft.Win32.OpenFileDialog;
global using SaveFileDialog   = Microsoft.Win32.SaveFileDialog;
