import type * as Monaco from 'monaco-editor'
import { catchError, firstValueFrom, of } from 'rxjs'
import { splitSql } from '../core/sql-splitter'
import { Catalog, CatalogColumn, CatalogObject, CatalogObjects, ident } from '../schema/catalog'
import { EditorTab } from '../workspace/workspace'
import { completionContext, RelationRef, resolveQualifier } from './completion'
import { SQL_LANGUAGE, type MonacoApi } from './monaco'

const KEYWORDS = (
  'select from where and or not in exists between like ilike is null true false as join left right inner full outer ' +
  'cross on using group by order asc desc nulls first last having limit offset distinct union all intersect except ' +
  'case when then else end insert into values update set delete returning with recursive create table view index ' +
  'alter drop add column primary key foreign references default unique check constraint begin commit rollback ' +
  'explain analyze over partition window filter lateral cast interval materialized refresh truncate'
).split(' ')

const FUNCTIONS = (
  'count sum avg min max coalesce nullif greatest least now current_date current_timestamp date_trunc date_part ' +
  'extract age to_char to_date to_timestamp lower upper length substring trim concat format split_part ' +
  'regexp_replace string_agg array_agg json_agg jsonb_agg jsonb_build_object json_build_object row_number rank ' +
  'dense_rank lag lead round abs floor ceil random gen_random_uuid generate_series unnest'
).split(' ')

const TABLE_KINDS = new Set(['table', 'view', 'matview', 'foreign'])

/**
 * Schema-aware completion for the pgsql language: tables after FROM/JOIN, columns of the statement's
 * relations (aliases resolved), schema members after `schema.`, plus keywords and functions.
 * Data comes from the same catalog cache the schema tree uses.
 */
export function registerSqlCompletion(
  monaco: MonacoApi,
  catalog: Catalog,
  tabFor: (model: Monaco.editor.ITextModel) => EditorTab | undefined,
): Monaco.IDisposable {
  const K = monaco.languages.CompletionItemKind

  return monaco.languages.registerCompletionItemProvider(SQL_LANGUAGE, {
    triggerCharacters: ['.'],
    async provideCompletionItems(model, position) {
      const tab = tabFor(model)
      if (!tab) return { suggestions: [] }

      const text = model.getValue()
      const offset = model.getOffsetAt(position)
      const statement = currentStatement(text, offset)
      const ctx = completionContext(statement.sql, offset - statement.start)
      if (ctx.kind === 'none') return { suggestions: [] }

      const word = model.getWordUntilPosition(position)
      const range = new monaco.Range(
        position.lineNumber,
        word.startColumn,
        position.lineNumber,
        word.endColumn,
      )
      const upper = /^[A-Z]/.test(word.word)
      const data = await firstValueFrom(catalog.objects(tab.connection.id).pipe(catchError(() => of(null))))
      if (!data) return { suggestions: keywordItems() }

      const columnsOf = async (o: CatalogObject) =>
        (await firstValueFrom(catalog.relation(tab.connection.id, o.oid).pipe(catchError(() => of(null)))))
          ?.columns ?? []

      const relationItem = (
        o: CatalogObject,
        qualifiedBySchema: boolean,
        sort: string,
      ): Monaco.languages.CompletionItem => ({
        label: {
          label: o.name,
          description: `${o.schema}${o.estRows != null ? ` · ~${o.estRows.toLocaleString()}` : ''}`,
        },
        kind: o.kind === 'view' || o.kind === 'matview' ? K.Interface : K.Struct,
        detail: o.kind,
        documentation: o.comment ?? undefined,
        // Unqualified for public (it's on everyone's search_path), schema-qualified otherwise.
        insertText:
          qualifiedBySchema || o.schema === 'public' ? ident(o.name) : `${ident(o.schema)}.${ident(o.name)}`,
        filterText: o.name,
        sortText: sort + o.name,
        range,
      })

      const columnItem = (
        c: CatalogColumn,
        owner: string,
        insert: string,
        sort: string,
      ): Monaco.languages.CompletionItem => ({
        label: { label: c.name, description: owner },
        kind: K.Field,
        detail: `${c.type}${c.nullable ? '' : ' not null'}${c.primaryKey ? ' · pk' : ''}`,
        documentation:
          [c.default ? `default ${c.default}` : '', c.references ? `→ ${c.references}` : '', c.comment ?? '']
            .filter(Boolean)
            .join('\n') || undefined,
        insertText: insert,
        filterText: c.name,
        sortText: sort + c.name,
        range,
      })

      function keywordItems(): Monaco.languages.CompletionItem[] {
        return [
          ...KEYWORDS.map((k) => ({
            label: upper ? k.toUpperCase() : k,
            kind: K.Keyword,
            insertText: upper ? k.toUpperCase() : k,
            sortText: '4' + k,
            range,
          })),
          ...FUNCTIONS.map((f) => ({
            label: f,
            kind: K.Function,
            insertText: `${f}($0)`,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            sortText: '5' + f,
            range,
          })),
        ]
      }

      const schemaItems = (): Monaco.languages.CompletionItem[] =>
        data.schemas.map((s) => ({
          label: s,
          kind: K.Module,
          detail: 'schema',
          insertText: `${ident(s)}.`,
          // Typing on into the schema's objects.
          command: { id: 'editor.action.triggerSuggest', title: 'Suggest' },
          sortText: '3' + s,
          range,
        }))

      switch (ctx.kind) {
        case 'relation': {
          const objects = data.objects.filter(
            (o) => TABLE_KINDS.has(o.kind) && (!ctx.schema || o.schema === ctx.schema),
          )
          return {
            suggestions: [
              ...objects.map((o) => relationItem(o, !!ctx.schema, o.schema === 'public' ? '1' : '2')),
              ...(ctx.schema ? [] : schemaItems()),
            ],
          }
        }

        case 'member': {
          // alias. / table. → columns; schema. → that schema's objects.
          const ref = resolveQualifier(ctx.qualifier, ctx.refs)
          const object = (ref && findObject(data, ref)) ?? findObject(data, { name: ctx.qualifier })
          if (object) {
            const cols = await columnsOf(object)
            return { suggestions: cols.map((c) => columnItem(c, object.name, ident(c.name), '1')) }
          }
          if (data.schemas.includes(ctx.qualifier)) {
            return {
              suggestions: data.objects
                .filter((o) => o.schema === ctx.qualifier)
                .map((o) =>
                  o.kind === 'function' || o.kind === 'procedure'
                    ? {
                        label: o.name,
                        kind: K.Function,
                        insertText: `${ident(o.name.slice(0, o.name.indexOf('(')))}($0)`,
                        insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                        sortText: '2' + o.name,
                        range,
                      }
                    : relationItem(o, true, '1'),
                ),
            }
          }
          return { suggestions: [] }
        }

        case 'general': {
          // The same table named twice without an alias (`from t` … `insert into t`, or two statements
          // without a `;` between them) is one scope, not two: listing it twice doubles every column.
          const seen = new Set<string>()
          const resolved = ctx.refs
            .map((ref) => ({ ref, object: findObject(data, ref) }))
            .filter((r): r is { ref: RelationRef; object: CatalogObject } => !!r.object)
            .filter((r) => {
              const key = `${r.object.oid}|${r.ref.alias ?? ''}`
              return !seen.has(key) && !!seen.add(key)
            })
          const columnSets = await Promise.all(resolved.map((r) => columnsOf(r.object)))

          // A column name present in several relations gets qualified on insert (u.id vs i.id).
          const counts = new Map<string, number>()
          columnSets.flat().forEach((c) => counts.set(c.name, (counts.get(c.name) ?? 0) + 1))

          const columns = resolved.flatMap((r, i) =>
            columnSets[i].map((c) => {
              const owner = r.ref.alias ?? r.object.name
              const insert =
                (counts.get(c.name) ?? 0) > 1 ? `${ident(owner)}.${ident(c.name)}` : ident(c.name)
              return columnItem(
                c,
                r.ref.alias ? `${r.ref.alias} · ${r.object.name}` : r.object.name,
                insert,
                '1',
              )
            }),
          )
          const aliases = resolved.map((r) => ({
            label: r.ref.alias ?? r.object.name,
            kind: K.Variable,
            detail: r.ref.alias ? `alias of ${r.object.schema}.${r.object.name}` : `${r.object.kind}`,
            insertText: ident(r.ref.alias ?? r.object.name),
            sortText: '2' + (r.ref.alias ?? r.object.name),
            range,
          }))
          // Nothing in scope yet (`select |`): offer tables too.
          const tables = resolved.length
            ? []
            : data.objects.filter((o) => TABLE_KINDS.has(o.kind)).map((o) => relationItem(o, false, '3'))
          const userFunctions = data.objects
            .filter((o) => o.kind === 'function')
            .map((o) => ({
              label: o.name,
              kind: K.Function,
              insertText: `${o.schema === 'public' ? '' : ident(o.schema) + '.'}${ident(o.name.slice(0, o.name.indexOf('(')))}($0)`,
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              filterText: o.name,
              sortText: '5' + o.name,
              range,
            }))
          return { suggestions: [...columns, ...aliases, ...tables, ...keywordItems(), ...userFunctions] }
        }
      }
    },
  })
}

/** The statement containing the cursor; text after the last `;` while a new statement is being typed. */
function currentStatement(text: string, offset: number): { sql: string; start: number } {
  const statements = splitSql(text)
  const containing = statements.find((s) => offset >= s.start && offset <= s.end)
  if (containing) return { sql: text.slice(containing.start, containing.end), start: containing.start }
  const before = statements.filter((s) => s.end <= offset).at(-1)
  const start = before ? before.end : 0
  return { sql: text.slice(start, Math.max(offset, start)), start }
}

/** Unqualified names: public first (the usual search_path), then any schema. */
function findObject(data: CatalogObjects, ref: { schema?: string; name: string }): CatalogObject | undefined {
  const tables = data.objects.filter((o) => TABLE_KINDS.has(o.kind) && o.name === ref.name)
  if (ref.schema) return tables.find((o) => o.schema === ref.schema)
  return tables.find((o) => o.schema === 'public') ?? tables[0]
}
