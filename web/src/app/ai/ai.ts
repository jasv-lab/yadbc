import { HttpClient } from '@angular/common/http'
import { inject, Injectable, signal } from '@angular/core'
import { firstValueFrom } from 'rxjs'
import { apiToken } from '../core/token'

/** What the assistant uses (endpoint, model, key) and the two sources behind it. */
export interface AiConfig {
  endpoint: string | null
  model: string | null
  maxTokens: number
  hasKey: boolean
  source: 'own' | 'team' | 'none'
  own: { endpoint: string | null; model: string | null; maxTokens: number; hasKey: boolean }
  team: {
    endpoint: string
    model: string
    maxTokens: number
    hasKey: boolean
    updatedBy: string
    updatedAt: string
  } | null
  /** An admin on the broker: may share their own settings with the team. */
  canShare: boolean
}

/** Where a suggested statement would go back to: the statement the question was about. */
export interface Anchor {
  tabId: string
  offset: number
  sql: string
}

export interface AiMessage {
  role: 'user' | 'assistant'
  content: string
  /** A thinking model's reasoning, shown collapsed. */
  reasoning?: string
  error?: string
  streaming?: boolean
  anchor?: Anchor | null
}

export interface AskContext {
  connectionId: string
  sql?: string | null
  error?: string | null
  plan?: string | null
  anchor?: Anchor | null
}

/**
 * The assistant's conversation and settings. Chat goes through the backend (which holds the API key
 * and adds the schema) and streams back as server-sent events; Stop aborts the request.
 */
@Injectable({ providedIn: 'root' })
export class Ai {
  private readonly http = inject(HttpClient)

  readonly config = signal<AiConfig | null>(null)
  readonly messages = signal<AiMessage[]>([])
  readonly busy = signal(false)
  private abort: AbortController | null = null

  async loadConfig(): Promise<AiConfig> {
    const c = await firstValueFrom(this.http.get<AiConfig>('/api/ai/settings'))
    this.config.set(c)
    return c
  }

  async saveConfig(input: { endpoint: string; model: string; maxTokens: number; key: string | null }) {
    await firstValueFrom(this.http.put('/api/ai/settings', input))
    await this.loadConfig()
  }

  /** Admins: your own endpoint and model become the team's, with your key or without. */
  async share(includeKey: boolean) {
    await firstValueFrom(this.http.post('/api/ai/share', { includeKey }))
    await this.loadConfig()
  }

  async stopSharing() {
    await firstValueFrom(this.http.delete('/api/ai/share'))
    await this.loadConfig()
  }

  /** The endpoint's models — also checks the URL and key. */
  models(endpoint: string, key: string | null): Promise<{ models?: string[]; error?: string }> {
    return firstValueFrom(this.http.post<{ models: string[] }>('/api/ai/models', { endpoint, key })).catch(
      (e) => ({ error: e?.error?.error ?? 'Could not reach the endpoint' }),
    )
  }

  newChat() {
    this.stop()
    this.messages.set([])
  }

  stop() {
    this.abort?.abort()
    this.abort = null
  }

  async ask(prompt: string, ctx: AskContext) {
    if (this.busy()) return
    const history = this.messages().filter((m) => !m.error)
    const user: AiMessage = { role: 'user', content: prompt }
    const reply: AiMessage = {
      role: 'assistant',
      content: '',
      reasoning: '',
      streaming: true,
      anchor: ctx.anchor,
    }
    this.messages.set([...this.messages(), user, reply])
    this.busy.set(true)
    const abort = new AbortController()
    this.abort = abort
    const update = (change: Partial<AiMessage>) =>
      this.messages.update((list) => {
        const copy = [...list]
        copy[copy.length - 1] = { ...copy[copy.length - 1], ...change }
        return copy
      })

    let content = ''
    let reasoning = ''
    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        signal: abort.signal,
        headers: { 'Content-Type': 'application/json', 'X-Yadbc-Token': apiToken },
        body: JSON.stringify({
          connectionId: ctx.connectionId,
          messages: [...history, user].map((m) => ({ role: m.role, content: m.content })),
          context: { sql: ctx.sql ?? null, error: ctx.error ?? null, plan: ctx.plan ?? null },
        }),
      })
      if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText}`)
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
      let buffer = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += value
        let cut: number
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
          const event = buffer.slice(0, cut)
          buffer = buffer.slice(cut + 2)
          if (!event.startsWith('data:')) continue
          const e = JSON.parse(event.slice(5)) as { t: 'c' | 'r' | 'e' | 'd'; v?: string }
          if (e.t === 'c') content += e.v ?? ''
          else if (e.t === 'r') reasoning += e.v ?? ''
          else if (e.t === 'e') update({ error: e.v })
          update({ content, reasoning })
        }
      }
    } catch (e) {
      if (!abort.signal.aborted) update({ error: (e as Error)?.message ?? String(e) })
    } finally {
      update({ streaming: false, ...(abort.signal.aborted && !content ? { error: 'Stopped' } : {}) })
      this.busy.set(false)
      if (this.abort === abort) this.abort = null
    }
  }
}
