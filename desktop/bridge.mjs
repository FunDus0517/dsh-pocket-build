import {mkdirSync,writeFileSync,existsSync} from 'node:fs'
import {resolve,dirname,join} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {spawn} from 'node:child_process'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
if(!existsSync(join(root,'dist/index.html')))throw new Error('请先运行 npm run build')
const state=join(root,'.desktop-state');mkdirSync(state,{recursive:true})
const overlay=join(state,'mobile.overlay.yml')
writeFileSync(overlay,[
  '- insert:',
  '    - id: mobile-gateway',
  '      name: ' + JSON.stringify(pathToFileURL(join(root,'desktop/gateway.mjs')).href),
  '      config:',
  '        workspace: ' + JSON.stringify(process.env.DSH_MOBILE_WORKSPACE || root),
  '        host: ' + JSON.stringify(process.env.DSH_MOBILE_HOST || '127.0.0.1'),
  '        allowedOrigins: \'http://127.0.0.1:52019,http://localhost:52019,http://localhost:5188,http://127.0.0.1:5188\''
].join('\n') + '\n')
const installed=process.env.APPDATA?join(process.env.APPDATA,'npm/node_modules/@deepseek-ai/dsh/lib/bin.js'):''
const cli=process.env.DSH_CLI_ENTRY || (installed && existsSync(installed)?installed:join(root,'node_modules/@deepseek-ai/dsh/lib/bin.js'))
const child=spawn(process.execPath,[cli,'--profile','web','--patch',overlay,'--port',process.env.DSH_WEB_PORT || '3096','--no-open'],{cwd:process.env.DSH_MOBILE_WORKSPACE || root,env:{...process.env,DSH_TELEMETRY_DISABLED:'1'},stdio:'inherit',windowsHide:true})
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal))
child.on('exit',code=>process.exit(code || 0))
