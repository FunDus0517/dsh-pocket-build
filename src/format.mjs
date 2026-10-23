/** Pure rendering and connection parsers shared with the regression suite. */
export function parseConnection(raw) {
  let url
  try { url = new URL(raw.trim()) } catch { throw new Error('请输入完整的桌面地址') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('桌面地址需要使用 http 或 https')
  const fragment = new URLSearchParams(url.hash.slice(1))
  const token = fragment.get('token') || ''
  url.hash = ''; url.search = ''
  return { endpoint: url.origin, token }
}
export function blocksText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n')
}
export function safeFileName(name) {
  const leaf = String(name).replaceAll('\\', '/').split('/').pop() || 'file.txt'
  if (leaf === '.' || leaf === '..' || /[\0-\x1f]/.test(leaf)) throw new Error('文件名无效')
  return leaf
}
export function exportChat(chat) {
  return '# ' + chat.title + '\n\n' + chat.messages.filter(m => !m.pending).map(m => `## ${m.role === 'user' ? '你' : m.role === 'tool' ? '工具 · ' + (m.tool || '') : 'DSH'}\n\n${m.text}`).join('\n\n') + '\n'
}
/** Split fenced code without interpreting untrusted HTML. */
export function splitMarkdown(text) {
  const parts = []; const re = /```([^\n`]*)\n([\s\S]*?)(?:```|$)/g; let start = 0; let m
  while ((m = re.exec(text))) { if(m.index > start) parts.push({type:'text', text:text.slice(start,m.index)}); parts.push({type:'code', language:m[1].trim(), text:m[2].replace(/\n$/,'')}); start = re.lastIndex }
  if(start < text.length) parts.push({type:'text',text:text.slice(start)})
  return parts
}
/**
 * 桌面连接地址归一化：主地址与备用地址合并后统一成去重、合法的 http(s) origin 列表。
 * 输入可以是字符串（换行 / 逗号 / 分号 / 中文逗号分隔）或字符串数组；无效项直接丢弃。
 */
export function normalizeEndpointList(value) {
  const raw = Array.isArray(value) ? value.filter(item => typeof item === 'string').join('\n') : typeof value === 'string' ? value : ''
  const endpoints = []
  const seen = new Set()
  for (const part of raw.split(/[\n,;，]/)) {
    const item = part.trim()
    if (!item) continue
    let url
    try { url = new URL(item) } catch { continue }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue
    const origin = url.origin
    if (!origin || origin === 'null' || seen.has(origin)) continue
    seen.add(origin)
    endpoints.push(origin)
  }
  return endpoints
}
/** 按顺序探测候选地址，返回第一个可达项；全部失败或抛错时返回 null（单项异常不影响后续）。 */
export async function pickReachableEndpoint(candidates, probe) {
  if (!Array.isArray(candidates) || typeof probe !== 'function') return null
  for (const candidate of candidates) {
    try { if (await probe(candidate)) return candidate } catch { /* 单项探测失败，继续下一个候选 */ }
  }
  return null
}

