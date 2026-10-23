import {existsSync} from 'node:fs'
import {resolve,join} from 'node:path'
const root=resolve(import.meta.dirname,'..')
const required=['public/runtime/mobile-worker.js','public/runtime/vfs-image.bin','public/runtime/build.json']
const missing=required.filter(file=>!existsSync(join(root,file)))
if(missing.length){
  console.error('缺少手机运行时资产：'+missing.join(', '))
  console.error('请先运行 npm run runtime:pack（或 npm run ios:prepare）')
  process.exit(1)
}
console.log('手机运行时资产已就绪')
