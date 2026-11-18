; Coherence installer (installer report §4; brief Stage 5). Built by packaging/build-installer.mjs, which defines
; AppVersion, StageDir, OutputDir, IconFile and Signed. Per-user by default (no elevation, %LOCALAPPDATA%\Programs);
; IT can install for all users with /ALLUSERS. Setup never touches a user's profile, projects, settings or saved keys,
; except when the user explicitly asks the interactive uninstaller to remove settings and saved keys (decision D10).

#ifndef AppVersion
  #error Build with packaging/build-installer.mjs
#endif

; Never change: upgrades and uninstall find earlier installs by this id.
#define AppGuid "618DBBDC-AAC3-4AAF-A721-8B86390289F5"
#define UninstallKey "Software\Microsoft\Windows\CurrentVersion\Uninstall\{" + AppGuid + "}_is1"

[Setup]
AppId={{{#AppGuid}}
AppName=Coherence
AppVersion={#AppVersion}
AppVerName=Coherence {#AppVersion}
AppPublisher=Deon Fouche
VersionInfoVersion={#AppVersion}
VersionInfoProductName=Coherence
VersionInfoDescription=Coherence Setup
DefaultDirName={autopf}\Coherence
DisableDirPage=yes
DisableProgramGroupPage=yes
UsePreviousAppDir=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=commandline
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; Windows 11 x64 for v1 (decision D21).
MinVersion=10.0.22000
; The launcher refuses to start while Setup runs. Setup quits a running launcher itself (see PrepareToInstall), so
; AppMutex is not used: it would refuse an upgrade before the graceful quit could happen.
SetupMutex=CoherenceSetupRunning,Global\CoherenceSetupRunning
CloseApplications=yes
RestartApplications=no
AllowNetworkDrive=no
AllowUNCPath=no
ChangesAssociations=no
ChangesEnvironment=no
OutputDir={#OutputDir}
#if Signed == "1"
OutputBaseFilename=Coherence-{#AppVersion}-Setup
SignTool=coherence $f
SignedUninstaller=yes
#else
OutputBaseFilename=Coherence-{#AppVersion}-Setup
#endif
SetupIconFile={#IconFile}
UninstallDisplayIcon={app}\Coherence.exe
UninstallDisplayName=Coherence
WizardStyle=modern
Compression=lzma2/max
SolidCompression=yes
SetupLogging=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[InstallDelete]
; Upgrades and repairs start from a clean program folder: no stale modules or assets survive. There is no app\ folder.
Type: filesandordirs; Name: "{app}\runtime"
Type: filesandordirs; Name: "{app}\server"
Type: filesandordirs; Name: "{app}\dist"
Type: filesandordirs; Name: "{app}\node_modules"
Type: filesandordirs; Name: "{app}\samples"
Type: filesandordirs; Name: "{app}\licenses"

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\Coherence"; Filename: "{app}\Coherence.exe"; Check: WantShortcuts
Name: "{autodesktop}\Coherence"; Filename: "{app}\Coherence.exe"; Tasks: desktopicon; Check: WantShortcuts

[Run]
; runasoriginaluser: an elevated all-users Setup never starts Coherence elevated. --after-setup: Setup is still
; running (its SetupMutex exists) when this starts, so Coherence waits for it to exit instead of refusing.
Filename: "{app}\Coherence.exe"; Parameters: "--after-setup"; Description: "{cm:LaunchProgram,Coherence}"; Flags: nowait postinstall skipifsilent runasoriginaluser

[UninstallDelete]
; The launcher's own logs (outside the profile). Never the profile, projects, settings or saved keys.
Type: filesandordirs; Name: "{localappdata}\CoherenceLauncher"; Check: not IsAdminInstallMode

[Code]
const
  QuitCancelled = 23;

var
  RelaunchAfterInstall: Boolean;
  RemoveSettings: Boolean;

{ /NOSHORTCUTS=1 installs without Start menu or desktop shortcuts (IT images and automated checks). }
function WantShortcuts: Boolean;
begin
  Result := ExpandConstant('{param:noshortcuts|0}') <> '1';
end;

procedure Refuse(const Message: String);
begin
  Log('Refused: ' + Message);
  SuppressibleMsgBox(Message, mbError, MB_OK, IDOK);
end;

{ Dotted numeric versions: 1 if A is newer than B, -1 if older, 0 if equal. }
function CompareVersions(A, B: String): Integer;
var
  PartA, PartB, Dot: Integer;
begin
  Result := 0;
  while (Result = 0) and ((A <> '') or (B <> '')) do
  begin
    Dot := Pos('.', A);
    if Dot = 0 then Dot := Length(A) + 1;
    PartA := StrToIntDef(Copy(A, 1, Dot - 1), 0);
    Delete(A, 1, Dot);
    Dot := Pos('.', B);
    if Dot = 0 then Dot := Length(B) + 1;
    PartB := StrToIntDef(Copy(B, 1, Dot - 1), 0);
    Delete(B, 1, Dot);
    if PartA > PartB then Result := 1
    else if PartA < PartB then Result := -1;
  end;
end;

function IsInside(Dir, Parent: String): Boolean;
begin
  Result := (Parent <> '') and (Pos(Lowercase(AddBackslash(Parent)), Lowercase(AddBackslash(Dir))) = 1);
end;

{ Any process (any user, as far as this account can see) running from the program folder, except Inno's own
  uninstaller, whose first phase keeps running from there while the second phase works. }
function ProcessesInFolder(const Dir: String): Integer;
var
  Locator, Service, Items, Item: Variant;
  I: Integer;
  Path: String;
begin
  Result := 0;
  try
    Locator := CreateOleObject('WbemScripting.SWbemLocator');
    Service := Locator.ConnectServer('.', 'root\CIMV2');
    Items := Service.ExecQuery('SELECT ProcessId, ExecutablePath FROM Win32_Process');
    for I := 0 to Items.Count - 1 do
    begin
      Item := Items.ItemIndex(I);
      if not VarIsNull(Item.ExecutablePath) then
      begin
        Path := Item.ExecutablePath;
        if IsInside(Path, Dir) and not WildcardMatch(Lowercase(ExtractFileName(Path)), 'unins*.exe') then
        begin
          Log('Running from the program folder: ' + Path);
          Result := Result + 1;
        end;
      end;
    end;
  except
    Log('Could not list running processes: ' + GetExceptionMessage);
  end;
end;

{ Asks this user's running launcher to quit gracefully; it warns about running AI tasks itself. }
function QuitLauncher(const Dir: String; AsOriginalUser: Boolean; var Error: String): Boolean;
var
  Code: Integer;
  Started: Boolean;
begin
  Result := True;
  if not CheckForMutexes('CoherenceLauncherRunning') or not FileExists(Dir + '\Coherence.exe') then Exit;
  if AsOriginalUser then
    Started := ExecAsOriginalUser(Dir + '\Coherence.exe', '--quit --wait', Dir, SW_HIDE, ewWaitUntilTerminated, Code)
  else
    Started := Exec(Dir + '\Coherence.exe', '--quit --wait', Dir, SW_HIDE, ewWaitUntilTerminated, Code);
  Log(Format('Coherence.exe --quit --wait: started %d, exit code %d', [Ord(Started), Code]));
  if Started and (Code = QuitCancelled) then
  begin
    Error := 'Coherence is still running AI tasks and was kept open. Let them finish or stop them, quit Coherence, then run this again.';
    Result := False;
  end
  else if not Started or (Code <> 0) then
  begin
    Error := 'Coherence is running but did not quit. Quit it from its tray icon, then run this again.';
    Result := False;
  end;
end;

function StillRunningMessage: String;
begin
  Result := 'Coherence is still running, possibly for another user of this computer. Close every copy of Coherence, then run this again.';
end;

{ Installing into data, Documents, OneDrive or a network location would break the storage boundaries. }
function UnsafeInstallDir(const Dir: String): String;
begin
  Result := '';
  if Copy(Dir, 1, 2) = '\\' then
    Result := 'a network location'
  else if IsInside(Dir, ExpandConstant('{localappdata}\Coherence')) or IsInside(Dir, ExpandConstant('{localappdata}\Coherence-Dev')) then
    Result := 'the Coherence data folder'
  else if IsInside(Dir, ExpandConstant('{userdocs}')) then
    Result := 'the Documents folder'
  else if IsInside(Dir, GetEnv('OneDrive')) or IsInside(Dir, GetEnv('OneDriveCommercial')) or IsInside(Dir, GetEnv('OneDriveConsumer')) then
    Result := 'a OneDrive folder';
end;

function InitializeSetup: Boolean;
var
  Installed: String;
begin
  Result := True;
  { A per-user and an all-users install of one version line would share each user's profile: refuse the mix. }
  if IsAdminInstallMode and RegKeyExists(HKCU, '{#UninstallKey}') then
  begin
    Refuse('Coherence is already installed for your account only. Uninstall that copy (Settings > Apps) before installing it for all users.');
    Result := False;
    Exit;
  end;
  if not IsAdminInstallMode and RegKeyExists(HKLM64, '{#UninstallKey}') then
  begin
    Refuse('Coherence is already installed for all users of this computer. Use that copy, or ask your IT team to update it.');
    Result := False;
    Exit;
  end;
  { Downgrades need a deliberate yes (decision D11); data saved by the newer version stays readable only by it. }
  if RegQueryStringValue(HKA, '{#UninstallKey}', 'DisplayVersion', Installed) and
     (CompareVersions(Installed, '{#AppVersion}') > 0) and
     (ExpandConstant('{param:allowdowngrade|0}') <> '1') then
  begin
    if WizardSilent or (MsgBox('Coherence ' + Installed + ' is installed, which is newer than this Setup ({#AppVersion}).' + #13#13 +
      'The older version cannot open data saved by the newer one, and it will say so instead of changing it. Install the older version anyway?',
      mbConfirmation, MB_YESNO or MB_DEFBUTTON2) <> IDYES) then
    begin
      Log('Refused: downgrade from ' + Installed + ' without confirmation (use /ALLOWDOWNGRADE=1 when silent)');
      Result := False;
    end;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Dir, Reason: String;
begin
  Result := '';
  Dir := ExpandConstant('{app}');
  Reason := UnsafeInstallDir(Dir);
  if Reason <> '' then
  begin
    Result := 'Coherence cannot be installed in ' + Reason + '. Choose a program folder instead.';
    Exit;
  end;
  RelaunchAfterInstall := CheckForMutexes('CoherenceLauncherRunning');
  if not QuitLauncher(Dir, True, Result) then Exit;
  { Copies that the graceful quit cannot reach (other users, leftovers) are never force-closed: data could be lost. }
  if ProcessesInFolder(Dir) > 0 then
    Result := StillRunningMessage;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Code: Integer;
begin
  { A silent upgrade restarts Coherence if it was running; interactive Setup offers it on the last page. }
  if (CurStep = ssDone) and RelaunchAfterInstall and WizardSilent then
    ExecAsOriginalUser(ExpandConstant('{app}\Coherence.exe'), '--after-setup', ExpandConstant('{app}'), SW_SHOWNORMAL, ewNoWait, Code);
end;

function ProfileDir: String;
begin
  Result := ExpandConstant('{localappdata}\Coherence');
end;

{ Only a folder Coherence itself owns, and not a link to somewhere else, may be removed. }
function IsCoherenceProfile(const Dir: String): Boolean;
var
  Find: TFindRec;
  Owner: AnsiString;
begin
  Result := False;
  if FindFirst(RemoveBackslash(Dir), Find) then
  try
    if (Find.Attributes and FILE_ATTRIBUTE_DIRECTORY = 0) or (Find.Attributes and FILE_ATTRIBUTE_REPARSE_POINT <> 0) then Exit;
  finally
    FindClose(Find);
  end
  else
    Exit;
  Result := LoadStringFromFile(Dir + '\.coherence-global.json', Owner) and (Pos('"screenscribe-v2-global"', String(Owner)) > 0);
end;

function InitializeUninstall: Boolean;
var
  Error: String;
begin
  Result := QuitLauncher(ExpandConstant('{app}'), False, Error);
  if Result and (ProcessesInFolder(ExpandConstant('{app}')) > 0) then
  begin
    Error := StillRunningMessage;
    Result := False;
  end;
  if not Result then
  begin
    Log('Uninstall refused: ' + Error);
    if not UninstallSilent then MsgBox(Error, mbError, MB_OK);
    Exit;
  end;
  { Decision D10: offered, unchecked, interactive per-user uninstall only, and only the profile (never projects). }
  if not UninstallSilent and not IsAdminInstallMode and IsCoherenceProfile(ProfileDir) then
    RemoveSettings := MsgBox('Also remove your Coherence settings and saved AI keys from this computer?' + #13#13 +
      'Your projects are not removed: they stay in their project folders (by default Documents\Coherence\Projects).' + #13 +
      'Choose No to keep your settings for a later reinstall.', mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep <> usPostUninstall then Exit;
  if RemoveSettings and IsCoherenceProfile(ProfileDir) then
  begin
    Log('Removing the settings and saved keys in ' + ProfileDir);
    DelTree(ProfileDir, True, True, True);
    RegDeleteKeyIncludingSubkeys(HKCU, 'Software\Coherence');
  end;
  if not UninstallSilent then
  begin
    if RemoveSettings then
      MsgBox('Coherence has been removed, with its settings and saved keys. Your projects are still in their folders.', mbInformation, MB_OK)
    else
      MsgBox('Coherence has been removed. Your projects are still in their folders, and your settings and saved keys are in ' +
        ProfileDir + ' for a later reinstall.', mbInformation, MB_OK);
  end;
end;
