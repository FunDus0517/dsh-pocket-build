import assert from 'node:assert/strict'
const url='http://127.0.0.1:'+(process.env.TEST_DESKTOP_PORT || '5193')+'/bridge/dispatch'
async function call(operation,input={}){const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer fixture-desktop-token'},body:JSON.stringify({operation,input})});const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));if(data.error)throw new Error(data.error);return data.result}
const hello=await call('hello');assert.equal(hello.protocol,1)
const list=await call('list');assert.ok(Array.isArray(list.items))
const session=await call('create');assert.ok(session.sessionId)
const snapshot=await call('history',{id:session.sessionId});assert.equal(snapshot.type,'snapshot')
console.log('DESKTOP: real DSH profile; pairing=PASS; sessions=PASS; create=PASS; history=PASS')
