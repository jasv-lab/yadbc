import type * as Monaco from 'monaco-editor'

export type MonacoApi = typeof Monaco

let loading: Promise<MonacoApi> | null = null

/** Monaco is lazy-loaded into its own chunk: the shell paints before the editor's ~MBs arrive. */
export function loadMonaco(): Promise<MonacoApi> {
  loading ??= (async () => {
    ;(self as unknown as { MonacoEnvironment: object }).MonacoEnvironment = {
      getWorker: () => new Worker(new URL('./editor.worker', import.meta.url), { type: 'module' }),
    }
    // The ESM build's CSS imports aren't injected for lazy chunks; the min build ships one
    // self-contained stylesheet (codicon font inlined), copied as an asset.
    const [monaco] = await Promise.all([import('monaco-editor'), loadStylesheet('monaco/editor.main.css')])
    await document.fonts.load('13px "JetBrains Mono"')
    defineThemes(monaco)
    return monaco
  })()
  return loading
}

/** Monaco only understands #rrggbb[aa]; tokens may be rgb(... / a). Let the browser normalize them. */
function toHex(color: string): string {
  const probe = document.createElement('div')
  probe.style.color = color
  document.body.appendChild(probe)
  const rgb = getComputedStyle(probe).color
  probe.remove()
  const [r, g, b, a = 1] = (rgb.match(/[\d.]+/g) ?? []).map(Number)
  const hex = (n: number) => Math.round(n).toString(16).padStart(2, '0')
  return `#${hex(r)}${hex(g)}${hex(b)}${a < 1 ? hex(a * 255) : ''}`
}

function loadStylesheet(href: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = href
    link.onload = () => resolve()
    link.onerror = () => reject(new Error(`Failed to load ${href}`))
    document.head.appendChild(link)
  })
}

function defineThemes(monaco: MonacoApi) {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string) => toHex(css.getPropertyValue(name).trim())
  const colors = {
    'editor.background': v('--bg-raised'),
    'editor.foreground': v('--fg'),
    'editorLineNumber.foreground': v('--fg-faint'),
    'editorLineNumber.activeForeground': v('--fg-muted'),
    'editor.lineHighlightBackground': v('--bg-hover'),
    'editor.lineHighlightBorder': '#00000000',
    'editorGutter.background': v('--bg-raised'),
    'editorWidget.background': v('--bg-raised'),
    'editorWidget.border': v('--border-strong'),
  }
  // Token colors match the mockup: violet keywords, teal strings; theme follows the OS scheme like the tokens do.
  const dark = matchMedia('(prefers-color-scheme: dark)').matches
  monaco.editor.defineTheme('yadbc', {
    base: dark ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [
      { token: 'keyword', foreground: dark ? 'a5a0f5' : '534ab7' },
      { token: 'operator', foreground: dark ? 'a5a0f5' : '534ab7' },
      { token: 'string', foreground: dark ? '5dcaa5' : '0f6e56' },
      { token: 'number', foreground: dark ? 'f0997b' : '993c1d' },
      { token: 'comment', foreground: dark ? '63636b' : 'a1a1aa', fontStyle: 'italic' },
      { token: 'predefined', foreground: dark ? '85b7eb' : '185fa5' },
    ],
    colors,
  })
}
