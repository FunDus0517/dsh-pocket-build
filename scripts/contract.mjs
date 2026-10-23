import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
const [root = '.', expected = 'modified'] = process.argv.slice(2)
const c = JSON.parse(readFileSync(resolve(root, 'src/capabilities.json'), 'utf8'))
if (expected === 'baseline') {
  assert.equal(c.mobileLocal, false); assert.equal(c.desktopRemote, false); assert.equal(c.interface, 'baseline')
  console.log('BASELINE: local=false; remote=false; ui=baseline')
} else {
  assert.equal(c.mobileLocal, true); assert.equal(c.desktopRemote, true); assert.equal(c.interface, 'mobile-chat')
  console.log('MODIFIED: local=true; remote=true; ui=mobile-chat')
}
