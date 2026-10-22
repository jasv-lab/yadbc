/**
 * Just enough Markdown for model answers: paragraphs, headings, lists, fenced code, `code` and **bold**.
 * Produces plain data that templates render — never HTML strings — so model output can't inject markup.
 * Works on partial text while it streams (an unclosed fence is a code block in progress).
 */

export interface Inline {
  t: 'text' | 'code' | 'bold'
  v: string
}

export type Block =
  | { t: 'p'; inl: Inline[] }
  | { t: 'h'; inl: Inline[] }
  | { t: 'list'; ordered: boolean; items: Inline[][] }
  | { t: 'code'; lang: string; v: string; open: boolean }

export function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  const re = /`([^`]+)`|\*\*([^*]+)\*\*/g
  let last = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ t: 'text', v: text.slice(last, m.index) })
    out.push(m[1] !== undefined ? { t: 'code', v: m[1] } : { t: 'bold', v: m[2] })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) })
  return out
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let para: string[] = []
  const flush = () => {
    if (para.length) blocks.push({ t: 'p', inl: parseInline(para.join(' ')) })
    para = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fence = /^\s*```\s*([\w-]*)/.exec(line)
    if (fence) {
      flush()
      const code: string[] = []
      let closed = false
      for (i++; i < lines.length; i++) {
        if (/^\s*```\s*$/.test(lines[i])) {
          closed = true
          break
        }
        code.push(lines[i])
      }
      blocks.push({ t: 'code', lang: fence[1].toLowerCase(), v: code.join('\n'), open: !closed })
      continue
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    if (heading) {
      flush()
      blocks.push({ t: 'h', inl: parseInline(heading[1]) })
      continue
    }
    const item = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (item) {
      flush()
      const ordered = /\d/.test(item[1])
      const last = blocks[blocks.length - 1]
      if (last?.t === 'list' && last.ordered === ordered) last.items.push(parseInline(item[2]))
      else blocks.push({ t: 'list', ordered, items: [parseInline(item[2])] })
      continue
    }
    if (!line.trim()) {
      flush()
      continue
    }
    para.push(line.trim())
  }
  flush()
  return blocks
}
