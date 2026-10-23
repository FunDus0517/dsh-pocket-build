import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Menu, SquarePen, ChevronDown, Plus, ArrowUp, Square, X, Camera, Image as ImageIcon, Monitor, Smartphone, ArrowRight, Check, Settings2, Search, MessageCircle, Code2, FolderOpen, FileText, Sparkles, Copy, Download, Sun, Moon, Laptop, CheckCheck, ArrowLeft, ExternalLink, Cable, ChevronRight, Paperclip, Trash2, WifiOff, Loader2, MoreHorizontal, CircleHelp, ShieldCheck, RefreshCw } from 'lucide-react'
import type { Chat, Harness, Message, Preferences, RunMode, RuntimeState } from './types'
import { loadChats, saveChats, readLS, writeLS, download, uid } from './storage'
import { parseConnection, splitMarkdown, exportChat, normalizeEndpointList, pickReachableEndpoint } from './format.mjs'
import { createHarness } from './harness'
import capabilities from './capabilities.json'
type ModelEntry = { id: string; name: string; description?: string; efforts: { id: string; name: string; description?: string }[]; defaultEffort?: string }

const suggestions = [
  { icon: Code2, label: '写点代码', hint: '把想法变成现实', prompt: '帮我写一个简洁的番茄钟网页，保存为 index.html。' },
  { icon: FolderOpen, label: '梳理项目', hint: '理清文件与思路', prompt: '请检查当前工作区，列出文件并解释项目结构。' },
  { icon: FileText, label: '分析文件', hint: '提炼重要信息', prompt: '请阅读我导入的文件，整理重点和下一步建议。' },
  { icon: Sparkles, label: '一起想想', hint: '从一个问题开始', prompt: '我有一个新想法，想和你一起推敲。' },
]
// 不再从公开仓库自动发现桌面连接器（旧方案会把 endpoint/token 公开）。
// 如确实需要自动发现，只能显式传入自己控制的私有地址：?discovery=<url>
const explicitDiscoveryUrl = new URLSearchParams(location.search).get('discovery')
const discoveryCandidates = explicitDiscoveryUrl ? [explicitDiscoveryUrl] : []
// 个人构建（CI 通过 VITE_DSH_* 注入）可把局域网/中转地址与令牌编进 App：安装后免配置。
// 公开仓库的普通构建不注入这些变量，行为与之前一致。
const bakedEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env || {}
const BAKED_LAN_ENDPOINT = String(bakedEnv.VITE_DSH_LAN_ENDPOINT || '').trim()
const BAKED_RELAY_ENDPOINT = String(bakedEnv.VITE_DSH_RELAY_ENDPOINT || '').trim()
const BAKED_TOKEN = String(bakedEnv.VITE_DSH_RELAY_TOKEN || '').trim()
const BAKED_DESKTOP_DEFAULT = Boolean(BAKED_TOKEN && (BAKED_LAN_ENDPOINT || BAKED_RELAY_ENDPOINT))
// 预置包首次启动后会写入这个标记：之后 Web 包从服务器更新（不再内置配置）仍保持「默认桌面 + 自动连接」。
const AUTO_DESKTOP = BAKED_DESKTOP_DEFAULT || readLS('dsh-mobile-autodesktop') === '1'
const storedTheme = readLS('dsh-mobile-theme') as Preferences['theme'] | null
const sessionToken = (() => { try { return sessionStorage.getItem('dsh-mobile-token') || '' } catch { return '' } })()
// 预置构建（BAKED_*）优先级最高：覆盖旧版本残留在 localStorage 里的地址/令牌，保证升级后也免配置。
const defaultPrefs: Preferences = { theme: storedTheme || 'system', model: readLS('dsh-mobile-model') || '', apiKey: readLS('dsh-mobile-key') || '', baseUrl: readLS('dsh-mobile-baseurl') || 'https://api.deepseek.com', endpoint: BAKED_DESKTOP_DEFAULT ? (BAKED_LAN_ENDPOINT || BAKED_RELAY_ENDPOINT) : (readLS('dsh-mobile-endpoint') || ''), token: BAKED_DESKTOP_DEFAULT ? BAKED_TOKEN : (readLS('dsh-mobile-token') || sessionToken), reasoningEffort: readLS('dsh-mobile-effort') || '' }
function Mark({ small = false }: { small?: boolean }) {
  return <svg className={small ? 'mark small' : 'mark'} viewBox="0 0 48 48" fill="none" aria-label="DSH"><path d="M13 12h13a11 11 0 0 1 0 22H13V12Z" stroke="currentColor" strokeWidth="3.3"/><path d="M21 12v22M12 23h25M31 9v8M31 29v8" stroke="currentColor" strokeWidth="3.3" strokeLinecap="round"/></svg>
}
function CodeBlock({ part }: { part: { language?: string; text: string } }) {
  const isHtml = (part.language || '').toLowerCase() === 'html' || /^\s*<!doctype html/i.test(part.text)
  const [preview, setPreview] = useState(isHtml)
  return <div className="code-block">
    <div className="code-top"><span>{isHtml ? 'HTML 预览' : (part.language || '代码')}</span>
      <div className="code-actions">
        {isHtml && <button onClick={() => setPreview(!preview)}>{preview ? '查看代码' : '运行预览'}</button>}
        <button onClick={() => navigator.clipboard?.writeText(part.text)}><Copy size={13}/>复制</button>
      </div>
    </div>
    {isHtml && preview ? <iframe className="html-preview" sandbox="allow-scripts" srcDoc={part.text} title="HTML 预览"/> : <pre><code>{part.text}</code></pre>}
  </div>
}
const RichText = memo(function RichText({ text }: { text: string }) {
  const parts = useMemo(() => splitMarkdown(text), [text])
  return <div className="rich-text">{parts.map((part, i) => part.type === 'code' ? <CodeBlock key={i} part={part}/> : <div className="prose" key={i}>{part.text.split('\n').map((line: string, j: number) => /^#{1,3} /.test(line) ? <h3 key={j}>{line.replace(/^#{1,3} /, '')}</h3> : <div key={j}>{line.split(/(\*\*[^*]+\*\*|`[^`]+`)/).map((p: string, k: number) => p.startsWith('**') ? <strong key={k}>{p.slice(2, -2)}</strong> : p.startsWith('`') ? <code key={k}>{p.slice(1, -1)}</code> : p)}{!line && <br/>}</div>)}</div>)}</div>
})
const MessageView = memo(function MessageView({ message, reasoningOpen, onReasoningToggle, onEdit }: { message: Message; reasoningOpen: boolean; onReasoningToggle: (open: boolean) => void; onEdit?: (message: Message) => void }) {
  const [copied, setCopied] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const sourceUrls = [...new Set([
    ...(message.tools || []).flatMap(tool => (tool.text || '').match(/https?:\/\/[^\s"'<>)\\]+/g) || []),
    ...[...message.text.matchAll(/\]\((https?:\/\/[^)]+)\)/g)].map(match => match[1])
  ].map(url => url.replace(/[.,;)]+$/, '')).filter(url => /^https?:\/\//.test(url)))].slice(0, 6)
  const pressTimer = useRef<number | null>(null)
  const startPress = () => { if (!onEdit) return; pressTimer.current = window.setTimeout(() => onEdit(message), 520) }
  const cancelPress = () => { if (pressTimer.current !== null) { window.clearTimeout(pressTimer.current); pressTimer.current = null } }
  if (message.role === 'tool') return null
  return <article className={`message ${message.role} ${message.error ? 'message-error' : ''}`} onPointerDown={startPress} onPointerUp={cancelPress} onPointerCancel={cancelPress} onPointerLeave={cancelPress}>
    {message.role === 'assistant' && <div className="assistant-name"><Mark small/><span>DSH</span></div>}
    {message.role === 'assistant' && (message.reasoning || message.tools?.length) ? <details className="reasoning" open={reasoningOpen} onToggle={e=>onReasoningToggle(e.currentTarget.open)}><summary><Sparkles size={14}/>思考过程{message.tools?.length ? ' · ' + message.tools.length + ' 次工具' : ''}<ChevronDown size={12}/></summary>{message.reasoning ? <p>{message.reasoning}</p> : null}{message.tools?.map(tool=><div className="tool-inline" key={tool.id}><span>{tool.tool || '工具'}</span><pre>{tool.text}</pre></div>)}</details> : null}
    <RichText text={message.text.replace(/\/dsh\/workspace\/[^\s`]+\.html?/gi, '').trim()}/>
    {message.images?.map((src, index)=><img className="message-image" src={src} alt={`图片 ${index + 1}`} key={index}/>)}
    {message.html && <iframe className="html-preview message-preview" sandbox="allow-scripts" srcDoc={message.html.text} title={message.html.name}/>} 
    {message.pending && !message.text && <span className="typing"><i/><i/><i/></span>}
    {message.role === 'assistant' && !message.pending && message.text && sourceUrls.length > 0 && <div className="message-sources"><span>来源</span>{sourceUrls.map(url => { let host = url; try { host = new URL(url).hostname } catch {} ; return <a key={url} href={url} target="_blank" rel="noreferrer">{host}</a> })}</div>}
    {message.role === 'assistant' && !message.pending && message.text && <div className="message-actions"><button aria-label="更多操作" onClick={()=>setMenuOpen(value=>!value)}><MoreHorizontal size={18}/></button>{menuOpen && <div className="message-more-menu"><button onClick={async (e) => { e.stopPropagation(); await navigator.clipboard?.writeText(message.text); setCopied(true); setMenuOpen(false); setTimeout(() => setCopied(false), 1800) }}>{copied ? <CheckCheck size={16}/> : <Copy size={16}/>}复制回复</button></div>}</div>}
  </article>
})

function applyOverrides(messages: Message[], overrides?: Chat['overrides']): Message[] {
  if (!overrides) return messages
  return messages.map(message => { const override = overrides[message.id]; return override && typeof override.text === 'string' ? { ...message, text: override.text } : message })
}
export default function App() {
  const [chats, setChats] = useState<Chat[]>(loadChats)
  const [active, setActive] = useState<string | null>(null)
  const [mode, setMode] = useState<RunMode>(AUTO_DESKTOP ? 'desktop' : 'phone')
  const [prefs, setPrefs] = useState(defaultPrefs)
  const [drawer, setDrawer] = useState(false)
  const [sheet, setSheet] = useState<'connect' | 'settings' | 'files' | 'model' | 'about' | null>(null)
  const [search, setSearch] = useState('')
  const [draft, setDraft] = useState('')
  // 双运行时：手机本机与桌面远程各自维护 busy / 状态，互不打断（可同时生成）。
  const [busyModes, setBusyModes] = useState<Record<RunMode, boolean>>({ phone: false, desktop: false })
  const [statusByMode, setStatusByMode] = useState<Record<RunMode, RuntimeState>>({ phone: 'idle', desktop: 'idle' })
  const [statusTextByMode, setStatusTextByMode] = useState<Record<RunMode, string>>({ phone: '', desktop: '' })
  const setBusyFor = (target: RunMode, value: boolean) => setBusyModes(current => current[target] === value ? current : { ...current, [target]: value })
  const setStatusFor = (target: RunMode, state: RuntimeState, text = '') => { setStatusByMode(current => current[target] === state ? current : { ...current, [target]: state }); setStatusTextByMode(current => current[target] === text ? current : { ...current, [target]: text }) }
  const [notice, setNotice] = useState('')
  const [balance, setBalance] = useState<{ currency: string; total: string } | null>(null)
  const [balanceStatus, setBalanceStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [remoteUrl, setRemoteUrl] = useState(prefs.endpoint)
  const [remoteToken, setRemoteToken] = useState(prefs.token)
  // 桌面可能同时有局域网 / Cloudflare 等多个地址：备用地址逐行保存，连接时自动选可达的。
  const [backupEndpoints, setBackupEndpoints] = useState(() => BAKED_DESKTOP_DEFAULT ? BAKED_RELAY_ENDPOINT : (readLS('dsh-mobile-endpoints') || ''))
  const [connected, setConnected] = useState(false)
  const [discovery, setDiscovery] = useState<{endpoint?:string;token?:string;updated?:string} | null>(null)
  const [discoveryState, setDiscoveryState] = useState<'idle'|'loading'|'ready'|'error'>('idle')
  const [discoveryError, setDiscoveryError] = useState('')
  const [files, setFiles] = useState<{path:string;text:string}[]>([])
  const [chosenFile, setChosenFile] = useState<{path:string;text:string} | null>(null)
  const [models, setModels] = useState<ModelEntry[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsError, setModelsError] = useState('')
  const [filesLoading, setFilesLoading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [displayName, setDisplayName] = useState(() => readLS('dsh-mobile-name') || 'DeepSeek Harness')
  const [userName, setUserName] = useState(() => readLS('dsh-mobile-user-name') || '朋友')
  const runtimes = useRef<Partial<Record<RunMode, Harness>>>({})
  const runtimePromises = useRef<Partial<Record<RunMode, Promise<Harness>>>>({})
  const controllers = useRef<Record<RunMode, AbortController | null>>({ phone: null, desktop: null })
  const busyRefs = useRef<Record<RunMode, boolean>>({ phone: false, desktop: false })
  const streams = useRef<Record<RunMode, { text: string; reasoning: string; raf: number | null }>>({ phone: { text: '', reasoning: '', raf: null }, desktop: { text: '', reasoning: '', raf: null } })
  const busy = busyModes[mode]
  const status = statusByMode[mode]
  const statusText = statusTextByMode[mode]
  const scroll = useRef<HTMLDivElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const cameraInput = useRef<HTMLInputElement>(null)
  const photoInput = useRef<HTMLInputElement>(null)
  const swipeStart = useRef<{x:number;y:number} | null>(null)
  const swipeHandled = useRef(false)
  const stickBottom = useRef(true)
  const [sheetClosing, setSheetClosing] = useState(false)
  const ignoreClickUntil = useRef(0)
  const lastGestureRef = useRef(0)
  const drawerShiftRef = useRef(0)
  const [drawerShift, setDrawerShift] = useState<number | null>(null)
  const sheetDragStart = useRef<number | null>(null)
  const sheetDragRef = useRef(0)
  const [sheetDrag, setSheetDrag] = useState(0)
  const modeRef = useRef<RunMode>('phone')
  // online / visibilitychange 监听里读取最新状态，避免闭包拿到旧值。
  const desktopStatusRef = useRef<RuntimeState>('idle')
  const autoSwitchRef = useRef(false)
  const connectRef = useRef(false)
  const [translating, setTranslating] = useState<Record<string, boolean>>({})
  const [pendingImages, setPendingImages] = useState<{ name: string; mediaType: string; data: string }[]>([])
  const [imageMenuOpen, setImageMenuOpen] = useState(false)
  const [reasoningOpen, setReasoningOpen] = useState(false)
  const [showJump, setShowJump] = useState(false)
  const [editing, setEditing] = useState<{ chatId: string; messageId: string; text: string } | null>(null)
  const pendingEditRef = useRef<{ chatId: string; messageId: string } | null>(null)
  const pendingSendTextRef = useRef<string | null>(null)
  const chat = chats.find(c => c.id === active)
  const hasMessages = !!chat?.messages.length
  const saveFailedRef = useRef(false)
  useEffect(() => {
    const timer = setTimeout(() => {
      const ok = saveChats(chats)
      if (!ok && !saveFailedRef.current) {
        saveFailedRef.current = true
        setNotice('本地存储空间不足：历史已停止保存，图片不会保存。可删除旧会话后重试。')
      }
    }, 450)
    return () => clearTimeout(timer)
  }, [chats])
  useEffect(() => { modeRef.current = mode }, [mode])
  useEffect(() => { desktopStatusRef.current = statusByMode.desktop }, [statusByMode.desktop])
  useEffect(() => {
    const scrollToBottom = () => requestAnimationFrame(() => scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' }))
    if ((window as any).__dshNativeBridge) {
      document.documentElement.classList.add('native-app')
      return
    }
    let nativeInset = 0
    const apply = (inset: number) => {
      document.documentElement.style.setProperty('--keyboard-inset', Math.max(0, Math.round(inset)) + 'px')
      if (inset > 60) scrollToBottom()
    }
    const visualInset = () => {
      const viewport = window.visualViewport
      if (!viewport) return 0
      return Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)
    }
    const applyMax = () => apply(Math.max(nativeInset, visualInset()))
    ;(window as any).__dshSetKeyboard = (inset: number) => { nativeInset = inset || 0; applyMax() }
    const viewport = window.visualViewport
    if (viewport) {
      viewport.addEventListener('resize', applyMax)
      viewport.addEventListener('scroll', applyMax)
    }
    applyMax()
    return () => {
      delete (window as any).__dshSetKeyboard
      if (viewport) { viewport.removeEventListener('resize', applyMax); viewport.removeEventListener('scroll', applyMax) }
    }
  }, [])
  useEffect(() => { document.documentElement.dataset.theme = prefs.theme; writeLS('dsh-mobile-theme', prefs.theme) }, [prefs.theme])
  useEffect(() => {
    const timer = setTimeout(() => { void refreshBalance() }, 900)
    return () => clearTimeout(timer)
  }, [prefs.apiKey, prefs.baseUrl])
  useEffect(() => { writeLS('dsh-mobile-key', prefs.apiKey); writeLS('dsh-mobile-effort', prefs.reasoningEffort || ''); writeLS('dsh-mobile-name', displayName); writeLS('dsh-mobile-user-name', userName); try { sessionStorage.setItem('dsh-mobile-token', prefs.token) } catch { /* 隐私模式下忽略 */ }; if (AUTO_DESKTOP) writeLS('dsh-mobile-token', prefs.token); writeLS('dsh-mobile-endpoint', prefs.endpoint); writeLS('dsh-mobile-model', prefs.model); writeLS('dsh-mobile-baseurl', prefs.baseUrl) }, [prefs.apiKey, prefs.token, prefs.endpoint, prefs.model, prefs.baseUrl, prefs.reasoningEffort, userName, displayName])
  // 启动时如有 Key，校验并刷新官方模型目录
  useEffect(() => { if (prefs.apiKey.trim()) void fetchModels(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [])
  // 原生文件选择回调（Swift bridge）
  useEffect(() => {
    (window as any).__dshFilePicked = (name: string, text: string) => { void importTextFile(name, text).catch(error => notify(error instanceof Error ? error.message : '导入失败')) }
    (window as any).__dshFileError = (message: string) => notify(message || '导入失败')
    return () => { delete (window as any).__dshFilePicked; delete (window as any).__dshFileError }
  }, [mode, prefs.apiKey, prefs.baseUrl])
  // 打开模型面板时若目录为空则自动刷新
  useEffect(() => { if (sheet === 'model' && prefs.apiKey.trim() && !models.length && !modelsLoading) void fetchModels(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [sheet])

  useEffect(() => { if(notice) { const id = setTimeout(() => setNotice(''), 4200); return () => clearTimeout(id) } }, [notice])
  useEffect(() => { if (!draft && textarea.current) textarea.current.style.height = 'auto' }, [draft])
  useEffect(() => { const element = scroll.current; if (!element) return; if (!busy && !stickBottom.current) return; element.scrollTo({ top: element.scrollHeight, behavior: busy ? 'auto' : 'smooth' }); if (busy) setShowJump(false) }, [chat?.messages.length, chat?.messages.at(-1)?.text, chat?.messages.at(-1)?.reasoning, statusText, busy])
  useEffect(() => { document.body.style.overflow = drawer || sheet ? 'hidden' : ''; return () => { document.body.style.overflow = '' } }, [drawer, sheet])
  useEffect(() => { const handler = (e: KeyboardEvent) => { if(e.key === 'Escape') { if (sheet) dismissSheet(); else closeDrawer() } }; document.addEventListener('keydown', handler); return () => document.removeEventListener('keydown', handler) }, [sheet, drawer])
  useEffect(() => () => { for (const control of Object.values(controllers.current)) control?.abort(); for (const stream of Object.values(streams.current)) if (stream.raf !== null) { cancelAnimationFrame(stream.raf); stream.raf = null } for (const harness of Object.values(runtimes.current)) harness?.dispose() }, [])
  // 页面隐藏时让运行中内核把会话日志 flush 到持久层；没有 harness 时静默跳过。
  useEffect(() => {
    // iOS 侧会 await 这个 Promise 再结束后台任务；没有 harness / flush 失败时静默 resolve。
    ;(window as any).__dshFlushAll = () => Promise.all(Object.values(runtimes.current).map(harness => harness ? harness.flush().catch(() => {}) : Promise.resolve())).then(() => {})
    const flushAll = () => { void ((window as any).__dshFlushAll() as Promise<void>) }
    window.addEventListener('pagehide', flushAll)
    return () => { window.removeEventListener('pagehide', flushAll); delete (window as any).__dshFlushAll }
  }, [])
  useEffect(() => { if(location.hash.startsWith('#token=')) {setRemoteUrl(location.origin); setRemoteToken(new URLSearchParams(location.hash.slice(1)).get('token') || ''); setSheet('connect'); history.replaceState(null, '', location.pathname)} }, [])
  // 自动发现电脑连接器：App 启动时读取固定 JSON，拿到 endpoint + token。
  useEffect(() => { void refreshDiscovery() }, [])
  // 个人构建预置了地址与令牌时：启动后自动连接，失败按 5s/15s/30s 退避重试，直到连上或切到手机模式。
  const connectedRef = useRef(false)
  useEffect(() => { connectedRef.current = connected }, [connected])
  useEffect(() => {
    if (!AUTO_DESKTOP) return
    let timer: number | undefined
    let index = 0
    const delays = [800, 5000, 15000, 30000]
    const tick = () => {
      if (connectedRef.current || modeRef.current !== 'desktop') return
      void connect()
      index = Math.min(index + 1, delays.length - 1)
      timer = window.setTimeout(tick, delays[index])
    }
    timer = window.setTimeout(tick, delays[0])
    return () => { if (timer) window.clearTimeout(timer) }
  }, [])
  // 预置构建启动时把地址写回本地存储，避免旧版本残留值干扰后续手动操作。
  useEffect(() => {
    if (!BAKED_DESKTOP_DEFAULT) return
    writeLS('dsh-mobile-autodesktop', '1')
    writeLS('dsh-mobile-token', BAKED_TOKEN)
    writeLS('dsh-mobile-endpoint', BAKED_LAN_ENDPOINT || BAKED_RELAY_ENDPOINT)
    writeLS('dsh-mobile-endpoints', BAKED_RELAY_ENDPOINT)
  }, [])
  function zhError(text: string) {
    const message = String(text || '')
    const replacements: Array<[RegExp, string]> = [
      [/Authentication Fails[^。]*/i, 'API Key 无效或已过期'],
      [/invalid[_ ]?api[_ ]?key/i, 'API Key 无效'],
      [/Insufficient Balance|insufficient_quota/i, '账户余额不足'],
      [/Rate limit|rate_limit/i, '请求过于频繁，请稍后重试'],
      [/DeepSeek API stream from (\S+) failed/i, '连接 DeepSeek 失败（网络或流式响应中断）'],
      [/DeepSeek API request to (\S+) failed/i, '无法连接 DeepSeek（请检查网络）'],
      [/API error \(HTTP (\d+)\)/i, 'API 返回错误（HTTP $1）'],
      [/stream idle timeout[^。]*/i, '流式响应超时'],
      [/network|fetch failed|Load failed/i, '网络请求失败'],
      [/The operation was aborted|AbortError/i, '已停止生成'],
    ]
    let output = message
    for (const [pattern, value] of replacements) output = output.replace(pattern, value)
    return output || '操作失败，请重试'
  }
  const notify = (text: string) => setNotice(zhError(text))
  // 网络变化（家里 Wi-Fi <-> 蜂窝 / Tailscale）时自动从候选地址里挑可达的桌面地址，静默切换。
  useEffect(() => {
    async function maybeSwitch() {
      if (!connected || busyModes.desktop || busyRefs.current.desktop || !runtimes.current.desktop || autoSwitchRef.current || connectRef.current) return
      const token = prefs.token
      if (!token) return
      const candidates = normalizeEndpointList([prefs.endpoint, backupEndpoints])
      if (!candidates.length) return
      autoSwitchRef.current = true
      try {
        const picked = await pickReachableEndpoint(candidates, (endpoint: string) => probeDesktop(endpoint, token))
        if (!picked || picked === prefs.endpoint) return
        const desktopRuntime = runtimes.current.desktop
        if (!desktopRuntime) return
        desktopRuntime.dispose()
        delete runtimes.current.desktop
        setStatusFor('desktop', 'idle')
        setPrefs(current => ({ ...current, endpoint: picked }))
        await ensureRuntime('desktop', { ...prefs, endpoint: picked, token: prefs.token })
        notify('已自动切换桌面地址：' + picked)
      } catch {
        // 探测 / 切换失败时静默保留现有连接，不弹错误。
      } finally {
        autoSwitchRef.current = false
      }
    }
    const onOnline = () => { void maybeSwitch() }
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      if (desktopStatusRef.current === 'error' || statusByMode.desktop === 'error') void maybeSwitch()
    }
    window.addEventListener('online', onOnline)
    document.addEventListener('visibilitychange', onVisible)
    return () => { window.removeEventListener('online', onOnline); document.removeEventListener('visibilitychange', onVisible) }
  }, [connected, prefs.endpoint, prefs.token, backupEndpoints])
  // 仅在用户显式提供私有 discovery 地址时读取；默认不再访问公开仓库。
  async function refreshDiscovery() {
    if (!discoveryCandidates.length) { setDiscoveryState('idle'); setDiscoveryError(''); return }
    setDiscoveryState('loading'); setDiscoveryError('')
    for (const base of discoveryCandidates) {
      try {
        const separator = base.includes('?') ? '&' : '?'
        const response = await fetch(base + separator + 't=' + Date.now(), { cache: 'no-store' })
        if (!response.ok) continue
        let data: any = await response.json()
        if (data && typeof data.content === 'string') { try { data = JSON.parse(atob(data.content.replace(/\n/g, ''))) } catch { continue } }
        if (!data || !data.endpoint) continue
        setDiscovery({ endpoint: String(data.endpoint), token: String(data.token || ''), updated: data.updated })
        setRemoteUrl(String(data.endpoint))
        if (data.token) setRemoteToken(String(data.token))
        setDiscoveryState('ready')
        return
      } catch { /* try next candidate */ }
    }
    setDiscoveryState('error'); setDiscoveryError('指定的 discovery 地址不可用；请在「桌面 DSH」里手动填写 HTTPS 地址与令牌。')
  }
  // 从 API 的 /models 拉取可用模型；不内置、不写死任何模型名。
  // 校验 API Key 后从官方模型目录读取名称/描述/推理等级；不内置任何模型。
  async function fetchModels(apiKey = prefs.apiKey, baseUrl = prefs.baseUrl) {
    const key = apiKey.trim()
    const base = baseUrl.trim().replace(/\/+$/, '')
    if (!validApiBase(base)) { setModels([]); setModelsError('API 地址必须是 https://（本机调试可用 127.0.0.1 / localhost）'); return }
    if (!key) { setModels([]); setModelsError('先填写 API Key'); return }
    if (!base) { setModels([]); setModelsError('先填写 API 地址'); return }
    setModelsLoading(true); setModelsError('')
    try {
      const check = await fetch(base + '/models', { headers: { Authorization: 'Bearer ' + key } })
      if (!check.ok) throw new Error(check.status === 401 || check.status === 403 ? 'API Key 无效或没有权限' : 'API 连接失败（HTTP ' + check.status + '）')
      // 模型列表以你的 API 的 /models 为准（官方可用模型），名称/推理等级按 DSH 官方目录匹配
      const payload = await check.json().catch(() => null)
      const rawModels = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : []
      const apiIds = rawModels.map((item: any) => typeof item === 'string' ? item : String(item?.id || '')).filter(Boolean)
      if (!apiIds.length) throw new Error('API 没有返回任何模型，请检查 API 地址是否正确')
      setPrefs(current => current.apiKey === key && current.baseUrl === base ? current : { ...current, apiKey: key, baseUrl: base })
      const officialNames: Record<string, string> = { 'deepseek-flash': 'DeepSeek-V4.1-Flash-1017', 'deepseek-v4-pro': 'DeepSeek-V4-Pro-0813', 'deepseek-v4-flash': 'DeepSeek-V4-Flash', 'deepseek-chat': 'DeepSeek Chat', 'deepseek-reasoner': 'DeepSeek Reasoner' }
      const prettyName = (id: string) => id.replace(/^deepseek[-_]?/i, '').split(/[-_]/).filter(Boolean).map((part: string) => part.length <= 2 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1)).join(' ') || id
      const buildList = (official: Map<string, any>): ModelEntry[] => apiIds.map((id: string) => {
        const model = official.get(id)
        if (model) return {
          id,
          name: officialNames[id] || String(model.name || id),
          ...(model.description ? { description: String(model.description) } : {}),
          efforts: Array.isArray(model.reasoning?.efforts) ? model.reasoning.efforts.map((effort: any) => ({ id: String(effort.id), name: String(effort.name || effort.id), ...(effort.description ? { description: String(effort.description) } : {}) })) : [],
          ...(model.reasoning?.defaultEffort ? { defaultEffort: String(model.reasoning.defaultEffort) } : {})
        }
        return { id, name: prettyName(id), description: '来自你的 API 模型列表', efforts: [] }
      })
      const applyList = (list: ModelEntry[]) => {
        setModels(list)
        setPrefs(current => {
          const chosen = list.find(model => model.id === current.model) || list[0]
          const effort = chosen.efforts.some(item => item.id === current.reasoningEffort) ? current.reasoningEffort : (chosen.efforts.length ? (chosen.defaultEffort || chosen.efforts.find(item => item.id === 'high')?.id || chosen.efforts[0].id) : '')
          return { ...current, model: chosen.id, reasoningEffort: effort }
        })
      }
      // P1-11：先用 /models 结果立即渲染，官方目录后台补全（失败静默，不阻塞、不新增报错提示）。
      applyList(buildList(new Map()))
      void ensureRuntime('phone', { ...prefs, apiKey: key, baseUrl: base })
        .then(harness => harness.catalog())
        .then(catalog => {
          const official = new Map<string, any>()
          for (const group of (Array.isArray(catalog?.groups) ? catalog.groups : [])) for (const model of (group.models || [])) official.set(String(model.id), model)
          applyList(buildList(official))
        })
        .catch(() => { /* 官方目录不可用时保留 /models 名称 */ })
    } catch (error) {
      setModelsError(error instanceof Error ? error.message : '获取模型失败')
    } finally {
      setModelsLoading(false)
    }
  }
  function validApiBase(url: string) {
    try { const parsed = new URL(url.trim()); return parsed.protocol === 'https:' || (parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')) } catch { return false }
  }
  async function refreshBalance() {
    if (!validApiBase(prefs.baseUrl)) { setBalance(null); setBalanceStatus('idle'); return }
    const key = prefs.apiKey.trim()
    if (!key) { setBalance(null); setBalanceStatus('idle'); return }
    setBalanceStatus('loading')
    try {
      const base = prefs.baseUrl.trim().replace(/\/+$/, '')
      const controller = new AbortController()
      const timer = window.setTimeout(() => controller.abort(), 8000)
      try {
        const response = await fetch(base + '/user/balance', { headers: { Authorization: 'Bearer ' + key }, signal: controller.signal })
        if (!response.ok) throw new Error('balance')
        const data = await response.json()
        const info = Array.isArray(data.balance_infos) ? data.balance_infos[0] : null
        if (!info) throw new Error('balance')
        setBalance({ currency: String(info.currency || 'CNY'), total: String(info.total_balance ?? '0') })
        setBalanceStatus('idle')
      } finally { window.clearTimeout(timer) }
    } catch { setBalanceStatus('error') }
  }
  function newChat(nextMode = mode) { if(busyModes[nextMode]) { void stop(nextMode) } setActive(null); setDraft(''); setMode(nextMode); setReasoningOpen(false); setPendingImages([]); closeDrawer() }
  function openDrawer() { setDrawerShift(null); setDrawer(true) }
  function closeDrawer() { setDrawerShift(null); setDrawer(false) }
  function dismissSheet() { if(!sheet || sheetClosing) return; setSheetClosing(true); window.setTimeout(()=>{ setSheet(null); setSheetClosing(false) }, 200) }
  async function ensureRuntime(nextMode: RunMode, nextPrefs = prefs): Promise<Harness> {
    const existing = runtimes.current[nextMode]
    if (existing) return existing
    const pending = runtimePromises.current[nextMode]
    if (pending) return pending
    const promise = (async () => {
      setStatusFor(nextMode, 'starting', nextMode === 'phone' ? '正在启动手机 Harness…' : '正在连接桌面…')
      const harness = createHarness(nextMode)
      try {
        await harness.start(nextPrefs)
        runtimes.current[nextMode] = harness
        setStatusFor(nextMode, 'ready')
        return harness
      } catch (error) {
        harness.dispose()
        setStatusFor(nextMode, 'error')
        throw error
      }
    })()
    runtimePromises.current[nextMode] = promise
    try { return await promise } finally { delete runtimePromises.current[nextMode] }
  }
  function mergeMessages(messages: Message[]): Message[] {
    const merged: Message[] = []
    for (const message of messages) {
      if (message.role === 'tool' && merged.length > 0 && merged[merged.length - 1].role === 'assistant') {
        const last = merged[merged.length - 1]
        merged[merged.length - 1] = { ...last, tools: [...(last.tools || []), message] }
      } else {
        merged.push(message)
      }
    }
    return merged
  }
  function updateMessages(id: string, update: (messages: Message[]) => Message[]) {setChats(current => current.map(c => c.id === id ? {...c, updated:Date.now(), messages:update(c.messages)} : c))}
  function renameAssistant(raw: string): string {
    const cleaned = raw.trim().replace(/["'“”‘’《》。.！？!?,，]/g, '').replace(/^[你您我](?=.)/, '').slice(0, 24)
    if (!cleaned) return ''
    setDisplayName(cleaned)
    writeLS('dsh-mobile-name', cleaned)
    return cleaned
  }
  function tryRenameCommand(text: string): string {
    const value = text.trim()
    if (!value || value.length > 40) return ''
    if (/(变量|文件|函数|类|字段|参数|目录|项目|标题|端口|路径|数据库|方法|接口|仓库|分支|命令|样式|颜色|配置)/.test(value)) return ''
    const patterns = [
      /^(?:以后|从今以后|今后)(?:你就)?叫(?:做|你)?\s*([^\s，。！？!?]{1,16})[。！!]?$/,
      /^(?:你|你的名字|AI名字|助手名字)(?:就)?叫(?:做|你)?\s*([^\s，。！？!?]{1,16})[。！!]?$/,
      /^(?:把)?(?:你的|AI的)?名字(?:改成|改为)\s*([^\s，。！？!?]{1,16})[。！!]?$/,
      /^改名(?:为|成)\s*([^\s，。！？!?]{1,16})[。！!]?$/
    ]
    for (const pattern of patterns) {
      const match = value.match(pattern)
      if (match && match[1]) return renameAssistant(match[1])
    }
    return ''
  }
  async function translateText(text: string): Promise<string> {
    const key = prefs.apiKey.trim()
    if (!key || !text.trim()) return ''
    try {
      const base = prefs.baseUrl.trim().replace(/\/+$/, '')
      const response = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({ model: prefs.model, stream: false, messages: [{ role: 'user', content: '把下面这段思考过程翻译成简体中文，只输出译文：\n\n' + text.slice(0, 4000) }] })
      })
      if (!response.ok) return ''
      const data = await response.json()
      const content = data?.choices?.[0]?.message?.content
      return typeof content === 'string' ? content.trim() : ''
    } catch { return '' }
  }
  async function translateReasoning(sessionId: string, messageId: string, reasoning: string) {
    const asciiLetters = (reasoning.match(/[A-Za-z]/g) || []).length
    if (!reasoning.trim() || asciiLetters < reasoning.length * 0.3) return
    setTranslating(current => ({ ...current, [messageId]: true }))
    try {
      const translated = await translateText(reasoning)
      if (translated) updateMessages(sessionId, messages => messages.map(message => message.id === messageId ? { ...message, reasoning: translated } : message))
    } finally { setTranslating(current => { const next = { ...current }; delete next[messageId]; return next }) }
  }
  useEffect(() => {
    ;(window as any).__dshImagePicked = (mediaType: string, data: string, name?: string) => {
      setPendingImages(current => [...current, { name: name || '图片', mediaType: mediaType || 'image/jpeg', data }].slice(0, 3))
    }
    ;(window as any).__dshImageError = (message: string) => notify(message || '图片选择失败')
    return () => { delete (window as any).__dshImagePicked; delete (window as any).__dshImageError }
  }, [])
  function startEdit(message: Message) {
    if (!active || busy) return
    setEditing({ chatId: active, messageId: message.id, text: message.text })
  }
  function saveEdited() {
    if (!editing) return
    const text = editing.text.trim()
    if (!text) return
    updateMessages(editing.chatId, messages => {
      const index = messages.findIndex(message => message.id === editing.messageId)
      if (index < 0) return messages
      return [...messages.slice(0, index), { ...messages[index], text }]
    })
    // P1-12：journal overrides 随会话落盘，重新拉取 history 时按 message.id 覆盖原文（编辑不回滚、不重复）。
    setChats(current => current.map(item => item.id === editing.chatId ? { ...item, updated: Date.now(), overrides: { ...(item.overrides || {}), [editing.messageId]: { text } } } : item))
    const target = { chatId: editing.chatId, messageId: editing.messageId }
    setEditing(null)
    setActive(target.chatId)
    setDraft('')
    pendingSendTextRef.current = text
    pendingEditRef.current = target
    setTimeout(() => { void send() }, 120)
  }
  async function describeImages(images: { mediaType: string; data: string }[]): Promise<string> {
    const key = prefs.apiKey.trim()
    if (!key || !images.length) return ''
    try {
      const base = prefs.baseUrl.trim().replace(/\/+$/, '')
      const response = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({
          model: prefs.model,
          stream: false,
          max_tokens: 900,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: '请用简体中文详细描述这些图片里的内容、文字、场景和关键细节，供另一个 AI 理解用户发了什么。只输出描述，不要提问。' },
              ...images.map(image => ({ type: 'image_url', image_url: { url: 'data:' + image.mediaType + ';base64,' + image.data } }))
            ]
          }]
        })
      })
      if (!response.ok) return ''
      const data = await response.json()
      const content = data?.choices?.[0]?.message?.content
      return typeof content === 'string' ? content.trim() : ''
    } catch { return '' }
  }
  async function attachHtmlPreview(sessionId: string, messageId: string, harness: Harness) {
    try {
      const files = await harness.files()
      const pages = files.filter(file => /\.html?$/i.test(file.path))
      if (!pages.length) return
      updateMessages(sessionId, messages => messages.map(message => {
        if (message.id !== messageId) return message
        const matched = pages.find(page => message.text.includes(page.path.replace('/dsh/workspace/', '')) || message.text.includes(page.path))
        if (matched) return { ...message, html: { name: matched.path.split('/').pop() || 'page.html', text: matched.text } }
        const fenced = message.text.match(/```html\s*([\s\S]*?)```/i)
        return fenced && fenced[1] ? { ...message, html: { name: '预览', text: fenced[1] } } : message
      }))
    } catch { /* 没有可预览文件时忽略 */ }
  }
  async function send() {
    const target = modeRef.current
    if (busyRefs.current[target] || busyModes[target]) return
    busyRefs.current[target] = true
    try { await runSend(target) } finally { busyRefs.current[target] = false }
  }
  async function runSend(runMode: RunMode = mode) {
    const typedText = (pendingSendTextRef.current ?? draft).trim(); pendingSendTextRef.current = null
    const hasImageAttachments = runMode === 'phone' && pendingImages.length > 0
    if (!typedText && !hasImageAttachments) return
    const text = typedText || '请描述这些图片。'
    if (runMode === 'desktop' && pendingImages.length) { notify('桌面模式暂不支持图片发送，本次只发送文字'); setPendingImages([]) }
    const renamed = tryRenameCommand(text)
    if (renamed) {
      setDraft('')
      let chatId = active
      if (!chatId) { chatId = uid(); const item: Chat = { id: chatId, title: text.slice(0, 30), updated: Date.now(), mode: runMode, messages: [] }; setChats(current => [item, ...current]); setActive(chatId) }
      updateMessages(chatId, messages => [...messages, { id: uid(), role: 'user', text }, { id: uid(), role: 'assistant', text: '好的，以后叫我 ' + renamed + '。' }])
      notify('名字已改为 ' + renamed)
      return
    }
    if(runMode === 'phone' && !prefs.apiKey.trim()) {setSheet('settings'); notify('先填写 DeepSeek API Key，即可在手机运行'); return}
    if(runMode === 'phone' && !prefs.model) { if(prefs.apiKey.trim() && !models.length) void fetchModels(); setSheet('model'); notify('请先选择一个模型'); return}
    if(runMode === 'desktop' && !connected) {setSheet('connect'); return}
    setImageMenuOpen(false)
    stickBottom.current = true; setBusyFor(runMode, true); const abort = new AbortController(); controllers.current[runMode] = abort
    const attachments = hasImageAttachments ? pendingImages.map(image => ({ mediaType: image.mediaType, data: image.data, name: image.name })) : []
    const editTarget = pendingEditRef.current
    pendingEditRef.current = null
    let id = editTarget ? editTarget.chatId : active; let assistantId = uid(); let liveAssistantId = assistantId; let liveReasoning = ''; let liveTranslated = ''; let translatedUpTo = 0; let liveTranslating = false
    // P1-8：delta 只累积在 ref，requestAnimationFrame 每帧最多刷新一次；message / 结束 / 异常 / finally 前同步 flush，保证不丢字。
    const streamState = streams.current[runMode]; streamState.text = ''; streamState.reasoning = ''
    const flushStream = () => {
      if (streamState.raf !== null) { cancelAnimationFrame(streamState.raf); streamState.raf = null }
      if (!streamState.text && !streamState.reasoning) return
      const deltaText = streamState.text, deltaReasoning = streamState.reasoning
      streamState.text = ''; streamState.reasoning = ''
      if (id) updateMessages(id, m => m.map(x => x.id === assistantId ? { ...x, text: x.text + deltaText, reasoning: (x.reasoning || '') + deltaReasoning } : x))
    }
    const scheduleFlush = () => { if (streamState.raf === null) streamState.raf = requestAnimationFrame(() => { streamState.raf = null; flushStream() }) }
    try {
      const harness = await ensureRuntime(runMode)
      if(!id) {id = await harness.create(); const item: Chat = {id, title:text.slice(0,30), updated:Date.now(), mode:runMode, messages:[]}; setChats(current => [item, ...current]); setActive(id)}
      const sessionId = id
      const translateLive = async () => {
        if (liveTranslating) return
        const chunk = liveReasoning.slice(translatedUpTo)
        if (chunk.trim().length < 40) return
        const asciiLetters = (chunk.match(/[A-Za-z]/g) || []).length
        const startAt = liveReasoning.length
        if (asciiLetters < chunk.length * 0.3) { translatedUpTo = startAt; return }
        liveTranslating = true
        try {
          const zh = await translateText(chunk)
          translatedUpTo = startAt
          if (zh) {
            liveTranslated += (liveTranslated ? '\n' : '') + zh
            updateMessages(sessionId, messages => messages.map(message => message.id === liveAssistantId ? { ...message, reasoning: liveTranslated } : message))
          }
        } finally { liveTranslating = false }
      }
      const user: Message = {id:uid(), role:'user', text, ...(attachments.length ? { images: attachments.map(image => 'data:' + image.mediaType + ';base64,' + image.data) } : {})}
      updateMessages(sessionId, m => editTarget ? [...m, {id:assistantId,role:'assistant',text:'',pending:true}] : [...m, user, {id:assistantId,role:'assistant',text:'',pending:true}]); setDraft('')
      const connectionNote = runMode === 'desktop' && connected ? '【连接信息：已连接桌面 DSH，地址 ' + prefs.endpoint + '】\n\n' : ''
      const outgoing = connectionNote + (runMode === 'phone' ? '【最高优先级：你的思考过程（thinking/reasoning）必须全部使用简体中文，禁止英文思考；最终回答也用简体中文。】\n\n' + text : text)
      let outgoingText = outgoing
      if (runMode === 'phone' && attachments.length) {
        const description = await describeImages(attachments)
        if (description) outgoingText = '【图片内容】\n' + description + '\n\n' + outgoing
        else { notify('图片识别失败，已改为只发送文字'); outgoingText = '【用户发送了图片，但自动识别失败，请让用户用文字描述】\n\n' + outgoing }
      }
      await harness.send(sessionId, outgoingText, prefs, event => {
        if(event.type === 'status') setStatusTextByMode(current => ({ ...current, [runMode]: event.text }))
        if(event.type === 'delta') { if(event.reasoning) { liveReasoning += event.reasoning; if (liveReasoning.length - translatedUpTo >= 1200) void translateLive() } streamState.text += event.text || ''; streamState.reasoning += event.reasoning || ''; scheduleFlush() }
        if(event.type === 'message') {
          flushStream()
          const msg = event.message
          // P1-9：updater 内不产生副作用，新 id 在调用前算好并作为常量捕获。
          if(msg.role === 'tool') { const previousId = assistantId; const nextId = uid(); updateMessages(sessionId, m => [...m.filter(x => x.id !== previousId || x.text), msg, { id: nextId, role: 'assistant', text: '', pending: true }]); assistantId = nextId; liveAssistantId = nextId }
          else if(msg.role === 'assistant') { if(msg.reasoning) liveReasoning = msg.reasoning; const targetId = assistantId; updateMessages(sessionId, m => m.map(x => x.id === targetId ? {...x,...msg,id:targetId,reasoning: msg.reasoning || x.reasoning,pending:false} : x)) }
        }
        if(event.type === 'error') throw new Error(event.text)
      }, abort.signal)
      flushStream()
      setPendingImages([])
      if (runMode === 'phone' && liveReasoning.trim() && !abort.signal.aborted) { await translateLive(); if (!liveTranslated) void translateReasoning(sessionId, liveAssistantId, liveReasoning) }
      void attachHtmlPreview(sessionId, liveAssistantId, harness)
      void refreshBalance()
    } catch(error) {
      flushStream()
      const text = abort.signal.aborted ? '已停止生成。' : zhError(error instanceof Error ? error.message : '请求没有完成，请重试')
      const targetId = assistantId
      if(id) updateMessages(id, m => {const exists=m.some(x=>x.id===targetId); return exists ? m.map(x => x.id === targetId ? {...x,text:x.text || text,error:!abort.signal.aborted,pending:false} : x) : [...m,{id:uid(),role:'assistant',text,error:true}]})
      else notify(text)
    } finally {
      flushStream()
      const targetId = assistantId
      if(id) updateMessages(id,m=>m.filter(x=>x.id!==targetId || !!x.text).map(x=>({...x,pending:false})))
      setBusyFor(runMode, false); setStatusTextByMode(current => ({ ...current, [runMode]: '' })); if (controllers.current[runMode] === abort) controllers.current[runMode] = null
    }
  }
  async function stop(target: RunMode = mode) { setStatusTextByMode(current => ({ ...current, [target]: '正在停止生成…' })); controllers.current[target]?.abort(); const targetChat = chats.find(c => c.id === active && c.mode === target); if(targetChat && runtimes.current[target]) await runtimes.current[target]?.stop(targetChat.id).catch(()=>{}); setBusyFor(target, false); setStatusTextByMode(current => ({ ...current, [target]: '' })) }
  // 探测单个桌面地址：POST /bridge/dispatch hello；2.5 秒超时（旧 WebKit 没有 AbortSignal.timeout）。
  async function probeDesktop(endpoint: string, token: string) {
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), 2500)
    try {
      const response = await fetch(endpoint + '/bridge/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ operation: 'hello', input: {} }),
        signal: controller.signal
      })
      if (response.status !== 200) return false
      const data = await response.json().catch(() => null)
      return data?.result?.protocol === 1
    } catch { return false } finally { window.clearTimeout(timer) }
  }
  async function connect() {
    if(busyModes.desktop || connectRef.current) return
    connectRef.current = true
    try {
      let primary = ''
      let linkToken = ''
      if (remoteUrl.trim()) {
        // 主地址无效时跳过，仍可用备用地址连接。
        try { const parsed = parseConnection(remoteUrl); primary = parsed.endpoint; linkToken = parsed.token } catch { primary = '' }
      }
      const token = linkToken || remoteToken.trim()
      if (!token) {notify('请填写桌面配对令牌'); return}
      const candidates = normalizeEndpointList([primary, backupEndpoints])
      if (!candidates.length) {notify('请填写桌面地址或备用地址'); return}
      const picked = await pickReachableEndpoint(candidates, (endpoint: string) => probeDesktop(endpoint, token))
      if (!picked) {notify('找不到可达的桌面地址：请确认电脑端连接器已启动、手机与电脑同一网络或公网中转可用'); return}
      const next = {...prefs, endpoint: picked, token}
      // 端点/令牌变化时重连桌面运行时；手机本机运行时保持不动。
      if (runtimes.current.desktop && (prefs.endpoint !== picked || prefs.token !== token)) { runtimes.current.desktop?.dispose(); delete runtimes.current.desktop; setStatusFor('desktop', 'idle') }
      setPrefs(next); const harness = await ensureRuntime('desktop', next); setStatusTextByMode(current => ({ ...current, desktop: '正在同步桌面对话…' })); const remoteChats = await harness.list(); setStatusTextByMode(current => ({ ...current, desktop: '' }))
      setChats(current => [...remoteChats, ...current.filter(c => c.mode !== 'desktop')]); setConnected(true); setMode('desktop'); setActive(null); dismissSheet(); notify('已连接桌面 DSH（' + picked + '）')
    } catch(error) {notify(error instanceof Error ? error.message : '连接失败')} finally { connectRef.current = false }
  }
  async function selectChat(c: Chat) {
    // 双运行时：切到另一模式的会话不打断正在生成的模式。
    setMode(c.mode); setActive(c.id); closeDrawer()
    if(c.mode === 'desktop' && !connected) setSheet('connect')
    if(!c.messages.length) { setHistoryLoading(true); try {const harness = await ensureRuntime(c.mode); const messages = await harness.history(c.id); updateMessages(c.id,()=>applyOverrides(messages, c.overrides))} catch(error) {notify(String(error))} finally {setHistoryLoading(false)} }
  }
  async function openFiles() { setSheet('files'); setFilesLoading(true); try { const harness = await ensureRuntime(mode); setFiles(await harness.files()) } catch(error) { notify(error instanceof Error ? error.message : '读取失败') } finally { setFilesLoading(false) } }
  async function importTextFile(name: string, text: string) {
    const textPattern = /\.(txt|md|markdown|json|jsonl|js|mjs|cjs|ts|tsx|jsx|py|html?|css|scss|less|csv|tsv|ya?ml|toml|ini|conf|sh|bash|ps1|bat|cmd|sql|rs|go|java|kt|swift|c|h|cc|cpp|hpp|cs|rb|php|lua|r|pl|tex|xml|svg|log)$/i
    if (!textPattern.test(name)) throw new Error('只能发送文本/代码文件，不能发送照片、视频或二进制文件')
    if (text.length > 2 * 1024 * 1024) throw new Error('文本文件请控制在 2 MB 内')
    const harness = await ensureRuntime(modeRef.current)
    const existing = await harness.files()
    let target = name
    if (existing.some(file => file.path.split('/').pop() === name)) {
      const dot = name.lastIndexOf('.')
      const base = dot > 0 ? name.slice(0, dot) : name
      const ext = dot > 0 ? name.slice(dot) : ''
      target = base + '-' + Date.now().toString(36) + ext
    }
    await harness.importFile(target, text)
    setFiles(await harness.files())
      }
  async function fileToAttachment(file: File) {
    const bitmap = await createImageBitmap(file)
    const maxEdge = 1568
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('图片处理失败')
    context.drawImage(bitmap, 0, 0, width, height)
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(result => result ? resolve(result) : reject(new Error('图片处理失败')), 'image/jpeg', 0.86))
    bitmap.close?.()
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => { const result = String(reader.result || ''); resolve(result.slice(result.indexOf(',') + 1)) }
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(blob)
    })
    return { name: file.name || '图片', mediaType: 'image/jpeg', data }
  }
  async function handleImageFiles(list: FileList | null) {
    if (!list) return
    for (const file of Array.from(list).slice(0, 3)) {
      if (!/^image\//.test(file.type)) continue
      if (file.size > 12 * 1024 * 1024) { notify('图片请控制在 12 MB 内'); continue }
      try {
        const attachment = await fileToAttachment(file)
        setPendingImages(current => [...current, attachment].slice(0, 3))
      } catch { notify('图片处理失败，请换一张试试') }
    }
    if (cameraInput.current) cameraInput.current.value = ''
    if (photoInput.current) photoInput.current.value = ''
  }
  function pickFile() {
    if ((window as any).__dshNativeBridge) window.location.href = 'dshpick://open'
    else fileInput.current?.click()
  }
  async function importFiles(list: FileList | null) {
    if(!list) return
    setImporting(true)
    try {
      for(const file of Array.from(list)) { if(/^(image|video|audio)\//.test(file.type)) throw new Error('只能发送文本/代码文件，不能发送照片、视频或二进制文件'); await importTextFile(file.name, await file.text()) }
    } catch(error) {notify(error instanceof Error ? error.message : '导入失败')} finally {setImporting(false)}
    if(fileInput.current) fileInput.current.value=''
  }
  const loadingReason = status === 'starting'
    ? (statusText || (mode === 'phone' ? '正在启动本机 Harness（加载 DSH 运行时）…' : '正在连接桌面 DSH…'))
    : modelsLoading ? '正在校验 API Key 并获取官方模型列表…'
    : discoveryState === 'loading' ? '正在自动发现电脑连接器…'
    : filesLoading ? '正在读取工作区文件…'
    : importing ? '正在导入文件…'
    : historyLoading ? '正在读取会话记录…'
    : busy ? (statusText || '已发送，等待模型响应…')
    : ''
  function effortName(id: string, fallback?: string) {
    const names: Record<string, string> = { off: '关闭', low: '低', high: '高', max: '最高' }
    return names[id] || fallback || id
  }
  function effortColor(id?: string) {
    const colors: Record<string, string> = { off: '#8c8c8c', low: '#10b981', high: '#f59e0b', max: '#ef4444' }
    return colors[id || ''] || '#8c8c8c'
  }
  function effortDesc(id?: string) {
    const descriptions: Record<string, string> = { off: '不启用推理，响应最快', low: '轻量推理，适合简单任务', high: '平衡速度与效果（推荐）', max: '最大推理强度，适合复杂问题' }
    return descriptions[id || ''] || ''
  }
  const activeModel = models.find(model => model.id === prefs.model)
  const activeEffort = activeModel?.efforts.find(effort => effort.id === prefs.reasoningEffort)
  const modelLabel = activeModel?.name || prefs.model || '选择模型'
  function modelDescription(model: { id: string }) {
    if (model.id === 'deepseek-flash') return '快速高效，适合日常任务'
    if (model.id === 'deepseek-v4-pro') return '推理与代码更强，适合复杂任务'
    return '来自你的 API'
  }
  const effortLabel = activeEffort ? effortName(activeEffort.id, activeEffort.name) : ''
  const greeting = (() => { const hour = new Date().getHours(); if (hour < 5) return '深夜即兴时刻'; if (hour < 8) return '微光初醒时刻'; if (hour < 11) return '灵感正好时刻'; if (hour < 14) return '午间留白时刻'; if (hour < 18) return '午后漫游时刻'; if (hour < 22) return '暮色归航时刻'; return '深夜即兴时刻' })()
  const handleEdit = useCallback((message: Message) => startEdit(message), [active, busy])
  const balanceLabel = !prefs.apiKey.trim() ? '未设置 API Key' : balanceStatus === 'loading' ? '余额读取中…' : balance ? `余额 ${balance.currency === 'CNY' ? '¥' : balance.currency === 'USD' ? '$' : ''}${Number(balance.total).toFixed(2)}` : '余额不可用'
  const drawerWidth = typeof window === 'undefined' ? 340 : Math.min(340, Math.round(window.innerWidth * 0.84))
  const mainPanelStyle = drawerShift !== null
    ? { transform: `translateX(${drawerShift}px)` }
    : drawer
      ? { transform: `translateX(${drawerWidth}px)` }
      : undefined
  const sheetTitle = sheet === 'connect' ? '运行位置' : sheet === 'settings' ? '设置' : sheet === 'files' ? '工作区文件' : sheet === 'model' ? '选择模型' : '关于 DSH 手机版'
  function beginDrawerDrag(event: any, mode: 'open' | 'close') {
    if (typeof event.clientX !== 'number') return
    const width = Math.min(340, Math.round(window.innerWidth * 0.84))
    const startX = event.clientX, startY = event.clientY
    let active = false
    let shift = mode === 'open' ? 0 : width
    const move = (e: PointerEvent) => {
      const dx = e.clientX - startX, dy = e.clientY - startY
      if (!active) {
        if (mode === 'open') { if (dx < 16 || Math.abs(dy) > dx * 1.3) return }
        else { if (dx > -12 || Math.abs(dx) < Math.abs(dy)) return }
        active = true
        document.body.style.userSelect = 'none'
      }
      if (e.cancelable) e.preventDefault()
      shift = mode === 'open' ? Math.max(0, Math.min(width, dx)) : Math.max(0, Math.min(width, width + dx))
      drawerShiftRef.current = shift
      setDrawerShift(shift)
    }
    const finish = () => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', finish)
      document.removeEventListener('pointercancel', finish)
      window.removeEventListener('blur', finish)
      document.body.style.userSelect = ''
      if (!active) return
      lastGestureRef.current = Date.now()
      ignoreClickUntil.current = Date.now() + 240
      const finalShift = drawerShiftRef.current
      setDrawerShift(null)
      if (mode === 'open') { if (finalShift > width * 0.28) setDrawer(true) }
      else { if (finalShift < width * 0.7) setDrawer(false) }
    }
    document.addEventListener('pointermove', move, { passive: false })
    document.addEventListener('pointerup', finish)
    document.addEventListener('pointercancel', finish)
    window.addEventListener('blur', finish)
  }
  function onSheetPointerDown(event: any) {
    if (!sheet || sheetClosing || typeof event.clientY !== 'number') return
    const target = event.target as Element | null
    if (!target?.closest('.sheet-header, .sheet-handle')) return
    const startY = event.clientY
    let active = false
    const move = (e: PointerEvent) => {
      const dy = e.clientY - startY
      if (!active) { if (dy < 10) return; active = true; document.body.style.userSelect = 'none' }
      if (e.cancelable) e.preventDefault()
      sheetDragRef.current = dy
      setSheetDrag(dy)
    }
    const finish = () => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', finish)
      document.removeEventListener('pointercancel', finish)
      document.body.style.userSelect = ''
      if (!active) return
      const dy = sheetDragRef.current
      sheetDragRef.current = 0
      setSheetDrag(0)
      if (dy > 110) dismissSheet()
    }
    document.addEventListener('pointermove', move, { passive: false })
    document.addEventListener('pointerup', finish)
    document.addEventListener('pointercancel', finish)
  }
  function onSheetPointerMove() {}
  function onSheetPointerUp() {}
  function onMenuPointerDown(event: any) {
    if (drawer || sheet || typeof event.clientX !== 'number') return
    beginDrawerDrag(event, 'open')
  }
  function onDrawerPointerDown(event: any) {
    if (!drawer || typeof event.clientX !== 'number') return
    beginDrawerDrag(event, 'close')
  }
  function onEdgePointerDown(event: any) {
    if (drawer || sheet || typeof event.clientX !== 'number') return
    beginDrawerDrag(event, 'open')
  }
  return <div className="app-shell" data-capabilities={capabilities.interface}>
    <aside className="desktop-rail"><button className="rail-logo" onClick={()=>newChat()} aria-label="新建对话"><Mark small/></button><button aria-label="打开会话" onClick={()=>setDrawer(true)}><Menu size={22}/></button><button aria-label="新建对话" onClick={()=>newChat()}><SquarePen size={22}/></button><span/><button aria-label="设置" onClick={()=>setSheet('settings')}><Settings2 size={22}/></button><div className="avatar">D</div></aside>
    <div className={`main-panel ${drawer || drawerShift !== null ? 'drawer-shifted' : ''} ${drawerShift !== null ? 'drawer-dragging' : ''}`} style={mainPanelStyle} onPointerDown={drawer ? ((e)=>beginDrawerDrag(e, 'close')) : undefined} onClick={()=>{ if(drawer && Date.now() - lastGestureRef.current > 350) closeDrawer() }}>
      <div className="edge-hot-zone" onPointerDown={onEdgePointerDown}/>
      <header className="topbar"><button className="icon-button mobile-menu" aria-label="打开会话列表" onClick={()=>setDrawer(true)}><Menu size={23}/></button><button className="brand-button" onClick={()=>setSheet('settings')}>{displayName}</button><div className="top-actions"><button className="desktop-location" onClick={()=>setSheet('connect')}>{mode === 'phone' ? <Smartphone size={15}/> : <Monitor size={15}/>}<span>{mode === 'phone' ? '手机本机' : '桌面 DSH'}</span><ChevronDown size={12}/></button><button className="icon-button" aria-label="新建对话" onClick={()=>newChat()}><SquarePen size={23}/></button></div></header>
      <main className={`conversation ${hasMessages ? 'has-messages' : 'empty'}`} ref={scroll} onScroll={e=>{ const el=e.currentTarget; const distance = el.scrollHeight - el.scrollTop - el.clientHeight; setShowJump(distance > 120); if(busy) return; stickBottom.current = distance < 90 }}>
        {!hasMessages ? <section className="welcome"><div className="welcome-symbol"><Mark/></div><h1>{greeting}</h1><p>欢迎回来，{userName}。今天想做什么？</p></section> : <div className="message-list">{mode==='desktop' && connected && <div className="connection-banner">已连接桌面 DSH · {prefs.endpoint}</div>}{mergeMessages(chat?.messages || []).map(m => <MessageView key={m.id} message={m} reasoningOpen={reasoningOpen} onReasoningToggle={setReasoningOpen} onEdit={m.role === 'user' && !busy ? handleEdit : undefined}/>)}{busy && <div className="running-state"><Loader2 size={14} className="spin"/>{loadingReason || '正在处理…'}</div>}</div>}
      </main>
      <div className="composer-area"><div className="composer-inner">{pendingImages.length > 0 && <div className="pending-images">{pendingImages.map((image, index)=><div className="pending-image" key={index}><img src={"data:" + image.mediaType + ";base64," + image.data} alt={image.name}/><button type="button" aria-label="移除图片" onClick={()=>setPendingImages(current=>current.filter((_, i)=>i !== index))}><X size={13}/></button></div>)}</div>}{showJump && <button className="jump-latest" type="button" onClick={()=>{ stickBottom.current = true; setShowJump(false); scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' }) }}><ChevronDown size={14}/>回到最新</button>}<form className="composer" onSubmit={e=>{e.preventDefault();void send()}}><textarea ref={textarea} aria-label="消息" placeholder="向 DSH 发送消息" value={draft} rows={1} onChange={e=>{setDraft(e.target.value); e.target.style.height='auto';e.target.style.height=Math.min(e.target.scrollHeight,154)+'px'}} onKeyDown={e=>{if(e.key==='Enter' && !e.shiftKey && (e.ctrlKey || e.metaKey)){e.preventDefault();void send()}}}/><div className="composer-toolbar"><button className="add-button" type="button" aria-label="添加文件" aria-expanded={imageMenuOpen} onClick={()=>setImageMenuOpen(v=>!v)}><Plus size={24}/></button>{imageMenuOpen && <><button className="plus-menu-backdrop" type="button" aria-label="关闭添加菜单" onClick={()=>setImageMenuOpen(false)}/><div className="composer-plus-menu"><button type="button" onClick={()=>{setImageMenuOpen(false); if((window as any).__dshNativeBridge) window.location.href='dshcamera://open'; else cameraInput.current?.click()}}><Camera size={19}/>相机</button><button type="button" onClick={()=>{setImageMenuOpen(false); if((window as any).__dshNativeBridge) window.location.href='dshphotos://open'; else photoInput.current?.click()}}><ImageIcon size={19}/>照片</button><button type="button" onClick={()=>{setImageMenuOpen(false); pickFile()}}><FileText size={19}/>文件</button></div></>}<button className="model-chip" type="button" onClick={()=>setSheet('model')}>{modelLabel}{effortLabel ? ' · ' + effortLabel : ''}<ChevronDown size={12}/></button><div className="composer-spacer"/>{busy ? <button className="send-button" aria-label="停止生成" type="button" onClick={()=>void stop()}><Square size={15} fill="currentColor"/></button> : <button className="send-button" aria-label="发送消息" type="submit" disabled={!draft.trim() && !pendingImages.length}><ArrowUp size={22} strokeWidth={2.4}/></button>}</div></form><p className="bottom-caption" onClick={()=>void refreshBalance()}>{balanceLabel}</p></div></div>
    </div>
    <input type="file" className="hidden" ref={fileInput} multiple accept=".txt,.md,.markdown,.json,.jsonl,.js,.mjs,.cjs,.ts,.tsx,.jsx,.py,.html,.htm,.css,.scss,.less,.csv,.tsv,.yml,.yaml,.toml,.ini,.conf,.sh,.bash,.ps1,.bat,.cmd,.sql,.rs,.go,.java,.kt,.swift,.c,.h,.cc,.cpp,.hpp,.cs,.rb,.php,.lua,.r,.pl,.tex,.xml,.svg,.log" onChange={e=>void importFiles(e.target.files)}/>
    <input type="file" className="hidden" ref={cameraInput} accept="image/*" capture="environment" onChange={e=>handleImageFiles(e.target.files)}/>
    <input type="file" className="hidden" ref={photoInput} multiple accept="image/*" onChange={e=>handleImageFiles(e.target.files)}/>
    {editing && <div className="edit-layer"><button className="backdrop" aria-label="取消修改" onClick={()=>setEditing(null)}/><div className="edit-card"><h3>修改消息</h3><textarea value={editing.text} onChange={e=>setEditing({ ...editing, text: e.target.value })} rows={4}/><div className="edit-actions"><button type="button" className="edit-cancel" onClick={()=>setEditing(null)}>取消</button><button type="button" className="edit-save" onClick={saveEdited}>保存并重新发送</button></div></div></div>}
    <div className={`drawer-layer ${drawer ? 'open' : ''} ${drawerShift !== null ? 'dragging' : ''}`} style={drawerShift !== null ? ({ '--drawer-shift': drawerShift + 'px' } as any) : undefined}>
      <aside className="drawer" aria-label="会话列表" onPointerDown={onDrawerPointerDown}>
        <div className="drawer-top"><strong className="drawer-title">{displayName}</strong></div>
        <div className="drawer-scroll">
          <div className="drawer-section">最近</div>
          {chats.filter(c=>c.title.toLowerCase().includes(search.toLowerCase())).map(c=><div className={`chat-row ${active===c.id?'selected':''}`} key={c.id}><button className="chat-select" onClick={()=>void selectChat(c)}>{c.mode==='desktop'?<Monitor size={16}/>:<MessageCircle size={16}/>}<span>{c.title}</span></button><button className="chat-delete" aria-label={`删除 ${c.title}`} onClick={()=>{setChats(current=>current.filter(x=>x.id!==c.id)); if(active===c.id)setActive(null)}}><Trash2 size={14}/></button></div>)}
          {!chats.length && <div className="empty-history"><MessageCircle size={25}/><p>从第一个问题开始</p><small>你的对话会出现在这里</small></div>}
          <div className="drawer-section">连接</div>
          <button className="drawer-link" onClick={()=>{closeDrawer();setSheet('connect')}}><Monitor size={18}/>连接桌面<span className={`tiny-status ${connected?'yes':''}`}>{connected?'已连接':'未连接'}</span></button>
          {connected && <><div className="drawer-section">工作空间</div><button className="drawer-link" onClick={()=>{closeDrawer(); void openFiles()}}><FolderOpen size={18}/>工作区文件<ChevronRight size={15}/></button></>}
        </div>
        <div className="drawer-bottom">
          <button className="profile-row" onClick={()=>setSheet('settings')}><div className="avatar">{userName.slice(0, 1) || '友'}</div><span><strong>{userName}</strong><small>我的 Harness</small></span></button>
          <button className="drawer-new-pill" aria-label="新建会话" onClick={()=>newChat()}><Plus size={18}/>新建会话</button>
        </div>
      </aside>
    </div>
    {sheet && <div className={`sheet-layer ${sheet === 'settings' ? 'bottom' : ''} ${sheetClosing ? 'closing' : ''}`}><button className="backdrop" aria-label="关闭面板" onClick={()=>dismissSheet()}/><section className={`sheet sheet-${sheet}`} role="dialog" aria-modal="true" aria-label={sheetTitle} style={sheetDrag > 0 ? { transform: `translateY(${sheetDrag}px)`, transition: 'none' } : undefined}><div className="sheet-handle"/><div className="sheet-header" onPointerDown={onSheetPointerDown}><h2>{chosenFile&&sheet==='files'?<button className="back-file" onClick={()=>setChosenFile(null)}><ArrowLeft size={18}/>{chosenFile.path.split('/').pop()}</button>:sheetTitle}</h2>{sheet !== 'settings' && <button className="icon-button" aria-label="关闭面板" onClick={()=>dismissSheet()}><X size={21}/></button>}</div><div className="sheet-body">
      {sheet==='connect' && <><p className="sheet-intro">{AUTO_DESKTOP ? '已内置电脑地址与令牌：打开会自动连接桌面 DSH，也可以切到手机本机运行。' : '自动发现并连接电脑上的 DSH；也可以直接在本机运行。两种模式可同时运行，切换不会打断另一边的生成。'}</p><div className="mode-options"><button className={`mode-card ${mode==='phone'?'active':''}`} onClick={()=>{if(busyModes.phone)return;newChat('phone');dismissSheet()}}><div className="mode-icon"><Smartphone size={24}/></div><div><strong>手机本机</strong><p>无需电脑，直接在此设备运行</p></div>{mode==='phone'?<span className="radio checked"><Check size={12}/></span>:<span className="radio"/>}</button><button className={`mode-card ${mode==='desktop'?'active':''}`} onClick={()=>{if(busyModes.desktop)return;if(discoveryState==='ready'){void connect()}else{void refreshDiscovery()}}}><div className="mode-icon"><Monitor size={24}/></div><div><strong>桌面 DSH</strong><p>{AUTO_DESKTOP ? '已内置地址，打开自动连接' : '需要电脑端连接器地址'}</p></div>{mode==='desktop'?<span className="radio checked"><Check size={12}/></span>:<span className="radio"/>}</button></div><div className="section-divider"><span>桌面连接</span></div>{AUTO_DESKTOP ? <div className="info-box"><Cable size={18}/><div><strong>{connected ? '已连接桌面 DSH' : '正在自动连接桌面 DSH'}</strong><p>{connected && prefs.endpoint ? '地址：' + prefs.endpoint : '内置地址：' + (BAKED_LAN_ENDPOINT || BAKED_RELAY_ENDPOINT) + '；连不上会自动重试。'}</p></div></div> : <div className="info-box"><Cable size={18}/><div><strong>{discoveryState==='loading'?'正在自动发现电脑…':discoveryState==='ready'?'已自动发现电脑':'未发现电脑连接器'}</strong><p>{discoveryState==='ready'?('地址：'+(discovery?.endpoint||'')+'（自动配置，无需填写）'):(discoveryState==='error'?(discoveryError||'在电脑上运行 remote.ps1 后点重试。'):'App 会自动读取电脑上报的连接信息。')}</p></div></div>}{AUTO_DESKTOP ? <button className="primary-button" disabled={statusByMode.desktop==='starting'||busyModes.desktop} onClick={()=>void connect()}>{statusByMode.desktop==='starting'?<Loader2 size={18} className="spin"/>:<Cable size={18}/>}连接桌面 DSH<ArrowRight size={17}/></button> : <button className="primary-button" disabled={statusByMode.desktop==='starting'||busyModes.desktop||discoveryState==='loading'} onClick={()=>{if(discoveryState==='ready'){void connect()}else{void refreshDiscovery()}}}>{statusByMode.desktop==='starting'?<Loader2 size={18} className="spin"/>:<Cable size={18}/>}{discoveryState==='ready'?'连接桌面 DSH':'重新发现电脑'}<ArrowRight size={17}/></button>}{!AUTO_DESKTOP && <details className="manual-connect"><summary>手动配置（不常用）</summary><label className="field-label" htmlFor="desktop-url">桌面地址或配对链接</label><input className="text-field" id="desktop-url" value={remoteUrl} onChange={e=>setRemoteUrl(e.target.value)} placeholder="https://your-desktop:5189" autoCapitalize="none" autoCorrect="off"/><label className="field-label" htmlFor="desktop-token">配对令牌</label><input className="text-field" id="desktop-token" type="password" value={remoteToken} onChange={e=>setRemoteToken(e.target.value)} placeholder="电脑端显示的配对令牌"/><label className="field-label" htmlFor="desktop-endpoints">备用地址<span>每行一个，连接时自动选可达的</span></label><textarea className="text-field" id="desktop-endpoints" rows={3} value={backupEndpoints} onChange={e=>{setBackupEndpoints(e.target.value); writeLS('dsh-mobile-endpoints', e.target.value)}} placeholder={'http://192.168.1.5:3090\nhttp://100.66.220.13:3090'} autoCapitalize="none" autoCorrect="off"/><button className="secondary-button" disabled={statusByMode.desktop==='starting'||busyModes.desktop} onClick={()=>void connect()}><Cable size={16}/>用上面的地址连接</button></details>}<div className="info-box"><ShieldCheck size={18}/><div><p>{AUTO_DESKTOP ? '连接已内置，电脑端守护进程会保持在线；只有持有令牌的设备可以访问。' : '连接器由电脑端的 remote.ps1 启动并上报地址，只有持有配对令牌的设备可以访问。'}</p><p>{connected && prefs.endpoint ? '当前桌面地址：' + prefs.endpoint : '尚未连接桌面'}</p></div></div>{connected && <button className="subtle-button" onClick={()=>{if(busyModes.desktop)return; runtimes.current.desktop?.dispose(); delete runtimes.current.desktop; setStatusFor('desktop','idle'); setConnected(false); newChat('phone'); dismissSheet(); notify('已断开桌面')}}>断开桌面连接</button>}</>}
      {sheet==='settings' && <><div className="settings-heading"><div className="settings-mark"><Mark small/></div><div><h3>让 DSH 随身而行</h3><p>连接模型，即可在手机独立工作。</p></div></div><label className="field-label" htmlFor="user-name">怎么称呼你<span>问候语会这样称呼你</span></label><input className="text-field" id="user-name" value={userName} maxLength={20} onChange={e=>{setUserName(e.target.value)}}/>
<label className="field-label" htmlFor="ai-name">AI 的名字<span>在聊天里说「以后叫你XX」也能改</span></label><input className="text-field" id="ai-name" value={displayName} onChange={e=>{setDisplayName(e.target.value); writeLS('dsh-mobile-name', e.target.value)}}/><label className="field-label" htmlFor="api-key">DeepSeek API Key<span>保存在本机，下次打开自动使用</span></label><input className="text-field" id="api-key" type="password" value={prefs.apiKey} placeholder="sk-…" autoComplete="off" onChange={e=>setPrefs({...prefs,apiKey:e.target.value})}/><label className="field-label" htmlFor="base-url">API 地址</label><input className="text-field" id="base-url" type="url" inputMode="url" value={prefs.baseUrl} placeholder="https://api.deepseek.com" onChange={e=>setPrefs({...prefs,baseUrl:e.target.value})} onBlur={()=>{ if(!validApiBase(prefs.baseUrl)) notify('API 地址必须是 https://（本机调试可用 127.0.0.1 / localhost）') }}/><div className="settings-section"><span>外观</span><div className="theme-picker">{([{id:'light',name:'浅色',icon:Sun},{id:'dark',name:'深色',icon:Moon},{id:'system',name:'跟随系统',icon:Laptop}] as const).map(t=><button className={prefs.theme===t.id?'active':''} key={t.id} onClick={()=>setPrefs({...prefs,theme:t.id})}><t.icon size={18}/>{t.name}</button>)}</div></div><div className="settings-links"><button onClick={()=>{if(chat)download(`${chat.title}.md`,exportChat(chat));else notify('先开始一段对话')}}><Download size={18}/>导出当前对话<ChevronRight size={16}/></button><button onClick={()=>setSheet('about')}><CircleHelp size={18}/>关于与使用说明<ChevronRight size={16}/></button></div><button className="primary-button" onClick={()=>{dismissSheet();if(prefs.apiKey.trim()) void fetchModels()}}>完成<Check size={18}/></button></>}
      {sheet==='model' && <>{!prefs.apiKey.trim() ? <div className="info-box"><Smartphone size={18}/><div><strong>先填写 API Key</strong><p>填写后自动获取官方模型与推理等级。</p></div></div> : modelsLoading ? <div className="model-loading"><Loader2 size={18} className="spin"/><span>正在校验并加载模型…</span></div> : models.length ? <><div className="model-list">{models.map(m=><button className={`model-option ${prefs.model===m.id?'active':''}`} key={m.id} onClick={()=>{setPrefs(current=>({...current,model:m.id,reasoningEffort:m.efforts.some(e=>e.id===current.reasoningEffort)?current.reasoningEffort:(m.defaultEffort||m.efforts.find(e=>e.id==='high')?.id||m.efforts[0]?.id||'')}))}}><MessageCircle size={22}/><span><strong>{m.name}</strong><small>{modelDescription(m)}</small>{m.efforts.length ? <em className="model-effort">{m.efforts.map(e=>e.name).join(' / ')}</em> : null}</span>{prefs.model===m.id&&<Check size={19}/>}</button>)}</div>{activeModel && activeModel.efforts.length ? <div className="reasoning-box"><div className="reasoning-head"><span>推理等级</span><strong style={{color: effortColor(prefs.reasoningEffort)}}>{effortName(activeEffort?.id || activeModel.efforts[0].id, activeEffort?.name || activeModel.efforts[0].name)}</strong></div><input className="reasoning-slider" style={{accentColor: effortColor(prefs.reasoningEffort)}} type="range" min={0} max={activeModel.efforts.length-1} step={1} value={Math.max(0, activeModel.efforts.findIndex(e=>e.id===prefs.reasoningEffort))} onChange={e=>{const effort=activeModel.efforts[Number(e.target.value)]; if(effort) setPrefs(current=>({...current,reasoningEffort:effort.id}))}} aria-label="推理等级"/><div className="reasoning-labels">{activeModel.efforts.map(effort=><button key={effort.id} type="button" className={prefs.reasoningEffort===effort.id?'active':''} style={{color: effortColor(effort.id)}} onClick={()=>setPrefs(current=>({...current,reasoningEffort:effort.id}))}>{effortName(effort.id, effort.name)}</button>)}</div><p className="reasoning-desc">{effortDesc(prefs.reasoningEffort)}</p></div> : null}</> : <div className="info-box"><div><strong>还没有模型</strong><p>{modelsError || '点下面按钮重新获取。'}</p></div></div>}{prefs.apiKey.trim() ? <button className="secondary-button" disabled={modelsLoading} onClick={()=>void fetchModels()}><RefreshCw size={16} className={modelsLoading?'spin':''}/>{modelsLoading?'加载中…':'刷新官方模型目录'}</button> : <button className="primary-button" onClick={()=>setSheet('settings')}>去填写 API Key<ChevronRight size={16}/></button>}</>}
      {sheet==='files' && (filesLoading ? <div className="model-loading"><Loader2 size={18} className="spin"/><span>正在读取工作区文件…</span></div> : chosenFile ? <><button className="file-export" onClick={()=>download(chosenFile.path.split('/').pop()||'file.txt',chosenFile.text)}><Download size={16}/>保存到设备</button><pre className="file-preview">{chosenFile.text}</pre></> : <><div className="files-toolbar"><span>{mode==='phone'?'手机工作区':'桌面工作区'}</span><button disabled={importing} onClick={()=>pickFile()}><Plus size={16}/>{importing?'导入中…':'导入文件'}</button></div>{files.length?files.map(f=><button className="file-row" key={f.path} onClick={()=>setChosenFile(f)}><FileText size={20}/><span>{f.path.replace('/dsh/workspace/','')}</span><ChevronRight size={17}/></button>):<div className="empty-files"><FolderOpen size={38} strokeWidth={1.3}/><h3>给想法一个工作空间</h3><p>导入文本、代码或笔记，<br/>让 DSH 阅读、编辑和整理。</p><button className="secondary-button" onClick={()=>fileInput.current?.click()}><Paperclip size={17}/>导入文件</button></div>}</>)}
      {sheet==='about' && <div className="about-body"><Mark/><h3>DSH 手机版</h3><p>把 Harness 装进口袋。</p>{AUTO_DESKTOP && <p style={{color:'#10b981'}}>个人预置版：打开自动连接桌面 DSH；Web 包会从服务器自动更新。</p>}<div className="about-row"><Smartphone size={20}/><div><strong>本机模式</strong><p>官方开源 DSH 在浏览器 Worker 中运行，提供会话、Agent 循环、工具和虚拟工作区。不是离线大模型，推理通过你的 API 完成。</p></div></div><div className="about-row"><Monitor size={20}/><div><strong>桌面模式</strong><p>桌面连接器为现有 DSH 提供配对访问，可读取会话并发送消息；手机本机模式会同时保持运行，切换不会中断。桌面文件操作遵循原有 Harness 的设置。</p></div></div><div className="about-row"><Download size={20}/><div><strong>安装到手机</strong><p>在 Safari 的分享菜单选择“添加到主屏幕”；Android 使用浏览器的“安装应用”。需要 HTTPS。</p></div></div><div className="about-row"><WifiOff size={20}/><div><strong>移动环境</strong><p>本机工具只操作应用虚拟文件，不运行桌面原生程序。浏览器清理站点数据会删除本地记录，请及时导出重要内容。</p></div></div><a href="https://github.com/deepseek-ai/deepseek-harness" target="_blank" rel="noreferrer">DeepSeek Harness 开源项目<ExternalLink size={14}/></a><small>独立移动端 · UI 参考手机聊天应用的简洁布局<br/>不隶属于 DeepSeek 或 OpenAI</small></div>}
    </div></section></div>}
    {notice && <div className="toast" role="alert">{notice}</div>}
  </div>
}
