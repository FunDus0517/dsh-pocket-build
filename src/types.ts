export type RunMode = 'phone' | 'desktop'
export type Message = { id: string; role: 'user' | 'assistant' | 'tool'; text: string; reasoning?: string; tool?: string; pending?: boolean; error?: boolean; tools?: Message[]; html?: { name: string; text: string }; images?: string[] }
export type Chat = { id: string; title: string; updated: number; mode: RunMode; messages: Message[]; cwd?: string; overrides?: Record<string, { text: string }> }
export type Preferences = { theme: 'system' | 'light' | 'dark'; model: string; reasoningEffort?: string; apiKey: string; baseUrl: string; endpoint: string; token: string }
export type RuntimeState = 'idle' | 'starting' | 'ready' | 'error'
export type RuntimeEvent = { type: 'message'; message: Message } | { type: 'delta'; text: string; reasoning?: string } | { type: 'status'; text: string } | { type: 'done' } | { type: 'error'; text: string }
export type Harness = {
  start(prefs: Preferences): Promise<void>
  create(): Promise<string>
  list(): Promise<Chat[]>
  history(id: string): Promise<Message[]>
  catalog(): Promise<any>
  send(id: string, text: string, prefs: Preferences, onEvent: (event: RuntimeEvent) => void, signal: AbortSignal, images?: ImageAttachment[]): Promise<void>
  stop(id: string): Promise<void>
  files(): Promise<{ path: string; text: string }[]>
  importFile(name: string, text: string): Promise<void>
  flush(): Promise<void>
  dispose(): void
}

export type ImageAttachment = { mediaType: string; data: string; name?: string }
