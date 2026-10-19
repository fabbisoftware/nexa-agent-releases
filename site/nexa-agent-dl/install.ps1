# NEXA Agent installer for Windows. Install and update are the same run.
#
#   irm https://downloads.agilekit.cc/nexa-agent-dl/install.ps1 | iex
#
# Specific release:
#   & ([scriptblock]::Create((irm https://downloads.agilekit.cc/nexa-agent-dl/install.ps1))) -Version 3.7.1
#
# Environment: NEXA_AGENT_HOME (default %LOCALAPPDATA%\nexa-agent), NEXA_AGENT_REPO, NEXA_AGENT_DL_BASE
param(
  [string]$Version = $env:NEXA_AGENT_VERSION,
  [switch]$NoModifyPath
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is very slow with the progress bar on PS 5
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Repo = if ($env:NEXA_AGENT_REPO) { $env:NEXA_AGENT_REPO } else { 'fabbisoftware/nexa-agent-releases' }
$DlBase = if ($env:NEXA_AGENT_DL_BASE) { $env:NEXA_AGENT_DL_BASE } else { "https://github.com/$Repo/releases" }
$Root = if ($env:NEXA_AGENT_HOME) { $env:NEXA_AGENT_HOME } else { Join-Path $env:LOCALAPPDATA 'nexa-agent' }
$BinName = 'nexa-agent'
$KeepVersions = 3

function Ok($m)   { Write-Host "OK  $m" -ForegroundColor Green }
function Info($m) { Write-Host $m }
function Die($m)  { Write-Host "ERR $m" -ForegroundColor Red; throw $m }

# --- platform ---------------------------------------------------------------
# Windows on ARM runs the x64 build under emulation.
$arch = $env:PROCESSOR_ARCHITEW6432; if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
switch ($arch) {
  'AMD64' { $Arch = 'x64' }
  'ARM64' { $Arch = 'x64' }
  default { Die "unsupported CPU: $arch. NEXA Agent needs 64-bit Windows." }
}
$Asset = "$BinName-windows-$Arch.zip"

# --- resolve the release ----------------------------------------------------
$Version = "$Version".TrimStart('v')
if (-not $Version -and $DlBase -match '^https?://') {
  try {
    # GitHub answers latest/download/<file> with a 302 to download/<tag>/<file>.
    $req = [System.Net.HttpWebRequest]::Create("$DlBase/latest/download/SHA256SUMS")
    $req.Method = 'HEAD'; $req.AllowAutoRedirect = $false
    $resp = $req.GetResponse()
    $loc = $resp.Headers['Location']; $resp.Close()
    if ($loc -match '/download/v?([^/]+)/SHA256SUMS$') { $Version = $Matches[1] }
  } catch { }
}
if ($Version) { $RelUrl = "$DlBase/download/v$Version"; $Label = $Version }
else { $RelUrl = "$DlBase/latest/download"; $Label = 'latest' }
Info "Installing NEXA Agent $Label for windows-$Arch"

$Tmp = Join-Path ([IO.Path]::GetTempPath()) ("nexa-agent-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $Tmp | Out-Null
try {
  $sums = Join-Path $Tmp 'SHA256SUMS'
  try { Invoke-WebRequest -UseBasicParsing -Uri "$RelUrl/SHA256SUMS" -OutFile $sums }
  catch { Die "no release found at $RelUrl (check the version, or your network/proxy)." }

  $want = $null
  foreach ($line in Get-Content $sums) {
    $parts = $line -split '\s+', 2
    if ($parts.Count -eq 2 -and $parts[1].TrimStart('*').Trim() -eq $Asset) { $want = $parts[0].ToLower() }
  }
  if (-not $want) { Die "release $Label has no build for windows-$Arch." }

  $zip = Join-Path $Tmp $Asset
  try { Invoke-WebRequest -UseBasicParsing -Uri "$RelUrl/$Asset" -OutFile $zip }
  catch { Die "download failed: $RelUrl/$Asset" }
  $got = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLower()
  if ($got -ne $want) { Die "checksum mismatch for $Asset (expected $want, got $got). Download again; if it repeats, report it." }
  Ok "sha256 verified ($Asset)"

  $x = Join-Path $Tmp 'x'
  Expand-Archive -Path $zip -DestinationPath $x -Force
  # The archive holds one top-level folder with agent.json, bin\ and runtime\node.exe.
  $infoFile = Get-ChildItem -Path $x -Recurse -File -Filter 'agent.json' | Select-Object -First 1
  if (-not $infoFile) { Die "$Asset has no agent.json; it is not a NEXA Agent archive." }
  $info = Get-Content -Raw $infoFile.FullName | ConvertFrom-Json
  $agentDir = $infoFile.Directory.FullName
  foreach ($need in @($info.runtime, $info.entry)) {
    if (-not $need -or -not (Test-Path (Join-Path $agentDir $need))) { Die "$Asset is incomplete: $need is missing." }
  }
  if (-not $Version) { $Version = $info.version }

  # --- install: versions\<v>, one bin\<name>.cmd shim per command ---------------
  $versions = Join-Path $Root 'versions'
  $bin = Join-Path $Root 'bin'
  New-Item -ItemType Directory -Force -Path $versions, $bin | Out-Null
  $dest = Join-Path $versions $Version
  if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
  Copy-Item -Recurse $x $dest   # Move-Item fails across volumes on PS 5 (TEMP on another drive)
  $rel = $agentDir.Substring($x.Length).TrimStart('\', '/')
  $node = "%~dp0..\versions\$Version\$rel\" + ($info.runtime -replace '/', '\')
  $entry = "%~dp0..\versions\$Version\$rel\" + ($info.entry -replace '/', '\')
  foreach ($name in @('nexa-agent', 'nexa')) {
    $shim = "@echo off`r`n`"$node`" `"$entry`" %*`r`n"
    [IO.File]::WriteAllText((Join-Path $bin "$name.cmd"), $shim, [Text.Encoding]::ASCII)
  }
  Ok "installed $Version into $dest (commands: nexa-agent, nexa)"

  Get-ChildItem $versions -Directory | Sort-Object LastWriteTime -Descending |
    Select-Object -Skip $KeepVersions | Where-Object { $_.Name -ne $Version } |
    ForEach-Object { Remove-Item -Recurse -Force $_.FullName }

  # --- PATH (user scope, no admin) ---------------------------------------------
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not (($userPath -split ';') -contains $bin)) {
    if ($NoModifyPath) { Info "Add to PATH: $bin" }
    else {
      $new = if ($userPath) { "$bin;$userPath" } else { $bin }
      [Environment]::SetEnvironmentVariable('Path', $new, 'User')
      Ok "added $bin to your user PATH (open a new terminal to use it)"
    }
  }
  $env:Path = "$bin;$env:Path"

  $ver = (& (Join-Path $bin "$BinName.cmd") --version 2>$null | Out-String).Trim()
  if ($ver) { Ok "$BinName --version -> $ver" } else { Info "$BinName is installed but --version printed nothing." }
  Info "Uninstall: Remove-Item -Recurse -Force `"$Root`" and remove $bin from your user PATH"
}
finally {
  Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}
