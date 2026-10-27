; Inno Setup 6+ — compiled by scripts/make-installer.mjs
; Defines passed on the command line:
;   MyAppVersion, StageDir, OutputDir, Arch

#ifndef MyAppVersion
  #define MyAppVersion "0.0.0"
#endif
#ifndef StageDir
  #define StageDir "..\..\release\stage"
#endif
#ifndef OutputDir
  #define OutputDir "..\..\release"
#endif
#ifndef Arch
  #define Arch "x64"
#endif

#define MyAppName "Cursor OpenAI Proxy"
#define MyAppPublisher "cursor-openai-proxy"
#define MyAppURL "https://github.com/praetore/cursor-openai-proxy"
#define MyAppLauncher "start-bg.vbs"
#define MyAppConsole "start.cmd"

[Setup]
AppId={{A7C3E9F2-4B1D-4E8A-9C2F-1D5E6A7B8C9D}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
DefaultDirName={localappdata}\cursor-openai-proxy
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
LicenseFile={#StageDir}\LICENSE
OutputDir={#OutputDir}
OutputBaseFilename=cursor-openai-proxy-Setup-{#MyAppVersion}-{#Arch}
SetupIconFile={#StageDir}\assets\tray.ico
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\assets\tray.ico
UninstallDisplayName={#MyAppName}
VersionInfoVersion={#MyAppVersion}.0
CloseApplications=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "autostart"; Description: "Run at startup"; GroupDescription: "Additional options:"

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{userprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppLauncher}"; \
  WorkingDir: "{app}"; IconFilename: "{app}\assets\tray.ico"; Comment: "Start Cursor OpenAI Proxy"
Name: "{userprograms}\{#MyAppName} (Console)"; Filename: "{app}\{#MyAppConsole}"; \
  WorkingDir: "{app}"; IconFilename: "{app}\assets\tray.ico"; Comment: "Start with console window"
Name: "{userstartup}\{#MyAppName}"; Filename: "{app}\{#MyAppLauncher}"; \
  WorkingDir: "{app}"; IconFilename: "{app}\assets\tray.ico"; Comment: "Run at startup"; \
  Tasks: autostart

[Run]
; No Description → runs automatically after Finish (no checkbox).
Filename: "{app}\{#MyAppLauncher}"; \
  WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent shellexec

[UninstallDelete]
Type: filesandordirs; Name: "{app}"
Type: files; Name: "{userstartup}\{#MyAppName}.lnk"

[Code]
function NodeOnPath: Boolean;
var
  ResultCode: Integer;
begin
  Result := False;
  if Exec(ExpandConstant('{cmd}'), '/C where node >nul 2>&1', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    Result := ResultCode = 0;
end;

function InitializeSetup(): Boolean;
begin
  Result := True;
  if not NodeOnPath then
  begin
    MsgBox(
      'Node.js 22.13 or newer is required but was not found on PATH.'#13#10#13#10 +
      'Install it from https://nodejs.org/ and run this setup again.',
      mbError, MB_OK);
    Result := False;
  end;
end;

procedure WriteStartAtLoginConfig(Enabled: Boolean);
var
  Flag: string;
  ResultCode: Integer;
begin
  if Enabled then Flag := '$true' else Flag := '$false';
  Exec(
    ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\write-start-at-login.ps1') + '" -Enabled ' + Flag,
    ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    WriteStartAtLoginConfig(WizardIsTaskSelected('autostart'));
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  ResultCode: Integer;
begin
  if CurUninstallStep = usUninstall then
  begin
    Exec(
      ExpandConstant('{cmd}'),
      '/C powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name = ''node.exe''\" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like ''*cursor-openai-proxy*'' -or $_.CommandLine -like ''*dist\\index.js*'' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end;
end;
