/**
 * 电脑端连接器：把 desktop/gateway.mjs 挂到本地 DSH，让手机远程使用桌面 DSH。
 *
 * 模式（默认 auto）：
 *   node tools/remote.mjs               # auto：局域网 + Cloudflare 隧道，手机自动选可达地址
 *   node tools/remote.mjs --lan         # 只提供局域网地址（不需要公网）
 *   node tools/remote.mjs --cloudflare  # 只提供 Cloudflare 公网 HTTPS 地址
 *   node tools/remote.mjs --check       # 只读检查：打印局域网地址与推荐用法
 *   node tools/remote.mjs --stop        # 停止连接器与隧道
 *   node tools/remote.mjs --rotate      # 轮换配对令牌
 *   node tools/remote.mjs --revoke      # 作废并清空本机配对信息
 *
 * 安全说明（v0.1.25）：
 * - token 只写入本机私有目录（%USERPROFILE%\.dsh\remote-desktop\），不提交仓库、不写进 overlay YAML；
 * - 网关默认只监听回环；--lan/--auto 时监听 0.0.0.0 并使用 DSH_MOBILE_LAN=1（明文 HTTP + Bearer 令牌，仅建议可信网络）；
 * - cloudflared 固定版本 + SHA256 校验；也可用 DSH_CLOUDFLARED_PATH 指向本地已校验的二进制；
 * - 手机端在「运行位置 → 桌面 DSH」里粘贴地址与 token；支持多个候选地址自动选择。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn, execFileSync } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { collectDesktopEndpoints } from './endpoints.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..')
const stateDir = path.join(os.homedir(), '.dsh', 'remote-desktop')
fs.mkdirSync(stateDir, { recursive: true })
const stateFile = path.join(stateDir, 'state.json')
const configFile = path.join(stateDir, 'remote-desktop.json')
const CLOUDFLARED = {
  version: '2026.10.3',
  asset: 'cloudflared-windows-amd64.exe',
  sha256: '76b2805253d0d6ffacb092a7acfbee99e7af6917835c0c5410e23f3ef5052da2'
}
function readState() { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')) } catch { return {} } }
function grantAcl(target) {
  if (process.platform !== 'win32') return
  try { execFileSync('icacls', [target, '/grant:r', os.userInfo().username + ':F'], { stdio: 'ignore' }) } catch {}
}
function writeFilePrivate(target, text) {
  try { fs.writeFileSync(target, text) } catch (error) {
    // 极端情况下旧文件 ACL 可能损坏：先删除再重建（目录授予当前用户完全控制，可删除）。
    fs.rmSync(target, { force: true })
    fs.writeFileSync(target, text)
  }
  try { fs.chmodSync(target, 0o600) } catch {}
  grantAcl(target)
}
function writeState(value) { writeFilePrivate(stateFile, JSON.stringify(value, null, 1)) }
function hardenAcl() {
  if (process.platform !== 'win32') return
  // 只授予当前用户完全控制，不使用 /inheritance:r（会让之后创建的子文件丢失 ACL）。
  grantAcl(stateDir)
  for (const file of [stateFile, configFile]) if (fs.existsSync(file)) grantAcl(file)
}
hardenAcl()

const args = process.argv.slice(2)
const arg = (name, def) => { const index = args.indexOf('--' + name); return index >= 0 ? args[index + 1] : def }
const CONNECTOR_PORT = Number(arg('connector-port', '3090'))
const WEB_PORT = Number(arg('port', '3096'))
const lanMode = args.includes('--lan')
const cloudflareOnly = args.includes('--cloudflare')
const relayUrl = arg('relay', '').trim()
const mode = lanMode ? 'lan' : cloudflareOnly ? 'cloudflare' : 'auto'

function killPid(pid) {
  if (!pid) return
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch { try { process.kill(pid, 'SIGTERM') } catch {} }
}
function freePort(port) {
  try {
    const lines = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/)
    for (const line of lines) {
      const match = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i)
      if (match && Number(match[1]) === port) killPid(Number(match[2]))
    }
  } catch {}
}
function collectLanAddresses() {
  const addresses = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list || []) {
      if (!entry || entry.family !== 'IPv4' || entry.internal) continue
      addresses.push(entry.address)
    }
  }
  return [...new Set(addresses)]
}
function findCli() {
  if (process.env.DSH_CLI_ENTRY && fs.existsSync(process.env.DSH_CLI_ENTRY)) return { cmd: process.execPath, args: [process.env.DSH_CLI_ENTRY] }
  try {
    const candidates = execFileSync('where', ['dsh'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\r?\n/).map(line => line.trim()).filter(Boolean).filter(candidate => fs.existsSync(candidate))
    // Windows 上 where 可能先返回无扩展名的 sh 包装脚本，直接 spawn 会 ENOENT；优先 .cmd/.exe。
    const preferred = candidates.find(candidate => /\.(exe|cmd|bat)$/i.test(candidate))
    if (preferred) return { cmd: preferred, args: [] }
  } catch {}
  const globalShim = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (fs.existsSync(globalShim)) return { cmd: process.execPath, args: [globalShim] }
  const bundled = path.join(repo, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (fs.existsSync(bundled)) return { cmd: process.execPath, args: [bundled] }
  throw new Error('找不到 dsh 命令：请先安装 DSH，或设置 DSH_CLI_ENTRY 指向 dsh 的 lib/bin.js')
}
function cloudflaredBinary() {
  if (process.env.DSH_CLOUDFLARED_PATH) return path.resolve(process.env.DSH_CLOUDFLARED_PATH)
  const binDir = path.join(stateDir, 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  return path.join(binDir, CLOUDFLARED.asset)
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function ensureCloudflared() {
  const binary = cloudflaredBinary()
  if (fs.existsSync(binary)) return binary
  if (process.platform !== 'win32') {
    console.error('当前平台请设置 DSH_CLOUDFLARED_PATH 指向已校验的 cloudflared；Windows 会自动下载固定版本。')
    process.exit(1)
  }
  console.log('下载 cloudflared ' + CLOUDFLARED.version + '…')
  const url = 'https://github.com/cloudflare/cloudflared/releases/download/' + CLOUDFLARED.version + '/' + CLOUDFLARED.asset
  const response = await fetch(url)
  if (!response.ok) { console.error('下载 cloudflared 失败: HTTP ' + response.status); process.exit(1) }
  const bytes = Buffer.from(await response.arrayBuffer())
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== CLOUDFLARED.sha256) {
    console.error('cloudflared SHA256 校验失败：期望 ' + CLOUDFLARED.sha256 + '，实际 ' + digest)
    process.exit(1)
  }
  fs.writeFileSync(binary, bytes)
  return binary
}
async function startCloudflared(port) {
  const binary = await ensureCloudflared()
  const tunnelLog = path.join(stateDir, 'cloudflared.log')
  const out = fs.openSync(tunnelLog, 'w')
  const tunnel = spawn(binary, ['tunnel', '--url', 'http://127.0.0.1:' + port, '--no-autoupdate'], {
    cwd: stateDir, detached: true, windowsHide: true, stdio: ['ignore', out, out]
  })
  tunnel.unref()
  let url = ''
  for (let index = 0; index < 60 && !url; index += 1) {
    await sleep(500)
    try {
      const log = fs.readFileSync(tunnelLog, 'utf8')
      const match = log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i)
      if (match) url = match[0]
    } catch {}
  }
  if (!url) {
    killPid(tunnel.pid)
    console.error('Cloudflare 隧道启动失败，查看日志: ' + tunnelLog)
    process.exit(1)
  }
  return { url, pid: tunnel.pid }
}

if (args.includes('--check')) {
  const lan = collectLanAddresses()
  console.log('本机局域网 IPv4：' + (lan.length ? lan.join(', ') : '无'))
  console.log('默认（auto，推荐）：node tools/remote.mjs         → 局域网 + Cloudflare 双地址')
  console.log('  局域网候选：' + (collectDesktopEndpoints({ lanAddresses: lan, port: CONNECTOR_PORT, mode: 'lan' }).map(item => item.url).join(' , ') || '无'))
  console.log('仅局域网：node tools/remote.mjs --lan             → 不需要公网，手机必须同一网络')
  console.log('仅 Cloudflare：node tools/remote.mjs --cloudflare → 手机有网即可，不需要同一网络')
  console.log('公网中转：node tools/remote.mjs --lan --relay http://<VPS_IP>:<PORT>  （需先运行 frpc）')
  console.log('提示：手机端可把多个地址填进「备用地址」，App 会自动选可达的。')
  process.exit(0)
}

if (args.includes('--revoke')) {
  const state = readState()
  killPid(state.connectorPid); killPid(state.cloudflaredPid)
  try { fs.rmSync(stateFile, { force: true }) } catch {}
  try { fs.rmSync(configFile, { force: true }) } catch {}
  console.log('已清除本机配对信息（token 作废）。下次运行会生成新 token。')
  process.exit(0)
}

if (args.includes('--stop')) {
  const state = readState()
  killPid(state.connectorPid); killPid(state.cloudflaredPid)
  writeState({ token: state.token, mode: state.mode })
  console.log('已停止电脑端连接器与隧道；token 保留在 ' + configFile + '（如需作废请加 --revoke）')
  process.exit(0)
}

// 连接器 token：只存本机私有目录；--rotate 立即轮换。
let state = readState()
if (args.includes('--rotate') || !state.token) {
  state = { ...state, token: randomBytes(24).toString('hex') }
  writeState(state)
  if (args.includes('--rotate')) console.log('配对令牌已轮换：请在手机端重新填写新 token。')
}
const token = state.token
const lanExposed = mode === 'lan' || mode === 'auto'
const bindHost = lanExposed ? '0.0.0.0' : '127.0.0.1'
let relayHost = ''
if (relayUrl) {
  try { relayHost = new URL(relayUrl).hostname } catch { throw new Error('--relay 需要是完整 URL，例如 http://103.85.227.144:30500') }
  if (!/^https?:$/.test(new URL(relayUrl).protocol)) throw new Error('--relay 只支持 http/https URL')
}
const allowedHosts = [mode === 'cloudflare' ? '*.trycloudflare.com' : '', relayHost].filter(Boolean).join(',')
console.log('模式：' + (mode === 'auto' ? 'auto（局域网 + Cloudflare）' : mode === 'lan' ? 'lan（仅局域网）' : 'cloudflare（仅公网隧道）'))
if (lanExposed) console.warn('[提示] --' + mode + ' 会在局域网接口上使用明文 HTTP（Bearer 令牌鉴权，局域网内可被嗅探，请只在可信网络使用）。')

const gatewayEntry = path.join(repo, 'desktop', 'gateway.mjs').replace(/\\/g, '/').replace(/^\//, '')
const overlay = [
  '- insert:',
  '    - id: mobile-gateway',
  '      name: \'file:///' + gatewayEntry + '\'',
  '      config:',
  '        workspace: ' + JSON.stringify(repo),
  '        host: ' + JSON.stringify(bindHost),
  '        port: ' + CONNECTOR_PORT,
  '        allowedOrigins: \'http://127.0.0.1:52019,http://localhost:52019\''
].join('\n') + '\n'
const overlayPath = path.join(stateDir, 'mobile.overlay.yml')
writeFilePrivate(overlayPath, overlay)

const cli = findCli()
const connectorLog = path.join(stateDir, 'connector.log')
const previous = readState()
killPid(previous.connectorPid); killPid(previous.cloudflaredPid)
// 清掉占用端口的遗留进程（连接器被强杀时子进程可能仍监听）。
freePort(CONNECTOR_PORT); freePort(WEB_PORT)
const out = fs.openSync(connectorLog, 'w')
const spawnArgs = [...cli.args, '--profile', 'web', '--patch', overlayPath, '--port', String(WEB_PORT), '--no-open']
const spawnEnv = {
  ...process.env,
  DSH_MOBILE_TOKEN: token,
  DSH_MOBILE_ALLOWED_HOSTS: allowedHosts,
  ...(lanExposed ? { DSH_MOBILE_LAN: '1' } : {}),
  DSH_TELEMETRY_DISABLED: '1'
}
const connector = /[.](cmd|bat)$/i.test(cli.cmd)
  ? spawn('cmd.exe', ['/c', cli.cmd, ...spawnArgs], { cwd: repo, env: spawnEnv, detached: true, windowsHide: true, stdio: ['ignore', out, out] })
  : spawn(cli.cmd, spawnArgs, { cwd: repo, env: spawnEnv, detached: true, windowsHide: true, stdio: ['ignore', out, out] })
connector.on('error', error => { console.error('连接器启动失败：' + (error && error.message ? error.message : error)); process.exit(1) })
connector.unref()
writeState({ ...readState(), token, mode, connectorPid: connector.pid })
console.log('连接器启动中 (pid ' + connector.pid + ', 端口 ' + CONNECTOR_PORT + ')…')

const healthHost = bindHost === '0.0.0.0' ? '127.0.0.1' : bindHost
async function health() {
  try {
    const response = await fetch('http://' + healthHost + ':' + CONNECTOR_PORT + '/bridge/dispatch', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'list', input: {} })
    })
    return response.ok
  } catch { return false }
}
let ready = false
for (let index = 0; index < 60 && !ready; index += 1) { await sleep(1000); ready = await health() }
if (!ready) { console.error('连接器没有就绪，查看日志: ' + connectorLog); process.exit(1) }
console.log('连接器已就绪')

let tunnel = null
if (mode === 'auto' || mode === 'cloudflare') {
  tunnel = await startCloudflared(CONNECTOR_PORT)
  writeState({ ...readState(), cloudflaredPid: tunnel.pid })
}
const endpoints = collectDesktopEndpoints({
  lanAddresses: lanExposed ? collectLanAddresses() : [],
  relayUrl,
  tunnelUrl: tunnel ? tunnel.url : '',
  port: CONNECTOR_PORT,
  mode
})
if (!endpoints.length) {
  console.error('没有可用的连接地址：请检查网络接口。')
  process.exit(1)
}
const endpoint = endpoints[0].url
const config = { endpoint, endpoints, token, mode, updated: new Date().toISOString() }
writeFilePrivate(configFile, JSON.stringify(config, null, 1))
writeState({ ...readState(), endpoint, endpoints, mode })
console.log('手机端地址（App 会按顺序自动选择可达的）：')
endpoints.forEach((item, index) => console.log('  ' + (index + 1) + '. ' + item.url + '  [' + item.label + ']'))
console.log('配置文件（本机私有，勿外传）: ' + configFile)
console.log('在手机 App 的「运行位置 → 桌面 DSH」里填第一个地址，其余填到「备用地址」自动切换。')
if (mode === 'auto') console.log('提示：家里优先走局域网；外出自动切到 Cloudflare（手机有网即可）。')
if (mode === 'lan') console.log('提示：仅局域网模式，出门在外无法连接；需要外网访问请用默认 auto 或 --cloudflare。')
if (mode === 'cloudflare') console.log('提示：公网隧道模式，手机有网即可连接（Bearer 令牌鉴权）。')
console.log('轮换 token: node tools/remote.mjs --rotate；停止: node tools/remote.mjs --stop')
