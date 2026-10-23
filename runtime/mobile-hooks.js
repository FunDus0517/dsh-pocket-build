/* iOS Safari/WebKit 兼容：ReadableStream 尚未实现异步迭代（Safari 26.4 才加），
   DSH 用 for await 读 SSE 流会在真机抛 TypeError，表现为 "DeepSeek API stream ... failed"。 */
if (typeof ReadableStream !== 'undefined' && typeof ReadableStream.prototype[Symbol.asyncIterator] !== 'function') {
  const iterateStream = function () {
    const reader = this.getReader();
    return {
      next: () => reader.read().then(result => result.done ? { value: undefined, done: true } : { value: result.value, done: false }),
      return: () => { reader.releaseLock(); return Promise.resolve({ value: undefined, done: true }); },
      throw: (error) => { reader.cancel(error).catch(() => {}); return Promise.reject(error); },
      [Symbol.asyncIterator]() { return this; }
    };
  };
  Object.defineProperty(ReadableStream.prototype, Symbol.asyncIterator, { value: iterateStream, writable: true, configurable: true });
  if (typeof ReadableStream.prototype.values !== 'function') Object.defineProperty(ReadableStream.prototype, 'values', { value: iterateStream, writable: true, configurable: true });
}
/* 旧 WebKit 可能没有 TextDecoderStream；用 TransformStream 补一个最小实现。 */
if (typeof TextDecoderStream === 'undefined' && typeof TransformStream === 'function') {
  globalThis.TextDecoderStream = class TextDecoderStream {
    constructor(label, options) {
      const decoder = new TextDecoder(label, options);
      const transform = new TransformStream({
        transform(chunk, controller) { const text = decoder.decode(chunk, { stream: true }); if (text) controller.enqueue(text); },
        flush(controller) { const text = decoder.decode(); if (text) controller.enqueue(text); }
      });
      this.readable = transform.readable;
      this.writable = transform.writable;
    }
  };
}
/* 旧 WebKit 可能没有 AbortSignal.any。 */
if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any !== 'function') {
  AbortSignal.any = function (signals) {
    const controller = new AbortController();
    for (const signal of signals) {
      if (signal.aborted) { controller.abort(signal.reason); break; }
      signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
    }
    return controller.signal;
  };
}
/* 把 DSH 错误的原因链带出来，避免只显示 "stream failed" 这种笼统信息。 */
/* iOS WKWebView 兼容：旧 WebKit 没有 Explicit Resource Management 的 Symbol.dispose / Symbol.asyncDispose / SuppressedError。 */
for (const key of ['dispose', 'asyncDispose']) {
  if (typeof Symbol[key] !== 'symbol') Object.defineProperty(Symbol, key, { value: Symbol(key), writable: true, configurable: true });
}
if (typeof globalThis.SuppressedError !== 'function') {
  globalThis.SuppressedError = class SuppressedError extends Error {
    constructor(error, suppressed, message) {
      super(message);
      this.name = 'SuppressedError';
      this.error = error;
      this.suppressed = suppressed;
    }
  };
}
/* Safari/WebKit: JavaScriptCore 的原生函数 toString 带换行（"function Object() {\n    [native code]\n}"），
   DSH 0.1.6 用严格字符串比较判断内建原型，真机上会误判并拒绝 session header。这里统一规范成单行。 */
try {
  const originalFunctionToString = Function.prototype.toString;
  const normalized = function toString() {
    const text = originalFunctionToString.call(this);
    return typeof text === 'string' && text.includes('[native code]') ? text.replace(/\s+/g, ' ').trim() : text;
  };
  Object.defineProperty(normalized, 'toString', { value: () => originalFunctionToString.call(normalized), configurable: true });
  Object.defineProperty(Function.prototype, 'toString', { value: normalized, writable: true, configurable: true });
} catch (error) {
  console.warn('function-toString-compat: ' + (error && error.message));
}
/* Browser persistence and request bridge, appended to the pinned upstream Worker. */
let mobileDatabase;
let mobileSaveTimer;
let mobileSavePending = Promise.resolve();
let mobileHostReady;
const mobileDiagnostics=[];
const mobileRequests = new Map();
function mobileDb() {
  return mobileDatabase ??= new Promise((resolve,reject) => {
    const open=indexedDB.open('dsh-mobile-runtime-v1',1);
    open.onupgradeneeded=()=>open.result.createObjectStore('state');
    open.onsuccess=()=>resolve(open.result);
    open.onerror=()=>reject(open.error);
  });
}
async function mobileReadState() {
  const db=await mobileDb();
  return new Promise((resolve,reject)=>{const request=db.transaction('state').objectStore('state').get('filesystem');request.onsuccess=()=>resolve(request.result || []);request.onerror=()=>reject(request.error)});
}
const MOBILE_DENIED_SEGMENTS = new Set(['credentials','credentials.json','credentials.jsonl','llm-deepseek','secrets','secrets.json','auth.json','token','tokens.json'])
function mobileAllowedPath(path) {
  if (!path.startsWith('/dsh/home/') && !path.startsWith('/dsh/workspace/')) return false
  return !path.split('/').filter(Boolean).some(segment => segment.startsWith('.') || MOBILE_DENIED_SEGMENTS.has(segment.toLowerCase()))
}
async function mobileRestore(vfs) {
  const entries = await mobileReadState();
  for (const item of entries) {
    if(!mobileAllowedPath(item.path)) continue;
    const metadata={mode:item.mode ?? (item.directory?0o755:0o600),mtimeMs:item.mtimeMs ?? Date.now()};
    if(item.directory) vfs.seedDirectory(item.path,metadata);
    else {vfs.seedDirectory(item.path.slice(0,item.path.lastIndexOf('/')));vfs.seed(item.path,new Uint8Array(item.bytes),metadata)}
  }
}
function mobileCollect(vfs, root, output) {
  if(!vfs.existsSync(root)) return;
  for(const name of vfs.readdirSync(root)) {
    const path=root+'/'+name;if(!mobileAllowedPath(path)) continue;
    const stat=vfs.statSync(path);const metadata={mode:stat.mode & 0o777,mtimeMs:stat.mtimeMs};
    if(stat.isDirectory()){output.push({path,directory:true,...metadata});mobileCollect(vfs,path,output)}
    else output.push({path,bytes:new Uint8Array(vfs.readFileSync(path)).slice(),...metadata});
  }
}
async function mobilePersist(vfs) {
  clearTimeout(mobileSaveTimer);
  mobileSavePending=mobileSavePending.catch(()=>{}).then(async()=>{
    const entries=[];mobileCollect(vfs,'/dsh/home',entries);mobileCollect(vfs,'/dsh/workspace',entries);
    const db=await mobileDb();
    await new Promise((resolve,reject)=>{const tx=db.transaction('state','readwrite');tx.objectStore('state').put(entries,'filesystem');tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error || new Error('本地保存失败'))});
  });
  return mobileSavePending;
}
function mobileFileSystem(vfs) {
  return {
    root:'/dsh/workspace',
    list:()=>{const all=[];mobileCollect(vfs,'/dsh/workspace',all);return all.filter(x=>!x.directory).map(x=>({path:x.path,text:new TextDecoder().decode(x.bytes)}))},
    write:async(name,text)=>{
      const leaf=String(name).replaceAll('\\','/').split('/').pop();
      if(!leaf || leaf==='.' || leaf==='..' || /[\0-\x1f]/.test(leaf) || typeof text!=='string' || text.length>2*1024*1024) throw new Error('文件无效或超过 2 MB');
      const path='/dsh/workspace/'+leaf;
      vfs.mkdirSync('/dsh/workspace',{recursive:true});vfs.writeFileSync(path,text);await mobilePersist(vfs);return {path};
    },
    flush:()=>mobilePersist(vfs)
  };
}
function mobileBind(created) {
  created.vfs.subscribe(mutation=>{if(mobileAllowedPath(mutation.path)){clearTimeout(mobileSaveTimer);mobileSaveTimer=setTimeout(()=>{void mobilePersist(created.vfs).catch(()=>self.postMessage({t:'mobile-storage-error',error:'设备存储已满，请导出重要文件'}))},180)}});
}
async function mobileRpc(data) {
  if(data.operation==='abort'){mobileRequests.get(data.input?.id)?.abort();return}
  const abort=new AbortController();mobileRequests.set(data.id,abort);
  try {
    await mobileHostReady;
    if(!host?.context || !host.vfs) throw new Error('手机 Harness 尚未启动');
    const result=await dispatchOperation(host.context,mobileFileSystem(host.vfs),data.operation,data.input || {},frame=>self.postMessage({t:'mobile-event',id:data.id,frame}),abort.signal);
    if(['create','send','write','flush'].includes(data.operation)) {
      await host.context.get('sessionPersistence')?.flush();
      await mobilePersist(host.vfs);
    }
    self.postMessage({t:'mobile-result',id:data.id,result});
  } catch(error) {const cause = error?.cause?.message || error?.cause?.cause?.message; self.postMessage({t:'mobile-result',id:data.id,error:(error?.message || String(error)) + (cause ? '（原因：' + cause + '）' : '')})}
  finally {mobileRequests.delete(data.id)}
}
/* 主页面在 pagehide / 原生进入后台时调用：把内存 VFS 与会话持久化立刻落盘。 */
globalThis.__dshFlushAll = async function () {
  try {
    if (host?.vfs) await mobilePersist(host.vfs)
    const persistence = host?.context?.get('sessionPersistence')
    if (persistence?.flush) await persistence.flush()
    return { saved: true }
  } catch (error) {
    return { saved: false, error: error?.message || String(error) }
  }
}
