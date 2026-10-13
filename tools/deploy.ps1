# Deploy quick-panel to a vault plugin folder. ASCII-only (PowerShell 5.1 reads ANSI).
#   usage: powershell -ExecutionPolicy Bypass -File tools\deploy.ps1 [-Vault E:\Dnotes]
# After copying it verifies: node --check + SHA256 repo-vs-vault for every deployed file.
param([string]$Vault = 'E:\Dnotes')

$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
$dst = Join-Path $Vault '.obsidian\plugins\quick-panel'

$files = @('main.js', 'manifest.json', 'styles.css', 'versions.json')
foreach ($f in $files) {
  $src = Join-Path $repo $f
  if (-not (Test-Path $src)) { Write-Host ('MISSING in repo: ' + $f); exit 1 }
}

New-Item -ItemType Directory -Force -Path $dst | Out-Null
foreach ($f in $files) {
  Copy-Item (Join-Path $repo $f) (Join-Path $dst $f) -Force
}

node --check (Join-Path $dst 'main.js')
if ($LASTEXITCODE -ne 0) { Write-Host 'node --check FAILED - not deployed'; exit 1 }

# prune stale files so the vault matches the repo exactly
Get-ChildItem $dst -File | ForEach-Object {
  if ($files -notcontains $_.Name) { Remove-Item $_.FullName -Force }
}

Write-Host ('deployed to ' + $dst)
$bad = 0
foreach ($f in $files) {
  $h1 = (Get-FileHash (Join-Path $repo $f) -Algorithm SHA256).Hash
  $h2 = (Get-FileHash (Join-Path $dst $f) -Algorithm SHA256).Hash
  $same = ($h1 -eq $h2)
  if (-not $same) { $bad = $bad + 1 }
  Write-Host ('  {0,-16} {1,10:N0} B  hash {2}' -f $f, (Get-Item (Join-Path $dst $f)).Length, $(if ($same) { 'OK' } else { 'MISMATCH' }))
}
if ($bad -gt 0) { Write-Host ('HASH MISMATCH on ' + $bad + ' file(s)'); exit 1 }
Write-Host 'hash check: repo == vault'
