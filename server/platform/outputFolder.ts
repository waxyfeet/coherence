import { spawn } from "node:child_process";

import { HttpError } from "../errors";
import { platformProcess } from "./nativeHelper";

// Fixed code; paths travel over stdin as JSON, never as PowerShell source/arguments.
export const FOLDER_DIALOG_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$owner = New-Object System.Windows.Forms.Form
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
try {
  # The console is hidden; show an invisible owner before creating its modal
  # chooser so the shell dialog does not inherit an ownerless hidden window.
  $owner.Text = 'Coherence folder chooser'
  $owner.ShowInTaskbar = $false
  $owner.TopMost = $true
  $owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
  $owner.Size = New-Object System.Drawing.Size(1, 1)
  $owner.Opacity = 0
  $owner.Show()
  $owner.Activate()
  $dialog.Description = $request.description
  $dialog.SelectedPath = $request.initialPath
  $dialog.ShowNewFolderButton = $false
  $selected = $null
  if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
    $selected = $dialog.SelectedPath
  }
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  [Console]::Out.Write((@{path = $selected} | ConvertTo-Json -Compress))
} finally {
  $dialog.Dispose()
  $owner.Dispose()
}`;

type FolderDialog = (
  initialPath: string,
  signal: AbortSignal,
  description?: string,
) => Promise<string | null>;
const unavailable = () =>
  new HttpError(
    503,
    "The Windows folder chooser is unavailable. Enter a folder path manually, or use the managed project folder.",
    "FOLDER_CHOOSER_UNAVAILABLE",
  );

export const windowsFolderDialog: FolderDialog = (
  initialPath,
  signal,
  description = "Choose a Coherence project folder",
) =>
  new Promise((resolve, reject) => {
    const command = platformProcess("choose-folder", [
      "-STA",
      "-EncodedCommand",
      Buffer.from(FOLDER_DIALOG_SCRIPT, "utf16le").toString("base64"),
    ]);
    const child = spawn(command.file, command.args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let output = "";
    let settled = false;
    const finish = (error?: Error, value: string | null = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error) {
        child.kill();
        reject(error);
      } else resolve(value);
    };
    const abort = () =>
      finish(
        new HttpError(
          408,
          "Folder selection was cancelled. Your project has not changed.",
          "FOLDER_CHOOSER_CANCELLED",
        ),
      );
    const timer = setTimeout(
      () =>
        finish(
          new HttpError(
            408,
            "Folder selection timed out. Choose a folder again, or enter the path manually.",
            "FOLDER_CHOOSER_TIMEOUT",
          ),
        ),
      120_000,
    );
    signal.addEventListener("abort", abort, { once: true });
    child.once("error", () => finish(unavailable()));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 16_384) finish(unavailable());
    });
    child.once("close", (code) => {
      if (settled) return;
      try {
        if (code !== 0) throw Error();
        const result: unknown = JSON.parse(output.trim());
        if (
          !result ||
          typeof result !== "object" ||
          !("path" in result) ||
          (result.path !== null && typeof result.path !== "string")
        )
          throw Error();
        finish(undefined, result.path);
      } catch {
        finish(unavailable());
      }
    });
    child.stdin.on("error", () => finish(unavailable()));
    if (signal.aborted) abort();
    else child.stdin.end(JSON.stringify({ initialPath, description }));
  });
