import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './style.css'

try {
  const stored = localStorage.getItem('dsh-mobile-theme')
  document.documentElement.dataset.theme = stored || 'system'
} catch {}

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() {
    if (this.state.failed) return <div style={{ padding: 24, fontFamily: '-apple-system, sans-serif', color: '#171717' }}><h2>界面加载失败</h2><p>本地数据可能过大或已损坏。可以尝试重新加载；如果仍然失败，请在设置中清理本地存储。</p><button onClick={() => location.reload()} style={{ padding: '10px 16px', borderRadius: 12, background: '#171717', color: '#fff', border: 0 }}>重新加载</button></div>
    return this.props.children
  }
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><ErrorBoundary><App /></ErrorBoundary></React.StrictMode>)
if ('serviceWorker' in navigator && import.meta.env.PROD) window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(error => console.info('离线缓存未启动', error.message)) })
