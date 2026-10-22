/**
 * Clipboard text from Excel, LibreOffice or another grid → rows of cells. Tab-separated; a field in
 * double quotes may contain tabs, line breaks and "" for a quote (how Excel copies multi-line cells).
 * The trailing line break Excel adds doesn't make an extra empty row.
 */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let i = 0
  const endField = () => {
    row.push(field)
    field = ''
  }
  const endRow = () => {
    endField()
    rows.push(row)
    row = []
  }
  while (i < text.length) {
    const ch = text[i]
    if (ch === '"' && field === '') {
      // Quoted field: up to the closing quote; "" is a literal quote.
      i++
      while (i < text.length) {
        if (text[i] === '"' && text[i + 1] === '"') {
          field += '"'
          i += 2
        } else if (text[i] === '"') {
          i++
          break
        } else field += text[i++]
      }
      continue
    }
    if (ch === '\t') endField()
    else if (ch === '\r' || ch === '\n') {
      endRow()
      if (ch === '\r' && text[i + 1] === '\n') i++
    } else field += ch
    i++
  }
  if (field !== '' || row.length) endRow()
  return rows
}
