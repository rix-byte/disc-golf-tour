# Measure the game's frame time in a headless Edge.
# Usage: .\tools\perf.ps1 -Name perf_nv [-Gpu nvidia|default] [-Query "q=low"]
param(
  [Parameter(Mandatory)] [string] $Name,
  [ValidateSet("nvidia", "default")] [string] $Gpu = "nvidia",
  [string] $Query = ""
)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$done = Join-Path $root "shots\$($Name)_done.png"
Remove-Item $done -ErrorAction SilentlyContinue
$edge = @("C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe", "C:\Program Files\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
$args = @("--headless=new", "--user-data-dir=$(Join-Path $env:TEMP "dg-headless-edge")", "--no-first-run", "--disable-extensions",
  "--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=d3d11", "--disable-frame-rate-limit", "--disable-gpu-vsync", "--window-size=1600,900")
if ($Gpu -eq "nvidia") { $args += "--force_high_performance_gpu" }
$args += "http://localhost:5190/?perf=$Name&$Query"
Start-Process -FilePath $edge -ArgumentList $args | Out-Null
$deadline = (Get-Date).AddSeconds(180)
while (-not (Test-Path $done) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like "*dg-headless-edge*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
if (Test-Path $done) { Remove-Item $done; Get-Content (Join-Path $root "shots\$Name.png") } else { throw "timed out" }
