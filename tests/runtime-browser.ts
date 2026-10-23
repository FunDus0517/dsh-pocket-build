import {createHarness} from '../src/harness'
import type {Preferences,RuntimeEvent} from '../src/types'
const out=document.querySelector('#results')!
function log(value:string){out.textContent+=value+'\n'}
function assert(value:unknown,message:string){if(!value)throw new Error(message);log('PASS '+message)}
const prefs:Preferences={theme:'light',model:'deepseek-flash',apiKey:'fixture-key-not-real',baseUrl:'http://127.0.0.1:5191',endpoint:'',token:''}
const first=createHarness('phone')
try{
 log('ASSET '+(await fetch('/runtime/vfs-image.bin')).status)
 await new Promise<void>((resolve,reject)=>{
  const source="self.onmessage=async(event)=>{try{const response=await fetch(event.data);self.postMessage({status:response.status,bytes:(await response.arrayBuffer()).byteLength})}catch(error){self.postMessage({error:String(error)})}}"
  const probe=new Worker(URL.createObjectURL(new Blob([source],{type:'application/javascript'})))
  const timer=window.setTimeout(()=>{probe.terminate();reject(new Error('fetch-probe timeout'))},5000)
  probe.onmessage=event=>{window.clearTimeout(timer);log('PROBE '+JSON.stringify(event.data));probe.terminate();resolve()}
  probe.postMessage(new URL('/runtime/vfs-image.bin',location.href).href)
 })
 await first.start(prefs);assert(true,'official DSH Worker boots on phone')
 const id=await first.create();assert(id.startsWith('session-'),'real DSH session created')
 await first.importFile('mobile-import.txt','persistent mobile file');let files=await first.files();assert(files.some(x=>x.text==='persistent mobile file'),'local workspace imports and reads file')
 const frames:RuntimeEvent[]=[]
 await first.send(id,'TOOL_TEST 请用 write 工具创建 mobile-proof.txt。',prefs,e=>{frames.push(e);if(e.type==='status')log('STATUS '+e.text)},new AbortController().signal)
 files=await first.files();assert(files.some(x=>x.path.endsWith('/mobile-proof.txt')&&x.text.includes('DSH worker tool executed successfully')),'real agent loop executes write tool')
 assert(frames.some(x=>x.type==='delta'&&x.text),'assistant streams incremental text')
 const history=await first.history(id);assert(history.some(x=>x.role==='assistant'&&x.text.includes('Harness 工作正常')),'journal contains assistant response')
 first.dispose()
 const second=createHarness('phone');await second.start(prefs);files=await second.files()
 assert(files.some(x=>x.path.endsWith('mobile-proof.txt')),'IndexedDB restores workspace after Worker restart')
 const restored=await second.history(id);assert(restored.some(x=>x.role==='assistant'&&x.text.includes('Harness 工作正常')),'IndexedDB restores real DSH session history')
 second.dispose();log('RESULT: 8/8 browser runtime checks passed');document.documentElement.dataset.result='passed'
}catch(error){log('FAIL '+(error instanceof Error?error.stack:String(error)));document.documentElement.dataset.result='failed';first.dispose()}
