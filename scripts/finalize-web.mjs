import {readFileSync,writeFileSync,readdirSync,cpSync,mkdirSync,existsSync,rmSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {createHash} from 'node:crypto'
const root=resolve(import.meta.dirname,'..')
const dist=join(root,'dist')
const required=['/runtime/mobile-worker.js','/runtime/vfs-image.bin']
for(const asset of required){
  if(!existsSync(join(dist,asset))) throw new Error('缺少手机运行时资产 '+asset+'：请先运行 npm run runtime:pack')
}
const assets=['/','/index.html','/icon.svg','/icon-192.png','/icon-512.png','/manifest.webmanifest',...required,'/runtime/build.json',...readdirSync(join(dist,'assets')).map(n=>'/assets/'+n)]
const hash=createHash('sha256')
for(const asset of assets){
  hash.update(asset)
  hash.update(readFileSync(join(dist,asset==='/'?'index.html':asset)))
}
const version=hash.digest('hex').slice(0,12)
const source=`const CACHE='dsh-mobile-${version}';const ASSETS=${JSON.stringify(assets)};self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting())));self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('dsh-mobile-')&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));self.addEventListener('fetch',event=>{const url=new URL(event.request.url);if(event.request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/bridge/'))return;if(!ASSETS.includes(url.pathname)&&event.request.mode!=='navigate')return;event.respondWith(fetch(event.request).catch(()=>caches.match(event.request).then(cached=>cached||(event.request.mode==='navigate'?caches.match('/index.html'):Response.error()))))});`
writeFileSync(join(dist,'sw.js'),source)
const native=join(root,'ios/DSHPocket/Web');rmSync(native,{recursive:true,force:true});mkdirSync(native,{recursive:true});cpSync(dist,native,{recursive:true})
console.log('PWA cache prepared; iPhone Web bundle embedded ('+assets.length+' assets).')
