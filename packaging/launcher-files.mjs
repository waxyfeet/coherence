/** Shared by build-launcher.mjs and verify-launcher.mjs. */

/** Must match the WebView2 PackageReference in packaging/launcher/Coherence.Launcher.csproj. */
export const WEBVIEW2_VERSION = "1.0.4314.35";

/** Everything Coherence.exe needs beside it: the launcher and its app window (WebView2 SDK). */
export const LAUNCHER_FILES = [
  "Coherence.exe",
  "Coherence.exe.config",
  "Microsoft.Web.WebView2.Core.dll",
  "Microsoft.Web.WebView2.WinForms.dll",
  "WebView2Loader.dll",
];

/** The native platform helper the backend runs instead of PowerShell (packaging/helper, installer Stage 6). */
export const HELPER_FILES = [
  "CoherencePlatform.exe",
  "CoherencePlatform.exe.config",
];
