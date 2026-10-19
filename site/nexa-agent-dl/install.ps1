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
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Repo = if ($env:NEXA_AGENT_REPO) { $env:NEXA_AGENT_REPO } else { 'fabbisoftware/nexa-agent-releases' }
$DlBase = if ($env:NEXA_AGENT_DL_BASE) { $env:NEXA_AGENT_DL_BASE } else { "https://github.com/$Repo/releases" }
$Root = if ($env:NEXA_AGENT_HOME) { $env:NEXA_AGENT_HOME } else { [IO.Path]::Combine($env:LOCALAPPDATA, 'nexa-agent') }
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

# Downloads, hashing and unzip go through .NET, not Invoke-WebRequest/Get-FileHash/Expand-Archive:
# Windows PowerShell started from PowerShell 7 inherits a PSModulePath that hides the
# script-module cmdlets (Get-FileHash "is not recognized"), and .NET behaves the same everywhere.
function Fetch($url, $file) {
  $wc = [Net.WebClient]::new()
  if ([Net.WebRequest]::DefaultWebProxy) { [Net.WebRequest]::DefaultWebProxy.Credentials = [Net.CredentialCache]::DefaultNetworkCredentials }
  try { $wc.DownloadFile($url, $file) } finally { $wc.Dispose() }
}
function Sha256($file) {
  $sha = [Security.Cryptography.SHA256]::Create()
  $fs = [IO.File]::OpenRead($file)
  try { return ([BitConverter]::ToString($sha.ComputeHash($fs)) -replace '-', '').ToLower() } finally { $fs.Dispose(); $sha.Dispose() }
}
try { [void][IO.Compression.ZipFile] } catch { [void][Reflection.Assembly]::LoadWithPartialName('System.IO.Compression.FileSystem') }

$Tmp = [IO.Path]::Combine([IO.Path]::GetTempPath(), 'nexa-agent-' + [guid]::NewGuid())
[void][IO.Directory]::CreateDirectory($Tmp)
$staged = $null
try {
  $sums = [IO.Path]::Combine($Tmp, 'SHA256SUMS')
  try { Fetch "$RelUrl/SHA256SUMS" $sums }
  catch { Die "no release found at $RelUrl (check the version, or your network/proxy)." }

  $want = $null
  foreach ($line in [IO.File]::ReadAllLines($sums)) {
    $parts = $line.Trim() -split '\s+', 2
    if ($parts.Count -eq 2 -and $parts[1].TrimStart('*').Trim() -eq $Asset) { $want = $parts[0].ToLower() }
  }
  if (-not $want) { Die "release $Label has no build for windows-$Arch. On another platform, install the NEXA CLI with npm (Node 22.19+): https://downloads.agilekit.cc/nexa-dl/" }

  $zip = [IO.Path]::Combine($Tmp, $Asset)
  try { Fetch "$RelUrl/$Asset" $zip }
  catch { Die "download failed: $RelUrl/$Asset" }
  $got = Sha256 $zip
  if ($got -ne $want) { Die "checksum mismatch for $Asset (expected $want, got $got). Download again; if it repeats, report it." }
  Ok "sha256 verified ($Asset)"

  # Unzip straight into the install root (same volume as the final folder, so the
  # rename below works; TEMP is often on another drive).
  $versions = [IO.Path]::Combine($Root, 'versions')
  $bin = [IO.Path]::Combine($Root, 'bin')
  [void][IO.Directory]::CreateDirectory($versions)
  [void][IO.Directory]::CreateDirectory($bin)
  $staged = [IO.Path]::Combine($versions, '.new-' + [guid]::NewGuid())
  [IO.Compression.ZipFile]::ExtractToDirectory($zip, $staged)
  # The archive holds one top-level folder with agent.json, bin\ and runtime\node.exe.
  $infoPath = [IO.Directory]::GetFiles($staged, 'agent.json', [IO.SearchOption]::AllDirectories) | Select-Object -First 1
  if (-not $infoPath) { Die "$Asset has no agent.json; it is not a NEXA Agent archive." }
  $info = [IO.File]::ReadAllText($infoPath) | ConvertFrom-Json
  $agentDir = [IO.Path]::GetDirectoryName($infoPath)
  foreach ($need in @($info.runtime, $info.entry)) {
    if (-not $need -or -not [IO.File]::Exists([IO.Path]::Combine($agentDir, $need))) { Die "$Asset is incomplete: $need is missing." }
  }
  if (-not $Version) { $Version = $info.version }
  $rel = $agentDir.Substring($staged.Length).TrimStart('\', '/')

  # --- install: versions\<v>, one bin\<name>.cmd shim per command ---------------
  $dest = [IO.Path]::Combine($versions, $Version)
  if ([IO.Directory]::Exists($dest)) { [IO.Directory]::Delete($dest, $true) }
  [IO.Directory]::Move($staged, $dest)
  $staged = $null
  $node = "%~dp0..\versions\$Version\$rel\" + ($info.runtime -replace '/', '\')
  $entry = "%~dp0..\versions\$Version\$rel\" + ($info.entry -replace '/', '\')
  foreach ($name in @('nexa-agent', 'nexa')) {
    $shim = "@echo off`r`n`"$node`" `"$entry`" %*`r`n"
    [IO.File]::WriteAllText([IO.Path]::Combine($bin, "$name.cmd"), $shim, [Text.Encoding]::ASCII)
  }
  Ok "installed $Version into $dest (commands: nexa-agent, nexa)"

  # keep the newest $KeepVersions versions for rollback
  $dirs = [IO.DirectoryInfo]::new($versions).GetDirectories() | Where-Object { -not $_.Name.StartsWith('.') }
  $dirs = @($dirs | Sort-Object LastWriteTimeUtc -Descending)
  for ($i = $KeepVersions; $i -lt $dirs.Count; $i++) {
    if ($dirs[$i].Name -ne $Version) { [IO.Directory]::Delete($dirs[$i].FullName, $true) }
  }

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

  $ver = (& ([IO.Path]::Combine($bin, "$BinName.cmd")) --version 2>$null | Out-String).Trim()
  if ($ver) { Ok "$BinName --version -> $ver" } else { Info "$BinName is installed but --version printed nothing." }
  Info "Uninstall: Remove-Item -Recurse -Force `"$Root`" and remove $bin from your user PATH"
}
finally {
  if ($staged -and [IO.Directory]::Exists($staged)) { [IO.Directory]::Delete($staged, $true) }
  if ([IO.Directory]::Exists($Tmp)) { [IO.Directory]::Delete($Tmp, $true) }
}
