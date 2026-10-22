import { Injectable } from '@angular/core'

export interface Command {
  id: string
  label: string
  /** e.g. 'Ctrl+Enter', 'Ctrl+Shift+B'. Never Ctrl+Alt: on Czech layouts AltGr = Ctrl+Alt and types @ { } [ ]. */
  shortcut?: string
  /** More combos that do the same (F5 for run), listed in the tooltip after the main one. */
  also?: string[]
  /** Shortcut handled by the focused component (e.g. Space in the grid), not by the global dispatcher. */
  local?: boolean
  when?: () => boolean
  run: () => void
}

/**
 * Single source of truth for actions: shortcuts, buttons, tooltips (and later the Ctrl+K palette,
 * context menus and the MCP surface) all render from here, so nothing is reachable only one way.
 */
@Injectable({ providedIn: 'root' })
export class Commands {
  private readonly commands = new Map<string, Command>()

  register(...commands: Command[]) {
    for (const c of commands) this.commands.set(c.id, c)
  }

  execute(id: string): boolean {
    const c = this.commands.get(id)
    if (!c || (c.when && !c.when())) return false
    c.run()
    return true
  }

  /** Commands available right now (their `when` holds), for the palette. */
  list(): Command[] {
    return [...this.commands.values()].filter((c) => !c.when || c.when())
  }

  tooltip(id: string): string {
    const c = this.commands.get(id)
    if (!c) return ''
    const keys = [c.shortcut, ...(c.also ?? [])].filter(Boolean)
    return keys.length ? `${c.label} · ${keys.join(' or ')}` : c.label
  }

  /** Global keydown dispatch. Returns true when the event was consumed. */
  handleKey(e: KeyboardEvent): boolean {
    const combo = comboOf(e)
    for (const c of this.commands.values()) {
      const match = c.shortcut === combo || !!c.also?.includes(combo)
      if (!c.local && match && (!c.when || c.when())) {
        e.preventDefault()
        e.stopPropagation()
        c.run()
        return true
      }
    }
    return false
  }
}

export function comboOf(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  const key = e.key.length === 1 ? e.key.toUpperCase() : e.key
  parts.push(key === ' ' ? 'Space' : key)
  return parts.join('+')
}
