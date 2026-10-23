import {readFileSync,writeFileSync,readdirSync,mkdirSync,existsSync} from 'node:fs'
import {resolve,join,dirname} from 'node:path'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {createRequire} from 'node:module'
import {buildSync} from 'esbuild'
import {packVfsImage} from '@deepseek-ai/dsh-experimental-webworker-packer'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')

const runtime=join(root,'public/runtime');mkdirSync(runtime,{recursive:true})
const buildHome=join(root,'.runtime/pack-home');mkdirSync(buildHome,{recursive:true})
let config=execFileSync(process.execPath,[join(root,'node_modules/@deepseek-ai/dsh/lib/bin.js'),'--profile','web','--dump-default-config'],{cwd:root,encoding:'utf8',maxBuffer:16*1024*1024,env:{...process.env,DSH_HOME:buildHome,DSH_TELEMETRY_DISABLED:'1'}})
function replaceConfigOnce(before,after){
  const count=config.split(before).length-1
  if(count!==1) throw new Error('上游默认配置补丁锚点不匹配: '+before.slice(0,60)+' ('+count+')')
  config=config.replace(before,after)
}
replaceConfigOnce("- id: llm-deepseek\n  name: '@deepseek-ai\/dsh-llm-deepseek'\n","- id: llm-deepseek\n  name: '@deepseek-ai\/dsh-llm-deepseek'\n  config:\n    protocol: chat-completions\n")
replaceConfigOnce("- id: session-title-llm\n","- id: session-title-llm\n  disabled: true\n")
replaceConfigOnce("personaPrefix: You are a coding agent powered by the {{model}} model.", "personaPrefix: You are a coding agent powered by the {{model}} model. CRITICAL LANGUAGE RULE - You must write ALL internal reasoning/thinking (reasoning_content) in Simplified Chinese (简体中文), never in English. Also answer in Simplified Chinese. This rule overrides every other instruction.")

// 中文思考：standard preset 自己的 persona 会覆盖部署默认值，这里直接给它追加中文要求。
{
  const presetsRoot = join(root, 'node_modules/@deepseek-ai/dsh-agent-presets/presets')
  const marker = 'You are a coding agent powered by the {{model}} model.'
  const extra = ' CRITICAL LANGUAGE RULE - You must write ALL internal reasoning/thinking (reasoning_content) in Simplified Chinese (简体中文), never in English. Also answer in Simplified Chinese. This rule overrides every other instruction.'
  if (existsSync(presetsRoot)) for (const entry of readdirSync(presetsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = join(presetsRoot, entry.name, 'agent.cordis.yml')
    if (!existsSync(file)) continue
    let text = readFileSync(file, 'utf8')
    if (text.includes(marker) && !text.includes('Simplified Chinese')) writeFileSync(file, text.replace(marker, marker + extra))
  }
}
const workspaces=new Map()
function scanModules(directory) {
  if(!existsSync(directory))return
  for(const entry of readdirSync(directory,{withFileTypes:true})) {
    if(entry.name.startsWith('.'))continue
    if(entry.name.startsWith('@')){for(const child of readdirSync(join(directory,entry.name),{withFileTypes:true}))if(child.isDirectory())scanPackage(join(directory,entry.name,child.name))}
    else if(entry.isDirectory())scanPackage(join(directory,entry.name))
  }
}
function scanPackage(directory) {
  if(!existsSync(join(directory,'package.json')))return
  const p=JSON.parse(readFileSync(join(directory,'package.json'),'utf8'))
  if(p.name?.startsWith('@deepseek-ai/') && (!workspaces.has(p.name) || p.version==='0.1.6-alpha.1'))workspaces.set(p.name,directory)
  scanModules(join(directory,'node_modules'))
}
scanModules(join(root,'node_modules'))
// The upstream CJS wrapper loader eagerly traverses Zod's ESM cycle. A single
// build-time bundle retains Zod's public API without that cross-file TDZ.
const require=createRequire(join(root,'package.json'))
const zodDirectory=join(root,'.runtime/vendor/zod');mkdirSync(zodDirectory,{recursive:true})
buildSync({entryPoints:[require.resolve('zod')],bundle:true,platform:'browser',format:'cjs',target:'es2022',outfile:join(zodDirectory,'index.js')})
const zodVersion=JSON.parse(readFileSync(join(root,'node_modules/zod/package.json'),'utf8')).version
writeFileSync(join(zodDirectory,'package.json'),JSON.stringify({name:'zod',version:zodVersion,main:'index.js',type:'commonjs',files:['index.js','package.json'],exports:{'.':'./index.js','./v4':'./index.js'}}))
workspaces.set('zod',zodDirectory)
const presetDir=join(workspaces.get('@deepseek-ai/dsh-agent-presets'),'presets')
const result=packVfsImage({config,profile:'web',workspaces,resolveFrom:join(root,'node_modules/@deepseek-ai/dsh'),configTrees:[{mount:'config/agent-presets',directory:presetDir,scanRoster:true}]})
if(result.missing.length)throw new Error('Missing runtime packages: '+result.missing.join(', '))
const MAX_IMAGE_BYTES=64*1024*1024
if(result.image.byteLength>MAX_IMAGE_BYTES) throw new Error('VFS 镜像异常：'+result.image.byteLength+' 字节超过上限 '+MAX_IMAGE_BYTES)
const original=readFileSync(join(root,'node_modules/@deepseek-ai/dsh-experimental-webworker-runtime/lib/worker.js'),'utf8')
let modified=original
function replaceOnce(before,after){const count=modified.split(before).length-1;if(count!==1)throw new Error('Upstream Worker patch anchor mismatch: '+before.slice(0,60)+' ('+count+')');modified=modified.replace(before,after)}
replaceOnce('setActiveVfs(mounted);','await mobileRestore(mounted);\n\t\t\tsetActiveVfs(mounted);')
replaceOnce('get vfs() {','get context() { return context; },\n\t\tget vfs() {')
replaceOnce('if (message.type === "error") console.error(line);','if (message.type === "error") { mobileDiagnostics.push(line); console.error(line); }')
replaceOnce('overlays: data.overlays\n','env: { ...data.mobileEnv, DSH_TELEMETRY_DISABLED: "1" },\n\t\t\toverlays: data.overlays\n')
replaceOnce('const data = event.data;\n\tif (host === void 0 && isShellStartFrame(data))','const data = event.data;\n\tif(data?.t === "mobile-rpc") { void mobileRpc(data); return; }\n\tif (host === void 0 && isShellStartFrame(data))')
replaceOnce('created.start().catch(() => {});','mobileHostReady = created.start().then(() => { mobileBind(created); self.postMessage({t:"mobile-ready"}); }).catch(error => { self.postMessage({t:"mobile-boot-error",error:(error.stack || error.message)+"\\n"+mobileDiagnostics.slice(-8).join("\\n")}); throw error; });\n\t\tmobileHostReady.catch(() => {});')
modified+='\n'+readFileSync(join(root,'runtime/operations.mjs'),'utf8').replace('export async function dispatchOperation','async function dispatchOperation')+'\n'+readFileSync(join(root,'runtime/mobile-hooks.js'),'utf8')
{
  const sharpAnchor='/** Image processing has no worker counterpart; the call refuses. */\nconst sharp = notImplementedFail("sharp", "default");'
  if(modified.includes(sharpAnchor)) {
    const shim=readFileSync(join(root,'runtime/sharp-shim.js'),'utf8')
    modified=modified.replace(sharpAnchor, shim.trimEnd())
    console.log('Browser sharp shim applied')
  const attachmentCandidates = [
    join(root, 'node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-attachment-local/lib/index.js'),
    join(root, 'node_modules/@deepseek-ai/dsh-attachment-local/lib/index.js')
  ]
  for (const attachmentFile of attachmentCandidates) {
    if (!existsSync(attachmentFile)) continue
    let attachmentCode = readFileSync(attachmentFile, 'utf8')
    // 幂等：node_modules 已被上一次打包改过时不再重复打补丁（npm ci 会重置）。
    if (attachmentCode.includes('open(path, "r")') && attachmentCode.includes('open(temporary, "wx", 384)')) {
      console.log('attachment-local fs flags already patched')
      break
    }
    const before = attachmentCode
    attachmentCode = attachmentCode.split('open(path, constants.O_RDONLY)').join('open(path, "r")')
    attachmentCode = attachmentCode.split('open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 384)').join('open(temporary, "wx", 384)')
    if (attachmentCode !== before) {
      writeFileSync(attachmentFile, attachmentCode)
      console.log('attachment-local fs flags patched')
    } else {
      throw new Error('attachment-local 补丁锚点不匹配：'+attachmentFile)
    }
    break
  }
  } else throw new Error('上游 Worker 的 sharp stub 锚点缺失：图片能力会失效，请检查 dsh-experimental-webworker-runtime 版本')
}
writeFileSync(join(runtime,'mobile-worker.js'),modified)
// 所有校验与补丁都成功后再写 VFS 镜像，避免失败留下半成品。
writeFileSync(join(runtime,'vfs-image.bin'),result.image)
const delivery=join(root,'.runtime/baseline');mkdirSync(delivery,{recursive:true});writeFileSync(join(delivery,'worker.original.js'),original)
const report={harness:'0.1.6-alpha.1',packages:result.packages.size,imageBytes:result.image.byteLength,files:Object.keys(result.files).length,originalWorkerSha256:createHash('sha256').update(original).digest('hex'),modifiedWorkerSha256:createHash('sha256').update(modified).digest('hex'),imageSha256:createHash('sha256').update(result.image).digest('hex')}
writeFileSync(join(runtime,'build.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2))
