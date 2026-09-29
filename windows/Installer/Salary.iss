#ifndef AppVersion
  #error AppVersion must be supplied by scripts/windows-installer.ps1
#endif
#ifndef SourceDir
  #error SourceDir is required
#endif
#ifndef OutputDir
  #error OutputDir is required
#endif

[Setup]
#ifdef InstallerTestId
AppId=SalaryTrail.Test.{#InstallerTestId}
DefaultDirName={#InstallerTestRoot}\Application
DefaultGroupName=SalaryTrail Installer Test
OutputBaseFilename=salary-installer-test-{#AppVersion}
CloseApplications=no
#else
AppId=FlyLabs.SalaryTrail
DefaultDirName={localappdata}\Programs\SalaryTrail
DefaultGroupName=薪迹
OutputBaseFilename=salary-{#AppVersion}-windows-setup
AppMutex=Local\SalaryTrail.Desktop
CloseApplications=no
#endif
AppName=薪迹
AppVersion={#AppVersion}
AppVerName=薪迹 {#AppVersion}
AppPublisher=FlyLabs
VersionInfoProductName=薪迹
VersionInfoDescription=薪迹安装程序
VersionInfoVersion={#AppVersion}
UninstallDisplayName=薪迹
UninstallDisplayIcon={app}\Salary.exe
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
WizardStyle=modern
DisableWelcomePage=no
DisableDirPage=no
DisableProgramGroupPage=yes
UsePreviousAppDir=yes
SetupIconFile=Salary.ico
OutputDir={#OutputDir}
Compression=lzma2/normal
SolidCompression=yes
RestartApplications=no
SetupLogging=yes

[Languages]
Name: "zh"; MessagesFile: "compiler:Default.isl,Languages\ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "快捷方式："; Flags: unchecked

[Files]
Source: "{#SourceDir}\Salary.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\SalaryCollector.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\Microsoft.Web.WebView2.Core.dll"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\Microsoft.Web.WebView2.WinForms.dll"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\WebView2Loader.dll"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\WebView2-LICENSE.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\使用说明.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\app\*"; DestDir: "{app}\app"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
#ifdef InstallerTestId
Name: "{#InstallerTestRoot}\Shortcuts\Start Menu\薪迹"; Filename: "{app}\Salary.exe"; WorkingDir: "{app}"
Name: "{#InstallerTestRoot}\Shortcuts\Desktop\薪迹"; Filename: "{app}\Salary.exe"; WorkingDir: "{app}"; Tasks: desktopicon
#else
Name: "{group}\薪迹"; Filename: "{app}\Salary.exe"; WorkingDir: "{app}"
Name: "{userdesktop}\薪迹"; Filename: "{app}\Salary.exe"; WorkingDir: "{app}"; Tasks: desktopicon
#endif

#ifndef InstallerTestId
[Run]
Filename: "{app}\Salary.exe"; Description: "打开薪迹"; Flags: nowait postinstall skipifsilent
#endif

[Code]
function WindowsFileAttributes(FileName: String): Cardinal;
  external 'GetFileAttributesW@kernel32.dll stdcall';

function NormalPath(Value: String): String;
begin
  Result := AddBackslash(Lowercase(ExpandFileName(Value)));
end;

function HasLinkedAncestor(Value: String): Boolean;
var
  Current, Parent: String;
  Attributes: Cardinal;
begin
  Result := False;
  Current := RemoveBackslashUnlessRoot(ExpandFileName(Value));
  while Current <> '' do begin
    Attributes := WindowsFileAttributes(Current);
    if (Attributes <> $FFFFFFFF) and ((Attributes and $400) <> 0) then begin
      Result := True;
      Exit;
    end;
    Parent := ExtractFileDir(Current);
    if CompareText(Parent, Current) = 0 then Exit;
    Current := Parent;
  end;
end;

function ValidateInstallDirectory(): String;
var
  Selected, DataRoot, TestRoot: String;
begin
  Result := '';
  { Short DOS aliases and linked directories cannot be checked using a textual prefix. }
  if (Pos('~', WizardDirValue) > 0) or HasLinkedAncestor(WizardDirValue) then begin
    Result := '请选择普通文件夹路径，不要使用目录联接、符号链接或含 ~ 的短路径别名。';
    Exit;
  end;
  Selected := NormalPath(WizardDirValue);
  DataRoot := NormalPath(ExpandConstant('{localappdata}\SalaryTrail'));
  if Selected = NormalPath(ExtractFileDrive(WizardDirValue)) then
    Result := '请选择程序文件夹，不能直接安装到磁盘根目录。';
  { App files and persistent data must never overlap: uninstall only owns app files. }
  if (Pos(DataRoot, Selected) = 1) or (Pos(Selected, DataRoot) = 1) then
    Result := '请选择独立的程序文件夹，不能安装到薪迹数据目录或它的上级目录。';
#ifdef InstallerTestId
  TestRoot := NormalPath('{#InstallerTestRoot}');
  if (Pos(TestRoot, Selected) <> 1) or (Selected = TestRoot) then
    Result := '测试安装仅允许使用指定隔离目录内的程序文件夹。';
#endif
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  ErrorText: String;
begin
  Result := True;
  if CurPageID = wpSelectDir then begin
    ErrorText := ValidateInstallDirectory();
    Result := ErrorText = '';
    if not Result then SuppressibleMsgBox(ErrorText, mbError, MB_OK, IDOK);
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  NetRelease: Cardinal;
begin
  Result := ValidateInstallDirectory();
  if Result <> '' then Exit;
  if not RegQueryDWordValue(HKLM, 'SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full', 'Release', NetRelease) or (NetRelease < 528040) then
    Result := '需要 Microsoft .NET Framework 4.8。请通过 Windows 更新安装后重新运行安装程序。';
end;
