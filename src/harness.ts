import type { Chat, Harness, ImageAttachment, Message, Preferences, RunMode, RuntimeEvent } from './types'
import { blocksText, parseConnection, safeFileName } from './format.mjs'
import { uid } from './storage'

// The pre-stable upstream journal is decoded at this wire boundary only.
type Wire = Record<string, any>
function record(value: unknown): Wire { return value && typeof value === 'object' && !Array.isArray(value) ? value as Wire : {} }
export const TOOL_NAMES: Record<string,string> = { write: '写入文件', read: '读取文件', edit: '编辑文件', bash: '运行命令', pwsh: '运行命令', glob: '查找文件', grep: '搜索内容', ls: '列出文件', web_search: '网页搜索', web_fetch: '打开网页', todo_write: '更新计划', task: '子任务', subagent: '子代理' }
function toolLabel(name: string) { return TOOL_NAMES[name] || name }
function journalMessage(value: unknown): Message | null {
  const e = record(value); const data = record(e.data); const message = record(data.message || e.data)
  if(e.type === 'user/message') { const text=blocksText(message.content).replace(/^【最高优先级：[\s\S]*?】\n\n/, '').replace(/^【连接信息：[^\n]*】\n\n/, '').replace(/^【系统要求：[^\n]*】\n\n/, ''); return {id:String(message.id || 'user-'+e.seq),role:'user',text} }
  if(e.type === 'assistant/message') {
    const content = message.content || data.content
    return {id:String(message.id || 'assistant-'+e.seq),role:'assistant',text:blocksText(content),reasoning:Array.isArray(content)?content.filter(p=>p?.type==='reasoning').map(p=>p.text || '').join(''):''}
  }
  if(e.type === 'tool/result') {const result=record(message.content?.[0] || data.result);return {id:'tool-'+e.seq,role:'tool',tool:toolLabel(String(data.name || data.toolName || '工具结果')),text:blocksText(result.content || data.content) || String(data.output || result.output || '')}}
  return null
}
function parseFrame(raw: unknown, onEvent:(e:RuntimeEvent)=>void) {
  const frame = record(raw)
  if(frame.type === 'assistant-stream') {
    const live = record(frame.frame); const chunk = record(live.chunk)
    if(chunk.type === 'text-delta') onEvent({type:'delta',text:String(chunk.text || '')})
    if(chunk.type === 'reasoning-delta') onEvent({type:'delta',text:'',reasoning:String(chunk.text || '')})
  }
  if(frame.type === 'event') {
    const event = record(frame.event); const message=journalMessage(event)
    if(message && message.role!=='user') onEvent({type:'message',message})
    if(event.type === 'tool/call') {const data=record(event.data); const toolName=String(data.tool || data.name || data.toolName || data.function?.name || '工具'); onEvent({type:'status',text:'正在执行工具：'+toolLabel(toolName)})}
    if(event.type === 'step/start') onEvent({type:'status',text:'DSH 正在思考…'})
    if(event.type === 'turn/end') {const data=record(event.data);const reason=record(data.reason);if(reason.kind==='error')throw new Error(String(record(reason.error).message || '模型请求失败，请检查 API Key、额度与地址'));if(data.error) throw new Error(String(record(data.error).message || data.error));onEvent({type:'done'})}
    if(event.type === 'agent/error' || event.type === 'llm/error') throw new Error(String(record(event.data).message || record(event.data).error || '模型请求失败'))
  }
}
function chatList(value: unknown, mode:RunMode):Chat[] {
  const result=record(value);const rows=Array.isArray(result.items)?result.items:[]
  return rows.filter(x=>typeof x.sessionId==='string').map(x=>({id:x.sessionId,title:x.projections?.values?.sessionTitle?.title || x.projections?.values?.title?.title || '桌面对话 · '+x.sessionId.slice(-6),updated:x.updatedAt || Date.now(),mode,messages:[],cwd:x.cwd}))
}
class PhoneHarness implements Harness {
  private worker:Worker | null=null
  private key=''
  private pending=new Map<string,{resolve:(x:unknown)=>void;reject:(x:Error)=>void;frame?:(x:unknown)=>void;cleanup:()=>void}>()
  async start(prefs:Preferences) {
    const endpoint=new URL(prefs.baseUrl)
    if(!['https:','http:'].includes(endpoint.protocol))throw new Error('API 地址需要使用 HTTPS 或 HTTP')
    this.key=prefs.apiKey+'\n'+prefs.baseUrl
    const worker=new Worker('/runtime/mobile-worker.js',{type:'module',name:'dsh-phone'});this.worker=worker
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>{this.dispose();reject(new Error('手机内核启动超时，请刷新后重试'))},60000)
      worker.addEventListener('message',({data})=>{
        if(data?.t==='mobile-ready'){clearTimeout(timer);resolve()}
        if(data?.t==='mobile-boot-error'){clearTimeout(timer);reject(new Error(data.error))}
        const waiting=this.pending.get(data?.id)
        if(data?.t==='mobile-event' && waiting) {try{waiting.frame?.(data.frame)}catch(error){this.pending.delete(data.id);waiting.cleanup();worker.postMessage({t:'mobile-rpc',operation:'abort',input:{id:data.id}});waiting.reject(error instanceof Error?error:new Error(String(error)))}}
        if(data?.t==='mobile-result' && waiting){this.pending.delete(data.id);waiting.cleanup();if(data.error)waiting.reject(new Error(data.error));else waiting.resolve(data.result)}
      })
      worker.addEventListener('error',event=>{clearTimeout(timer);const error=new Error(event.message || '手机内核运行失败');reject(error);for(const job of this.pending.values()){job.cleanup();job.reject(error)}this.pending.clear()})
      worker.postMessage({t:'init',image:new URL('/runtime/vfs-image.bin',location.href).href,overlays:[],mobileEnv:{DEEPSEEK_API_KEY:prefs.apiKey,DEEPSEEK_BASE_URL:prefs.baseUrl}})
    })
  }
  private call(operation:string,input:object={},frame?:(x:unknown)=>void,signal?:AbortSignal):Promise<unknown> {
    if(!this.worker)return Promise.reject(new Error('手机内核尚未启动'))
    const id=uid();const worker=this.worker
    return new Promise((resolve,reject)=>{
      let settled=false;let timedOut=false
      const finish=(ok:boolean,value:unknown)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);this.pending.delete(id);ok?resolve(value):reject(value as Error)}
      // 手动停止与超时分开：超时先置 timedOut，再由 abort 统一收口。
      const abort=()=>{worker.postMessage({t:'mobile-rpc',operation:'abort',input:{id}});finish(false,new Error(timedOut?'操作等待超时':'已停止生成'))}
      const timer=setTimeout(()=>{timedOut=true;abort()},operation==='send'?15*60*1000:30000)
      signal?.addEventListener('abort',abort,{once:true})
      this.pending.set(id,{resolve:(value)=>finish(true,value),reject:(error)=>finish(false,error),frame,cleanup:()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort)}})
      if(signal?.aborted){abort();return}
      worker.postMessage({t:'mobile-rpc',id,operation,input})
    })
  }
  async create(){return String(record(await this.call('create')).sessionId)}
  async list(){return chatList(await this.call('list'),'phone')}
  async history(id:string){const snapshot=record(await this.call('history',{id}));return (snapshot.records || []).map((x:Wire)=>journalMessage(x.event)).filter((x:Message|null):x is Message=>x!==null)}
  async catalog(){return await this.call('catalog')}
  async send(id:string,text:string,prefs:Preferences,onEvent:(e:RuntimeEvent)=>void,signal:AbortSignal,images?:ImageAttachment[]){
    if(!prefs.apiKey.trim())throw new Error('请先填写 API Key')
    if(!prefs.model)throw new Error('请先选择模型')
    if(this.key!==prefs.apiKey+'\n'+prefs.baseUrl){await this.call('flush');this.dispose();await this.start(prefs)}
    await this.call('send',{id,text,model:prefs.model,reasoningEffort:prefs.reasoningEffort || undefined,images:images && images.length ? images : undefined,requestId:uid(),timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone},raw=>parseFrame(raw,onEvent),signal)
  }
  async stop(id:string){await this.call('cancel',{id})}
  async files(){return await this.call('files') as {path:string;text:string}[]}
  async importFile(name:string,text:string){await this.call('write',{name:safeFileName(name),text})}
  async flush(){await this.call('flush')}
  dispose(){this.worker?.terminate();this.worker=null;for(const job of this.pending.values()){job.cleanup();job.reject(new Error('连接已关闭'))}this.pending.clear()}
}
class DesktopHarness implements Harness {
  private prefs:Preferences | null=null
  private requests=new Set<AbortController>()
  async start(prefs:Preferences){const {endpoint}=parseConnection(prefs.endpoint);this.prefs={...prefs,endpoint};const result=record(await this.call('hello'));if(result.protocol!==1)throw new Error('桌面连接器版本不匹配')}
  private async call(operation:string,input:object={},onFrame?:(x:unknown)=>void,signal?:AbortSignal):Promise<unknown>{
    if(!this.prefs)throw new Error('尚未连接桌面')
    if(location.protocol==='https:' && this.prefs.endpoint.startsWith('http:'))throw new Error('当前页面使用 HTTPS，桌面地址也需要 HTTPS；局域网可直接打开连接器提供的手机页面')
    const abort=new AbortController();this.requests.add(abort)
    const cancel=()=>abort.abort();signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel()
    let timedOut=false
    const timer=setTimeout(()=>{timedOut=true;abort.abort()},operation==='send'?15*60*1000:30000)
    try {
      const response=await fetch(this.prefs.endpoint+'/bridge/dispatch',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+this.prefs.token},body:JSON.stringify({operation,input}),signal:abort.signal,credentials:'omit',redirect:'error'})
      if(!response.ok)throw new Error(response.status===401?'配对令牌不正确或已过期':response.status===403?'此手机页面未加入桌面允许来源':'桌面请求失败（'+response.status+'）')
      if(!onFrame){const result=record(await response.json());if(result.error)throw new Error(String(result.error));return result.result}
      const reader=response.body?.getReader();if(!reader)throw new Error('桌面没有返回数据流')
      let buffer='';let terminal=false;const decoder=new TextDecoder()
      while(true){const part=await reader.read();buffer+=decoder.decode(part.value,{stream:!part.done});let index;while((index=buffer.indexOf('\n'))!==-1){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(!line.trim())continue;const row=record(JSON.parse(line));if(row.error)throw new Error(String(row.error));if(row.frame)onFrame(row.frame);if(row.done)terminal=true}if(part.done)break}
      if(!terminal)throw new Error('桌面连接中断，重新连接后可查看已完成的内容')
      return {completed:true}
    } catch(error){
      // 超时与 AbortError 统一映射为中文提示，避免英文 DOMException 直接冒泡到界面。
      if(timedOut)throw new Error('操作等待超时')
      if(signal?.aborted || (error as {name?:string})?.name==='AbortError')throw new Error('已停止生成')
      throw error
    } finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);this.requests.delete(abort)}
  }
  async create(){return String(record(await this.call('create')).sessionId)}
  async list(){return chatList(await this.call('list'),'desktop')}
  async history(id:string){const s=record(await this.call('history',{id}));return (s.records || []).map((x:Wire)=>journalMessage(x.event)).filter((x:Message|null):x is Message=>x!==null)}
  async catalog(){return {groups:[]}}
  async send(id:string,text:string,_prefs:Preferences,onEvent:(e:RuntimeEvent)=>void,signal:AbortSignal,_images?:ImageAttachment[]){await this.call('send',{id,text,requestId:uid(),timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone},raw=>parseFrame(raw,onEvent),signal)}
  async stop(id:string){await this.call('cancel',{id})}
  async files(){return await this.call('files') as {path:string;text:string}[]}
  async importFile(name:string,text:string){await this.call('write',{name:safeFileName(name),text})}
  async flush(){await this.call('flush')}
  dispose(){for(const request of this.requests)request.abort();this.requests.clear()}
}
export function createHarness(mode:RunMode):Harness{return mode==='phone'?new PhoneHarness():new DesktopHarness()}
