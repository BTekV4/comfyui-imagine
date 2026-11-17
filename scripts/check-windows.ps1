# Install Imagine's Windows installer and check what a person would meet, on a
# machine that has no Imagine, no Node and no ffmpeg.
#
#   pwsh -File scripts/check-windows.ps1 -Installer release\Imagine-0.2.0-windows-x64-setup.exe
#   pwsh -File scripts/check-windows.ps1 -Installer <this one> -UpgradeTo <the next build>
#
# The counterpart of `scripts/check-appimage.sh`, and the same rule applies: a
# package nobody booted is not a package. What it proves, in order:
#
# 1. the installer runs silently, for the current user: the program lands in
#    %LOCALAPPDATA%\Programs, its "Apps & features" entry and its shortcuts are
#    the user's (HKCU, Desktop, Start menu), and its manifest does not ask
#    Windows for an administrator;
# 2. the installed app opens its window and loads the studio — the app writes
#    what the page drew, a PNG of the window is kept, and `/setup-status`
#    answers that ffmpeg (the package's own, with a PATH that has none) and
#    Node are fine;
# 3. the Windows-specific pieces behave: a bundled workflow edited through the
#    API is copied into %APPDATA%\Imagine\data\workflows (a backslash path
#    under the user's folder) and the copy wins, «Restore default» removes it,
#    and `POST /api/restart` brings back a *new* server while the window stays;
# 4. a second double-click does not start a second studio;
# 5. closing the window stops the server: no Imagine, no server on the port;
# 6. uninstalling silently removes the program, its entry and its shortcuts and
#    leaves %APPDATA%\Imagine (config.yaml, the media, the projects) alone;
# 7. with -UpgradeTo: installing the next build over this one keeps the data
#    and replaces the program (this one is installed, run and marked first,
#    then the next one is installed over it and checked).
#
# Every failure says what it was waiting for, and the app's log tail is printed
# so a CI run that goes red explains itself.

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [string]$UpgradeTo = '',
  [string]$Work = (Join-Path $(if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }) 'imagine-windows-check')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Where the app keeps everything the user made: `app.getPath('userData')` with
# the name the app sets, and the folder the uninstaller must not touch.
$DataRoot = Join-Path $env:APPDATA 'Imagine'
$DesktopLink = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Imagine.lnk'
$StartMenuLink = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Imagine.lnk'
$UninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'

function Say([string]$Message) { Write-Host "check: $Message" }

# The app's log belongs with the other artifacts: a failed run has to explain
# itself from the files it left behind, not only from the console.
function Save-Log {
  $log = Join-Path $DataRoot 'logs\imagine.log'
  if (-not (Test-Path $log)) { return }
  if (Test-Path $Work) { Copy-Item $log (Join-Path $Work 'imagine.log') -Force }
}

function Fail([string]$Message) {
  Write-Host "check: FAILED: $Message" -ForegroundColor Red
  $log = Join-Path $DataRoot 'logs\imagine.log'
  if (Test-Path $log) {
    Write-Host '--- the app log (last 60 lines) ---'
    Get-Content $log -Tail 60 | Write-Host
  }
  Save-Log
  exit 1
}

# Poll a condition instead of sleeping a fixed time: installs and boots are the
# slow parts and they are not the same length on every runner.
function Wait-Until {
  param([string]$What, [int]$Seconds = 60, [scriptblock]$Condition)
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    $value = & $Condition
    if ($value) { return $value }
    Start-Sleep -Milliseconds 500
  }
  Fail "waited ${Seconds}s for $What"
}

function Test-Process([int]$Id) {
  return $null -ne (Get-Process -Id $Id -ErrorAction SilentlyContinue)
}

# A studio whose window is gone must not keep its port: binding it again is the
# check, not a process listing that could have exited between two calls.
function Test-Port-Free([int]$Port) {
  $listener = [System.Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
  try {
    $listener.Start()
  } catch {
    Fail "the studio's port $Port is still taken after its window closed"
  } finally {
    $listener.Stop()
  }
}

# A registry value that may not exist: properties are optional, and reading one
# that is not there is an error under StrictMode.
function Value-Of($Entry, [string]$Name) {
  if ($null -eq $Entry) { return $null }
  $property = $Entry.PSObject.Properties[$Name]
  if ($null -eq $property) { return $null }
  return $property.Value
}

# One row of "Apps & features", looked up the way a person would see it.
function Get-InstallEntry {
  if (-not (Test-Path $UninstallKey)) { return $null }
  return Get-ChildItem $UninstallKey -ErrorAction SilentlyContinue |
    ForEach-Object { Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue } |
    Where-Object { (Value-Of $_ 'DisplayName') -like 'Imagine*' } |
    Select-Object -First 1
}

function Get-InstallDir {
  $entry = Get-InstallEntry
  $location = Value-Of $entry 'InstallLocation'
  if ($location) { return $location }
  return Join-Path $env:LOCALAPPDATA 'Programs\Imagine'
}

# The version the package says it is: the manifest inside `resources\app`, the
# same one `app.getVersion()` reads (`scripts/package-electron.sh` writes it).
function Get-ProgramVersion([string]$Dir) {
  $manifest = Join-Path $Dir 'resources\app\package.json'
  if (-not (Test-Path $manifest)) { Fail "no program manifest at $manifest" }
  return (Get-Content -Raw $manifest | ConvertFrom-Json).version
}

function Install-Silently([string]$File) {
  Say "installing $(Split-Path $File -Leaf) silently (per user)"
  $process = Start-Process -FilePath $File -ArgumentList '/S' -PassThru -Wait
  if ($process.ExitCode -ne 0) { Fail "the installer exited with $($process.ExitCode)" }
}

function Wait-Installed([string]$Dir) {
  $exe = Join-Path $Dir 'Imagine.exe'
  Wait-Until "the installed program ($exe)" 120 { Test-Path $exe } | Out-Null
  return $exe
}

# The app is started the way Explorer starts it — the exe, no arguments — with
# the variables the self-test reads. PATH is cut down to Windows itself: the
# studio ships its own ffmpeg, and a runner's PATH must not be able to hide it.
function Start-Imagine([string]$Exe, [string]$Tag) {
  $script:selftest = Join-Path $Work "selftest-$Tag.json"
  $script:screenshot = Join-Path $Work "window-$Tag.png"
  Remove-Item $script:selftest -Force -ErrorAction SilentlyContinue
  Remove-Item $script:screenshot -Force -ErrorAction SilentlyContinue
  $env:IMAGINE_APP_SELFTEST = $script:selftest
  $env:IMAGINE_APP_SCREENSHOT = $script:screenshot
  # A safety net for CI, not the way this closes the window (see Close-Imagine).
  $env:IMAGINE_APP_SELFTEST_CLOSE_MS = '300000'
  $savedPath = $env:PATH
  $env:PATH = "$env:SystemRoot\System32;$env:SystemRoot"
  try {
    $app = Start-Process -FilePath $Exe -PassThru
  } finally {
    $env:PATH = $savedPath
  }
  Say "started $(Split-Path $Exe -Leaf) (pid $($app.Id)), waiting for the window"
  Wait-Until 'the window to load the studio' 150 { Test-Path $script:selftest } | Out-Null
  return $app
}

# The report is written once, in one call: a reader that catches the file
# mid-write waits instead of failing on half a JSON document.
function Read-Report {
  $deadline = (Get-Date).AddSeconds(20)
  while ($true) {
    try {
      return Get-Content -Raw $script:selftest | ConvertFrom-Json
    } catch {
      if ((Get-Date) -gt $deadline) { throw }
      Start-Sleep -Milliseconds 200
    }
  }
}

function Assert-Window([object]$Report, [string]$ExpectedVersion) {
  if ($Report.studioLoaded -ne $true) { Fail 'the studio did not report itself as loaded' }
  if ($Report.url -notmatch '^http://127\.0\.0\.1:\d+/?$') { Fail "the window is not on the studio: $($Report.url)" }
  if ($Report.title -ne 'Imagine') { Fail "the window title is '$($Report.title)', not Imagine" }
  if (-not ($Report.rootChildren -gt 0)) { Fail 'the page rendered nothing: the studio did not draw' }
  if ($Report.visible -ne $true) { Fail 'the window is not visible' }
  if ($Report.app -ne $ExpectedVersion) { Fail "the app says version $($Report.app), the package is $ExpectedVersion" }
  $nodeMajor = [int]($Report.node.Split('.')[0])
  if ($nodeMajor -lt 24) { Fail "the studio runs on Node $($Report.node) (24 is the minimum)" }
  if (-not (Test-Path $Report.screenshot)) { Fail "no screenshot was written ($($Report.screenshot))" }
  $bytes = [IO.File]::ReadAllBytes($Report.screenshot)
  if ($bytes.Length -lt 10000) { Fail "the screenshot is tiny ($($bytes.Length) bytes): the window is probably blank" }
  if (-not ($bytes[0] -eq 0x89 -and $bytes[1] -eq 0x50 -and $bytes[2] -eq 0x4E -and $bytes[3] -eq 0x47)) {
    Fail 'the screenshot is not a PNG'
  }
  Say "window ok: $($Report.url), $($Report.rootChildren) nodes in #root, Node $($Report.node) on Electron $($Report.electron)"
  Say "screenshot: $($Report.screenshot)"
}

# The package's ffmpeg is the one the studio runs: PATH starts with it, and it
# is inside the installation (not a copy from the runner).
function Assert-PackagedFfmpeg([object]$Report, [string]$Dir) {
  $plugins = Join-Path $Dir 'resources\ffmpeg'
  $exe = Join-Path $plugins 'ffmpeg.exe'
  if (-not (Test-Path $exe)) { Fail "the package has no ffmpeg at $exe" }
  if (-not (Test-Path (Join-Path $plugins 'ffprobe.exe'))) { Fail "the package has no ffprobe in $plugins" }
  $version = (& $exe -version 2>&1 | Select-Object -First 1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $version -notmatch 'ffmpeg version') { Fail "the bundled ffmpeg does not start: $version" }
  if ($Report.pathHead -ne $Report.ffmpegDir) { Fail "the server's PATH does not start with the package's ffmpeg: '$($Report.pathHead)'" }
  if (-not $Report.ffmpegDir.Equals($plugins, [StringComparison]::OrdinalIgnoreCase)) {
    Fail "the studio runs $($Report.ffmpegDir), not the installed ffmpeg ($plugins)"
  }
  Say "$version (from the package, first on PATH)"
}

function Invoke-Studio {
  param([string]$Method = 'GET', [string]$Path, [object]$Body = $null)
  $params = @{
    Method = $Method
    Uri = "http://127.0.0.1:$($script:port)$Path"
    TimeoutSec = 20
  }
  if ($null -ne $Body) {
    $params.ContentType = 'application/json; charset=utf-8'
    $params.Body = [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 10 -Compress))
  }
  return Invoke-RestMethod @params
}

# 3a. The workflows an action runs come from the read-only program; the first
# edit must copy that one file into the user's folder, backslashes and all.
function Assert-WorkflowOverlay([string]$Dir) {
  $list = Invoke-Studio -Path '/comfy-imagine/workflows'
  if (-not ($list.workflows.Count -gt 0)) { Fail 'the studio lists no workflow' }
  $programDir = Join-Path $Dir 'resources\app'
  $chosen = $list.workflows | Where-Object { Test-Path (Join-Path $programDir "workflows\$($_.file)") } | Select-Object -First 1
  if ($null -eq $chosen) { $chosen = $list.workflows[0] }
  $key = $chosen.key
  $detail = Invoke-Studio -Path "/comfy-imagine/workflows/$key"
  if ($detail.overridden -ne $false) { Fail "the fresh installation says $key was already edited" }
  $field = $detail.fields | Where-Object { $_.kind -eq 'number' } | Select-Object -First 1
  if ($null -eq $field) { $field = $detail.fields | Select-Object -First 1 }
  if ($null -eq $field) { Fail "the workflow $key has no editable field" }
  $value = switch ($field.kind) {
    'number' { [double]$field.value + 1 }
    'boolean' { -not [bool]$field.value }
    default { "$($field.value) " }
  }
  Say "editing $key ($($field.field) of node $($field.node)) through the API"
  $applied = Invoke-Studio -Method Post -Path '/comfy-imagine/workflows' -Body @{
    key = $key
    changes = @(@{ node = $field.node; field = $field.field; value = $value })
  }
  if ($applied.ok -ne $true -or -not ($applied.applied -gt 0)) {
    Fail "the studio refused the change: $($applied | ConvertTo-Json -Compress)"
  }
  $after = Invoke-Studio -Path "/comfy-imagine/workflows/$key"
  if ($after.overridden -ne $true) { Fail 'the edit did not make the user copy win' }
  $name = Split-Path $detail.file -Leaf
  $copyRoot = Join-Path $DataRoot 'data\workflows'
  if (-not (Test-Path $copyRoot)) { Fail "the installed app has no workflow copies folder at $copyRoot" }
  $copies = @(Get-ChildItem -Path $copyRoot -Recurse -Filter $name -File -ErrorAction SilentlyContinue)
  if ($copies.Count -eq 0) { Fail "the edit did not copy the graph into $copyRoot" }
  $copy = $copies[0].FullName
  if (-not $copy.StartsWith($DataRoot, [StringComparison]::OrdinalIgnoreCase)) { Fail "the copy is not under %APPDATA%: $copy" }
  $program = @(Get-ChildItem -Path $programDir -Recurse -Filter $name -File -ErrorAction SilentlyContinue)
  if ($program.Count -eq 0) { Fail "the program has no file named $name" }
  if ((Get-FileHash $copy).Hash -eq (Get-FileHash $program[0].FullName).Hash) { Fail 'the copy is identical to the program file: nothing was written' }
  Say "copy-on-write under %APPDATA%: $copy"
  $restored = Invoke-Studio -Method Post -Path "/comfy-imagine/workflows/$key/restore"
  if ($restored.overridden -ne $false) { Fail '«Restore default» left the copy in place' }
  if (Test-Path $copy) { Fail "«Restore default» did not remove $copy" }
  Say 'the user copy is gone, the program graph is in use again'
}

# 3b. The restart button: a new server process, the same window, the page.
function Assert-Restart([object]$Before) {
  $old = [int]$Before.serverPid
  $restarted = Invoke-Studio -Method Post -Path '/api/restart' -Body @{}
  if ($restarted.ok -ne $true) { Fail 'POST /api/restart did not answer ok' }
  Say "restart asked (the old server was pid $old)"
  $report = Wait-Until 'the studio to come back after a restart' 120 {
    try { $candidate = Read-Report } catch { return $null }
    if ([int]$candidate.serverPid -ne $old -and $candidate.studioLoaded -eq $true) { return $candidate }
    return $null
  }
  if (Test-Process $old) { Fail "the old server (pid $old) is still running after the restart" }
  $script:port = [int]$report.port
  if (-not ($report.rootChildren -gt 0)) { Fail 'after the restart the page drew nothing' }
  Say "restarted: server pid $($report.serverPid) on port $($report.port), $($report.rootChildren) nodes in #root"
  return $report
}

# 5. Closing the window is the quit path a person uses; it must take the server
# with it. `CloseMainWindow` posts WM_CLOSE to the window, exactly what the ✕
# does; if Windows does not hand us that window, the message is posted by hand.
function Close-Imagine($App) {
  Say 'closing the window'
  $posted = $false
  for ($i = 0; $i -lt 20 -and -not $posted; $i++) {
    $App.Refresh()
    $posted = $App.CloseMainWindow()
    if (-not $posted) { Start-Sleep -Milliseconds 250 }
  }
  if (-not $posted) {
    Add-Type -Namespace ImagineCheck -Name Window -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
public static extern System.IntPtr FindWindow(string lpClassName, string lpWindowName);
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
public static extern bool PostMessage(System.IntPtr hWnd, uint Msg, System.IntPtr wParam, System.IntPtr lParam);
'@
    $handle = [ImagineCheck.Window]::FindWindow($null, 'Imagine')
    if ($handle -eq [IntPtr]::Zero) { Fail 'could not find the window to close' }
    [void][ImagineCheck.Window]::PostMessage($handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
  }
  if (-not $App.WaitForExit(90000)) { Fail 'the window never closed (the app is still running)' }
  Say "window closed (exit code $($App.ExitCode))"
}

# 6. Silent uninstall. NSIS may run the uninstaller from a copy in %TEMP% and
# return before the files are gone, so the registry entry is what is waited for.
function Uninstall-Silently([string]$Dir) {
  $uninstaller = Join-Path $Dir 'Uninstall Imagine.exe'
  if (-not (Test-Path $uninstaller)) { Fail "the package has no uninstaller at $uninstaller" }
  Say 'uninstalling silently'
  Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait | Out-Null
  Wait-Until 'the uninstall entry to go' 120 { $null -eq (Get-InstallEntry) } | Out-Null
  Wait-Until 'the installed program to be removed' 120 { -not (Test-Path (Join-Path $Dir 'Imagine.exe')) } | Out-Null
  foreach ($link in @($DesktopLink, $StartMenuLink)) {
    if (Test-Path $link) { Fail "the shortcut $link survived the uninstall" }
  }
  Say 'program, entry and shortcuts are gone'
}

function Assert-DataKept([string]$Marker = '') {
  if (-not (Test-Path $DataRoot)) { Fail "the uninstall removed ${DataRoot}: the projects and the media are gone" }
  $config = Join-Path $DataRoot 'config.yaml'
  if (-not (Test-Path $config)) { Fail "the uninstall removed $config" }
  if (-not (Test-Path (Join-Path $DataRoot 'data'))) { Fail "the uninstall removed $(Join-Path $DataRoot 'data')" }
  if ($Marker -ne '') {
    $file = Join-Path $DataRoot 'data\upgrade-marker.txt'
    if (-not (Test-Path $file)) { Fail "the upgrade lost $file" }
    if ((Get-Content -Raw $file).Trim() -ne $Marker) { Fail "the upgrade changed the contents of $file" }
  }
  Say "$DataRoot is still there: config.yaml, data\ and the media are the user's"
}

# The installer is a per-user one, so its manifest must not ask Windows for an
# administrator. Only positive evidence is a failure: the evidence that matters
# is where it installed (LOCALAPPDATA, HKCU) and this says why that is expected.
function Assert-PerUserInstaller([string]$File) {
  $chunk = 1MB
  $overlap = 64
  $stream = [IO.File]::OpenRead($File)
  try {
    $buffer = New-Object byte[] ($chunk + $overlap)
    $carry = 0
    while (($read = $stream.Read($buffer, $carry, $chunk)) -gt 0) {
      $total = $carry + $read
      $text = [Text.Encoding]::ASCII.GetString($buffer, 0, $total)
      if ($text.Contains('requireAdministrator')) {
        Fail 'the installer asks Windows for administrator rights (its manifest says requireAdministrator)'
      }
      $keep = [Math]::Min($overlap, $total)
      [Array]::Copy($buffer, $total - $keep, $buffer, 0, $keep)
      $carry = $keep
    }
  } finally {
    $stream.Dispose()
  }
  Say 'the installer does not ask for an administrator'
}

# --------------------------------------------------------------------- main

if (-not (Test-Path $Installer)) { Fail "no installer at $Installer" }
$Installer = (Resolve-Path $Installer).Path
if ($UpgradeTo -ne '' -and -not (Test-Path $UpgradeTo)) { Fail "no upgrade installer at $UpgradeTo" }

Remove-Item $Work -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $Work | Out-Null
# A runner is fresh, but a re-run of this script must not inherit a studio.
Get-Process Imagine -ErrorAction SilentlyContinue | ForEach-Object { $_.Kill(); $_.WaitForExit(10000) }
Remove-Item $DataRoot -Recurse -Force -ErrorAction SilentlyContinue
if ($null -ne (Get-InstallEntry)) { Fail 'an Imagine entry is already installed: this check needs a clean account' }

Assert-PerUserInstaller $Installer
Install-Silently $Installer
$dir = Get-InstallDir
$exe = Wait-Installed $dir
# The version this check is about: the one the installed program declares, so a
# build that carries a version other than package.json (an upgrade test does)
# is still checked against itself.
$expected = Get-ProgramVersion $dir
Say "installed version $expected in $dir"
if (-not $dir.StartsWith($env:LOCALAPPDATA, [StringComparison]::OrdinalIgnoreCase)) {
  Fail "the program was installed outside %LOCALAPPDATA% ($dir): that is not a per-user installation"
}
$entry = Get-InstallEntry
if ($null -eq $entry) { Fail 'the installer left no entry in "Apps & features" (HKCU uninstall key)' }
if ((Value-Of $entry 'DisplayVersion') -ne $expected) {
  Fail "the uninstall entry says $(Value-Of $entry 'DisplayVersion'), the program is $expected"
}
$uninstallString = Value-Of $entry 'UninstallString'
if ($null -eq $uninstallString -or -not $uninstallString.Contains('Uninstall Imagine.exe')) {
  Fail "the uninstall entry has no working uninstall command: '$uninstallString'"
}
Say "Apps & features: '$(Value-Of $entry 'DisplayName')', $(Value-Of $entry 'DisplayVersion')"
foreach ($link in @($DesktopLink, $StartMenuLink)) {
  if (-not (Test-Path $link)) { Fail "no shortcut at $link" }
  $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($link)
  if ($shortcut.TargetPath -ne $exe) { Fail "the shortcut $link points at '$($shortcut.TargetPath)', not $exe" }
  if ($shortcut.IconLocation -eq '') { Fail "the shortcut $link has no icon" }
}
Say 'shortcuts on the Desktop and in the Start menu, both with the icon'

$app = Start-Imagine $exe 'fresh'
$report = Read-Report
Assert-Window $report $expected
Assert-PackagedFfmpeg $report $dir
$script:port = [int]$report.port
$setup = Invoke-Studio -Path '/setup-status'
if ($setup.ffmpeg.ok -ne $true) { Fail "/setup-status says ffmpeg is missing: $($setup.ffmpeg.problem) $($setup.ffmpeg.detail)" }
if ($setup.node.ok -ne $true) { Fail "/setup-status says Node is too old: $($setup.node.found)" }
Say "first-run card: ffmpeg $($setup.ffmpeg.detail), Node $($setup.node.found)"

Assert-WorkflowOverlay $dir
$report = Assert-Restart $report

# A second double-click hands the window to the first: the second process has
# to exit, soon and cleanly, and must not write a self-test of its own.
Say 'second launch'
$secondTest = Join-Path $Work 'selftest-second.json'
$env:IMAGINE_APP_SELFTEST = $secondTest
$second = Start-Process -FilePath $exe -PassThru
if (-not $second.WaitForExit(60000)) { $second.Kill(); Fail 'the second launch did not exit (two studios, one port?)' }
if ($second.ExitCode -ne 0) { Fail "the second launch exited with $($second.ExitCode)" }
if (Test-Path $secondTest) { Fail 'a second launch started a second studio' }
if (-not (Test-Process ([int]$report.appPid))) { Fail 'the second launch closed the first window' }
Say 'second launch kept the first window'
$env:IMAGINE_APP_SELFTEST = $script:selftest

# 5a. A window killed from outside (a crash, a logout, Task Manager) is not a
# quit: it runs no handler, so the server has to notice by itself — the parent
# watchdog in `server/src/parent-watch.ts`, whose `process.kill(pid, 0)` is the
# Windows half of it.
$serverPid = [int]$report.serverPid
Say "killing the window (pid $($report.appPid)) the way a crash would"
Stop-Process -Id ([int]$report.appPid) -Force
Wait-Until "the server (pid $serverPid) to notice that its window is gone" 30 {
  -not (Test-Process $serverPid)
} | Out-Null
Test-Port-Free ([int]$report.port)
Say "the studio stopped when its window was killed, port $($report.port) free"

# 5b. Closing the window is the quit path a person uses.
$app = Start-Imagine $exe 'close'
$report = Read-Report
$script:port = [int]$report.port
$serverPid = [int]$report.serverPid
Close-Imagine $app
Wait-Until "the server (pid $serverPid) to stop" 30 { -not (Test-Process $serverPid) } | Out-Null
Test-Port-Free $script:port
Say "window closed, server $serverPid gone, port $($script:port) free"

# 5c. The paths a real Windows user has: a name with a space, a folder with
# accents. The program is started from a copy of itself in such a folder, with
# its data in another one — a path built by hand, an unquoted argument or a
# `PATH` joined with `:` instead of `;` would fail here.
$spacedProgram = Join-Path $Work 'Programmi con spazi àè'
$spacedData = Join-Path $Work 'dati con spazi àè'
Say "copying the program to a path with spaces and accents: $spacedProgram"
Copy-Item $dir $spacedProgram -Recurse -Force
$savedData = $env:IMAGINE_DATA
$env:IMAGINE_DATA = $spacedData
try {
  $copyApp = Start-Imagine (Join-Path $spacedProgram 'Imagine.exe') 'paths'
  $copyReport = Read-Report
  Assert-Window $copyReport $expected
  if (-not $copyReport.data.Equals($spacedData, [StringComparison]::OrdinalIgnoreCase)) {
    Fail "the studio used '$($copyReport.data)' as its data folder, not '$spacedData'"
  }
  if (-not $copyReport.pathHead.Equals($copyReport.ffmpegDir, [StringComparison]::OrdinalIgnoreCase)) {
    Fail "the server's PATH does not start with the package's ffmpeg: '$($copyReport.pathHead)'"
  }
  if (-not $copyReport.ffmpegDir.StartsWith($spacedProgram, [StringComparison]::OrdinalIgnoreCase)) {
    Fail "the studio runs '$($copyReport.ffmpegDir)', not the ffmpeg of the copied program"
  }
  if (-not (Test-Path (Join-Path $spacedData 'logs\imagine.log'))) {
    Fail "no log was written in '$spacedData'"
  }
  Close-Imagine $copyApp
  Wait-Until "the copied program's server (pid $($copyReport.serverPid)) to stop" 30 {
    -not (Test-Process ([int]$copyReport.serverPid))
  } | Out-Null
  Say 'the window and the studio work from a path with spaces and accents'
} finally {
  $env:IMAGINE_DATA = $savedData
  Remove-Item $spacedProgram -Recurse -Force -ErrorAction SilentlyContinue
}

Uninstall-Silently $dir
Assert-DataKept

# 7. The update a real version does: N installed and used, then N+1 over it.
if ($UpgradeTo -ne '') {
  $UpgradeTo = (Resolve-Path $UpgradeTo).Path
  Install-Silently $Installer
  $dir = Get-InstallDir
  $exe = Wait-Installed $dir
  $fromVersion = Get-ProgramVersion $dir
  Say "installed $fromVersion again, to upgrade it"
  $oldApp = Start-Imagine $exe 'previous'
  $oldReport = Read-Report
  Assert-Window $oldReport $fromVersion
  Close-Imagine $oldApp
  Wait-Until "the previous server (pid $($oldReport.serverPid)) to stop" 30 {
    -not (Test-Process ([int]$oldReport.serverPid))
  } | Out-Null
  $marker = "written by Imagine $fromVersion"
  Set-Content -Path (Join-Path $DataRoot 'data\upgrade-marker.txt') -Value $marker -NoNewline
  $configHash = (Get-FileHash (Join-Path $DataRoot 'config.yaml')).Hash
  Install-Silently $UpgradeTo
  $dir = Get-InstallDir
  $exe = Wait-Installed $dir
  $toVersion = Get-ProgramVersion $dir
  if ($toVersion -eq $fromVersion) { Fail "the upgrade check needs two different versions (both say $fromVersion)" }
  Say "installed $toVersion over $fromVersion"
  if ((Get-FileHash (Join-Path $DataRoot 'config.yaml')).Hash -ne $configHash) { Fail 'the upgrade rewrote config.yaml' }
  Assert-DataKept $marker
  $entry = Get-InstallEntry
  if ((Value-Of $entry 'DisplayVersion') -ne $toVersion) {
    Fail "the uninstall entry says $(Value-Of $entry 'DisplayVersion') after the upgrade, not $toVersion"
  }
  foreach ($link in @($DesktopLink, $StartMenuLink)) {
    if (-not (Test-Path $link)) { Fail "the upgrade removed the shortcut $link" }
    if ((New-Object -ComObject WScript.Shell).CreateShortcut($link).TargetPath -ne $exe) {
      Fail "after the upgrade the shortcut $link does not point at the program"
    }
  }
  Say 'the upgrade kept the shortcuts pointing at the program'
  $upgraded = Start-Imagine $exe 'upgraded'
  $upgradedReport = Read-Report
  Assert-Window $upgradedReport $toVersion
  Close-Imagine $upgraded
  Wait-Until "the upgraded server (pid $($upgradedReport.serverPid)) to stop" 30 {
    -not (Test-Process ([int]$upgradedReport.serverPid))
  } | Out-Null
  Say "upgrade $fromVersion -> $toVersion kept the data and replaced the program"
  Uninstall-Silently $dir
  Assert-DataKept $marker
}

Get-Process Imagine -ErrorAction SilentlyContinue | ForEach-Object { $_.Kill() }
Save-Log
Say 'all checks passed'
Say "artifacts in $Work"
