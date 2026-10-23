# DSH 桌面连接器守护脚本：frpc + 连接器（--lan，可带 --relay），每 30 秒检查一次。
# 用法：powershell -ExecutionPolicy Bypass -File tools\relay-supervisor.ps1 [-RelayUrl http://VPS_IP:30500]
param(
  [string]$RelayUrl = '',
  [string]$Repo = (Split-Path -Parent $PSScriptRoot),
  [string]$RelayDir = (Join-Path $env:USERPROFILE '.dsh\remote-desktop\relay'),
  [string]$GuiGatewayPath = ''
)
$ErrorActionPreference = 'SilentlyContinue'
if (-not $RelayUrl) {
  $urlFile = Join-Path $RelayDir 'relay-url.txt'
  if (Test-Path $urlFile) { $RelayUrl = (Get-Content $urlFile -Raw).Trim() }
}
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }
function Ensure-Frpc {
  if (-not (Get-Process frpc -ErrorAction SilentlyContinue)) {
    $exe = Join-Path $RelayDir 'frpc.exe'
    $conf = Join-Path $RelayDir 'frpc.toml'
    if ((Test-Path $exe) -and (Test-Path $conf)) { Start-Process -FilePath $exe -ArgumentList @('-c', $conf) -WindowStyle Hidden }
  }
}
function Ensure-GuiGateway {
  if (-not $GuiGatewayPath) { return }
  $listening = Get-NetTCPConnection -State Listen -LocalPort 64600 -ErrorAction SilentlyContinue
  if ($listening) { return }
  if (Test-Path $GuiGatewayPath) {
    Start-Process -FilePath $node -ArgumentList @($GuiGatewayPath) -WorkingDirectory (Split-Path $GuiGatewayPath) -WindowStyle Hidden
  }
}
function Ensure-Connector {
  $listening = Get-NetTCPConnection -State Listen -LocalPort 3090 -ErrorAction SilentlyContinue
  if ($listening) { return }
  $arguments = @((Join-Path $Repo 'tools\remote.mjs'), '--lan')
  if ($RelayUrl) { $arguments += @('--relay', $RelayUrl) }
  Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $Repo -WindowStyle Hidden -RedirectStandardOutput (Join-Path $RelayDir 'connector.out.log') -RedirectStandardError (Join-Path $RelayDir 'connector.err.log')
}
while ($true) {
  Ensure-Frpc
  Ensure-GuiGateway
  Ensure-Connector
  Start-Sleep -Seconds 30
}
