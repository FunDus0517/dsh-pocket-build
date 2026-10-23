# 电脑端一键配置：连接器 + Tailscale serve（推荐）或 cloudflared HTTPS 隧道
#   .\remote.ps1 --tailscale   使用 Tailscale（需同一 tailnet + MagicDNS/HTTPS）
#   .\remote.ps1          启动/更新
#   .\remote.ps1 -Stop    停止连接器与隧道
param([switch]$Stop)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Error '未找到 node，请先安装 Node.js 18+'; exit 1 }
$target = Join-Path $here 'remote.mjs'
if ($Stop) { & $node $target --stop; exit $LASTEXITCODE }
& $node $target @args
exit $LASTEXITCODE