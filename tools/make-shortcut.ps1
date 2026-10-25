# Creates a "Skylog" Desktop shortcut that opens Skylog.html in its own app window (Chrome or Edge).
# Right-click this file > "Run with PowerShell". Pass a path to use a different HTML file.
param([string]$Html = (Join-Path $PSScriptRoot '..\index.html'))

$Html = (Resolve-Path $Html).Path
$browser = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $browser) { throw 'Chrome or Edge is required.' }

$url = 'file:///' + ($Html -replace '\', '/')
$lnk = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Skylog.lnk'))
$lnk.TargetPath = $browser
$lnk.Arguments = "--app=`"$url`" --window-size=1440,960"
$lnk.IconLocation = (Resolve-Path (Join-Path $PSScriptRoot '..\skylog.ico')).Path + ',0'
$lnk.Description = 'Skylog - personal flight log'
$lnk.Save()
Write-Host "Created Skylog shortcut on your Desktop -> $Html"
