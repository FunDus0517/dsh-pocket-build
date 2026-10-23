/** Cordis plugin: authenticated mobile access to the running desktop DSH services. */
import http from 'node:http'
import https from 'node:https'
import {readFile,stat,readdir,mkdir,realpath,writeFile} from 'node:fs/promises'
import {resolve,join,dirname,extname,sep} from 'node:path'
import {fileURLToPath} from 'node:url'
import {randomBytes,timingSafeEqual} from 'node:crypto'
import {networkInterfaces} from 'node:os'
import {dispatchOperation} from '../runtime/operations.mjs'

export const name='dsh-mobile-gateway'
export const inject=['sessionController']

const PLUGIN_ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const MIME={'.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.json':'application/json','.webmanifest':'application/manifest+json','.gz':'application/octet-stream','.bin':'application/octet-stream','.wasm':'application/wasm','.map':'application/json','.ico':'image/x-icon'}
const LOOPBACK=new Set(['127.0.0.1','::1','localhost'])
const CSP="default-src 'self' blob: data:; script-src 'self' 'unsafe-inline' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https:; worker-src 'self' blob:; frame-src 'self' blob:; base-uri 'none'; form-action 'none'"
const AUTH_WINDOW_MS=60*1000
const AUTH_MAX_FAILURES=10
const MAX_CONNECTIONS=64

function userError(message){const error=new Error(message);error.expose=true;return error}
function equalToken(a,b){const left=Buffer.from(String(a||'')),right=Buffer.from(String(b||''));return left.length===right.length && timingSafeEqual(left,right)}
function validLeaf(name){return typeof name==='string' && name.length>0 && name.length<200 && !/[\/\\\0-\x1f]/.test(name) && name!=='.' && name!=='..'}
function normalizeHost(value){return String(value||'').toLowerCase().replace(/:\d+$/,'').replace(/^\[|\]$/g,'')}
function hostAllowed(hostname,patterns){
  if(!hostname)return false
  for(const pattern of patterns){
    if(pattern===hostname)return true
    if(pattern.startsWith('*.')){
      const suffix=pattern.slice(1)
      const leaf=hostname.slice(0,-suffix.length)
      if(hostname.endsWith(suffix)&&leaf.length>0&&!leaf.includes('.'))return true
    }
  }
  return false
}
function localAddresses(){return [...new Set(Object.values(networkInterfaces()).flat().filter(x=>x&&x.family==='IPv4'&&!x.internal).map(x=>x.address))]}
function publicErrorMessage(error){
  if(error&&error.expose)return String(error.message)
  const message=error&&typeof error.message==='string'?error.message:''
  if(!message||message.length>200)return ''
  // 路径 / 文件系统 / 堆栈类错误一律脱敏，只保留业务可读文案。
  if(/[\\/]|ENOENT|EACCES|EPERM|EISDIR|realpath|stack/i.test(message))return ''
  return message
}
function errorPayload(error){
  const message=publicErrorMessage(error)
  return message?{error:message,expose:true}:{error:'桌面请求失败（内部错误）',expose:false}
}

export async function makeFileSystem(root){
  await mkdir(root,{recursive:true});const canonical=await realpath(root)
  async function inside(path){const target=await realpath(path);if(target!==canonical && !target.startsWith(canonical+sep))throw userError('文件不在当前工作区');return target}
  return {root:canonical,flush:async()=>({saved:true}),list:async()=>{
    const output=[]
    async function walk(directory,depth){if(depth>5 || output.length>=100)return;for(const entry of await readdir(directory,{withFileTypes:true})){if((entry.name.startsWith('.')&&entry.name!=='.mobile-imports')||['node_modules','dist','build','vendor'].includes(entry.name)||entry.isSymbolicLink())continue;const path=join(directory,entry.name);if(entry.isDirectory())await walk(path,depth+1);else if(entry.isFile() && /\.(md|txt|json|tsx?|jsx?|py|html|css|csv|ya?ml|toml|xml|sh)$/i.test(entry.name)){const safe=await inside(path);const info=await stat(safe);if(info.size<=2*1024*1024)output.push({path,text:await readFile(safe,'utf8')})}if(output.length>=100)break}}
    await walk(canonical,0);return output
  },write:async(name,text)=>{if(!validLeaf(name)||typeof text!=='string'||Buffer.byteLength(text)>2*1024*1024)throw userError('文件无效或超过 2 MB');const directory=join(canonical,'.mobile-imports');await mkdir(directory,{recursive:true});await inside(directory);let path=join(directory,name);try{await writeFile(path,text,{flag:'wx'})}catch(error){if(error.code!=='EEXIST')throw error;path=join(directory,Date.now()+'-'+name);await writeFile(path,text,{flag:'wx'})}return {path}}}
}

/**
 * Desktop gateway.
 *
 * Security defaults (v0.1.20):
 * - binds loopback only unless the operator explicitly opts into LAN access;
 * - refuses non-loopback listeners without TLS unless DSH_MOBILE_LAN=1 is set;
 * - validates the Host header against a whitelist (loopback + local interfaces + configured names);
 * - validates Origin against an allowlist and the whitelist, never by echoing the Host header;
 * - rate-limits repeated authentication failures per client address.
 */
export async function createGateway(context,config={}){
  const token=config.token || process.env.DSH_MOBILE_TOKEN || randomBytes(32).toString('hex')
  const requestedHost=config.host || process.env.DSH_MOBILE_HOST || '127.0.0.1'
  const lanOptIn=config.lan===true || process.env.DSH_MOBILE_LAN==='1'
  const certPath=process.env.DSH_MOBILE_TLS_CERT,keyPath=process.env.DSH_MOBILE_TLS_KEY
  const tls=Boolean(certPath&&keyPath)
  if(!tls && !LOOPBACK.has(requestedHost) && !lanOptIn){
    throw new Error('监听非回环地址必须配置 DSH_MOBILE_TLS_CERT / DSH_MOBILE_TLS_KEY；确需明文请显式设置 DSH_MOBILE_LAN=1')
  }
  const port=Number(config.port ?? process.env.DSH_MOBILE_PORT ?? 5189)
  const fs=await makeFileSystem(resolve(config.workspace || process.env.DSH_MOBILE_WORKSPACE || process.cwd()))
  const extraHosts=(config.allowedHosts || process.env.DSH_MOBILE_ALLOWED_HOSTS || '').split(',').map(x=>normalizeHost(x)).filter(Boolean)
  const publicOrigin=(config.publicOrigin || process.env.DSH_MOBILE_PUBLIC_ORIGIN || '').trim()
  const hostPatterns=[...new Set([...LOOPBACK,...localAddresses(),requestedHost,...extraHosts].filter(host=>host&&host!=='0.0.0.0'&&host!=='::'))]
  const allowedOrigins=new Set((config.allowedOrigins || process.env.DSH_MOBILE_ALLOWED_ORIGINS || 'http://localhost:5188,http://127.0.0.1:5188').split(',').map(x=>x.trim()).filter(Boolean))
  if(publicOrigin)allowedOrigins.add(publicOrigin)
  const allowedOps=new Set(['hello','list','create','history','send','cancel','files','write','flush'])
  let actualPort=port
  const failures=new Map()
  function clientKey(req){return String(req.socket.remoteAddress||'unknown')}
  function blocked(ip){const entry=failures.get(ip);return Boolean(entry&&entry.blockedUntil>Date.now())}
  function noteFailure(ip){
    const now=Date.now();const entry=failures.get(ip)||{count:0,start:now,blockedUntil:0}
    if(now-entry.start>AUTH_WINDOW_MS){entry.count=0;entry.start=now}
    entry.count+=1
    if(entry.count>AUTH_MAX_FAILURES)entry.blockedUntil=now+AUTH_WINDOW_MS
    failures.set(ip,entry)
    if(failures.size>1024){for(const [key,value] of failures){if(value.blockedUntil<=now&&now-value.start>AUTH_WINDOW_MS)failures.delete(key)}}
    return entry.blockedUntil>now
  }
  function trustedOrigin(origin,requestHostname){
    let parsed
    try{parsed=new URL(origin)}catch{return false}
    if(parsed.protocol!=='http:'&&parsed.protocol!=='https:')return false
    const hostname=parsed.hostname.toLowerCase().replace(/^\[|\]$/g,'')
    if(!hostAllowed(hostname,hostPatterns))return false
    const effective=parsed.port || (parsed.protocol==='https:'?'443':'80')
    if(LOOPBACK.has(hostname)||hostPatterns.includes(hostname))return effective===String(actualPort)
    // 通配 Host（如 cloudflared 隧道）：只信任与请求 Host 完全一致的同源 HTTPS 页面，
    // 避免「同后缀任意子域」被当成可信 Origin。
    return hostname===requestHostname && parsed.protocol==='https:' && effective==='443'
  }
  const handler=async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff')
    res.setHeader('Referrer-Policy','no-referrer')
    res.setHeader('Cache-Control','no-store')
    const hostname=normalizeHost(req.headers.host)
    if(!hostAllowed(hostname,hostPatterns)){res.writeHead(421);res.end('Misdirected Request');return}
    let pathname
    try{pathname=new URL(req.url||'/','http://'+String(req.headers.host||'localhost')).pathname}
    catch{res.writeHead(400);res.end('Bad Request');return}
    if(pathname!=='/bridge/dispatch'){
      if(req.method!=='GET' && req.method!=='HEAD'){res.writeHead(405);res.end();return}
      let decoded
      try{decoded=decodeURIComponent(pathname==='/'?'/index.html':pathname)}catch{res.writeHead(400);res.end('Bad Request');return}
      const dist=join(PLUGIN_ROOT,'dist')
      const path=resolve(dist,'.'+decoded)
      if(!path.startsWith(dist+sep)){res.writeHead(404);res.end();return}
      try{const bytes=await readFile(path);const headers={'Content-Type':MIME[extname(path)]||'application/octet-stream','X-Frame-Options':'DENY'};if(extname(path)==='.html')headers['Content-Security-Policy']=CSP;res.writeHead(200,headers);res.end(req.method==='HEAD'?undefined:bytes)}catch{res.writeHead(404);res.end('Build the mobile app with npm run build first')}
      return
    }
    const origin=req.headers.origin
    const sameOriginAllowed=!origin || allowedOrigins.has(origin) || trustedOrigin(origin,hostname)
    if(origin && sameOriginAllowed)res.setHeader('Access-Control-Allow-Origin',origin)
    if(origin)res.setHeader('Vary','Origin')
    if(req.method==='OPTIONS'){
      if(!sameOriginAllowed){res.writeHead(403);res.end('Origin not allowed');return}
      res.writeHead(204,{'Access-Control-Allow-Headers':'authorization,content-type','Access-Control-Allow-Methods':'POST,OPTIONS'})
      res.end()
      return
    }
    if(!sameOriginAllowed){res.writeHead(403);res.end('Origin not allowed');return}
    if(req.method!=='POST'){res.writeHead(405);res.end();return}
    const ip=clientKey(req)
    const supplied=(req.headers.authorization||'').replace(/^Bearer /,'')
    if(!equalToken(supplied,token)){
      if(blocked(ip)||noteFailure(ip)){res.writeHead(429);res.end('Too Many Requests')}else{res.writeHead(401);res.end('Pairing required')}
      return
    }
    // 正确令牌永远放行：未认证请求不能把合法配对锁死（cloudflared 回源时所有来源 IP 相同）。
    failures.delete(ip)
    const abort=new AbortController()
    res.on('close',()=>abort.abort())
    try{
      const chunks=[];let size=0
      for await(const chunk of req){size+=chunk.length;if(size>3*1024*1024){res.writeHead(413);res.end();return}chunks.push(chunk)}
      const data=JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if(!allowedOps.has(data.operation) || !data.input || typeof data.input!=='object' || Array.isArray(data.input))throw userError('无效的操作')
      if(data.operation==='hello'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({result:{protocol:1,name:'Desktop DSH',workspace:fs.root}}));return}
      const streaming=data.operation==='send'
      if(streaming){res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8','X-Accel-Buffering':'no'});res.flushHeaders()}
      const result=await dispatchOperation(context,fs,data.operation,data.input,frame=>{if(!res.destroyed)res.write(JSON.stringify({frame})+'\n')},abort.signal)
      if(!res.destroyed){if(streaming)res.end(JSON.stringify({done:true})+'\n');else{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({result}))}}
    }catch(error){
      const payload=errorPayload(error)
      if(!payload.expose)console.error('[dsh-mobile-gateway]',error)
      if(!res.destroyed){
        if(res.headersSent)res.end(JSON.stringify(payload)+'\n')
        else{res.writeHead(payload.expose?400:500,{'Content-Type':'application/json'});res.end(JSON.stringify(payload))}
      }
    }
  }
  const cert=certPath,key=keyPath
  const server=tls?https.createServer({cert:await readFile(cert),key:await readFile(key)},(req,res)=>void handler(req,res).catch(()=>{if(!res.headersSent)res.writeHead(500);res.end()})):http.createServer((req,res)=>void handler(req,res).catch(()=>{if(!res.headersSent)res.writeHead(500);res.end()}))
  server.requestTimeout=15*60*1000
  server.headersTimeout=15000
  server.maxConnections=MAX_CONNECTIONS
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,requestedHost,resolve)})
  actualPort=server.address().port
  return {server,token,port:actualPort,host:requestedHost,tls,close:()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve)})}
}

export async function apply(context,config={}){
  const gateway=await createGateway(context,config)
  context.on('dispose',()=>gateway.close())
  const scheme=gateway.tls?'https':'http'
  const loopbackOnly=!gateway.tls && LOOPBACK.has(gateway.host)
  const addresses=loopbackOnly
    ? ['127.0.0.1']
    : [...new Set([gateway.host,...localAddresses()].filter(address=>address&&address!=='0.0.0.0'&&address!=='::'))]
  if(!addresses.length)addresses.push('127.0.0.1')
  const links=addresses.map(address=>scheme+'://'+address+':'+gateway.port+'/#token='+gateway.token)
  if(!gateway.tls && !loopbackOnly)console.warn('\n[警告] 桌面连接器未启用 TLS：配对令牌与对话内容会以明文经过网络。仅建议在本机回环或可信局域网使用。\n')
  if(loopbackOnly)console.log('\nDSH 手机版已就绪（仅本机回环监听，手机无法直接连接）。本机调试可用：\n'+links.join('\n')+'\n需要手机连接请运行 tools\\remote.ps1（cloudflared HTTPS 隧道），或显式配置 DSH_MOBILE_HOST=0.0.0.0 + TLS/DSH_MOBILE_LAN=1。\n')
  else console.log('\nDSH 手机版已就绪。选择与手机同一网络的桌面配对链接：\n'+links.join('\n')+'\n')
}
