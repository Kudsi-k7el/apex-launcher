using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Documents;
using System.Windows.Input;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Effects;
using System.Windows.Media.Imaging;
using System.Windows.Shapes;
using Microsoft.Win32;
using WinForms = System.Windows.Forms;
using IOPath = System.IO.Path;
using ShapePath = System.Windows.Shapes.Path;

[assembly: AssemblyTitle("Project Apex Installer")]
[assembly: AssemblyDescription("The Project Apex setup experience")]
[assembly: AssemblyCompany("Project Apex")]
[assembly: AssemblyProduct("Project Apex")]
[assembly: AssemblyCopyright("Copyright (c) 2026 Project Apex")]
[assembly: AssemblyVersion("2.11.0.0")]
[assembly: AssemblyFileVersion("2.11.0.0")]

namespace ApexSetup
{
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            bool silent = args.Any(a =>
                string.Equals(a, "/S", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(a, "-s", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(a, "--silent", StringComparison.OrdinalIgnoreCase));

            if (silent)
            {
                return SilentInstall(args);
            }

            var app = new Application();
            app.ShutdownMode = ShutdownMode.OnMainWindowClose;
            try
            {
                var window = new InstallerWindow(args);
                app.Run(window);
                return 0;
            }
            catch (Exception ex)
            {
                try
                {
                    File.WriteAllText(IOPath.Combine(IOPath.GetTempPath(), "apex-setup-error.txt"), ex.ToString());
                }
                catch { }
                return 1;
            }
        }

        private static int SilentInstall(string[] args)
        {
            string core = null;
            try
            {
                core = ExtractPayload();
                var psi = new ProcessStartInfo(core);
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.WorkingDirectory = IOPath.GetDirectoryName(core);

                var pass = args.Where(a =>
                    !string.Equals(a, "/S", StringComparison.OrdinalIgnoreCase) &&
                    !string.Equals(a, "-s", StringComparison.OrdinalIgnoreCase) &&
                    !string.Equals(a, "--silent", StringComparison.OrdinalIgnoreCase)).ToArray();

                psi.Arguments = "/S " + string.Join(" ", pass);
                using (var process = Process.Start(psi))
                {
                    process.WaitForExit();
                    return process.ExitCode;
                }
            }
            catch
            {
                return 1;
            }
            finally
            {
                if (core != null)
                {
                    TryDelete(core);
                }
            }
        }

        internal static string ExtractPayload()
        {
            string dir = IOPath.Combine(IOPath.GetTempPath(), "ApexSetup-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(dir);
            string core = IOPath.Combine(dir, "ApexCore.exe");

            using (Stream source = Assembly.GetExecutingAssembly().GetManifestResourceStream("ApexCore"))
            {
                if (source == null)
                {
                    throw new InvalidOperationException("The installer payload is missing.");
                }
                using (FileStream target = File.Create(core))
                {
                    source.CopyTo(target);
                }
            }
            return core;
        }

        internal static void TryDelete(string file)
        {
            try
            {
                if (File.Exists(file))
                {
                    File.Delete(file);
                }
                string dir = IOPath.GetDirectoryName(file);
                if (!string.IsNullOrEmpty(dir) && Directory.Exists(dir) && !Directory.EnumerateFileSystemEntries(dir).Any())
                {
                    Directory.Delete(dir);
                }
            }
            catch
            {
                // A still-locked core installer is allowed to clean itself up later.
            }
        }
    }

    internal sealed class Language
    {
        public string Code;
        public string NativeName;
        public string Title;
        public string Welcome;
        public string WelcomeSub;
        public string Folder;
        public string FolderTitle;
        public string FolderSub;
        public string Browse;
        public string TermsBefore;
        public string TermsLink1;
        public string TermsBetween;
        public string TermsLink2;
        public string TermsAfter;
        public string Next;
        public string Installing;
        public string InstallSub;
        public string Working;
        public string Cancel;
        public string DoneTitle;
        public string DoneSub;
        public string ReadyTitle;
        public string ReadySub;
        public string InstalledTo;
        public string Launch;
        public string Close;
        public string ErrorPath;
        public string ErrorInstall;
        public string InstallFailed;
        public string SetupLabel;
        public string StepWelcome;
        public string StepFolder;
        public string StepInstall;
        public string StepDone;
        public string ThemeLabel;
        public string LanguageLabel;
        public string PrivacyNote;
        public string KeepOpen;
        public string ShortcutDesktop;
        public string ShortcutStart;
        public string ShortcutUninstall;
    }

    internal sealed class ThemeDef
    {
        public string Key;
        public string Name;
        public string Description;
        public Color Accent;
        public Color Bg;
        public Color Bg2;
        public Color Panel;
        public Color Side;
        public Color Hover;
        public Color Border;
        public Color Text;
        public Color Muted;
    }

    internal sealed class ThemeManager
    {
        public static readonly ThemeDef[] Themes = new ThemeDef[]
        {
            new ThemeDef
            {
                Key = "lightning", Name = "Project Apex",
                Description = "Black into deep red, with a warm red accent",
                Accent = C("#FF3355"), Bg = C("#0A0405"), Bg2 = C("#050202"),
                Panel = C("#1D1718"), Side = C("#1E1E1E"), Hover = C("#333333"),
                Border = C("#2C2425"), Text = C("#F4EEEE"), Muted = C("#A29495")
            },
            new ThemeDef
            {
                Key = "autumn", Name = "Samurai Autumn",
                Description = "Charcoal dusk and maple-ember accent",
                Accent = C("#FF8A1F"), Bg = C("#120A06"), Bg2 = C("#0B0503"),
                Panel = C("#221410"), Side = C("#1A100C"), Hover = C("#2C1C15"),
                Border = C("#37231A"), Text = C("#F8EFE6"), Muted = C("#B09A8C")
            },
            new ThemeDef
            {
                Key = "dark", Name = "Dark",
                Description = "Balanced dark grey",
                Accent = C("#00A8FF"), Bg = C("#0E1015"), Bg2 = C("#0B0D12"),
                Panel = C("#171A21"), Side = C("#12141A"), Hover = C("#232733"),
                Border = C("#232733"), Text = C("#EEF1F6"), Muted = C("#8B93A3")
            },
            new ThemeDef
            {
                Key = "oled", Name = "Pitch Black OLED",
                Description = "True black for OLED panels",
                Accent = C("#00A8FF"), Bg = C("#000000"), Bg2 = C("#000000"),
                Panel = C("#0A0A0C"), Side = C("#000000"), Hover = C("#17181D"),
                Border = C("#16171B"), Text = C("#EEF1F6"), Muted = C("#8B93A3")
            },
            new ThemeDef
            {
                Key = "neon", Name = "Neon Accent",
                Description = "Violet glow, vivid highlights",
                Accent = C("#FF2FD0"), Bg = C("#0A0616"), Bg2 = C("#07040F"),
                Panel = C("#150E2B"), Side = C("#0C0820"), Hover = C("#241744"),
                Border = C("#2B1C52"), Text = C("#F3ECFF"), Muted = C("#9D8FC4")
            }
        };

        public ThemeDef Current { get; private set; }
        public readonly SolidColorBrush Accent;
        public readonly SolidColorBrush AccentSoft;
        public readonly SolidColorBrush AccentLine;
        public readonly SolidColorBrush AccentGlow;
        public readonly SolidColorBrush Bg;
        public readonly SolidColorBrush Bg2;
        public readonly SolidColorBrush Panel;
        public readonly SolidColorBrush PanelGlass;
        public readonly SolidColorBrush Side;
        public readonly SolidColorBrush Hover;
        public readonly SolidColorBrush Border;
        public readonly SolidColorBrush Text;
        public readonly SolidColorBrush Muted;
        public readonly SolidColorBrush Input;
        public readonly SolidColorBrush White;
        public readonly SolidColorBrush Danger;
        public readonly LinearGradientBrush BackgroundGradient;
        public readonly LinearGradientBrush TitleGradient;
        public readonly LinearGradientBrush PrimaryGradient;
        public readonly GradientStop BgStop;
        public readonly GradientStop Bg2Stop;
        public readonly GradientStop TitleStop;
        public readonly GradientStop TitleStop2;
        public readonly GradientStop PrimaryStop;
        public readonly GradientStop PrimaryStop2;
        public readonly GradientStop GlowStop;
        public readonly GradientStop GlowStop2;
        private readonly string settingsFile;

        public ThemeManager()
        {
            string key = ReadSavedKey();
            Current = Find(key) ?? Themes[0];

            Accent = new SolidColorBrush(Current.Accent);
            AccentSoft = new SolidColorBrush(WithAlpha(Current.Accent, 38));
            AccentLine = new SolidColorBrush(WithAlpha(Current.Accent, 120));
            AccentGlow = new SolidColorBrush(WithAlpha(Current.Accent, 80));
            Bg = new SolidColorBrush(Current.Bg);
            Bg2 = new SolidColorBrush(Current.Bg2);
            Panel = new SolidColorBrush(Current.Panel);
            PanelGlass = new SolidColorBrush(WithAlpha(Current.Panel, 218));
            Side = new SolidColorBrush(Current.Side);
            Hover = new SolidColorBrush(Current.Hover);
            Border = new SolidColorBrush(Current.Border);
            Text = new SolidColorBrush(Current.Text);
            Muted = new SolidColorBrush(Current.Muted);
            Input = new SolidColorBrush(Blend(Current.Panel, Current.Bg, 0.36));
            White = new SolidColorBrush(Colors.White);
            Danger = new SolidColorBrush(Color.FromRgb(0xFF, 0x5C, 0x5C));
            White.Freeze();
            Danger.Freeze();

            BgStop = new GradientStop(Current.Bg, 0);
            Bg2Stop = new GradientStop(Current.Bg2, 1);
            var bgStops = new GradientStopCollection();
            bgStops.Add(BgStop);
            bgStops.Add(Bg2Stop);
            BackgroundGradient = new LinearGradientBrush(bgStops, new Point(0, 0), new Point(0, 1));

            TitleStop = new GradientStop(Current.Side, 0);
            TitleStop2 = new GradientStop(Blend(Current.Side, Colors.Black, 0.16), 1);
            var titleStops = new GradientStopCollection();
            titleStops.Add(TitleStop);
            titleStops.Add(TitleStop2);
            TitleGradient = new LinearGradientBrush(titleStops, new Point(0, 0), new Point(0, 1));

            PrimaryStop = new GradientStop(Current.Accent, 0);
            PrimaryStop2 = new GradientStop(C("#6A3DE8"), 1);
            var primaryStops = new GradientStopCollection();
            primaryStops.Add(PrimaryStop);
            primaryStops.Add(PrimaryStop2);
            PrimaryGradient = new LinearGradientBrush(primaryStops, new Point(0, 0), new Point(1, 1));

            GlowStop = new GradientStop(WithAlpha(Current.Accent, 58), 0);
            GlowStop2 = new GradientStop(WithAlpha(Current.Accent, 26), 0);
            settingsFile = IOPath.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "ApexSetup", "theme.txt");
        }

        public static ThemeDef Find(string key)
        {
            if (string.IsNullOrEmpty(key))
            {
                return null;
            }
            foreach (ThemeDef theme in Themes)
            {
                if (string.Equals(theme.Key, key, StringComparison.OrdinalIgnoreCase))
                {
                    return theme;
                }
            }
            return null;
        }

        public void Apply(ThemeDef next, bool animate, bool persist)
        {
            if (next == null)
            {
                return;
            }
            Current = next;
            AnimateBrush(Accent, next.Accent, animate);
            AnimateBrush(AccentSoft, WithAlpha(next.Accent, 38), animate);
            AnimateBrush(AccentLine, WithAlpha(next.Accent, 120), animate);
            AnimateBrush(AccentGlow, WithAlpha(next.Accent, 80), animate);
            AnimateBrush(Bg, next.Bg, animate);
            AnimateBrush(Bg2, next.Bg2, animate);
            AnimateBrush(Panel, next.Panel, animate);
            AnimateBrush(PanelGlass, WithAlpha(next.Panel, 218), animate);
            AnimateBrush(Side, next.Side, animate);
            AnimateBrush(Hover, next.Hover, animate);
            AnimateBrush(Border, next.Border, animate);
            AnimateBrush(Text, next.Text, animate);
            AnimateBrush(Muted, next.Muted, animate);
            AnimateBrush(Input, Blend(next.Panel, next.Bg, 0.36), animate);
            AnimateStop(BgStop, next.Bg, animate);
            AnimateStop(Bg2Stop, next.Bg2, animate);
            AnimateStop(TitleStop, next.Side, animate);
            AnimateStop(TitleStop2, Blend(next.Side, Colors.Black, 0.16), animate);
            AnimateStop(PrimaryStop, next.Accent, animate);
            AnimateStop(GlowStop, WithAlpha(next.Accent, 58), animate);
            AnimateStop(GlowStop2, WithAlpha(next.Accent, 26), animate);
            if (persist)
            {
                Save(next.Key);
            }
        }

        private static void AnimateBrush(SolidColorBrush brush, Color to, bool animate)
        {
            Color from = brush.Color;
            brush.BeginAnimation(SolidColorBrush.ColorProperty, null);
            brush.Color = to;
            if (!animate || from == to)
            {
                return;
            }
            var animation = new ColorAnimation(from, to, TimeSpan.FromMilliseconds(320))
            {
                EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut }
            };
            brush.BeginAnimation(SolidColorBrush.ColorProperty, animation);
        }

        private static void AnimateStop(GradientStop stop, Color to, bool animate)
        {
            Color from = stop.Color;
            stop.BeginAnimation(GradientStop.ColorProperty, null);
            stop.Color = to;
            if (!animate || from == to)
            {
                return;
            }
            var animation = new ColorAnimation(from, to, TimeSpan.FromMilliseconds(320))
            {
                EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut }
            };
            stop.BeginAnimation(GradientStop.ColorProperty, animation);
        }

        public static Color WithAlpha(Color color, byte alpha)
        {
            return Color.FromArgb(alpha, color.R, color.G, color.B);
        }

        private static Color Blend(Color a, Color b, double amount)
        {
            double keep = 1.0 - amount;
            return Color.FromRgb(
                (byte)Math.Round(a.R * keep + b.R * amount),
                (byte)Math.Round(a.G * keep + b.G * amount),
                (byte)Math.Round(a.B * keep + b.B * amount));
        }

        private string ReadSavedKey()
        {
            try
            {
                if (File.Exists(settingsFile))
                {
                    return File.ReadAllText(settingsFile).Trim();
                }
            }
            catch
            {
                // A missing or unreadable preference simply falls back to Lightning.
            }
            return "lightning";
        }

        private void Save(string key)
        {
            try
            {
                string dir = IOPath.GetDirectoryName(settingsFile);
                if (!Directory.Exists(dir))
                {
                    Directory.CreateDirectory(dir);
                }
                File.WriteAllText(settingsFile, key);
            }
            catch
            {
                // Preferences are a nicety; never block an install on them.
            }
        }

        private static Color C(string hex)
        {
            return (Color)ColorConverter.ConvertFromString(hex);
        }
    }

    internal static class Ui
    {
        private static readonly FontFamily Face = new FontFamily("Segoe UI");

        public static SolidColorBrush B(string hex)
        {
            Color color = (Color)ColorConverter.ConvertFromString(hex);
            var brush = new SolidColorBrush(color);
            brush.Freeze();
            return brush;
        }

        public static SolidColorBrush Solid(Color color)
        {
            var brush = new SolidColorBrush(color);
            brush.Freeze();
            return brush;
        }

        public static TextBlock Text(string text, double size, string color, FontWeight weight)
        {
            return Text(text, size, B(color), weight);
        }

        public static TextBlock Text(string text, double size, string color)
        {
            return Text(text, size, B(color), FontWeights.Normal);
        }

        public static TextBlock Text(string text, double size, Brush brush)
        {
            return Text(text, size, brush, FontWeights.Normal);
        }

        public static TextBlock Text(string text, double size, Brush brush, FontWeight weight)
        {
            var block = new TextBlock
            {
                Text = text,
                FontFamily = Face,
                FontSize = size,
                FontWeight = weight,
                Foreground = brush,
                UseLayoutRounding = true,
                SnapsToDevicePixels = true
            };
            TextOptions.SetTextFormattingMode(block, TextFormattingMode.Display);
            TextOptions.SetTextRenderingMode(block, TextRenderingMode.ClearType);
            return block;
        }

        public static Style ButtonStyle(bool primary)
        {
            const string xaml =
                "<Style xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\" " +
                "xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\" TargetType=\"Button\">" +
                "<Setter Property=\"FontFamily\" Value=\"Segoe UI\"/>" +
                "<Setter Property=\"FontSize\" Value=\"11.5\"/>" +
                "<Setter Property=\"FontWeight\" Value=\"SemiBold\"/>" +
                "<Setter Property=\"Cursor\" Value=\"Hand\"/>" +
                "<Setter Property=\"FocusVisualStyle\" Value=\"{x:Null}\"/>" +
                "<Setter Property=\"Template\"><Setter.Value><ControlTemplate TargetType=\"Button\">" +
                "<Border x:Name=\"b\" Background=\"{TemplateBinding Background}\" BorderBrush=\"{TemplateBinding BorderBrush}\" " +
                "BorderThickness=\"{TemplateBinding BorderThickness}\" CornerRadius=\"7\" SnapsToDevicePixels=\"True\" " +
                "RenderTransformOrigin=\"0.5,0.5\">" +
                "<Border.RenderTransform><ScaleTransform x:Name=\"scale\" ScaleX=\"1\" ScaleY=\"1\"/></Border.RenderTransform>" +
                "<ContentPresenter HorizontalAlignment=\"Center\" VerticalAlignment=\"Center\" Margin=\"{TemplateBinding Padding}\" RecognizesAccessKey=\"True\"/>" +
                "</Border>" +
                "<ControlTemplate.Triggers>" +
                "<Trigger Property=\"IsMouseOver\" Value=\"True\"><Setter TargetName=\"b\" Property=\"Opacity\" Value=\"0.93\"/></Trigger>" +
                "<Trigger Property=\"IsPressed\" Value=\"True\"><Setter TargetName=\"b\" Property=\"Opacity\" Value=\"0.78\"/></Trigger>" +
                "<Trigger Property=\"IsEnabled\" Value=\"False\"><Setter TargetName=\"b\" Property=\"Opacity\" Value=\"0.36\"/><Setter Property=\"Cursor\" Value=\"Arrow\"/></Trigger>" +
                "<EventTrigger RoutedEvent=\"MouseEnter\"><BeginStoryboard><Storyboard>" +
                "<DoubleAnimation Storyboard.TargetName=\"scale\" Storyboard.TargetProperty=\"ScaleX\" To=\"1.025\" Duration=\"0:0:0.14\"/>" +
                "<DoubleAnimation Storyboard.TargetName=\"scale\" Storyboard.TargetProperty=\"ScaleY\" To=\"1.025\" Duration=\"0:0:0.14\"/>" +
                "</Storyboard></BeginStoryboard></EventTrigger>" +
                "<EventTrigger RoutedEvent=\"MouseLeave\"><BeginStoryboard><Storyboard>" +
                "<DoubleAnimation Storyboard.TargetName=\"scale\" Storyboard.TargetProperty=\"ScaleX\" To=\"1\" Duration=\"0:0:0.16\"/>" +
                "<DoubleAnimation Storyboard.TargetName=\"scale\" Storyboard.TargetProperty=\"ScaleY\" To=\"1\" Duration=\"0:0:0.16\"/>" +
                "</Storyboard></BeginStoryboard></EventTrigger>" +
                "</ControlTemplate.Triggers></ControlTemplate></Setter.Value></Setter></Style>";
            return (Style)XamlReader.Parse(xaml);
        }

        public static BitmapSource Bitmap(string resource)
        {
            using (Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(resource))
            {
                if (stream == null)
                {
                    return null;
                }
                var image = new BitmapImage();
                image.BeginInit();
                image.CacheOption = BitmapCacheOption.OnLoad;
                image.StreamSource = stream;
                image.EndInit();
                image.Freeze();
                return image;
            }
        }

        public static BitmapSource Icon(string resource)
        {
            using (Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(resource))
            {
                if (stream == null)
                {
                    return null;
                }
                BitmapDecoder decoder = BitmapDecoder.Create(stream, BitmapCreateOptions.PreservePixelFormat, BitmapCacheOption.OnLoad);
                BitmapFrame best = decoder.Frames[0];
                foreach (BitmapFrame frame in decoder.Frames)
                {
                    if (frame.PixelWidth > best.PixelWidth)
                    {
                        best = frame;
                    }
                }
                best.Freeze();
                return best;
            }
        }
    }

    internal sealed class InstallerWindow : Window
    {
        private const double WindowWidth = 720;
        private const double WindowHeight = 472;

        private static readonly Language[] Languages = new Language[]
        {
            new Language
            {
                Code = "en", NativeName = "English", Title = "Project Apex Installer", Welcome = "Welcome to",
                WelcomeSub = "Your games, one place. Let's set up your launcher.",
                Folder = "Installation folder:", FolderTitle = "Install location",
                FolderSub = "Choose where Project Apex lives on this PC.", Browse = "Browse",
                TermsBefore = "By continuing, you accept the ", TermsLink1 = "Terms of use", TermsBetween = " and ",
                TermsLink2 = "Privacy Policy", TermsAfter = ".",
                Next = "Next", Installing = "Installing Project Apex",
                InstallSub = "Setting up your launcher. This only takes a moment.",
                Working = "Installing files", Cancel = "Cancel",
                DoneTitle = "Installation complete", DoneSub = "Project Apex is ready to launch.",
                ReadyTitle = "Your library is waiting.",
                ReadySub = "Launch Project Apex and bring your games together.",
                InstalledTo = "Installed to", Launch = "Launch", Close = "Close",
                ErrorPath = "Choose a valid installation folder.",
                ErrorInstall = "The installer could not finish. Try again.", InstallFailed = "Installation failed",
                SetupLabel = "SETUP", StepWelcome = "Welcome", StepFolder = "Install",
                StepInstall = "Installing", StepDone = "Finish", ThemeLabel = "Theme",
                LanguageLabel = "Language", PrivacyNote = "Your files stay on this PC.",
                KeepOpen = "Please keep this window open.",
                ShortcutDesktop = "Desktop shortcut", ShortcutStart = "Start menu", ShortcutUninstall = "Uninstaller"
            },
            new Language
            {
                Code = "es", NativeName = "Espa\u00f1ol", Title = "Instalador de Project Apex", Welcome = "Bienvenido a",
                WelcomeSub = "Tus juegos, en un solo lugar. Vamos a configurar el launcher.",
                Folder = "Carpeta de instalaci\u00f3n:", FolderTitle = "Ubicaci\u00f3n de instalaci\u00f3n",
                FolderSub = "Elige d\u00f3nde se instalar\u00e1 Project Apex en este PC.", Browse = "Examinar",
                TermsBefore = "Al continuar, aceptas los ", TermsLink1 = "T\u00e9rminos de uso", TermsBetween = " y la ",
                TermsLink2 = "Pol\u00edtica de privacidad", TermsAfter = ".",
                Next = "Siguiente", Installing = "Instalando Project Apex",
                InstallSub = "Configurando el launcher. Solo tardar\u00e1 un momento.",
                Working = "Instalando archivos", Cancel = "Cancelar",
                DoneTitle = "Instalaci\u00f3n completada", DoneSub = "Project Apex est\u00e1 listo para iniciarse.",
                ReadyTitle = "Tu biblioteca te espera.",
                ReadySub = "Abre Project Apex y re\u00fane tus juegos.",
                InstalledTo = "Instalado en", Launch = "Abrir", Close = "Cerrar",
                ErrorPath = "Elige una carpeta de instalaci\u00f3n v\u00e1lida.",
                ErrorInstall = "El instalador no pudo terminar. Int\u00e9ntalo de nuevo.", InstallFailed = "Error de instalaci\u00f3n",
                SetupLabel = "INSTALACI\u00d3N", StepWelcome = "Bienvenida", StepFolder = "Instalar",
                StepInstall = "Instalando", StepDone = "Finalizar", ThemeLabel = "Tema",
                LanguageLabel = "Idioma", PrivacyNote = "Tus archivos se quedan en este PC.",
                KeepOpen = "Mant\u00e9n esta ventana abierta.",
                ShortcutDesktop = "Acceso directo", ShortcutStart = "Men\u00fa Inicio", ShortcutUninstall = "Desinstalador"
            },
            new Language
            {
                Code = "fr", NativeName = "Fran\u00e7ais", Title = "Installateur Project Apex", Welcome = "Bienvenue dans",
                WelcomeSub = "Tous vos jeux au m\u00eame endroit. Configurons votre launcher.",
                Folder = "Dossier d'installation :", FolderTitle = "Dossier d'installation",
                FolderSub = "Choisissez o\u00f9 Project Apex sera install\u00e9 sur ce PC.", Browse = "Parcourir",
                TermsBefore = "En continuant, vous acceptez les ", TermsLink1 = "Conditions d'utilisation", TermsBetween = " et la ",
                TermsLink2 = "Politique de confidentialit\u00e9", TermsAfter = ".",
                Next = "Suivant", Installing = "Installation de Project Apex",
                InstallSub = "Configuration du launcher. Cela ne prend qu'un instant.",
                Working = "Installation des fichiers", Cancel = "Annuler",
                DoneTitle = "Installation termin\u00e9e", DoneSub = "Project Apex est pr\u00eat \u00e0 d\u00e9marrer.",
                ReadyTitle = "Votre biblioth\u00e8que vous attend.",
                ReadySub = "Lancez Project Apex et r\u00e9unissez vos jeux.",
                InstalledTo = "Install\u00e9 dans", Launch = "Lancer", Close = "Fermer",
                ErrorPath = "Choisissez un dossier d'installation valide.",
                ErrorInstall = "L'installateur n'a pas pu terminer. R\u00e9essayez.", InstallFailed = "\u00c9chec de l'installation",
                SetupLabel = "INSTALLATION", StepWelcome = "Bienvenue", StepFolder = "Installer",
                StepInstall = "Installation", StepDone = "Terminer", ThemeLabel = "Th\u00e8me",
                LanguageLabel = "Langue", PrivacyNote = "Vos fichiers restent sur ce PC.",
                KeepOpen = "Gardez cette fen\u00eatre ouverte.",
                ShortcutDesktop = "Raccourci bureau", ShortcutStart = "Menu D\u00e9marrer", ShortcutUninstall = "D\u00e9sinstalleur"
            },
            new Language
            {
                Code = "de", NativeName = "Deutsch", Title = "Project Apex Installer", Welcome = "Willkommen bei",
                WelcomeSub = "Deine Spiele, an einem Ort. Richten wir deinen Launcher ein.",
                Folder = "Installationsordner:", FolderTitle = "Installationsort",
                FolderSub = "W\u00e4hle, wo Project Apex auf diesem PC installiert wird.", Browse = "Durchsuchen",
                TermsBefore = "Mit dem Fortfahren akzeptierst du die ", TermsLink1 = "Nutzungsbedingungen", TermsBetween = " und die ",
                TermsLink2 = "Datenschutzrichtlinie", TermsAfter = ".",
                Next = "Weiter", Installing = "Project Apex wird installiert",
                InstallSub = "Dein Launcher wird eingerichtet. Das dauert nur einen Moment.",
                Working = "Dateien werden installiert", Cancel = "Abbrechen",
                DoneTitle = "Installation abgeschlossen", DoneSub = "Project Apex kann jetzt gestartet werden.",
                ReadyTitle = "Deine Bibliothek wartet.",
                ReadySub = "Starte Project Apex und bringe deine Spiele zusammen.",
                InstalledTo = "Installiert in", Launch = "Starten", Close = "Schlie\u00dfen",
                ErrorPath = "W\u00e4hle einen g\u00fcltigen Installationsordner.",
                ErrorInstall = "Der Installer konnte nicht fertig werden. Versuche es erneut.", InstallFailed = "Installation fehlgeschlagen",
                SetupLabel = "INSTALLATION", StepWelcome = "Willkommen", StepFolder = "Installieren",
                StepInstall = "Installation", StepDone = "Fertig", ThemeLabel = "Design",
                LanguageLabel = "Sprache", PrivacyNote = "Deine Dateien bleiben auf diesem PC.",
                KeepOpen = "Bitte lass dieses Fenster ge\u00f6ffnet.",
                ShortcutDesktop = "Desktop-Verkn\u00fcpfung", ShortcutStart = "Startmen\u00fc", ShortcutUninstall = "Deinstaller"
            },
            new Language
            {
                Code = "pt", NativeName = "Portugu\u00eas", Title = "Instalador do Project Apex", Welcome = "Bem-vindo ao",
                WelcomeSub = "Os teus jogos, num s\u00f3 lugar. Vamos configurar o launcher.",
                Folder = "Pasta de instala\u00e7\u00e3o:", FolderTitle = "Local de instala\u00e7\u00e3o",
                FolderSub = "Escolhe onde o Project Apex ser\u00e1 instalado neste PC.", Browse = "Procurar",
                TermsBefore = "Ao continuar, aceitas os ", TermsLink1 = "Termos de uso", TermsBetween = " e a ",
                TermsLink2 = "Pol\u00edtica de privacidade", TermsAfter = ".",
                Next = "Seguinte", Installing = "A instalar o Project Apex",
                InstallSub = "A configurar o launcher. Demora apenas um momento.",
                Working = "A instalar ficheiros", Cancel = "Cancelar",
                DoneTitle = "Instala\u00e7\u00e3o conclu\u00edda", DoneSub = "O Project Apex est\u00e1 pronto para iniciar.",
                ReadyTitle = "A tua biblioteca est\u00e1 \u00e0 espera.",
                ReadySub = "Abre o Project Apex e re\u00fane os teus jogos.",
                InstalledTo = "Instalado em", Launch = "Iniciar", Close = "Fechar",
                ErrorPath = "Escolhe uma pasta de instala\u00e7\u00e3o v\u00e1lida.",
                ErrorInstall = "O instalador n\u00e3o conseguiu terminar. Tenta novamente.", InstallFailed = "Falha na instala\u00e7\u00e3o",
                SetupLabel = "INSTALA\u00c7\u00c3O", StepWelcome = "Bem-vindo", StepFolder = "Instalar",
                StepInstall = "A instalar", StepDone = "Concluir", ThemeLabel = "Tema",
                LanguageLabel = "Idioma", PrivacyNote = "Os teus ficheiros ficam neste PC.",
                KeepOpen = "Mant\u00e9m esta janela aberta.",
                ShortcutDesktop = "Atalho", ShortcutStart = "Menu Iniciar", ShortcutUninstall = "Desinstalador"
            }
        };

        private readonly string[] startupArgs;
        private readonly ThemeManager theme;
        private Language language = Languages[0];
        private bool previewMode;
        private volatile Process childProcess;
        private string installPath;
        private string installedExe;
        private bool sparklesStarted;
        private int currentStep = -1;

        private Grid root;
        private Border frame;
        private Grid pageHost;
        private Grid pageWelcome;
        private Grid pageFolder;
        private Grid pageInstall;
        private Grid pageDone;
        private Grid footerWelcome;
        private Grid footerFolder;
        private Grid footerInstall;
        private Grid footerDone;
        private TextBlock welcomeText;
        private TextBlock welcomeSubText;
        private TextBlock folderText;
        private TextBlock folderHeading;
        private TextBlock folderSubText;
        private Button browseButton;
        private TextBlock installTitle;
        private TextBlock installSubText;
        private TextBlock installStatus;
        private TextBlock doneTitle;
        private TextBlock doneSub;
        private TextBlock errorText;
        private TextBox pathBox;
        private TextBlock termsText;
        private Button nextWelcome;
        private Button nextFolder;
        private Button cancelButton;
        private Button closeButton;
        private Button launchButton;
        private Border languageBox;
        private TextBlock languageText;
        private TextBlock languageLabel;
        private Popup languagePopup;
        private Border themeButton;
        private TextBlock themeButtonText;
        private Ellipse themeButtonDot;
        private TextBlock themePopupTitle;
        private Popup themePopup;
        private TextBlock stepTitle;
        private Border doneBadge;
        private TextBlock doneBadgeText;
        private TextBlock footerWelcomeHint;
        private TextBlock footerFolderHint;
        private TextBlock footerInstallHint;
        private TextBlock footerDoneHint;
        private Grid progressTrack;
        private Border progressFill;
        private TranslateTransform progressTransform;
        private Ellipse statusDot;
        private readonly List<UIElement> sparkles = new List<UIElement>();
        private readonly List<DropShadowEffect> accentEffects = new List<DropShadowEffect>();
        private readonly List<AccentStop> accentStops = new List<AccentStop>();
        private readonly Border[] stepRows = new Border[4];
        private readonly Border[] stepDots = new Border[4];
        private readonly TextBlock[] stepNumbers = new TextBlock[4];
        private readonly TextBlock[] stepLabels = new TextBlock[4];
        private readonly Border[] stepBars = new Border[4];

        private sealed class AccentStop
        {
            public GradientStop Stop;
            public byte Alpha;
        }

        public InstallerWindow(string[] args)
        {
            startupArgs = args ?? new string[0];
            previewMode = startupArgs.Any(a => a.StartsWith("--preview", StringComparison.OrdinalIgnoreCase));

            theme = new ThemeManager();
            string requestedTheme = startupArgs.FirstOrDefault(a => a.StartsWith("--theme=", StringComparison.OrdinalIgnoreCase));
            if (!string.IsNullOrEmpty(requestedTheme))
            {
                ThemeDef requested = ThemeManager.Find(requestedTheme.Substring(8));
                if (requested != null)
                {
                    theme.Apply(requested, false, false);
                }
            }

            if (previewMode)
            {
                Topmost = true;
            }

            Title = language.Title;
            Width = WindowWidth;
            Height = WindowHeight;
            WindowStartupLocation = WindowStartupLocation.CenterScreen;
            WindowStyle = WindowStyle.None;
            ResizeMode = ResizeMode.NoResize;
            AllowsTransparency = true;
            Background = Brushes.Transparent;
            ShowInTaskbar = true;
            Icon = Ui.Icon("AppIcon");
            UseLayoutRounding = true;
            SnapsToDevicePixels = true;
            TextOptions.SetTextFormattingMode(this, TextFormattingMode.Display);
            TextOptions.SetTextRenderingMode(this, TextRenderingMode.ClearType);
            Opacity = 0;

            BuildChrome();
            BuildPages();
            ApplyLanguage(language);
            UpdateNextEnabled();
            SetStep(0);
            ShowPage(pageWelcome, footerWelcome, false);
            Loaded += OnLoaded;
            Closing += OnClosing;
        }

        private void OnLoaded(object sender, RoutedEventArgs e)
        {
            var scale = new ScaleTransform(0.985, 0.985);
            root.RenderTransform = scale;
            root.RenderTransformOrigin = new Point(0.5, 0.5);
            BeginAnimation(OpacityProperty, new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(260))
            {
                EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut }
            });
            var zoom = new DoubleAnimation(0.985, 1, TimeSpan.FromMilliseconds(360))
            {
                EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut }
            };
            scale.BeginAnimation(ScaleTransform.ScaleXProperty, zoom);
            scale.BeginAnimation(ScaleTransform.ScaleYProperty, zoom);
            AnimateIn(pageWelcome, false);

            if (startupArgs.Any(a => string.Equals(a, "--preview=folder", StringComparison.OrdinalIgnoreCase) ||
                                     string.Equals(a, "--preview-folder", StringComparison.OrdinalIgnoreCase)))
            {
                ShowPage(pageFolder, footerFolder, false);
                AnimateIn(pageFolder, true);
            }
            else if (startupArgs.Any(a => string.Equals(a, "--preview=install", StringComparison.OrdinalIgnoreCase) ||
                                          string.Equals(a, "--preview-install", StringComparison.OrdinalIgnoreCase)))
            {
                ShowPage(pageInstall, footerInstall, false);
                AnimateIn(pageInstall, true);
                StartSparkleAnimations();
            }
            else if (startupArgs.Any(a => string.Equals(a, "--preview=done", StringComparison.OrdinalIgnoreCase) ||
                                          string.Equals(a, "--preview-done", StringComparison.OrdinalIgnoreCase)))
            {
                ShowPage(pageDone, footerDone, false);
                AnimateIn(pageDone, true);
            }
            else if (startupArgs.Any(a => string.Equals(a, "--preview=switch", StringComparison.OrdinalIgnoreCase) ||
                                          string.Equals(a, "--preview-switch", StringComparison.OrdinalIgnoreCase)))
            {
                Dispatcher.BeginInvoke(new Action(delegate
                {
                    ThemeDef autumn = ThemeManager.Find("autumn");
                    if (autumn != null)
                    {
                        ApplyTheme(autumn, true);
                    }
                }));
            }
            else if (startupArgs.Any(a => string.Equals(a, "--preview=theme", StringComparison.OrdinalIgnoreCase) ||
                                          string.Equals(a, "--preview-theme", StringComparison.OrdinalIgnoreCase)))
            {
                Dispatcher.BeginInvoke(new Action(delegate { OpenThemePopup(); }));
            }
            else if (startupArgs.Any(a => string.Equals(a, "--preview=lang", StringComparison.OrdinalIgnoreCase) ||
                                          string.Equals(a, "--preview-lang", StringComparison.OrdinalIgnoreCase)))
            {
                Dispatcher.BeginInvoke(new Action(delegate { OpenLanguagePopup(); }));
            }

            if (!previewMode)
            {
                nextWelcome.Focus();
            }
        }

        private void OnClosing(object sender, System.ComponentModel.CancelEventArgs e)
        {
            KillChild();
        }

        private void BuildChrome()
        {
            root = new Grid();
            Content = root;

            frame = new Border
            {
                Background = theme.BackgroundGradient,
                BorderBrush = theme.AccentLine,
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(9),
                ClipToBounds = true
            };
            frame.SizeChanged += delegate
            {
                if (frame.ActualWidth > 0 && frame.ActualHeight > 0)
                {
                    frame.Clip = new RectangleGeometry(
                        new Rect(0, 0, frame.ActualWidth, frame.ActualHeight), 9, 9);
                }
            };
            root.Children.Add(frame);

            var shell = new Grid();
            frame.Child = shell;
            shell.RowDefinitions.Add(new RowDefinition { Height = new GridLength(40) });
            shell.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });

            Grid titleBar = BuildTitleBar();
            Grid.SetRow(titleBar, 0);
            shell.Children.Add(titleBar);

            var body = new Grid();
            body.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(188) });
            body.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            Grid.SetRow(body, 1);
            shell.Children.Add(body);

            Border sidebar = BuildSidebar();
            Grid.SetColumn(sidebar, 0);
            body.Children.Add(sidebar);

            Grid main = BuildMain();
            Grid.SetColumn(main, 1);
            body.Children.Add(main);
        }

        private Grid BuildTitleBar()
        {
            var bar = new Grid { Background = theme.TitleGradient };
            bar.Children.Add(new Border
            {
                Height = 1,
                VerticalAlignment = VerticalAlignment.Bottom,
                Background = theme.AccentLine,
                Opacity = 0.8
            });

            var drag = new Border { Background = Brushes.Transparent };
            drag.MouseLeftButtonDown += delegate(object s, MouseButtonEventArgs e)
            {
                if (e.ButtonState == MouseButtonState.Pressed && e.ClickCount == 1)
                {
                    try { DragMove(); } catch { }
                }
            };
            bar.Children.Add(drag);

            var brand = new StackPanel
            {
                Orientation = Orientation.Horizontal,
                VerticalAlignment = VerticalAlignment.Center,
                Margin = new Thickness(14, 0, 0, 0),
                IsHitTestVisible = false
            };
            brand.Children.Add(new Image
            {
                Source = Ui.Bitmap("Mark"),
                Width = 20,
                Height = 18,
                Stretch = Stretch.Uniform,
                Margin = new Thickness(0, 0, 8, 0)
            });
            brand.Children.Add(Ui.Text("PROJECT APEX", 11.5, theme.Text, FontWeights.Bold));
            var setup = Ui.Text("SETUP", 9.5, theme.Muted, FontWeights.SemiBold);
            setup.VerticalAlignment = VerticalAlignment.Center;
            setup.Margin = new Thickness(8, 1, 0, 0);
            brand.Children.Add(setup);
            bar.Children.Add(brand);

            var right = new StackPanel
            {
                Orientation = Orientation.Horizontal,
                HorizontalAlignment = HorizontalAlignment.Right,
                VerticalAlignment = VerticalAlignment.Top
            };
            var version = Ui.Text("v" + Assembly.GetExecutingAssembly().GetName().Version.ToString(3), 9.5, theme.Muted);
            version.VerticalAlignment = VerticalAlignment.Center;
            version.Margin = new Thickness(0, 0, 12, 0);
            right.Children.Add(version);

            themeButton = new Border
            {
                Height = 26,
                Background = theme.PanelGlass,
                BorderBrush = theme.Border,
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(7),
                Padding = new Thickness(8, 0, 8, 0),
                Margin = new Thickness(0, 7, 8, 0),
                Cursor = Cursors.Hand,
                VerticalAlignment = VerticalAlignment.Top
            };
            var themeContent = new StackPanel
            {
                Orientation = Orientation.Horizontal,
                VerticalAlignment = VerticalAlignment.Center
            };
            themeButtonDot = new Ellipse
            {
                Width = 8,
                Height = 8,
                Fill = theme.Accent,
                Margin = new Thickness(0, 0, 6, 0),
                VerticalAlignment = VerticalAlignment.Center
            };
            themeContent.Children.Add(themeButtonDot);
            themeButtonText = Ui.Text(theme.Current.Name, 10.5, theme.Text, FontWeights.SemiBold);
            themeButtonText.VerticalAlignment = VerticalAlignment.Center;
            themeContent.Children.Add(themeButtonText);
            var themeChevron = ChevronDown(theme.Muted);
            themeChevron.Margin = new Thickness(6, 1, 0, 0);
            themeContent.Children.Add(themeChevron);
            themeButton.Child = themeContent;
            themeButton.MouseEnter += delegate { themeButton.BorderBrush = theme.AccentLine; };
            themeButton.MouseLeave += delegate { themeButton.BorderBrush = theme.Border; };
            themeButton.MouseLeftButtonUp += delegate(object s, MouseButtonEventArgs e)
            {
                e.Handled = true;
                OpenThemePopup();
            };
            right.Children.Add(themeButton);
            right.Children.Add(TitleButton(MinimizeGlyph(), false, delegate { WindowState = WindowState.Minimized; }));
            right.Children.Add(TitleButton(CloseGlyph(), true, delegate { Close(); }));
            bar.Children.Add(right);
            return bar;
        }

        private Border TitleButton(UIElement content, bool close, Action action)
        {
            var border = new Border
            {
                Width = 38,
                Height = 39,
                Background = Brushes.Transparent,
                Cursor = Cursors.Hand,
                Child = content
            };
            border.MouseEnter += delegate
            {
                border.Background = close ? Ui.B("#C42B1C") : theme.Hover;
            };
            border.MouseLeave += delegate
            {
                border.Background = Brushes.Transparent;
            };
            border.MouseLeftButtonUp += delegate(object s, MouseButtonEventArgs e)
            {
                e.Handled = true;
                action();
            };
            return border;
        }

        private UIElement MinimizeGlyph()
        {
            return new Grid
            {
                Children =
                {
                    new Rectangle
                    {
                        Width = 9,
                        Height = 1,
                        Fill = theme.Text,
                        HorizontalAlignment = HorizontalAlignment.Center,
                        VerticalAlignment = VerticalAlignment.Center
                    }
                }
            };
        }

        private UIElement CloseGlyph()
        {
            var path = new ShapePath
            {
                Data = Geometry.Parse("M 0,0 L 9,9 M 9,0 L 0,9"),
                Stroke = theme.Text,
                StrokeThickness = 1.1,
                StrokeStartLineCap = PenLineCap.Round,
                StrokeEndLineCap = PenLineCap.Round,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center
            };
            var grid = new Grid();
            grid.Children.Add(path);
            return grid;
        }

        private static ShapePath ChevronDown(Brush brush)
        {
            return new ShapePath
            {
                Data = Geometry.Parse("M 0,0 L 4,4 L 8,0"),
                Stroke = brush,
                StrokeThickness = 1.2,
                StrokeStartLineCap = PenLineCap.Round,
                StrokeEndLineCap = PenLineCap.Round,
                Width = 8,
                Height = 5,
                Stretch = Stretch.None,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center
            };
        }

        private static Grid GlobeGlyph(Brush brush)
        {
            var grid = new Grid { Width = 14, Height = 14 };
            grid.Children.Add(new Ellipse
            {
                Width = 13,
                Height = 13,
                Stroke = brush,
                StrokeThickness = 1,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center
            });
            grid.Children.Add(new ShapePath
            {
                Data = Geometry.Parse("M 1,7 L 13,7 M 7,1 C 3,3 3,11 7,13 M 7,1 C 11,3 11,11 7,13"),
                Stroke = brush,
                StrokeThickness = 1,
                StrokeStartLineCap = PenLineCap.Round,
                StrokeEndLineCap = PenLineCap.Round,
                Stretch = Stretch.None
            });
            return grid;
        }

        private Border BuildSidebar()
        {
            var sidebar = new Border
            {
                Background = theme.Side,
                BorderBrush = theme.Border,
                BorderThickness = new Thickness(0, 0, 1, 0),
                Padding = new Thickness(14, 16, 14, 14)
            };
            var grid = new Grid();
            grid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
            grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

            var steps = new StackPanel();
            stepTitle = Ui.Text(language.SetupLabel.ToUpperInvariant(), 9.5, theme.Muted, FontWeights.SemiBold);
            stepTitle.Margin = new Thickness(4, 0, 0, 10);
            steps.Children.Add(stepTitle);
            steps.Children.Add(BuildStep(0, language.StepWelcome));
            steps.Children.Add(BuildStep(1, language.StepFolder));
            steps.Children.Add(BuildStep(2, language.StepInstall));
            steps.Children.Add(BuildStep(3, language.StepDone));
            grid.Children.Add(steps);

            Border languageCard = BuildLanguageCard();
            Grid.SetRow(languageCard, 1);
            grid.Children.Add(languageCard);

            sidebar.Child = grid;
            return sidebar;
        }

        private Border BuildStep(int index, string label)
        {
            var row = new Border
            {
                Height = 38,
                CornerRadius = new CornerRadius(7),
                Padding = new Thickness(8, 0, 8, 0),
                Margin = new Thickness(0, 2, 0, 2),
                Background = Brushes.Transparent,
                BorderThickness = new Thickness(1),
                BorderBrush = Brushes.Transparent
            };
            var grid = new Grid();
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(22) });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(3) });

            var dot = new Border
            {
                Width = 20,
                Height = 20,
                CornerRadius = new CornerRadius(10),
                BorderThickness = new Thickness(1),
                BorderBrush = theme.Border,
                Background = theme.Input,
                HorizontalAlignment = HorizontalAlignment.Left,
                VerticalAlignment = VerticalAlignment.Center
            };
            var number = Ui.Text((index + 1).ToString(), 9.5, theme.Muted, FontWeights.SemiBold);
            number.HorizontalAlignment = HorizontalAlignment.Center;
            number.VerticalAlignment = VerticalAlignment.Center;
            dot.Child = number;

            var labelBlock = Ui.Text(label, 11.5, theme.Muted, FontWeights.SemiBold);
            labelBlock.VerticalAlignment = VerticalAlignment.Center;
            labelBlock.Margin = new Thickness(8, 0, 0, 0);

            var bar = new Border
            {
                Width = 3,
                Height = 18,
                CornerRadius = new CornerRadius(1.5),
                Background = theme.Accent,
                HorizontalAlignment = HorizontalAlignment.Right,
                VerticalAlignment = VerticalAlignment.Center,
                Opacity = 0
            };

            Grid.SetColumn(dot, 0);
            Grid.SetColumn(labelBlock, 1);
            Grid.SetColumn(bar, 2);
            grid.Children.Add(dot);
            grid.Children.Add(labelBlock);
            grid.Children.Add(bar);
            row.Child = grid;

            stepRows[index] = row;
            stepDots[index] = dot;
            stepNumbers[index] = number;
            stepLabels[index] = labelBlock;
            stepBars[index] = bar;

            row.MouseEnter += delegate
            {
                if (currentStep != index)
                {
                    row.Background = theme.Hover;
                }
            };
            row.MouseLeave += delegate
            {
                if (currentStep != index)
                {
                    row.Background = Brushes.Transparent;
                }
            };
            return row;
        }

        private Border BuildLanguageCard()
        {
            var card = new Border
            {
                Background = theme.PanelGlass,
                BorderBrush = theme.Border,
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(10),
                Padding = new Thickness(10)
            };
            var stack = new StackPanel();
            languageLabel = Ui.Text(language.LanguageLabel.ToUpperInvariant(), 9.5, theme.Muted, FontWeights.SemiBold);
            stack.Children.Add(languageLabel);

            languageBox = new Border
            {
                Height = 30,
                Background = theme.Input,
                BorderBrush = theme.Border,
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(7),
                Margin = new Thickness(0, 6, 0, 0),
                Cursor = Cursors.Hand
            };
            var langGrid = new Grid();
            var globe = GlobeGlyph(theme.Muted);
            globe.HorizontalAlignment = HorizontalAlignment.Left;
            globe.VerticalAlignment = VerticalAlignment.Center;
            globe.Margin = new Thickness(8, 0, 0, 0);
            langGrid.Children.Add(globe);
            languageText = Ui.Text(language.NativeName, 11, theme.Text, FontWeights.SemiBold);
            languageText.VerticalAlignment = VerticalAlignment.Center;
            languageText.Margin = new Thickness(28, 0, 0, 0);
            langGrid.Children.Add(languageText);
            var chevron = ChevronDown(theme.Muted);
            chevron.HorizontalAlignment = HorizontalAlignment.Right;
            chevron.VerticalAlignment = VerticalAlignment.Center;
            chevron.Margin = new Thickness(0, 0, 8, 0);
            langGrid.Children.Add(chevron);
            languageBox.Child = langGrid;
            languageBox.MouseEnter += delegate { languageBox.BorderBrush = theme.AccentLine; };
            languageBox.MouseLeave += delegate { languageBox.BorderBrush = theme.Border; };
            languageBox.MouseLeftButtonUp += delegate(object s, MouseButtonEventArgs e)
            {
                e.Handled = true;
                OpenLanguagePopup();
            };
            stack.Children.Add(languageBox);

            var hint = Ui.Text("Windows 10 / 11", 9, theme.Muted);
            hint.Margin = new Thickness(2, 8, 0, 0);
            stack.Children.Add(hint);
            card.Child = stack;
            return card;
        }

        private Grid BuildMain()
        {
            var main = new Grid { ClipToBounds = true };
            main.Children.Add(BuildGlowLayer());

            var layout = new Grid();
            layout.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
            layout.RowDefinitions.Add(new RowDefinition { Height = new GridLength(56) });
            main.Children.Add(layout);

            pageHost = new Grid { ClipToBounds = true, Margin = new Thickness(22, 18, 22, 0) };
            Grid.SetRow(pageHost, 0);
            layout.Children.Add(pageHost);

            var footerBorder = new Border
            {
                Background = theme.PanelGlass,
                BorderBrush = theme.Border,
                BorderThickness = new Thickness(0, 1, 0, 0)
            };
            Grid.SetRow(footerBorder, 1);
            layout.Children.Add(footerBorder);

            var footerHost = new Grid();
            footerBorder.Child = footerHost;
            footerWelcome = BuildWelcomeFooter();
            footerFolder = BuildFolderFooter();
            footerInstall = BuildInstallFooter();
            footerDone = BuildDoneFooter();
            footerHost.Children.Add(footerWelcome);
            footerHost.Children.Add(footerFolder);
            footerHost.Children.Add(footerInstall);
            footerHost.Children.Add(footerDone);
            return main;
        }

        private Canvas BuildGlowLayer()
        {
            var canvas = new Canvas { IsHitTestVisible = false, ClipToBounds = true };
            var glow1 = new Ellipse { Width = 430, Height = 430, Fill = HaloBrush(54), Opacity = 0.85 };
            Canvas.SetLeft(glow1, -80);
            Canvas.SetTop(glow1, -190);
            var move1 = new TranslateTransform();
            glow1.RenderTransform = move1;
            canvas.Children.Add(glow1);

            var glow2 = new Ellipse { Width = 330, Height = 330, Fill = HaloBrush(28), Opacity = 0.75 };
            Canvas.SetLeft(glow2, 300);
            Canvas.SetTop(glow2, 200);
            var move2 = new TranslateTransform();
            glow2.RenderTransform = move2;
            canvas.Children.Add(glow2);

            AnimateGlow(move1, 0, 26, 0, -20, 15);
            AnimateGlow(move2, 0, -22, 0, 16, 18);
            return canvas;
        }

        private static void AnimateGlow(TranslateTransform transform, double fromX, double toX, double fromY, double toY, double seconds)
        {
            var x = new DoubleAnimation(fromX, toX, TimeSpan.FromSeconds(seconds))
            {
                AutoReverse = true,
                RepeatBehavior = RepeatBehavior.Forever,
                EasingFunction = new SineEase { EasingMode = EasingMode.EaseInOut }
            };
            var y = new DoubleAnimation(fromY, toY, TimeSpan.FromSeconds(seconds))
            {
                AutoReverse = true,
                RepeatBehavior = RepeatBehavior.Forever,
                EasingFunction = new SineEase { EasingMode = EasingMode.EaseInOut }
            };
            transform.BeginAnimation(TranslateTransform.XProperty, x);
            transform.BeginAnimation(TranslateTransform.YProperty, y);
        }

        private Brush HaloBrush(byte alpha)
        {
            var accent = theme.Current.Accent;
            var brush = new RadialGradientBrush();
            var stop = new GradientStop(ThemeManager.WithAlpha(accent, alpha), 0);
            brush.GradientStops.Add(stop);
            brush.GradientStops.Add(new GradientStop(Color.FromArgb(0, accent.R, accent.G, accent.B), 1));
            accentStops.Add(new AccentStop { Stop = stop, Alpha = alpha });
            return brush;
        }

        private void BuildPages()
        {
            pageWelcome = BuildWelcomePage();
            pageFolder = BuildFolderPage();
            pageInstall = BuildInstallPage();
            pageDone = BuildDonePage();
            pageHost.Children.Add(pageWelcome);
            pageHost.Children.Add(pageFolder);
            pageHost.Children.Add(pageInstall);
            pageHost.Children.Add(pageDone);
        }

        private Grid NewPage(string heading, string subtitle, FrameworkElement content, out TextBlock headingBlock, out TextBlock subtitleBlock)
        {
            var page = new Grid();
            var stack = new StackPanel { VerticalAlignment = VerticalAlignment.Top };
            headingBlock = Ui.Text(heading, 22, theme.Text, FontWeights.Bold);
            headingBlock.LineHeight = 26;
            stack.Children.Add(headingBlock);
            subtitleBlock = Ui.Text(subtitle, 11.5, theme.Muted);
            subtitleBlock.TextWrapping = TextWrapping.Wrap;
            subtitleBlock.MaxWidth = 470;
            subtitleBlock.Margin = new Thickness(0, 5, 0, 0);
            stack.Children.Add(subtitleBlock);
            content.Margin = new Thickness(0, 16, 0, 0);
            stack.Children.Add(content);
            page.Children.Add(stack);
            return page;
        }

        private Grid BuildWelcomePage()
        {
            return NewPage(
                language.Welcome + " Project Apex",
                language.WelcomeSub,
                BuildWelcomeCard(),
                out welcomeText,
                out welcomeSubText);
        }

        private Border BuildWelcomeCard()
        {
            var grid = new Grid();
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

            var markHost = new Grid { Width = 92, Height = 92, Margin = new Thickness(0, 0, 22, 0) };
            markHost.Children.Add(new Ellipse { Width = 92, Height = 92, Fill = HaloBrush(78) });
            var mark = new Image
            {
                Source = Ui.Bitmap("Mark"),
                Width = 72,
                Height = 62,
                Stretch = Stretch.Uniform,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center
            };
            var glow = new DropShadowEffect
            {
                Color = theme.Current.Accent,
                BlurRadius = 30,
                ShadowDepth = 0,
                Opacity = 0.5
            };
            mark.Effect = glow;
            accentEffects.Add(glow);
            markHost.Children.Add(mark);
            Grid.SetColumn(markHost, 0);
            grid.Children.Add(markHost);

            var text = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
            text.Children.Add(Ui.Text("Your games, one place.", 16, theme.Text, FontWeights.SemiBold));
            var sub = Ui.Text("Project Apex keeps your library, emulators and tools in one clean place.", 11, theme.Muted);
            sub.TextWrapping = TextWrapping.Wrap;
            sub.MaxWidth = 330;
            sub.Margin = new Thickness(0, 6, 0, 0);
            text.Children.Add(sub);

            var chips = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 12, 0, 0) };
            chips.Children.Add(Chip("Library"));
            chips.Children.Add(Chip("Emulators"));
            chips.Children.Add(Chip("Updates"));
            text.Children.Add(chips);
            Grid.SetColumn(text, 1);
            grid.Children.Add(text);

            return CardShell(grid);
        }

        private Grid BuildFolderPage()
        {
            var content = new StackPanel();
            content.Children.Add(BuildFolderCard());
            content.Children.Add(BuildTermsLine());
            return NewPage(
                language.FolderTitle,
                language.FolderSub,
                content,
                out folderHeading,
                out folderSubText);
        }

        private Border BuildFolderCard()
        {
            var stack = new StackPanel();
            folderText = Ui.Text(
                language.Folder.Trim().TrimEnd(':').Trim().ToUpperInvariant(),
                9.5, theme.Muted, FontWeights.SemiBold);
            stack.Children.Add(folderText);

            var field = new Border
            {
                Height = 36,
                Background = theme.Input,
                BorderBrush = theme.Border,
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(8),
                Margin = new Thickness(0, 6, 0, 0)
            };
            var fieldGrid = new Grid();
            fieldGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            fieldGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            field.Child = fieldGrid;

            pathBox = new TextBox
            {
                Text = FindExistingInstall(),
                Background = Brushes.Transparent,
                Foreground = theme.Text,
                BorderThickness = new Thickness(0),
                FontFamily = new FontFamily("Segoe UI"),
                FontSize = 11.5,
                VerticalContentAlignment = VerticalAlignment.Center,
                Padding = new Thickness(10, 0, 8, 0),
                CaretBrush = theme.Accent,
                SelectionBrush = theme.AccentSoft
            };
            TextOptions.SetTextFormattingMode(pathBox, TextFormattingMode.Display);
            pathBox.TextChanged += delegate
            {
                if (errorText != null)
                {
                    errorText.Visibility = Visibility.Collapsed;
                }
                UpdateNextEnabled();
            };
            pathBox.GotFocus += delegate
            {
                field.BorderBrush = theme.Accent;
                field.BorderThickness = new Thickness(1.2);
            };
            pathBox.LostFocus += delegate
            {
                field.BorderBrush = theme.Border;
                field.BorderThickness = new Thickness(1);
            };
            fieldGrid.Children.Add(pathBox);

            browseButton = SmallButton(language.Browse);
            browseButton.Margin = new Thickness(0, 4, 4, 4);
            browseButton.Click += delegate { BrowseForFolder(); };
            Grid.SetColumn(browseButton, 1);
            fieldGrid.Children.Add(browseButton);
            stack.Children.Add(field);

            errorText = Ui.Text(string.Empty, 10, theme.Danger);
            errorText.Margin = new Thickness(0, 6, 0, 0);
            errorText.TextWrapping = TextWrapping.Wrap;
            errorText.Visibility = Visibility.Collapsed;
            stack.Children.Add(errorText);

            return CardShell(stack);
        }

        private TextBlock BuildTermsLine()
        {
            termsText = new TextBlock
            {
                FontFamily = new FontFamily("Segoe UI"),
                FontSize = 9.5,
                Foreground = theme.Muted,
                TextWrapping = TextWrapping.Wrap,
                LineHeight = 14.0,
                MaxWidth = 460,
                Margin = new Thickness(2, 10, 0, 0),
                UseLayoutRounding = true
            };
            TextOptions.SetTextFormattingMode(termsText, TextFormattingMode.Display);
            BuildTerms();
            return termsText;
        }

        private Grid BuildInstallPage()
        {
            return NewPage(
                language.Installing,
                language.InstallSub,
                BuildInstallCard(),
                out installTitle,
                out installSubText);
        }

        private Border BuildInstallCard()
        {
            var stack = new StackPanel();
            Canvas art = BuildArtwork();
            art.HorizontalAlignment = HorizontalAlignment.Center;
            stack.Children.Add(art);

            progressTrack = new Grid
            {
                Width = 400,
                Height = 4,
                Background = theme.Border,
                ClipToBounds = true,
                HorizontalAlignment = HorizontalAlignment.Center,
                Margin = new Thickness(0, 14, 0, 0)
            };
            progressFill = new Border
            {
                Width = 120,
                Height = 4,
                Background = theme.PrimaryGradient,
                CornerRadius = new CornerRadius(2),
                HorizontalAlignment = HorizontalAlignment.Left
            };
            progressTransform = new TranslateTransform(-120, 0);
            progressFill.RenderTransform = progressTransform;
            progressTrack.Children.Add(progressFill);
            stack.Children.Add(progressTrack);

            var statusRow = new StackPanel
            {
                Orientation = Orientation.Horizontal,
                HorizontalAlignment = HorizontalAlignment.Center,
                Margin = new Thickness(0, 11, 0, 0)
            };
            statusDot = new Ellipse
            {
                Width = 6,
                Height = 6,
                Fill = theme.Accent,
                Margin = new Thickness(0, 0, 7, 0),
                VerticalAlignment = VerticalAlignment.Center
            };
            statusRow.Children.Add(statusDot);
            installStatus = Ui.Text(language.Working + "...", 10.5, theme.Muted);
            installStatus.VerticalAlignment = VerticalAlignment.Center;
            statusRow.Children.Add(installStatus);
            stack.Children.Add(statusRow);

            return CardShell(stack);
        }

        private Grid BuildDonePage()
        {
            return NewPage(
                language.DoneTitle,
                language.DoneSub,
                BuildDoneCard(),
                out doneTitle,
                out doneSub);
        }

        private Border BuildDoneCard()
        {
            var stack = new StackPanel { HorizontalAlignment = HorizontalAlignment.Center };
            var markHost = new Grid { Width = 92, Height = 92 };
            markHost.Children.Add(new Ellipse { Width = 92, Height = 92, Fill = HaloBrush(78) });
            var mark = new Image
            {
                Source = Ui.Bitmap("Mark"),
                Width = 72,
                Height = 62,
                Stretch = Stretch.Uniform,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center
            };
            var glow = new DropShadowEffect
            {
                Color = theme.Current.Accent,
                BlurRadius = 30,
                ShadowDepth = 0,
                Opacity = 0.5
            };
            mark.Effect = glow;
            accentEffects.Add(glow);
            markHost.Children.Add(mark);

            doneBadge = new Border
            {
                Width = 26,
                Height = 26,
                CornerRadius = new CornerRadius(13),
                Background = theme.Accent,
                BorderBrush = theme.Bg,
                BorderThickness = new Thickness(2),
                HorizontalAlignment = HorizontalAlignment.Right,
                VerticalAlignment = VerticalAlignment.Bottom,
                Margin = new Thickness(0, 0, 2, 2)
            };
            doneBadgeText = Ui.Text("\u2713", 11, theme.White, FontWeights.Bold);
            doneBadgeText.HorizontalAlignment = HorizontalAlignment.Center;
            doneBadgeText.VerticalAlignment = VerticalAlignment.Center;
            doneBadge.Child = doneBadgeText;
            markHost.Children.Add(doneBadge);
            stack.Children.Add(markHost);

            var ready = Ui.Text(language.ReadyTitle, 15, theme.Text, FontWeights.SemiBold);
            ready.HorizontalAlignment = HorizontalAlignment.Center;
            ready.Margin = new Thickness(0, 12, 0, 0);
            stack.Children.Add(ready);
            var readySub = Ui.Text(language.ReadySub, 10.5, theme.Muted);
            readySub.HorizontalAlignment = HorizontalAlignment.Center;
            readySub.TextWrapping = TextWrapping.Wrap;
            readySub.MaxWidth = 380;
            readySub.Margin = new Thickness(0, 5, 0, 0);
            stack.Children.Add(readySub);

            var chips = new WrapPanel
            {
                Orientation = Orientation.Horizontal,
                HorizontalAlignment = HorizontalAlignment.Center,
                Margin = new Thickness(0, 12, 0, 0)
            };
            chips.Children.Add(Chip(language.ShortcutDesktop));
            chips.Children.Add(Chip(language.ShortcutStart));
            chips.Children.Add(Chip(language.ShortcutUninstall));
            stack.Children.Add(chips);

            return CardShell(stack);
        }

        private Border CardShell(UIElement content)
        {
            return CardShell(content, 18);
        }

        private Border CardShell(UIElement content, double padding)
        {
            var stack = new StackPanel();
            stack.Children.Add(new Border
            {
                Height = 2,
                Background = theme.PrimaryGradient,
                CornerRadius = new CornerRadius(1),
                Margin = new Thickness(0, 0, 0, 14)
            });
            stack.Children.Add(content);
            var card = new Border
            {
                Background = theme.PanelGlass,
                BorderBrush = theme.Border,
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(12),
                Padding = new Thickness(padding)
            };
            card.Child = stack;
            return card;
        }

        private Border Chip(string text)
        {
            var chip = new Border
            {
                Height = 24,
                Background = theme.AccentSoft,
                BorderBrush = theme.AccentLine,
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(6),
                Padding = new Thickness(8, 0, 8, 0),
                Margin = new Thickness(0, 0, 6, 6)
            };
            var label = Ui.Text(text, 9.5, theme.Text, FontWeights.SemiBold);
            label.VerticalAlignment = VerticalAlignment.Center;
            chip.Child = label;
            return chip;
        }

        private Grid BuildWelcomeFooter()
        {
            TextBlock left;
            StackPanel buttons;
            Grid footer = FooterBase(out left, out buttons);
            footerWelcomeHint = left;
            left.Text = "v" + Assembly.GetExecutingAssembly().GetName().Version.ToString(3);
            nextWelcome = PrimaryButton(language.Next);
            nextWelcome.Click += delegate
            {
                ShowPage(pageFolder, footerFolder, true);
                Dispatcher.BeginInvoke(new Action(delegate { if (pathBox != null) pathBox.Focus(); }));
            };
            buttons.Children.Add(nextWelcome);
            return footer;
        }

        private Grid BuildFolderFooter()
        {
            TextBlock left;
            StackPanel buttons;
            Grid footer = FooterBase(out left, out buttons);
            footerFolderHint = left;
            left.Text = language.PrivacyNote;
            nextFolder = PrimaryButton(language.Next);
            nextFolder.IsEnabled = false;
            nextFolder.Click += delegate { BeginInstall(); };
            buttons.Children.Add(nextFolder);
            return footer;
        }

        private Grid BuildInstallFooter()
        {
            TextBlock left;
            StackPanel buttons;
            Grid footer = FooterBase(out left, out buttons);
            footerInstallHint = left;
            left.Text = language.KeepOpen;
            cancelButton = OutlineButton(language.Cancel);
            cancelButton.Click += delegate { CancelInstall(); };
            buttons.Children.Add(cancelButton);
            return footer;
        }

        private Grid BuildDoneFooter()
        {
            TextBlock left;
            StackPanel buttons;
            Grid footer = FooterBase(out left, out buttons);
            footerDoneHint = left;
            left.Text = string.Empty;
            closeButton = OutlineButton(language.Close);
            closeButton.Margin = new Thickness(0, 0, 8, 0);
            closeButton.Click += delegate { Close(); };
            buttons.Children.Add(closeButton);
            launchButton = PrimaryButton(language.Launch);
            launchButton.Click += delegate { LaunchInstalledApp(); };
            buttons.Children.Add(launchButton);
            return footer;
        }

        private Grid FooterBase(out TextBlock left, out StackPanel buttons)
        {
            var footer = new Grid { Margin = new Thickness(22, 0, 22, 0), Height = 56 };
            footer.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            footer.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            left = Ui.Text(string.Empty, 9.5, theme.Muted);
            left.VerticalAlignment = VerticalAlignment.Center;
            left.HorizontalAlignment = HorizontalAlignment.Left;
            left.TextTrimming = TextTrimming.CharacterEllipsis;
            left.MaxWidth = 300;
            footer.Children.Add(left);
            buttons = new StackPanel
            {
                Orientation = Orientation.Horizontal,
                HorizontalAlignment = HorizontalAlignment.Right,
                VerticalAlignment = VerticalAlignment.Center
            };
            Grid.SetColumn(buttons, 1);
            footer.Children.Add(buttons);
            return footer;
        }

        private Button PrimaryButton(string text)
        {
            var button = new Button
            {
                Content = text,
                MinWidth = 92,
                Height = 32,
                Padding = new Thickness(16, 0, 16, 0)
            };
            StyleButton(button, true);
            return button;
        }

        private Button OutlineButton(string text)
        {
            var button = new Button
            {
                Content = text,
                MinWidth = 92,
                Height = 32,
                Padding = new Thickness(16, 0, 16, 0)
            };
            StyleButton(button, false);
            return button;
        }

        private Button SmallButton(string text)
        {
            var button = new Button
            {
                Content = text,
                MinWidth = 70,
                Height = 28,
                FontSize = 10.5,
                Padding = new Thickness(10, 0, 10, 0)
            };
            StyleButton(button, false);
            return button;
        }

        private void StyleButton(Button button, bool primary)
        {
            button.Style = Ui.ButtonStyle(primary);
            if (primary)
            {
                button.Background = theme.PrimaryGradient;
                button.Foreground = theme.White;
                button.BorderBrush = Brushes.Transparent;
                button.BorderThickness = new Thickness(0);
                var glow = new DropShadowEffect
                {
                    Color = theme.Current.Accent,
                    BlurRadius = 18,
                    ShadowDepth = 0,
                    Opacity = 0.38
                };
                button.Effect = glow;
                accentEffects.Add(glow);
            }
            else
            {
                button.Background = theme.Panel;
                button.Foreground = theme.Text;
                button.BorderBrush = theme.Border;
                button.BorderThickness = new Thickness(1);
                button.MouseEnter += delegate
                {
                    if (button.IsEnabled)
                    {
                        button.Background = theme.Hover;
                        button.BorderBrush = theme.AccentLine;
                    }
                };
                button.MouseLeave += delegate
                {
                    button.Background = theme.Panel;
                    button.BorderBrush = theme.Border;
                };
            }
        }

        private void OpenThemePopup()
        {
            if (themePopup != null)
            {
                themePopup.IsOpen = false;
            }

            var panel = new StackPanel();
            themePopupTitle = Ui.Text(language.ThemeLabel.ToUpperInvariant(), 9.5, theme.Muted, FontWeights.SemiBold);
            themePopupTitle.Margin = new Thickness(4, 2, 0, 8);
            panel.Children.Add(themePopupTitle);
            foreach (ThemeDef def in ThemeManager.Themes)
            {
                panel.Children.Add(ThemeRow(def));
            }

            var border = new Border
            {
                Background = theme.Panel,
                BorderBrush = theme.Border,
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(10),
                Padding = new Thickness(8),
                Width = 286
            };
            border.Child = panel;
            border.RenderTransformOrigin = new Point(0.5, 0);
            var scale = new ScaleTransform(0.96, 0.96);
            border.RenderTransform = scale;

            var popup = new Popup
            {
                PlacementTarget = themeButton,
                Placement = PlacementMode.Bottom,
                StaysOpen = previewMode,
                AllowsTransparency = true,
                PopupAnimation = PopupAnimation.Fade,
                VerticalOffset = 6,
                HorizontalOffset = -176
            };
            popup.Child = border;
            themePopup = popup;
            popup.IsOpen = true;
            var grow = new DoubleAnimation(0.96, 1, TimeSpan.FromMilliseconds(160))
            {
                EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut }
            };
            scale.BeginAnimation(ScaleTransform.ScaleXProperty, grow);
            scale.BeginAnimation(ScaleTransform.ScaleYProperty, grow);
        }

        private Border ThemeRow(ThemeDef def)
        {
            bool active = string.Equals(def.Key, theme.Current.Key, StringComparison.OrdinalIgnoreCase);
            var row = new Border
            {
                Height = 44,
                CornerRadius = new CornerRadius(7),
                Background = active ? theme.AccentSoft : Brushes.Transparent,
                BorderBrush = active ? theme.AccentLine : Brushes.Transparent,
                BorderThickness = new Thickness(1),
                Padding = new Thickness(6, 0, 6, 0),
                Margin = new Thickness(0, 2, 0, 2),
                Cursor = Cursors.Hand
            };
            var grid = new Grid();
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(56) });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(20) });

            Border preview = ThemePreview(def);
            Grid.SetColumn(preview, 0);
            grid.Children.Add(preview);

            var text = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
            var name = Ui.Text(def.Name, 11, theme.Text, FontWeights.SemiBold);
            text.Children.Add(name);
            var desc = Ui.Text(def.Description, 9, theme.Muted);
            desc.TextTrimming = TextTrimming.CharacterEllipsis;
            desc.Margin = new Thickness(0, 2, 0, 0);
            text.Children.Add(desc);
            Grid.SetColumn(text, 1);
            grid.Children.Add(text);

            var check = Ui.Text(active ? "\u2713" : string.Empty, 12, theme.Accent, FontWeights.Bold);
            check.HorizontalAlignment = HorizontalAlignment.Center;
            check.VerticalAlignment = VerticalAlignment.Center;
            Grid.SetColumn(check, 2);
            grid.Children.Add(check);
            row.Child = grid;

            row.MouseEnter += delegate
            {
                if (!active)
                {
                    row.Background = theme.Hover;
                }
            };
            row.MouseLeave += delegate
            {
                row.Background = active ? theme.AccentSoft : Brushes.Transparent;
            };
            row.MouseLeftButtonUp += delegate(object s, MouseButtonEventArgs e)
            {
                e.Handled = true;
                ApplyTheme(def, true);
                if (themePopup != null)
                {
                    themePopup.IsOpen = false;
                }
            };
            return row;
        }

        private Border ThemePreview(ThemeDef def)
        {
            var preview = new Border
            {
                Width = 48,
                Height = 28,
                Background = Ui.Solid(def.Bg),
                BorderBrush = Ui.Solid(def.Border),
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(5),
                HorizontalAlignment = HorizontalAlignment.Left,
                VerticalAlignment = VerticalAlignment.Center,
                ClipToBounds = true
            };
            var grid = new Grid();
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(14) });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            grid.Children.Add(new Border
            {
                Background = Ui.Solid(def.Side),
                CornerRadius = new CornerRadius(4, 0, 0, 4)
            });
            var content = new Grid { Margin = new Thickness(4) };
            content.Children.Add(new Border
            {
                Height = 3,
                Background = Ui.Solid(def.Accent),
                CornerRadius = new CornerRadius(1.5),
                VerticalAlignment = VerticalAlignment.Top
            });
            content.Children.Add(new Border
            {
                Height = 12,
                Background = Ui.Solid(def.Panel),
                CornerRadius = new CornerRadius(3),
                VerticalAlignment = VerticalAlignment.Bottom
            });
            Grid.SetColumn(content, 1);
            grid.Children.Add(content);
            preview.Child = grid;
            return preview;
        }

        private void OpenLanguagePopup()
        {
            if (languagePopup != null)
            {
                languagePopup.IsOpen = false;
            }

            var panel = new StackPanel();
            foreach (Language itemLanguage in Languages)
            {
                Language captured = itemLanguage;
                bool active = captured == language;
                var item = new Border
                {
                    Height = 30,
                    Padding = new Thickness(10, 0, 8, 0),
                    Background = active ? theme.AccentSoft : Brushes.Transparent,
                    BorderBrush = active ? theme.AccentLine : Brushes.Transparent,
                    BorderThickness = new Thickness(1),
                    CornerRadius = new CornerRadius(6),
                    Margin = new Thickness(0, 1, 0, 1),
                    Cursor = Cursors.Hand
                };
                var grid = new Grid();
                var label = Ui.Text(captured.NativeName, 11, theme.Text, FontWeights.SemiBold);
                label.VerticalAlignment = VerticalAlignment.Center;
                grid.Children.Add(label);
                var check = Ui.Text(active ? "\u2713" : string.Empty, 11, theme.Accent, FontWeights.Bold);
                check.HorizontalAlignment = HorizontalAlignment.Right;
                check.VerticalAlignment = VerticalAlignment.Center;
                grid.Children.Add(check);
                item.Child = grid;
                item.MouseEnter += delegate
                {
                    if (!active)
                    {
                        item.Background = theme.Hover;
                    }
                };
                item.MouseLeave += delegate
                {
                    item.Background = active ? theme.AccentSoft : Brushes.Transparent;
                };
                item.MouseLeftButtonUp += delegate(object s, MouseButtonEventArgs e)
                {
                    e.Handled = true;
                    if (languagePopup != null)
                    {
                        languagePopup.IsOpen = false;
                    }
                    ApplyLanguage(captured);
                };
                panel.Children.Add(item);
            }

            var border = new Border
            {
                Background = theme.Panel,
                BorderBrush = theme.Border,
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(8),
                Padding = new Thickness(4),
                Width = 176
            };
            border.Child = panel;

            var popup = new Popup
            {
                PlacementTarget = languageBox,
                Placement = PlacementMode.Top,
                StaysOpen = previewMode,
                AllowsTransparency = true,
                PopupAnimation = PopupAnimation.Fade,
                VerticalOffset = -4
            };
            popup.Child = border;
            languagePopup = popup;
            popup.IsOpen = true;
        }

        private void ApplyTheme(ThemeDef def, bool animate)
        {
            theme.Apply(def, animate, true);
            if (themeButtonText != null)
            {
                themeButtonText.Text = def.Name;
            }
            foreach (DropShadowEffect effect in accentEffects)
            {
                Color from = effect.Color;
                effect.BeginAnimation(DropShadowEffect.ColorProperty, null);
                effect.Color = def.Accent;
                if (animate && from != def.Accent)
                {
                    effect.BeginAnimation(DropShadowEffect.ColorProperty, new ColorAnimation(
                        from, def.Accent, TimeSpan.FromMilliseconds(320))
                    {
                        EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut }
                    });
                }
            }
            foreach (AccentStop entry in accentStops)
            {
                Color to = ThemeManager.WithAlpha(def.Accent, entry.Alpha);
                Color from = entry.Stop.Color;
                entry.Stop.BeginAnimation(GradientStop.ColorProperty, null);
                entry.Stop.Color = to;
                if (animate && from != to)
                {
                    entry.Stop.BeginAnimation(GradientStop.ColorProperty, new ColorAnimation(
                        from, to, TimeSpan.FromMilliseconds(320))
                    {
                        EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut }
                    });
                }
            }
            if (Application.Current != null)
            {
                Application.Current.Resources["ApexAccentColor"] = def.Accent;
            }
        }

        private void ApplyLanguage(Language next)
        {
            language = next;
            Title = next.Title;
            if (themeButtonText != null) themeButtonText.Text = theme.Current.Name;
            if (languageText != null) languageText.Text = next.NativeName;
            if (languageLabel != null) languageLabel.Text = next.LanguageLabel.ToUpperInvariant();
            if (stepTitle != null) stepTitle.Text = next.SetupLabel.ToUpperInvariant();
            if (stepLabels[0] != null) stepLabels[0].Text = next.StepWelcome;
            if (stepLabels[1] != null) stepLabels[1].Text = next.StepFolder;
            if (stepLabels[2] != null) stepLabels[2].Text = next.StepInstall;
            if (stepLabels[3] != null) stepLabels[3].Text = next.StepDone;
            if (welcomeText != null) welcomeText.Text = next.Welcome + " Project Apex";
            if (welcomeSubText != null) welcomeSubText.Text = next.WelcomeSub;
            if (folderText != null) folderText.Text = next.Folder.Trim().TrimEnd(':').Trim().ToUpperInvariant();
            if (folderHeading != null) folderHeading.Text = next.FolderTitle;
            if (folderSubText != null) folderSubText.Text = next.FolderSub;
            if (installTitle != null) installTitle.Text = next.Installing;
            if (installSubText != null) installSubText.Text = next.InstallSub;
            if (installStatus != null) installStatus.Text = next.Working + "...";
            if (doneTitle != null) doneTitle.Text = next.DoneTitle;
            if (doneSub != null) doneSub.Text = next.DoneSub;
            if (nextWelcome != null) nextWelcome.Content = next.Next;
            if (nextFolder != null) nextFolder.Content = next.Next;
            if (cancelButton != null) cancelButton.Content = next.Cancel;
            if (closeButton != null) closeButton.Content = next.Close;
            if (launchButton != null) launchButton.Content = next.Launch;
            if (browseButton != null) browseButton.Content = next.Browse;
            if (footerFolderHint != null) footerFolderHint.Text = next.PrivacyNote;
            if (footerInstallHint != null) footerInstallHint.Text = next.KeepOpen;
            if (themePopupTitle != null) themePopupTitle.Text = next.ThemeLabel.ToUpperInvariant();
            if (footerDoneHint != null && !string.IsNullOrEmpty(installedExe))
            {
                footerDoneHint.Text = next.InstalledTo + " " + IOPath.GetDirectoryName(installedExe);
            }
            if (errorText != null && errorText.Visibility == Visibility.Visible)
            {
                errorText.Text = next.ErrorPath;
            }
            BuildTerms();
        }

        private void BuildTerms()
        {
            if (termsText == null)
            {
                return;
            }
            termsText.Inlines.Clear();
            termsText.Inlines.Add(new Run(language.TermsBefore));
            termsText.Inlines.Add(TermsLink(language.TermsLink1, "terms"));
            termsText.Inlines.Add(new Run(language.TermsBetween));
            termsText.Inlines.Add(TermsLink(language.TermsLink2, "privacy"));
            termsText.Inlines.Add(new Run(language.TermsAfter));
        }

        private Hyperlink TermsLink(string text, string kind)
        {
            var link = new Hyperlink(new Run(text))
            {
                Foreground = theme.Accent,
                TextDecorations = TextDecorations.Underline,
                Cursor = Cursors.Hand,
                Focusable = false,
                FontWeight = FontWeights.SemiBold
            };
            link.Click += delegate
            {
                if (kind == "terms")
                {
                    new LegalWindow(language.TermsLink1, LegalText.Terms, this, theme).ShowDialog();
                }
                else
                {
                    new LegalWindow(language.TermsLink2, LegalText.Privacy, this, theme).ShowDialog();
                }
            };
            return link;
        }

        private void UpdateNextEnabled()
        {
            if (nextFolder == null)
            {
                return;
            }
            bool hasPath = pathBox != null && !string.IsNullOrWhiteSpace(pathBox.Text);
            nextFolder.IsEnabled = hasPath;
        }

        private void BrowseForFolder()
        {
            using (var dialog = new WinForms.FolderBrowserDialog())
            {
                dialog.Description = language.Folder.TrimEnd(':');
                dialog.ShowNewFolderButton = true;
                if (!string.IsNullOrWhiteSpace(pathBox.Text) && Directory.Exists(pathBox.Text.Trim()))
                {
                    dialog.SelectedPath = pathBox.Text.Trim();
                }
                if (dialog.ShowDialog() == WinForms.DialogResult.OK)
                {
                    pathBox.Text = dialog.SelectedPath;
                    pathBox.CaretIndex = pathBox.Text.Length;
                }
            }
        }

        private void BeginInstall()
        {
            if (pathBox == null)
            {
                return;
            }

            string chosen = (pathBox.Text ?? string.Empty).Trim().Trim('"');
            if (chosen.Length == 0)
            {
                ShowPathError(language.ErrorPath);
                return;
            }

            try
            {
                chosen = IOPath.GetFullPath(chosen).TrimEnd('\\');
            }
            catch
            {
                ShowPathError(language.ErrorPath);
                return;
            }

            if (File.Exists(chosen))
            {
                ShowPathError(language.ErrorPath);
                return;
            }

            try
            {
                Directory.CreateDirectory(chosen);
                string probe = IOPath.Combine(chosen, ".apex-write-test");
                File.WriteAllText(probe, "ok");
                File.Delete(probe);
            }
            catch
            {
                ShowPathError(language.ErrorPath);
                return;
            }

            installPath = chosen;
            errorText.Visibility = Visibility.Collapsed;
            ShowPage(pageInstall, footerInstall, true);
            StartSparkleAnimations();

            Task.Factory.StartNew(delegate { return RunCore(chosen); })
                .ContinueWith(delegate(Task<InstallResult> task)
                {
                    Dispatcher.BeginInvoke(new Action(delegate { FinishInstall(task.Result); }));
                });
        }

        private void ShowPathError(string message)
        {
            if (errorText != null)
            {
                errorText.Text = message;
                errorText.Visibility = Visibility.Visible;
            }
        }

        private InstallResult RunCore(string target)
        {
            string core = null;
            try
            {
                CloseRunningApp();
                core = Program.ExtractPayload();
                var psi = new ProcessStartInfo(core);
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.WorkingDirectory = IOPath.GetDirectoryName(core);
                psi.Arguments = "/S /D=" + target;

                using (var process = Process.Start(psi))
                {
                    childProcess = process;
                    process.WaitForExit();
                    if (process.ExitCode != 0)
                    {
                        return new InstallResult
                        {
                            Error = "The core installer exited with code " + process.ExitCode + "."
                        };
                    }
                }

                string exe = IOPath.Combine(target, "Apex Launcher.exe");
                if (!File.Exists(exe))
                {
                    exe = FindExe(target);
                }
                if (string.IsNullOrEmpty(exe))
                {
                    return new InstallResult { Error = "Apex Launcher.exe was not found after installation." };
                }

                return new InstallResult { ExePath = exe };
            }
            catch (Exception ex)
            {
                return new InstallResult { Error = ex.Message };
            }
            finally
            {
                childProcess = null;
                if (core != null)
                {
                    Program.TryDelete(core);
                }
            }
        }

        private void FinishInstall(InstallResult result)
        {
            if (!IsLoaded)
            {
                return;
            }
            if (result == null || !string.IsNullOrEmpty(result.Error))
            {
                string message = result == null || string.IsNullOrEmpty(result.Error) ? language.ErrorInstall : result.Error;
                if (doneTitle != null) doneTitle.Text = language.InstallFailed;
                if (doneSub != null) doneSub.Text = message;
                if (launchButton != null) launchButton.Visibility = Visibility.Collapsed;
                if (doneBadge != null)
                {
                    doneBadge.Background = theme.Danger;
                    doneBadge.BorderBrush = theme.Bg;
                }
                if (doneBadgeText != null) doneBadgeText.Text = "!";
                if (footerDoneHint != null) footerDoneHint.Text = string.Empty;
                ShowPage(pageDone, footerDone, true);
                return;
            }

            installedExe = result.ExePath;
            if (doneTitle != null) doneTitle.Text = language.DoneTitle;
            if (doneSub != null) doneSub.Text = language.DoneSub;
            if (launchButton != null) launchButton.Visibility = Visibility.Visible;
            if (doneBadge != null)
            {
                doneBadge.Background = theme.Accent;
                doneBadge.BorderBrush = theme.Bg;
            }
            if (doneBadgeText != null) doneBadgeText.Text = "\u2713";
            if (footerDoneHint != null)
            {
                footerDoneHint.Text = language.InstalledTo + " " + IOPath.GetDirectoryName(result.ExePath);
            }
            ShowPage(pageDone, footerDone, true);
        }

        private void LaunchInstalledApp()
        {
            try
            {
                if (!string.IsNullOrEmpty(installedExe) && File.Exists(installedExe))
                {
                    Process.Start(new ProcessStartInfo(installedExe) { UseShellExecute = true });
                }
            }
            catch
            {
                // The finish page stays open if the app cannot start.
                return;
            }
            Close();
        }

        private void CancelInstall()
        {
            KillChild();
            Close();
        }

        private void KillChild()
        {
            Process process = childProcess;
            if (process == null)
            {
                return;
            }
            try
            {
                if (!process.HasExited)
                {
                    process.Kill();
                }
            }
            catch
            {
                // Already gone, or the OS is still releasing it.
            }
            childProcess = null;
        }

        private static void CloseRunningApp()
        {
            Process[] running = Process.GetProcessesByName("Apex Launcher");
            foreach (Process process in running)
            {
                try { process.CloseMainWindow(); } catch { }
            }
            Thread.Sleep(350);
            foreach (Process process in running)
            {
                try
                {
                    if (!process.HasExited)
                    {
                        process.Kill();
                    }
                }
                catch { }
            }
        }

        private static string FindExe(string folder)
        {
            try
            {
                if (!Directory.Exists(folder))
                {
                    return null;
                }
                string direct = IOPath.Combine(folder, "Apex Launcher.exe");
                if (File.Exists(direct))
                {
                    return direct;
                }
                return Directory.GetFiles(folder, "Apex Launcher.exe", SearchOption.AllDirectories).FirstOrDefault();
            }
            catch
            {
                return null;
            }
        }

        private static string FindExistingInstall()
        {
            string fallback = IOPath.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Programs", "Apex Launcher");

            try
            {
                if (File.Exists(IOPath.Combine(fallback, "Apex Launcher.exe")))
                {
                    return fallback;
                }
            }
            catch { }

            try
            {
                using (RegistryKey uninstall = Registry.CurrentUser.OpenSubKey(
                    @"Software\Microsoft\Windows\CurrentVersion\Uninstall"))
                {
                    if (uninstall != null)
                    {
                        foreach (string name in uninstall.GetSubKeyNames())
                        {
                            using (RegistryKey entry = uninstall.OpenSubKey(name))
                            {
                                if (entry == null)
                                {
                                    continue;
                                }
                                object display = entry.GetValue("DisplayName");
                                if (display == null || !display.ToString().StartsWith("Apex Launcher", StringComparison.OrdinalIgnoreCase))
                                {
                                    continue;
                                }
                                object command = entry.GetValue("UninstallString");
                                if (command == null)
                                {
                                    continue;
                                }
                                string exe = FirstArgument(command.ToString());
                                if (!string.IsNullOrEmpty(exe))
                                {
                                    string folder = IOPath.GetDirectoryName(exe);
                                    if (Directory.Exists(folder))
                                    {
                                        return folder;
                                    }
                                }
                            }
                        }
                    }
                }
            }
            catch { }

            return fallback;
        }

        private static string FirstArgument(string command)
        {
            command = (command ?? string.Empty).Trim();
            if (command.Length == 0)
            {
                return null;
            }
            if (command[0] == '"')
            {
                int end = command.IndexOf('"', 1);
                return end > 1 ? command.Substring(1, end - 1) : null;
            }
            int space = command.IndexOf(' ');
            return space > 0 ? command.Substring(0, space) : command;
        }

        private void ShowPage(Grid page, Grid footer, bool animate)
        {
            foreach (Grid child in new Grid[] { pageWelcome, pageFolder, pageInstall, pageDone })
            {
                if (child != null)
                {
                    child.Visibility = child == page ? Visibility.Visible : Visibility.Collapsed;
                    child.Opacity = 1;
                }
            }
            foreach (Grid child in new Grid[] { footerWelcome, footerFolder, footerInstall, footerDone })
            {
                if (child != null)
                {
                    child.Visibility = child == footer ? Visibility.Visible : Visibility.Collapsed;
                    child.Opacity = 1;
                }
            }
            int step = page == pageWelcome ? 0 : page == pageFolder ? 1 : page == pageInstall ? 2 : 3;
            SetStep(step);
            if (animate)
            {
                AnimateIn(page, true);
                AnimateFade(footer);
            }
        }

        private void SetStep(int active)
        {
            currentStep = active;
            for (int i = 0; i < stepRows.Length; i++)
            {
                if (stepRows[i] == null)
                {
                    continue;
                }
                bool isActive = i == active;
                bool isDone = i < active;
                stepRows[i].Background = isActive ? theme.AccentSoft : Brushes.Transparent;
                stepRows[i].BorderBrush = isActive ? theme.AccentLine : Brushes.Transparent;
                stepDots[i].Background = isActive || isDone ? theme.Accent : theme.Input;
                stepDots[i].BorderBrush = isActive || isDone ? theme.Accent : theme.Border;
                stepNumbers[i].Text = isDone ? "\u2713" : (i + 1).ToString();
                stepNumbers[i].Foreground = isActive || isDone ? theme.White : theme.Muted;
                stepLabels[i].Foreground = isActive ? theme.Text : theme.Muted;
                stepBars[i].BeginAnimation(UIElement.OpacityProperty, new DoubleAnimation(
                    isActive ? 1 : 0, TimeSpan.FromMilliseconds(180))
                {
                    EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut }
                });
            }
        }

        private static void AnimateIn(Grid page, bool slide)
        {
            if (page == null)
            {
                return;
            }
            page.Opacity = 0;
            var transform = new TranslateTransform(slide ? 14 : 0, slide ? 0 : 7);
            page.RenderTransform = transform;
            var fade = new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(210))
            {
                EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut }
            };
            page.BeginAnimation(UIElement.OpacityProperty, fade);
            var move = new DoubleAnimation(slide ? 14 : 0, 0, TimeSpan.FromMilliseconds(slide ? 240 : 260))
            {
                EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut }
            };
            transform.BeginAnimation(TranslateTransform.XProperty, move);
            if (!slide)
            {
                var moveY = new DoubleAnimation(7, 0, TimeSpan.FromMilliseconds(260))
                {
                    EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut }
                };
                transform.BeginAnimation(TranslateTransform.YProperty, moveY);
            }
        }

        private static void AnimateFade(Grid footer)
        {
            if (footer == null)
            {
                return;
            }
            footer.Opacity = 0;
            footer.BeginAnimation(UIElement.OpacityProperty, new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(240))
            {
                EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut }
            });
        }

        private Canvas BuildArtwork()
        {
            var canvas = new Canvas { Width = 400, Height = 145, IsHitTestVisible = false };
            var random = new Random(23);

            for (int i = 0; i < 40; i++)
            {
                double x = 48 + i * 4.7 + random.NextDouble() * 5;
                double y = 80 + Math.Sin(i * 0.5) * 24 + (random.NextDouble() * 10 - 5);
                double size = 1.0 + random.NextDouble() * 2.7;
                UIElement spark;
                if (i % 5 == 0)
                {
                    var star = new ShapePath
                    {
                        Data = Geometry.Parse("M 0,-4 L 1.1,-1.1 L 4,0 L 1.1,1.1 L 0,4 L -1.1,1.1 L -4,0 L -1.1,-1.1 Z"),
                        Fill = theme.White,
                        Stretch = Stretch.None,
                        RenderTransformOrigin = new Point(0.5, 0.5)
                    };
                    Canvas.SetLeft(star, x);
                    Canvas.SetTop(star, y);
                    spark = star;
                }
                else
                {
                    var dot = new Ellipse { Width = size, Height = size, Fill = theme.White };
                    Canvas.SetLeft(dot, x);
                    Canvas.SetTop(dot, y);
                    spark = dot;
                }
                spark.Opacity = 0.18;
                canvas.Children.Add(spark);
                sparkles.Add(spark);
            }

            AddPcArt(canvas);
            return canvas;
        }

        private void AddPcArt(Canvas canvas)
        {
            Brush line = theme.Text;
            AddPath(canvas, "M 248,18 L 326,18 Q 333,18 333,25 L 333,78 Q 333,85 326,85 L 248,85 Q 241,85 241,78 L 241,25 Q 241,18 248,18 Z", line, 1.35);
            AddPath(canvas, "M 248,26 L 326,26 L 326,77 L 248,77 Z", line, 0.85, 0.5);
            AddPath(canvas, "M 278,85 L 274,103 M 296,85 L 300,103 M 262,104 L 312,104", line, 1.25);
            AddPath(canvas, "M 216,112 L 340,112 L 352,130 L 204,130 Z", line, 1.2);
            AddPath(canvas, "M 220,118 L 338,118 M 216,124 L 344,124", line, 0.9, 0.65);
            AddPath(canvas, "M 358,109 L 358,130 M 352,116 L 364,116 M 352,122 L 364,122", line, 1.15);
            AddPath(canvas, "M 368,112 L 368,128 M 376,112 L 376,128", line, 1.0, 0.55);

            var mark = new Image
            {
                Source = Ui.Bitmap("Mark"),
                Width = 28,
                Height = 24,
                Stretch = Stretch.Uniform,
                Opacity = 0.95
            };
            var glow = new DropShadowEffect
            {
                Color = theme.Current.Accent,
                BlurRadius = 18,
                ShadowDepth = 0,
                Opacity = 0.55
            };
            mark.Effect = glow;
            accentEffects.Add(glow);
            Canvas.SetLeft(mark, 273);
            Canvas.SetTop(mark, 39);
            canvas.Children.Add(mark);
        }

        private static void AddPath(Canvas canvas, string data, Brush stroke, double thickness)
        {
            AddPath(canvas, data, stroke, thickness, 1.0);
        }

        private static void AddPath(Canvas canvas, string data, Brush stroke, double thickness, double opacity)
        {
            var path = new ShapePath
            {
                Data = Geometry.Parse(data),
                Stroke = stroke,
                StrokeThickness = thickness,
                StrokeStartLineCap = PenLineCap.Round,
                StrokeEndLineCap = PenLineCap.Round,
                StrokeLineJoin = PenLineJoin.Round,
                Fill = null,
                Opacity = opacity,
                SnapsToDevicePixels = true
            };
            canvas.Children.Add(path);
        }

        private void StartSparkleAnimations()
        {
            if (sparklesStarted)
            {
                return;
            }
            sparklesStarted = true;
            for (int i = 0; i < sparkles.Count; i++)
            {
                UIElement spark = sparkles[i];
                var fade = new DoubleAnimation(0.12, 1.0, TimeSpan.FromMilliseconds(1300 + (i * 137) % 1300))
                {
                    BeginTime = TimeSpan.FromMilliseconds((i * 97) % 2400),
                    AutoReverse = true,
                    RepeatBehavior = RepeatBehavior.Forever,
                    EasingFunction = new SineEase { EasingMode = EasingMode.EaseInOut }
                };
                spark.BeginAnimation(UIElement.OpacityProperty, fade);
            }
            if (progressTransform != null)
            {
                var slide = new DoubleAnimation(-120, 430, TimeSpan.FromMilliseconds(1600))
                {
                    RepeatBehavior = RepeatBehavior.Forever,
                    EasingFunction = new SineEase { EasingMode = EasingMode.EaseInOut }
                };
                progressTransform.BeginAnimation(TranslateTransform.XProperty, slide);
            }
            if (statusDot != null)
            {
                var pulse = new DoubleAnimation(0.35, 1.0, TimeSpan.FromMilliseconds(900))
                {
                    AutoReverse = true,
                    RepeatBehavior = RepeatBehavior.Forever,
                    EasingFunction = new SineEase { EasingMode = EasingMode.EaseInOut }
                };
                statusDot.BeginAnimation(UIElement.OpacityProperty, pulse);
            }
        }

        private sealed class InstallResult
        {
            public string ExePath;
            public string Error;
        }
    }

    internal static class LegalText
    {
        public const string Terms =
            "Project Apex is provided as-is, without warranty of any kind. " +
            "You are responsible for the games, accounts and files you use it with. " +
            "Do not use Project Apex to break the law or the terms of the services you connect to. " +
            "Project Apex does not grant you ownership of any game or content.\r\n\r\n" +
            "If you do not agree with these terms, close this installer.";

        public const string Privacy =
            "Project Apex runs on your PC. It stores your settings, library and play history locally. " +
            "It contacts GitHub for updates and the game services you choose to connect. " +
            "Project Apex does not sell personal data and does not run an analytics profile of you.\r\n\r\n" +
            "You can remove the local data at any time by uninstalling the app and deleting its AppData folder.";
    }

    internal sealed class LegalWindow : Window
    {
        public LegalWindow(string title, string body, Window owner, ThemeManager theme)
        {
            Owner = owner;
            Title = title;
            Width = 480;
            Height = 380;
            WindowStartupLocation = WindowStartupLocation.CenterOwner;
            WindowStyle = WindowStyle.None;
            ResizeMode = ResizeMode.NoResize;
            AllowsTransparency = true;
            Background = Brushes.Transparent;
            ShowInTaskbar = false;
            UseLayoutRounding = true;
            SnapsToDevicePixels = true;
            TextOptions.SetTextFormattingMode(this, TextFormattingMode.Display);
            Opacity = 0;

            var root = new Grid();
            Content = root;
            var frame = new Border
            {
                Background = theme.BackgroundGradient,
                BorderBrush = theme.AccentLine,
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(9),
                ClipToBounds = true
            };
            frame.SizeChanged += delegate
            {
                if (frame.ActualWidth > 0 && frame.ActualHeight > 0)
                {
                    frame.Clip = new RectangleGeometry(
                        new Rect(0, 0, frame.ActualWidth, frame.ActualHeight), 9, 9);
                }
            };
            root.Children.Add(frame);

            var shell = new Grid();
            frame.Child = shell;
            shell.RowDefinitions.Add(new RowDefinition { Height = new GridLength(36) });
            shell.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
            shell.RowDefinitions.Add(new RowDefinition { Height = new GridLength(54) });

            var titleBar = new Grid { Background = theme.TitleGradient };
            titleBar.Children.Add(new Border
            {
                Height = 1,
                VerticalAlignment = VerticalAlignment.Bottom,
                Background = theme.AccentLine,
                Opacity = 0.8
            });
            var drag = new Border { Background = Brushes.Transparent };
            drag.MouseLeftButtonDown += delegate
            {
                try { DragMove(); } catch { }
            };
            titleBar.Children.Add(drag);
            var titleText = Ui.Text(title, 11.5, theme.Text, FontWeights.SemiBold);
            titleText.VerticalAlignment = VerticalAlignment.Center;
            titleText.Margin = new Thickness(14, 0, 0, 0);
            titleText.IsHitTestVisible = false;
            titleBar.Children.Add(titleText);

            var close = new Border
            {
                Width = 36,
                Height = 35,
                HorizontalAlignment = HorizontalAlignment.Right,
                VerticalAlignment = VerticalAlignment.Top,
                Background = Brushes.Transparent,
                Cursor = Cursors.Hand
            };
            var glyph = new ShapePath
            {
                Data = Geometry.Parse("M 0,0 L 9,9 M 9,0 L 0,9"),
                Stroke = theme.Text,
                StrokeThickness = 1.1,
                StrokeStartLineCap = PenLineCap.Round,
                StrokeEndLineCap = PenLineCap.Round,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center
            };
            close.Child = glyph;
            close.MouseEnter += delegate { close.Background = Ui.B("#C42B1C"); };
            close.MouseLeave += delegate { close.Background = Brushes.Transparent; };
            close.MouseLeftButtonUp += delegate { Close(); };
            titleBar.Children.Add(close);
            Grid.SetRow(titleBar, 0);
            shell.Children.Add(titleBar);

            var card = new Border
            {
                Background = theme.PanelGlass,
                BorderBrush = theme.Border,
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(10),
                Margin = new Thickness(16, 12, 16, 0)
            };
            Grid.SetRow(card, 1);
            var scroll = new ScrollViewer
            {
                VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
                HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
                Padding = new Thickness(16, 14, 16, 14)
            };
            var copy = new TextBlock
            {
                Text = body,
                TextWrapping = TextWrapping.Wrap,
                FontFamily = new FontFamily("Segoe UI"),
                FontSize = 11,
                Foreground = theme.Text,
                LineHeight = 17
            };
            TextOptions.SetTextFormattingMode(copy, TextFormattingMode.Display);
            scroll.Content = copy;
            card.Child = scroll;
            shell.Children.Add(card);

            var footer = new Grid { Margin = new Thickness(16, 0, 16, 0) };
            Grid.SetRow(footer, 2);
            var closeButton = new Button
            {
                Content = "Close",
                Style = Ui.ButtonStyle(false),
                Background = theme.Panel,
                Foreground = theme.Text,
                BorderBrush = theme.Border,
                BorderThickness = new Thickness(1),
                MinWidth = 86,
                Height = 30,
                Padding = new Thickness(14, 0, 14, 0),
                HorizontalAlignment = HorizontalAlignment.Right,
                VerticalAlignment = VerticalAlignment.Center
            };
            closeButton.MouseEnter += delegate
            {
                closeButton.Background = theme.Hover;
                closeButton.BorderBrush = theme.AccentLine;
            };
            closeButton.MouseLeave += delegate
            {
                closeButton.Background = theme.Panel;
                closeButton.BorderBrush = theme.Border;
            };
            closeButton.Click += delegate { Close(); };
            footer.Children.Add(closeButton);
            shell.Children.Add(footer);

            Loaded += delegate
            {
                var scale = new ScaleTransform(0.97, 0.97);
                root.RenderTransform = scale;
                root.RenderTransformOrigin = new Point(0.5, 0.5);
                BeginAnimation(OpacityProperty, new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(200))
                {
                    EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut }
                });
                var grow = new DoubleAnimation(0.97, 1, TimeSpan.FromMilliseconds(240))
                {
                    EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut }
                };
                scale.BeginAnimation(ScaleTransform.ScaleXProperty, grow);
                scale.BeginAnimation(ScaleTransform.ScaleYProperty, grow);
            };
        }
    }
}
