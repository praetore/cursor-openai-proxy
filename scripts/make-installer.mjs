#!/usr/bin/env node
/**
 * Builds real OS installers under release/:
 *   Windows → cursor-openai-proxy-Setup-<version>-<arch>.exe  (Inno Setup)
 *   macOS   → cursor-openai-proxy-<version>-<arch>.pkg
 *   Linux   → cursor-openai-proxy_<version>_<debArch>.deb
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  chmodSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { arch, platform, homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = process.env.PACKAGE_VERSION?.replace(/^v/, "") || pkg.version;

const osName =
  platform() === "win32" ? "windows" : platform() === "darwin" ? "macos" : "linux";
const cpu = arch() === "x64" ? "x64" : arch() === "arm64" ? "arm64" : arch();
const debArch = cpu === "x64" ? "amd64" : cpu === "arm64" ? "arm64" : cpu;

const outDir = join(root, "release");
const stageDir = join(outDir, "stage");

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
  writeFileSync(join(stageDir, "start.cmd"), windowsStartCmd(), "utf8");
  writeFileSync(join(stageDir, "start-bg.vbs"), windowsStartBgVbs(), "utf8");
  writeFileSync(join(stageDir, "write-start-at-login.ps1"), windowsWriteStartAtLoginPs1(), "utf8");
  buildWindowsExe();
} else if (osName === "macos") {
  writeFileSync(join(stageDir, "start.sh"), unixStartSh(), { encoding: "utf8", mode: 0o755 });
  buildMacPkg();
} else {
  writeFileSync(join(stageDir, "start.sh"), unixStartSh(), { encoding: "utf8", mode: 0o755 });
  buildLinuxDeb();
}

rmSync(stageDir, { recursive: true, force: true });

function buildWindowsExe() {
  const iscc = findIscc();
  if (!iscc) {
    throw new Error(
      "Inno Setup 6+ (ISCC.exe) not found. Install from https://jrsoftware.org/isinfo.php or set INNO_SETUP_ISCC.",
    );
  }
  const iss = join(root, "scripts", "windows", "installer.iss");
  console.log(`Compiling Inno Setup installer with ${iscc}…`);
  execFileSync(
    iscc,
    [
      iss,
      `/DMyAppVersion=${version}`,
      `/DStageDir=${stageDir}`,
      `/DOutputDir=${outDir}`,
      `/DArch=${cpu}`,
    ],
    { stdio: "inherit" },
  );
  const exeName = `cursor-openai-proxy-Setup-${version}-${cpu}.exe`;
  if (!existsSync(join(outDir, exeName))) {
    throw new Error(`Expected installer missing: ${exeName}`);
  }
  console.log(`Created ${join(outDir, exeName)}`);
}

function findIscc() {
  if (process.env.INNO_SETUP_ISCC && existsSync(process.env.INNO_SETUP_ISCC)) {
    return process.env.INNO_SETUP_ISCC;
  }
  const bases = [
    process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
    process.env.ProgramFiles || "C:\\Program Files",
    join(homedir(), "AppData", "Local", "Programs"),
  ];
  const folders = ["Inno Setup 7", "Inno Setup 6", "InnoSetup6"];
  const candidates = bases.flatMap((base) => folders.map((f) => join(base, f, "ISCC.exe")));
  return candidates.find((p) => existsSync(p)) || null;
}

function buildMacPkg() {
  const payloadRoot = join(outDir, "pkg-root");
  const appDir = join(payloadRoot, "usr", "local", "lib", "cursor-openai-proxy");
  const binDir = join(payloadRoot, "usr", "local", "bin");
  mkdirSync(appDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  for (const entry of readdirSync(stageDir)) {
    cpSync(join(stageDir, entry), join(appDir, entry), { recursive: true });
  }
  chmodSync(join(appDir, "start.sh"), 0o755);

  const launcher = `#!/usr/bin/env bash
set -euo pipefail
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22.13+ is required. Install from https://nodejs.org/" >&2
  exit 1
fi
exec /usr/local/lib/cursor-openai-proxy/start.sh "$@"
`;
  const launcherPath = join(binDir, "cursor-openai-proxy");
  writeFileSync(launcherPath, launcher, { encoding: "utf8", mode: 0o755 });

  const scriptsDir = join(outDir, "pkg-scripts");
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(
    join(scriptsDir, "postinstall"),
    `#!/usr/bin/env bash
set -euo pipefail
chmod +x /usr/local/lib/cursor-openai-proxy/start.sh || true
chmod +x /usr/local/bin/cursor-openai-proxy || true
if ! command -v node >/dev/null 2>&1; then
  echo "Warning: Node.js 22.13+ was not found on PATH. Install from https://nodejs.org/" >&2
fi
exit 0
`,
    { encoding: "utf8", mode: 0o755 },
  );

  const pkgPath = join(outDir, `cursor-openai-proxy-${version}-${cpu}.pkg`);
  console.log("Building macOS .pkg…");
  execFileSync(
    "pkgbuild",
    [
      "--root",
      payloadRoot,
      "--scripts",
      scriptsDir,
      "--identifier",
      "com.praetore.cursor-openai-proxy",
      "--version",
      version,
      "--install-location",
      "/",
      pkgPath,
    ],
    { stdio: "inherit" },
  );
  rmSync(payloadRoot, { recursive: true, force: true });
  rmSync(scriptsDir, { recursive: true, force: true });
  console.log(`Created ${pkgPath}`);
}

function buildLinuxDeb() {
  const debRoot = join(outDir, "deb-root");
  const appDir = join(debRoot, "usr", "lib", "cursor-openai-proxy");
  const binDir = join(debRoot, "usr", "bin");
  const debianDir = join(debRoot, "DEBIAN");
  mkdirSync(appDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(debianDir, { recursive: true });

  for (const entry of readdirSync(stageDir)) {
    cpSync(join(stageDir, entry), join(appDir, entry), { recursive: true });
  }
  chmodSync(join(appDir, "start.sh"), 0o755);

  const launcher = `#!/usr/bin/env bash
set -euo pipefail
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22.13+ is required. Install from https://nodejs.org/" >&2
  exit 1
fi
exec /usr/lib/cursor-openai-proxy/start.sh "$@"
`;
  writeFileSync(join(binDir, "cursor-openai-proxy"), launcher, {
    encoding: "utf8",
    mode: 0o755,
  });

  const installedSizeKb = Math.max(1, Math.ceil(dirSizeBytes(appDir) / 1024));
  const control = `Package: cursor-openai-proxy
Version: ${version}
Section: utils
Priority: optional
Architecture: ${debArch}
Maintainer: praetore <https://github.com/praetore/cursor-openai-proxy>
Installed-Size: ${installedSizeKb}
Homepage: https://github.com/praetore/cursor-openai-proxy
Description: Local OpenAI-compatible chat API for Cursor SDK
 Runs a local OpenAI-compatible proxy backed by the Cursor TypeScript SDK,
 with a system tray helper. Requires Node.js 22.13+.
`;
  writeFileSync(join(debianDir, "control"), control, "utf8");

  writeFileSync(
    join(debianDir, "postinst"),
    `#!/bin/sh
set -e
chmod +x /usr/lib/cursor-openai-proxy/start.sh || true
chmod +x /usr/bin/cursor-openai-proxy || true
if ! command -v node >/dev/null 2>&1; then
  echo "Warning: Node.js 22.13+ was not found on PATH. Install from https://nodejs.org/" >&2
fi
exit 0
`,
    { encoding: "utf8", mode: 0o755 },
  );

  const debPath = join(outDir, `cursor-openai-proxy_${version}_${debArch}.deb`);
  console.log("Building Linux .deb…");
  execFileSync("dpkg-deb", ["--build", "--root-owner-group", debRoot, debPath], {
    stdio: "inherit",
  });
  rmSync(debRoot, { recursive: true, force: true });
  console.log(`Created ${debPath}`);
}

function dirSizeBytes(dir) {
  let total = 0;
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) total += dirSizeBytes(p);
    else {
      try {
        total += statSync(p).size;
      } catch {
        /* ignore unreadable */
      }
    }
  }
  return total;
}

function windowsStartCmd() {
  return `@echo off
cd /d "%~dp0"
node dist\\index.js
`;
}

function windowsStartBgVbs() {
  return `' Hidden launcher for Cursor OpenAI Proxy
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "node dist\\index.js", 0, False
`;
}

function windowsWriteStartAtLoginPs1() {
  return `#Requires -Version 5.1
param(
  [Parameter(Mandatory = $true)]
  [bool] $Enabled
)
$ErrorActionPreference = "Stop"
$dir = Join-Path $env:APPDATA "cursor-openai-proxy"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$path = Join-Path $dir "config.json"
$cfg = [ordered]@{
  host = "127.0.0.1"
  port = 4646
  agentBin = "agent"
  startAtLogin = [bool]$Enabled
}
if (Test-Path -LiteralPath $path) {
  try {
    $existing = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    if ($null -ne $existing.host) { $cfg.host = [string]$existing.host }
    if ($null -ne $existing.port) { $cfg.port = [int]$existing.port }
    if ($null -ne $existing.agentBin) { $cfg.agentBin = [string]$existing.agentBin }
  } catch { }
}
($cfg | ConvertTo-Json) | Set-Content -LiteralPath $path -Encoding utf8
`;
}

function unixStartSh() {
  return `#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
exec node dist/index.js "$@"
`;
}
