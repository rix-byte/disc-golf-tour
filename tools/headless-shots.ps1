# Take look-test screenshots in a headless Edge (own temporary profile).
# Usage: .\tools\headless-shots.ps1 -Prefix g_ubcm -Query "golfer=ubc-m" -Shots "golfer,tee"
# Needs the dev server on http://localhost:5190. Files land in shots\<prefix>_<shot>.png.
param(
  [Parameter(Mandatory)] [string] $Prefix,
  [string] $Query = "",
  [string] $Shots = "tee,golfer",
  [int] $TimeoutSec = 240
)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$done = Join-Path $root "shots\$($Prefix)_done.png"
Remove-Item $done -ErrorAction SilentlyContinue
$edge = @("C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe", "C:\Program Files\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
$profile = Join-Path $env:TEMP "dg-headless-edge"
$url = "http://localhost:5190/look.html?$Query&autoshot=$($Prefix):$Shots"
$p = Start-Process -FilePath $edge -PassThru -ArgumentList @(
  "--headless=new", "--user-data-dir=$profile", "--no-first-run", "--disable-extensions",
  "--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=d3d11", "--force_high_performance_gpu",
  "--enable-logging=stderr", "--window-size=1600,900", $url) -RedirectStandardError (Join-Path $env:TEMP "dg-headless-edge.log")
$deadline = (Get-Date).AddSeconds($TimeoutSec)
while (-not (Test-Path $done) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like "*dg-headless-edge*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
if (Test-Path $done) { Remove-Item $done; "done: shots\$($Prefix)_*.png" } else { throw "timed out waiting for $done" }
