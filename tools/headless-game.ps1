# Let the game play itself in a headless Edge (NVIDIA GPU) and save screenshots.
# Usage: .\tools\headless-game.ps1 -Prefix play1 [-Holes 2]
# Needs the dev server on http://localhost:5190. Files land in shots\<prefix>_*.png.
param(
  [Parameter(Mandatory)] [string] $Prefix,
  [int] $Holes = 2,
  [string] $Query = "",
  [int] $TimeoutSec = 600
)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$done = Join-Path $root "shots\$($Prefix)_done.png"
Remove-Item $done -ErrorAction SilentlyContinue
$edge = @("C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe", "C:\Program Files\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
$profile = Join-Path $env:TEMP "dg-headless-edge"
# A previous run's Edge may still hold the profile lock: close it first.
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like "*dg-headless-edge*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 800
$url = if ($Query -match "release=") { "http://localhost:5190/?$Query" } else { "http://localhost:5190/?autoplay=$Prefix&holes=$Holes&$Query" }
$log = Join-Path $env:TEMP "dg-headless-game.log"
Start-Process -FilePath $edge -ArgumentList @(
  "--headless=new", "--user-data-dir=$profile", "--no-first-run", "--disable-extensions",
  "--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=d3d11", "--force_high_performance_gpu",
  "--enable-logging=stderr", "--window-size=1600,900", $url) -RedirectStandardError $log | Out-Null
$deadline = (Get-Date).AddSeconds($TimeoutSec)
while (-not (Test-Path $done) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like "*dg-headless-edge*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Select-String -Path $log -Pattern "CONSOLE.*(rror|Uncaught)" | Select-Object -Last 5 | ForEach-Object { $_.Line.Substring(0, [Math]::Min(300, $_.Line.Length)) }
if (Test-Path $done) { Remove-Item $done; "done: shots\$($Prefix)_*.png" } else { throw "timed out waiting for $done" }
