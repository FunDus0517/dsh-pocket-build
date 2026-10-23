import type { Chat } from './types'
// V2 落盘格式：{"v":2,"chats":[...]}。读取时兼容 V1 裸数组，下一次保存自动升级。
const KEY = 'dsh-mobile-chats-v2'
const LEGACY_KEY = 'dsh-mobile-chats-v1'
const BACKUP_KEY = 'dsh-mobile-chats-backup'
export function readLS(key: string): string | null { try { return localStorage.getItem(key) } catch { return null } }
export function writeLS(key: string, value: string): boolean { try { localStorage.setItem(key, value); return true } catch { return false } }
export function removeLS(key: string): void { try { localStorage.removeItem(key) } catch { /* 存储不可用时静默跳过 */ } }
const strip = (text: string) => String(text || '')
  .replace(/^【最高优先级：[\s\S]*?】\n\n/, '')
  .replace(/^【连接信息：[^\n]*】\n\n/, '')
  .replace(/^【系统要求：[^\n]*】\n\n/, '')
// 结构不合法时返回 null，由 loadChats 备份原文后返回空列表。
function normalize(data: unknown): Chat[] | null {
  let rows: any[] | null = null
  if (Array.isArray(data)) rows = data
  else if (data && typeof data === 'object' && Array.isArray((data as any).chats)) rows = (data as any).chats
  if (!rows) return null
  return rows.filter(c => c && typeof c.id === 'string' && Array.isArray(c.messages)).map(chat => ({
    ...chat,
    messages: chat.messages.map((message: any) => message && message.role === 'user' ? { ...message, text: strip(message.text) } : message)
  }))
}
function backup(raw: string) { writeLS(BACKUP_KEY, raw) }
export function loadChats(): Chat[] {
  // 优先新 KEY；仅当新 KEY 不存在时才回退旧 KEY（旧格式为裸数组）。
  const raw = readLS(KEY) ?? readLS(LEGACY_KEY)
  if (raw === null) return []
  let data: unknown
  try { data = JSON.parse(raw) } catch { backup(raw); return [] }
  const chats = normalize(data)
  if (!chats) { backup(raw); return [] }
  return chats
}
export function saveChats(chats: Chat[]): boolean {
  // 图片与整份 HTML 预览不落盘，避免 base64 把 localStorage 配额撑爆导致白屏。
  const safe = chats.map(chat => ({ ...chat, messages: chat.messages.map(message => { const { images: _images, html: _html, ...rest } = message; return rest }) }))
  const payload = (rows: Chat[]) => JSON.stringify({ v: 2, chats: rows })
  // 按 [全量, 一半, 10, 3] 逐级降量重试；永不 removeItem（删库会造成历史永久丢失）。
  const counts = [safe.length, Math.ceil(safe.length / 2), 10, 3].map(count => Math.max(0, Math.min(count, safe.length)))
  for (const count of [...new Set(counts)]) if (count > 0 || !safe.length) { if (writeLS(KEY, payload(safe.slice(0, count)))) { removeLS(LEGACY_KEY); return true } }
  return false
}
export function download(name: string, data: string, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([data], { type })); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 2000)
}
export function uid() { return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('') }
