import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,mkdir,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import http from 'node:http'
import {parseConnection,blocksText,safeFileName,splitMarkdown,exportChat} from '../src/format.mjs'
import {createGateway,makeFileSystem} from '../desktop/gateway.mjs'

test('pairing link keeps token out of HTTP URL',()=>assert.deepEqual(parseConnection('https://desktop.example:5189/#token=test-pair'),{endpoint:'https://desktop.example:5189',token:'test-pair'}))
test('rejects active-content and embedded credentials',()=>{for(const address of ['javascript:alert(1)','file:///etc/passwd','https://name:password@desktop.test'])assert.throws(()=>parseConnection(address))})
test('text projection excludes nontext blocks',()=>assert.equal(blocksText([{type:'text',text:'one'},{type:'image',data:'private'},{type:'text',text:'two'}]),'one\ntwo'))
test('import uses a leaf filename only',()=>{assert.equal(safeFileName('../nested\\note.md'),'note.md');assert.throws(()=>safeFileName('..'))})
test('code fences stay code, never HTML',()=>{const parts=splitMarkdown('hello\n```html\n<script>alert(1)</script>\n```');assert.equal(parts[1].type,'code');assert.match(parts[1].text,/<script>/)})
test('export excludes unfinished replies',()=>assert.equal(exportChat({title:'Test',messages:[{role:'user',text:'Hello'},{role:'assistant',text:'pending',pending:true}]}),'# Test\n\n## 你\n\nHello\n'))

test('gateway authenticates, restricts origins, preserves stream endings and protects imports',async t=>{
  const root=await mkdtemp(join(tmpdir(),'dsh-mobile-test-'))
  const service={list:async()=>({items:[]}),create:async()=>({sessionId:'session-fixture'}),cancel:()=>({cancelled:true}),selectModel:async()=>({}),prompt:async()=>({accepted:true}),async *follow(_request,signal){yield {type:'snapshot',records:[]};if(!signal.aborted)yield {type:'event',event:{type:'turn/end',seq:1,data:{}}}}}
  const gateway=await createGateway({get:name=>name==='sessionController'?service:undefined},{host:'127.0.0.1',port:0,token:'test-token-only',workspace:root,allowedOrigins:'https://phone.example'})
  t.after(()=>gateway.close())
  const url='http://127.0.0.1:'+gateway.port+'/bridge/dispatch'
  const call=(operation,input={},headers={})=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer test-token-only',...headers},body:JSON.stringify({operation,input})})
  await t.test('wrong token is rejected before dispatch',async()=>assert.equal((await call('hello',{}, {Authorization:'Bearer wrong'})).status,401))
  await t.test('unknown browser origin is rejected',async()=>assert.equal((await call('hello',{}, {Origin:'https://untrusted.example'})).status,403))
  await t.test('known browser origin can pair',async()=>{const r=await call('hello',{}, {Origin:'https://phone.example'});assert.equal(r.status,200);assert.equal((await r.json()).result.protocol,1)})
  await t.test('real dispatcher creates session',async()=>assert.equal((await (await call('create')).json()).result.sessionId,'session-fixture'))
  await t.test('unknown operation is rejected',async()=>assert.equal((await call('shell-exec')).status,400))
  await t.test('import rejects directory traversal',async()=>{const r=await call('write',{name:'../escape.txt',text:'blocked'});assert.equal(r.status,400)})
  await t.test('import does not overwrite existing files',async()=>{await call('write',{name:'note.txt',text:'first'});await call('write',{name:'note.txt',text:'second'});assert.equal(await readFile(join(root,'.mobile-imports/note.txt'),'utf8'),'first')})
  await t.test('send includes an explicit terminal frame',async()=>{const r=await call('send',{id:'session-fixture',requestId:'test',text:'hello'});assert.match(await r.text(),/"done":true/);assert.match(r.headers.get('content-type'),/ndjson/)})
})

function rawRequest(port, options = {}) {
  const { method = 'POST', path = '/bridge/dispatch', headers = {}, body = '' } = options
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method, path, headers }, response => {
      let data = ''
      response.on('data', chunk => { data += chunk })
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: data }))
    })
    request.on('error', reject)
    if (body) request.write(body)
    request.end()
  })
}

test('gateway defaults to loopback and refuses unencrypted non-loopback listeners', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-loopback-'))
  const service = { list: async () => ({ items: [] }) }
  const gateway = await createGateway({ get: name => name === 'sessionController' ? service : undefined }, { token: 'loopback-token', port: 0, workspace: root })
  try {
    assert.equal(gateway.host, '127.0.0.1')
    assert.equal(gateway.server.address().address, '127.0.0.1')
    await assert.rejects(() => createGateway({ get: () => service }, { token: 'lan-token', port: 0, host: '0.0.0.0', workspace: root }), /TLS|DSH_MOBILE_LAN/)
  } finally { await gateway.close() }
})

test('gateway rejects Host headers outside the whitelist', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-host-'))
  const service = { list: async () => ({ items: [] }) }
  const gateway = await createGateway({ get: name => name === 'sessionController' ? service : undefined }, { token: 'host-token', port: 0, workspace: root })
  try {
    const rejected = await rawRequest(gateway.port, { headers: { Host: 'evil.example', Authorization: 'Bearer host-token' }, body: JSON.stringify({ operation: 'hello', input: {} }) })
    assert.equal(rejected.status, 421)
    const allowed = await rawRequest(gateway.port, { headers: { Host: '127.0.0.1:' + gateway.port, Authorization: 'Bearer host-token' }, body: JSON.stringify({ operation: 'hello', input: {} }) })
    assert.equal(allowed.status, 200)
  } finally { await gateway.close() }
})

test('gateway accepts configured tunnel hosts for HTTPS pages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-tunnel-'))
  const service = { list: async () => ({ items: [] }) }
  const gateway = await createGateway({ get: name => name === 'sessionController' ? service : undefined }, { token: 'tunnel-token', port: 0, workspace: root, allowedHosts: '*.edge.example' })
  try {
    const accepted = await rawRequest(gateway.port, { headers: { Host: 'abc.edge.example', Origin: 'https://abc.edge.example', Authorization: 'Bearer tunnel-token' }, body: JSON.stringify({ operation: 'hello', input: {} }) })
    assert.equal(accepted.status, 200)
    const foreign = await rawRequest(gateway.port, { headers: { Host: 'abc.edge.example', Origin: 'https://evil.example', Authorization: 'Bearer tunnel-token' }, body: JSON.stringify({ operation: 'hello', input: {} }) })
    assert.equal(foreign.status, 403)
  } finally { await gateway.close() }
})

test('gateway hides internal error details', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-errors-'))
  const service = { list: async () => { throw new Error('/secret/workspace/private-file') } }
  const gateway = await createGateway({ get: name => name === 'sessionController' ? service : undefined }, { host: '127.0.0.1', port: 0, token: 'error-token', workspace: root })
  try {
    const response = await fetch('http://127.0.0.1:' + gateway.port + '/bridge/dispatch', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer error-token' }, body: JSON.stringify({ operation: 'list', input: {} }) })
    assert.equal(response.status, 500)
    assert.equal((await response.text()).includes('secret'), false)
  } finally { await gateway.close() }
})

test('gateway rate-limits repeated authentication failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-limit-'))
  const service = { list: async () => ({ items: [] }) }
  const gateway = await createGateway({ get: name => name === 'sessionController' ? service : undefined }, { host: '127.0.0.1', port: 0, token: 'limit-token', workspace: root })
  try {
    const url = 'http://127.0.0.1:' + gateway.port + '/bridge/dispatch'
    let last = 0
    for (let index = 0; index < 12; index += 1) {
      last = (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-' + index }, body: JSON.stringify({ operation: 'hello', input: {} }) })).status
    }
    assert.equal(last, 429)
    // 正确令牌必须在失败风暴后仍然放行：cloudflared 回源 IP 相同，不能把合法配对锁死。
    const valid = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer limit-token' }, body: JSON.stringify({ operation: 'hello', input: {} }) })
    assert.equal(valid.status, 200)
  } finally { await gateway.close() }
})
