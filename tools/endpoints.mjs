/** Desktop connector endpoint candidates (pure helpers, unit-tested). */

/** 100.64.0.0/10 CGNAT（部分 VPN/组网虚拟网卡会占用，不应作为局域网候选）。 */
export function isCgnatAddress(address) {
  return /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(String(address || ''))
}

/**
 * 生成手机端候选地址（按优先级排序、去重）。
 * mode: auto | lan | cloudflare
 */
export function collectDesktopEndpoints({ lanAddresses = [], relayUrl = '', tunnelUrl = '', port, mode = 'auto' }) {
  const numericPort = Number(port)
  if (!Number.isInteger(numericPort) || numericPort <= 0 || numericPort > 65535) throw new Error('无效端口：' + port)
  const lanRank = address => address.startsWith('192.168.') ? 0 : address.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(address) ? 2 : 3
  const lan = [...new Set(lanAddresses)]
    .filter(address => /^\d+\.\d+\.\d+\.\d+$/.test(String(address)) && !isCgnatAddress(address) && !String(address).startsWith('169.254.'))
    .sort((left, right) => lanRank(left) - lanRank(right))
  const out = []
  const push = (url, kind, label) => {
    const value = String(url || '').replace(/\/+$/, '')
    if (value && !out.some(item => item.url === value)) out.push({ url: value, kind, label })
  }
  if (mode === 'lan' || mode === 'auto') for (const address of lan) push('http://' + address + ':' + numericPort, 'lan', '局域网')
  if (relayUrl) push(relayUrl, 'relay', '公网中转')
  if ((mode === 'auto' || mode === 'cloudflare') && tunnelUrl) push(tunnelUrl, 'cloudflare', 'Cloudflare HTTPS')
  return out
}
