import test from 'node:test'
import assert from 'node:assert/strict'
import { collectDesktopEndpoints, isCgnatAddress } from '../tools/endpoints.mjs'

test('detects cgnat addresses', () => {
  assert.equal(isCgnatAddress('100.66.220.13'), true)
  assert.equal(isCgnatAddress('100.127.255.254'), true)
  assert.equal(isCgnatAddress('192.168.1.5'), false)
  assert.equal(isCgnatAddress('10.0.0.8'), false)
  assert.equal(isCgnatAddress('100.128.0.1'), false)
})

test('auto mode: lan first (home ranges), then tunnel, deduped', () => {
  const list = collectDesktopEndpoints({
    lanAddresses: ['172.18.0.1', '100.66.220.13', '10.0.0.8', '192.168.1.5', '192.168.1.5'],
    tunnelUrl: 'https://random-words.trycloudflare.com/',
    port: 3090,
    mode: 'auto'
  })
  assert.deepEqual(list.map(item => item.url), [
    'http://192.168.1.5:3090',
    'http://10.0.0.8:3090',
    'http://172.18.0.1:3090',
    'https://random-words.trycloudflare.com'
  ])
  assert.deepEqual(list.map(item => item.kind), ['lan', 'lan', 'lan', 'cloudflare'])
})

test('relay url is added after lan addresses', () => {
  const list = collectDesktopEndpoints({ lanAddresses: ['192.168.1.5'], relayUrl: 'http://103.85.227.144:30500', port: 3090, mode: 'lan' })
  assert.deepEqual(list.map(item => item.url), ['http://192.168.1.5:3090', 'http://103.85.227.144:30500'])
  assert.equal(list[1].kind, 'relay')
})

test('lan mode excludes tunnel and validates port', () => {
  const list = collectDesktopEndpoints({ lanAddresses: ['192.168.1.5'], tunnelUrl: 'https://x.trycloudflare.com', port: 3090, mode: 'lan' })
  assert.deepEqual(list.map(item => item.url), ['http://192.168.1.5:3090'])
  assert.throws(() => collectDesktopEndpoints({ port: 0 }))
  assert.throws(() => collectDesktopEndpoints({ port: 70000 }))
})

test('cloudflare mode only returns tunnel url', () => {
  const list = collectDesktopEndpoints({ lanAddresses: ['192.168.1.5'], tunnelUrl: 'https://x.trycloudflare.com', port: 3091, mode: 'cloudflare' })
  assert.deepEqual(list.map(item => item.url), ['https://x.trycloudflare.com'])
})
