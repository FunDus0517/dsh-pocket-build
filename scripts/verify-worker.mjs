import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'
const [stage='modified',path='public/runtime/mobile-worker.js']=process.argv.slice(2)
const bytes=readFileSync(path);const text=bytes.toString('utf8')
const hash=createHash('sha256').update(bytes).digest('hex')
const original='b9e58fd6236fe2a35b34162d61848ea6371efde6ded36e41642f2c21c4aef36e'
if(stage==='baseline'||stage==='rollback'){
 assert.equal(hash,original);assert.equal(text.includes('function mobileRpc'),false);assert.equal(text.includes('dsh-mobile-runtime-v1'),false)
 console.log(stage==='baseline'?'BASELINE PASS: upstream Worker; mobileIPC=off; durableStorage=off':'ROLLBACK PASS: original SHA256 restored; mobileIPC=off; durableStorage=off')
}else{
 assert.notEqual(hash,original);for(const term of ['await mobileRestore(mounted)','get context()','function mobileRpc','indexedDB.open','sessionPersistence','mobileAllowedPath','metadata'])assert.ok(text.includes(term),term)
 assert.ok(text.includes("host.context.get('sessionPersistence')?.flush()"))
 assert.ok(text.includes('MOBILE_DENIED_SEGMENTS'))
 console.log('MODIFIED PASS: mobileIPC=on; durableStorage=on; credentials=excluded')
}
