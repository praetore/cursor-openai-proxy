import { spawn } from "node:child_process";
import { access, mkdir, unlink, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP_NAME = "Cursor OpenAI Proxy";

/** Installed/package root (parent of dist/). */
export function appRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

function windowsStartupShortcutPath(): string {
  const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  return join(
    appData,
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup",
    `${APP_NAME}.lnk`,
  );
}

function macLaunchAgentPath(): string {
  return join(homedir(), "Library", "LaunchAgents", "com.praetore.cursor-openai-proxy.plist");
}

function linuxAutostartPath(): string {
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(configHome, "autostart", "cursor-openai-proxy.desktop");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function runPowerShell(command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
      { windowsHide: true, stdio: "ignore" },
    );
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`PowerShell exited with ${code}`));
    });
  });
}

async function enableWindows(): Promise<void> {
  const root = appRoot();
  const shortcut = windowsStartupShortcutPath();
  const startBg = join(root, "start-bg.vbs");
  const icon = join(root, "assets", "tray.ico");
  const q = (s: string) => s.replace(/'/g, "''");
  const useStartBg = await pathExists(startBg);

  const targetBlock = useStartBg
    ? `$Sc.TargetPath = '${q(startBg)}'
$Sc.Arguments = ''`
    : `$Sc.TargetPath = 'node'
$Sc.Arguments = 'dist/index.js'`;

  const script = `
$ErrorActionPreference = 'Stop'
$Wsh = New-Object -ComObject WScript.Shell
$Sc = $Wsh.CreateShortcut('${q(shortcut)}')
${targetBlock}
$Sc.WorkingDirectory = '${q(root)}'
$Sc.WindowStyle = 7
if (Test-Path '${q(icon)}') { $Sc.IconLocation = '${q(icon)}' }
$Sc.Save()
`;
  await mkdir(dirname(shortcut), { recursive: true });
  await runPowerShell(script);
}

async function disableWindows(): Promise<void> {
  const shortcut = windowsStartupShortcutPath();
  if (await pathExists(shortcut)) await unlink(shortcut);
}

async function enableMac(): Promise<void> {
  const root = appRoot();
  const startSh = join(root, "start.sh");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.praetore.cursor-openai-proxy</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${startSh}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>WorkingDirectory</key>
  <string>${root}</string>
</dict>
</plist>
`;
  const path = macLaunchAgentPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, plist, "utf8");
}

async function disableMac(): Promise<void> {
  const path = macLaunchAgentPath();
  if (await pathExists(path)) await unlink(path);
}

async function enableLinux(): Promise<void> {
  const root = appRoot();
  const startSh = join(root, "start.sh");
  const desktop = `[Desktop Entry]
Type=Application
Name=${APP_NAME}
Exec=${startSh}
Path=${root}
X-GNOME-Autostart-enabled=true
NoDisplay=false
`;
  const path = linuxAutostartPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, desktop, "utf8");
}

async function disableLinux(): Promise<void> {
  const path = linuxAutostartPath();
  if (await pathExists(path)) await unlink(path);
}

export async function isAutostartEnabled(): Promise<boolean> {
  if (process.platform === "win32") return pathExists(windowsStartupShortcutPath());
  if (process.platform === "darwin") return pathExists(macLaunchAgentPath());
  return pathExists(linuxAutostartPath());
}

/** Create or remove OS login autostart so it matches `enabled`. */
export async function setAutostartEnabled(enabled: boolean): Promise<void> {
  if (process.platform === "win32") {
    if (enabled) await enableWindows();
    else await disableWindows();
    return;
  }
  if (process.platform === "darwin") {
    if (enabled) await enableMac();
    else await disableMac();
    return;
  }
  if (enabled) await enableLinux();
  else await disableLinux();
}

/** Ensure OS autostart matches the config preference. */
export async function syncAutostart(enabled: boolean): Promise<void> {
  const current = await isAutostartEnabled();
  if (current !== enabled) await setAutostartEnabled(enabled);
}
