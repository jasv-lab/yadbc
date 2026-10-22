import { iconSvg } from '../ui/icon'
import { DiagramLayout, HEADER, LaidTable, ROW } from './diagram'

/**
 * The diagram as a standalone SVG (and PNG from it). Built from the layout, not by serializing the
 * on-screen DOM: the cards there are HTML, and an SVG carrying HTML (foreignObject) taints the canvas,
 * so it could never become a PNG. Colours come from the current theme; JetBrains Mono is embedded,
 * because an SVG rendered as an image can't see the page's web fonts.
 */

export interface ExportTheme {
  bg: string
  raised: string
  sunken: string
  border: string
  borderStrong: string
  fg: string
  muted: string
  faint: string
  accent: string
  warning: string
}

export function currentTheme(): ExportTheme {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string) => css.getPropertyValue(name).trim()
  return {
    bg: v('--bg'),
    raised: v('--bg-raised'),
    sunken: v('--bg-sunken'),
    border: v('--border'),
    borderStrong: v('--border-strong'),
    fg: v('--fg'),
    muted: v('--fg-muted'),
    faint: v('--fg-faint'),
    accent: v('--accent'),
    warning: v('--warning'),
  }
}

const SANS = `'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif`
const MONO = `'JetBrains Mono', ui-monospace, monospace`
const PAD = 40
const CAPTION = 56

let fontCss: Promise<string> | null = null

/** JetBrains Mono 400 (latin + latin-ext) as data-URI @font-face rules, read from the loaded stylesheets. */
export function embeddedFonts(): Promise<string> {
  fontCss ??= (async () => {
    const rules: CSSFontFaceRule[] = []
    for (const sheet of Array.from(document.styleSheets)) {
      let list: CSSRuleList
      try {
        list = sheet.cssRules
      } catch {
        continue
      }
      for (const rule of Array.from(list))
        if (
          rule instanceof CSSFontFaceRule &&
          rule.style.getPropertyValue('font-family').includes('JetBrains Mono') &&
          rule.style.getPropertyValue('font-weight').trim() === '400' &&
          // Latin and Latin Extended (Czech names) — by file name: Chromium normalizes unicode-range (U+0-FF).
          /jetbrains-mono-latin(-ext)?-400-normal/.test(rule.style.getPropertyValue('src'))
        )
          rules.push(rule)
    }
    const out: string[] = []
    for (const rule of rules) {
      const url = /url\(["']?([^"')]+\.woff2)["']?\)/.exec(rule.style.getPropertyValue('src'))?.[1]
      if (!url) continue
      const bytes = new Uint8Array(
        await (await fetch(new URL(url, rule.parentStyleSheet?.href ?? location.href))).arrayBuffer(),
      )
      let bin = ''
      for (let i = 0; i < bytes.length; i += 0x8000)
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      out.push(
        `@font-face{font-family:'JetBrains Mono';font-weight:400;font-style:normal;` +
          `unicode-range:${rule.style.getPropertyValue('unicode-range')};` +
          `src:url(data:font/woff2;base64,${btoa(bin)}) format('woff2')}`,
      )
    }
    return out.join('\n')
  })().catch(() => '')
  return fontCss
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

let ctx: CanvasRenderingContext2D | null = null
/** Cuts text to fit, with an ellipsis — SVG text doesn't do text-overflow. */
function fit(text: string, font: string, max: number): string {
  ctx ??= document.createElement('canvas').getContext('2d')
  if (!ctx || max <= 0) return text
  ctx.font = font
  if (ctx.measureText(text).width <= max) return text
  let s = text
  while (s.length > 1 && ctx.measureText(s + '…').width > max) s = s.slice(0, -1)
  return s + '…'
}

function width(text: string, font: string): number {
  ctx ??= document.createElement('canvas').getContext('2d')
  if (!ctx) return text.length * 7
  ctx.font = font
  return ctx.measureText(text).width
}

function card(t: LaidTable, th: ExportTheme): string {
  const { x, y, w, h } = t
  const out: string[] = [`<g transform="translate(${x},${y})">`]
  const dash = t.table.external ? ' stroke-dasharray="5 4"' : ''
  out.push(`<rect x="0" y="0" width="${w}" height="${h}" rx="10" fill="${th.raised}" filter="url(#shadow)"/>`)
  // Header: sunken, tinted toward the accent at the top, rounded only at the top.
  const head = `M0,10 a10,10 0 0 1 10,-10 h${w - 20} a10,10 0 0 1 10,10 v${HEADER - 10} h-${w} z`
  out.push(
    `<path d="${head}" fill="${th.sunken}"/>`,
    `<path d="${head}" fill="url(#head)"/>`,
    `<line x1="0" y1="${HEADER}" x2="${w}" y2="${HEADER}" stroke="${th.border}"/>`,
    `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="10" fill="none" stroke="${th.borderStrong}"${dash}/>`,
    iconSvg('table', 10, (HEADER - 13) / 2, 13, th.accent),
  )
  const rows = `~${compact(t.table.estRows)}`
  const rowsFont = `11px ${MONO}`
  const titleFont = `600 13px ${SANS}`
  const title = (t.table.external ? `${t.table.schema}.` : '') + t.table.name
  out.push(
    `<text x="30" y="${HEADER / 2 + 4.5}" font-family="${esc(SANS)}" font-size="13" font-weight="600" fill="${th.fg}">` +
      `${esc(fit(title, titleFont, w - 30 - width(rows, rowsFont) - 20))}</text>`,
    `<text x="${w - 10}" y="${HEADER / 2 + 4}" text-anchor="end" font-family="${esc(MONO)}" font-size="11" fill="${th.faint}">${rows}</text>`,
  )
  t.rows.forEach((r, i) => {
    const cy = HEADER + i * ROW + ROW / 2
    if (r.pk) out.push(iconSvg('key', 10, cy - 5.5, 11, th.warning))
    else if (r.fk) out.push(iconSvg('link', 10, cy - 5.5, 11, th.accent))
    else
      out.push(
        r.notNull
          ? `<circle cx="15.5" cy="${cy}" r="2.5" fill="${th.faint}"/>`
          : `<circle cx="15.5" cy="${cy}" r="2.2" fill="none" stroke="${th.faint}"/>`,
      )
    const typeFont = `11px ${MONO}`
    const nameFont = `${r.pk ? '600 ' : ''}12px ${MONO}`
    const typeText = fit(r.type, typeFont, Math.max(40, w * 0.42))
    const typeW = width(typeText, typeFont)
    out.push(
      `<text x="28" y="${cy + 4}" font-family="${esc(MONO)}" font-size="12"${r.pk ? ' font-weight="600"' : ''} fill="${th.fg}">` +
        `${esc(fit(r.name, nameFont, w - 28 - typeW - 20))}</text>`,
      `<text x="${w - 10}" y="${cy + 3.5}" text-anchor="end" font-family="${esc(MONO)}" font-size="11" fill="${th.faint}">${esc(typeText)}</text>`,
    )
  })
  if (t.more) {
    const cy = HEADER + t.rows.length * ROW + ROW / 2
    out.push(
      `<text x="28" y="${cy + 4}" font-family="${esc(SANS)}" font-size="11.5" fill="${th.faint}">+ ${t.more} more</text>`,
    )
  }
  out.push('</g>')
  return out.join('')
}

function compact(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${+(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${+(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`
}

export interface ExportedSvg {
  svg: string
  width: number
  height: number
}

export function diagramSvg(
  layout: DiagramLayout,
  theme: ExportTheme,
  caption: { title: string; subtitle: string },
  fonts: string,
): ExportedSvg {
  const width = Math.ceil(layout.width + PAD * 2)
  const height = Math.ceil(layout.height + PAD * 2 + CAPTION)
  const th = theme
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<style>${fonts}</style>`,
    `<defs>`,
    `<linearGradient id="head" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0" stop-color="${th.accent}" stop-opacity="0.12"/><stop offset="1" stop-color="${th.accent}" stop-opacity="0"/></linearGradient>`,
    `<filter id="shadow" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="3" stdDeviation="5" flood-color="#000" flood-opacity="0.16"/></filter>`,
    `<marker id="many" viewBox="0 0 12 12" refX="12" refY="6" markerWidth="12" markerHeight="12" orient="auto">` +
      `<path d="M0 6 L12 0 M0 6 L12 6 M0 6 L12 12" fill="none" stroke="${th.borderStrong}" stroke-width="1.4"/></marker>`,
    `<marker id="one" viewBox="0 0 12 12" refX="0" refY="6" markerWidth="12" markerHeight="12" orient="auto">` +
      `<path d="M5 1 L5 11" fill="none" stroke="${th.borderStrong}" stroke-width="1.6"/></marker>`,
    `</defs>`,
    `<rect width="100%" height="100%" fill="${th.bg}"/>`,
    `<text x="${PAD}" y="${PAD + 4}" font-family="${esc(SANS)}" font-size="16" font-weight="600" fill="${th.fg}">${esc(caption.title)}</text>`,
    `<text x="${PAD}" y="${PAD + 24}" font-family="${esc(SANS)}" font-size="12" fill="${th.faint}">${esc(caption.subtitle)}</text>`,
    `<g transform="translate(${PAD},${PAD + CAPTION})">`,
  ]
  for (const e of layout.edges)
    parts.push(
      `<path d="${e.path}" fill="none" stroke="${th.borderStrong}" stroke-width="1.5"` +
        `${e.relation.nullable ? ' stroke-dasharray="5 4"' : ''} marker-start="url(#one)" marker-end="url(#many)"/>`,
    )
  if (layout.looseTop !== null)
    parts.push(
      `<text x="0" y="${layout.looseTop + 12}" font-family="${esc(SANS)}" font-size="12" font-weight="500" fill="${th.muted}">Not related to other tables</text>`,
    )
  for (const t of layout.tables) parts.push(card(t, th))
  parts.push('</g></svg>')
  return { svg: parts.join('\n'), width, height }
}

/** 2× PNG, smaller when the diagram is huge (Chromium caps canvases around 16k px a side / 268M px). */
export async function svgToPng({ svg, width, height }: ExportedSvg): Promise<Blob> {
  const scale = Math.min(2, 16_000 / width, 16_000 / height, Math.sqrt(200_000_000 / (width * height)))
  const img = new Image()
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  await img.decode()
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(width * scale)
  canvas.height = Math.round(height * scale)
  const c = canvas.getContext('2d')!
  c.drawImage(img, 0, 0, canvas.width, canvas.height)
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png'),
  )
}

export function download(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
