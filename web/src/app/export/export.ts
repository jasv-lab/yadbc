import { Session } from '../core/session'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { inject, Injectable } from '@angular/core'
import { catchError, Observable, throwError } from 'rxjs'
import { ResultView } from '../workspace/workspace'

export type ExportFormat = 'tsv' | 'csv' | 'json' | 'markdown' | 'insert' | 'update' | 'in' | 'where'

export const FORMATS: { id: ExportFormat; label: string; sql?: boolean }[] = [
  { id: 'tsv', label: 'TSV' },
  { id: 'csv', label: 'CSV' },
  { id: 'json', label: 'JSON' },
  { id: 'markdown', label: 'Markdown' },
  { id: 'insert', label: 'INSERT', sql: true },
  { id: 'update', label: 'UPDATE by key', sql: true },
  { id: 'in', label: 'IN (…) list', sql: true },
  { id: 'where', label: 'WHERE clause', sql: true },
]

export interface ExportOptions {
  header: boolean
  table: string | null
  insertMode: 'row' | 'multi'
  onConflict: 'none' | 'nothing' | 'update'
}

export interface Selection {
  r0: number
  r1: number
  c0: number
  c1: number
}

export interface ExportScope {
  rows: [number, number] | null
  columns: number[] | null
  label: string
}

export interface ExportResult {
  text: string
  rowCount: number
  table: string | null
  extension: string
  mime: string
}

export interface ResultSourceInfo {
  table: string | null
  primaryKey: string[] | null
  totalRows: number
  capped: boolean
}

const OPTIONS_KEY = 'yadbc.exportOptions'
const DEFAULT_OPTIONS: ExportOptions = { header: true, table: null, insertMode: 'row', onConflict: 'none' }

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i)

/**
 * What an export covers. A real range selection exports exactly that; a single selected cell (or none)
 * means "the whole result" — except IN/WHERE, which are about the selected column's values.
 */
export function scopeFor(result: ResultView, sel: Selection | null, format: ExportFormat): ExportScope {
  const valueFormat = format === 'in' || format === 'where'
  const isRange = !!sel && (sel.r0 !== sel.r1 || sel.c0 !== sel.c1)
  if (sel && (isRange || valueFormat)) {
    const rows = sel.r1 - sel.r0 + 1
    const cols = sel.c1 - sel.c0 + 1
    return {
      rows: [sel.r0, sel.r1 + 1],
      columns: range(sel.c0, sel.c1),
      label: `${rows.toLocaleString()} ${rows === 1 ? 'row' : 'rows'} × ${cols} ${cols === 1 ? 'column' : 'columns'}`,
    }
  }
  if (valueFormat) return { rows: null, columns: [0], label: `column “${result.columns[0]?.name}”, all rows` }
  return { rows: null, columns: null, label: `all ${result.rowCount.toLocaleString()} rows` }
}

@Injectable({ providedIn: 'root' })
export class Exporter {
  private readonly http = inject(HttpClient)
  private readonly session = inject(Session)

  /** Last-used options, so the one-click menu items behave like the dialog did last time. */
  loadOptions(): ExportOptions {
    try {
      return {
        ...DEFAULT_OPTIONS,
        ...this.session.pref<Partial<ExportOptions>>(OPTIONS_KEY, {}),
        table: null,
      }
    } catch {
      return { ...DEFAULT_OPTIONS }
    }
  }

  saveOptions(options: ExportOptions) {
    try {
      const { table: _, ...rest } = options
      this.session.setPref(OPTIONS_KEY, rest)
    } catch {
      // remembering options is a convenience
    }
  }

  source(resultId: string, columns: number[] | null): Observable<ResultSourceInfo> {
    return this.http.get<ResultSourceInfo>(`/api/results/${resultId}/source`, {
      params: columns ? { cols: columns.join(',') } : {},
    })
  }

  run(
    resultId: string,
    format: ExportFormat,
    scope: ExportScope,
    options: ExportOptions,
    previewRows?: number,
  ): Observable<ExportResult> {
    return this.http
      .post<ExportResult>(`/api/results/${resultId}/export`, {
        format,
        rows: scope.rows,
        columns: scope.columns,
        options: { ...options, table: options.table?.trim() || null },
        previewRows,
      })
      .pipe(
        catchError((e: HttpErrorResponse) => throwError(() => new Error(e.error?.error ?? 'Export failed'))),
      )
  }

  copy(text: string): Observable<void> {
    return new Observable<void>((sub) => {
      navigator.clipboard.writeText(text).then(
        () => sub.complete(),
        (e) => sub.error(e),
      )
    })
  }

  /** Browser-style download; in the desktop window WebView2 saves it to Downloads. */
  save(result: ExportResult, baseName: string) {
    const blob = new Blob([result.text], { type: `${result.mime};charset=utf-8` })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${baseName}.${result.extension}`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  baseName(result: ExportResult): string {
    return (result.table ?? 'result').replace(/"/g, '').replace(/[^\w.-]+/g, '_')
  }

  copiedMessage(format: ExportFormat, result: ExportResult): string {
    const label = FORMATS.find((f) => f.id === format)?.label ?? format
    const rows = `${result.rowCount.toLocaleString()} ${result.rowCount === 1 ? 'row' : 'rows'}`
    return `Copied ${rows} as ${label}`
  }
}

export const toMessage = (e: unknown) => (e instanceof Error ? e.message : 'Export failed')
