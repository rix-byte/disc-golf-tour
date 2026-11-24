# Copy the game into its own git repo (next to calude) and push it; GitHub Pages
# then rebuilds the live site. Usage: .\tools\publish.ps1 -Message "what changed"
param([string] $Message = "update")
$ErrorActionPreference = "Stop"
$src = Split-Path $PSScriptRoot -Parent
$dst = "C:\Users\rihar\Desktop\disc-golf-tour"
# Mirror everything except build output, local screenshots, source art and the repo's own .git.
robocopy $src $dst /MIR /NFL /NDL /NJH /NJS /XD node_modules dist shots art-src .git /XF *.bak | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)" }
Push-Location $dst
try {
  git add -A
  git diff --cached --quiet
  if ($LASTEXITCODE -ne 0) { git commit -m $Message; git push }
  else { "nothing changed" }
} finally { Pop-Location }
