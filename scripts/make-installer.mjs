#!/usr/bin/env node
/**
 * Builds a platform package under release/:
 *   cursor-openai-proxy-<version>-<os>-<arch>.{zip|tar.gz}
 * plus install / uninstall / start helpers inside the archive.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { arch, platform } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = process.env.PACKAGE_VERSION?.replace(/^v/, "") || pkg.version;

const osName =
  platform() === "win32" ? "windows" : platform() === "darwin" ? "macos" : "linux";
const cpu = arch() === "x64" ? "x64" : arch() === "arm64" ? "arm64" : arch();

const outDir = join(root, "release");
const stageName = `cursor-openai-proxy-${version}-${osName}-${cpu}`;
const stageDir = join(outDir, stageName);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

for (const dir of ["dist", "public", "assets"]) {
  const src = join(root, dir);
  if (!existsSync(src)) {
    throw new Error(`Missing required directory: ${dir}`);
  }
  cpSync(src, join(stageDir, dir), { recursive: true });
}

cpSync(join(root, "package.json"), join(stageDir, "package.json"));
cpSync(join(root, "package-lock.json"), join(stageDir, "package-lock.json"));
cpSync(join(root, "LICENSE"), join(stageDir, "LICENSE"));
cpSync(join(root, "README.md"), join(stageDir, "README.md"));

console.log("Installing production dependencies into package…");
execFileSync("npm", ["ci", "--omit=dev"], {
  cwd: stageDir,
  stdio: "inherit",
  shell: platform() === "win32",
});

if (osName === "windows") {
  writeFileSync(join(stageDir, "install.ps1"), windowsInstallPs1(version), "utf8");
  writeFileSync(join(stageDir, "uninstall.ps1"), windowsUninstallPs1(), "utf8");
  writeFileSync(join(stageDir, "start.ps1"), windowsStartPs1(), "utf8");
  writeFileSync(join(stageDir, "start-bg.ps1"), windowsStartBgPs1(), "utf8");
} else {
  writeFileSync(join(stageDir, "install.sh"), unixInstallSh(version), { encoding: "utf8", mode: 0o755 });
  writeFileSync(join(stageDir, "uninstall.sh"), unixUninstallSh(), { encoding: "utf8", mode: 0o755 });
  writeFileSync(join(stageDir, "start.sh"), unixStartSh(), { encoding: "utf8", mode: 0o755 });
}

const archiveBase = join(outDir, stageName);
if (osName === "windows") {
  const zipPath = `${archiveBase}.zip`;
  if (platform() === "win32") {
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Compress-Archive -Path '${stageDir}' -DestinationPath '${zipPath}' -Force`,
      ],
      { stdio: "inherit" },
    );
  } else {
    execFileSync("zip", ["-r", zipPath, stageName], { cwd: outDir, stdio: "inherit" });
  }
  console.log(`Created ${zipPath}`);
} else {
  const tarPath = `${archiveBase}.tar.gz`;
  execFileSync("tar", ["-czf", tarPath, stageName], { cwd: outDir, stdio: "inherit" });
  console.log(`Created ${tarPath}`);
}

rmSync(stageDir, { recursive: true, force: true });

function windowsInstallPs1(ver) {
  return `#Requires -Version 5.1
$ErrorActionPreference = "Stop"
$InstallDir = Join-Path $env:LOCALAPPDATA "cursor-openai-proxy"
$Source = $PSScriptRoot

Write-Host "Installing cursor-openai-proxy ${ver} to $InstallDir"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "Node.js 22.13+ is required. Install from https://nodejs.org/ and re-run install.ps1"
}

if (Test-Path $InstallDir) {
  Remove-Item -Recurse -Force $InstallDir
}
New-Item -ItemType Directory -Path $InstallDir | Out-Null
Copy-Item -Path (Join-Path $Source "*") -Destination $InstallDir -Recurse -Force

$WshShell = New-Object -ComObject WScript.Shell
$StartMenu = Join-Path $env:APPDATA "Microsoft\\Windows\\Start Menu\\Programs"
$Shortcut = $WshShell.CreateShortcut((Join-Path $StartMenu "Cursor OpenAI Proxy.lnk"))
$Shortcut.TargetPath = "powershell.exe"
$Shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File \\"$InstallDir\\start-bg.ps1\\""
$Shortcut.WorkingDirectory = $InstallDir
$Shortcut.WindowStyle = 7
$Icon = Join-Path $InstallDir "assets\\tray.ico"
if (Test-Path $Icon) { $Shortcut.IconLocation = $Icon }
$Shortcut.Save()

Write-Host "Installed. Start via Start Menu 'Cursor OpenAI Proxy' or:"
Write-Host "  powershell -File \\"$InstallDir\\start.ps1\\""
`;
}

function windowsUninstallPs1() {
  return `#Requires -Version 5.1
$ErrorActionPreference = "Stop"
$InstallDir = Join-Path $env:LOCALAPPDATA "cursor-openai-proxy"
$Shortcut = Join-Path $env:APPDATA "Microsoft\\Windows\\Start Menu\\Programs\\Cursor OpenAI Proxy.lnk"

Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*cursor-openai-proxy*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

if (Test-Path $Shortcut) { Remove-Item -Force $Shortcut }
if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
Write-Host "Uninstalled cursor-openai-proxy"
`;
}

function windowsStartPs1() {
  return `#Requires -Version 5.1
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
node dist/index.js
`;
}

function windowsStartBgPs1() {
  return `#Requires -Version 5.1
$ErrorActionPreference = "Stop"
$InstallDir = $PSScriptRoot
Start-Process -WindowStyle Hidden -FilePath "node" -ArgumentList "dist/index.js" -WorkingDirectory $InstallDir
`;
}

function unixInstallSh(ver) {
  return `#!/usr/bin/env bash
set -euo pipefail
VERSION="${ver}"
INSTALL_DIR="\${XDG_DATA_HOME:-\$HOME/.local/share}/cursor-openai-proxy"
BIN_DIR="\${XDG_BIN_HOME:-\$HOME/.local/bin}"
SOURCE="$(cd "$(dirname "$0")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22.13+ is required. Install from https://nodejs.org/ and re-run install.sh" >&2
  exit 1
fi

echo "Installing cursor-openai-proxy \$VERSION to \$INSTALL_DIR"
rm -rf "\$INSTALL_DIR"
mkdir -p "\$INSTALL_DIR" "\$BIN_DIR"
cp -R "\$SOURCE/." "\$INSTALL_DIR/"
chmod +x "\$INSTALL_DIR/start.sh" "\$INSTALL_DIR/uninstall.sh" || true

cat > "\$BIN_DIR/cursor-openai-proxy" <<EOF
#!/usr/bin/env bash
exec "\$INSTALL_DIR/start.sh" "\\\$@"
EOF
chmod +x "\$BIN_DIR/cursor-openai-proxy"

echo "Installed. Run: cursor-openai-proxy"
echo "Ensure \$BIN_DIR is on your PATH."
`;
}

function unixUninstallSh() {
  return `#!/usr/bin/env bash
set -euo pipefail
INSTALL_DIR="\${XDG_DATA_HOME:-\$HOME/.local/share}/cursor-openai-proxy"
BIN_DIR="\${XDG_BIN_HOME:-\$HOME/.local/bin}"
pkill -f "cursor-openai-proxy.*dist/index.js" 2>/dev/null || true
rm -f "\$BIN_DIR/cursor-openai-proxy"
rm -rf "\$INSTALL_DIR"
echo "Uninstalled cursor-openai-proxy"
`;
}

function unixStartSh() {
  return `#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
exec node dist/index.js "$@"
`;
}
