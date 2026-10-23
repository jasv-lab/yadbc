// Monaco's pgsql grammar module ships without typings; we only read its two exports.
declare module 'monaco-editor/languages/definitions/pgsql/pgsql.js' {
  import type { languages } from 'monaco-editor'
  export const conf: languages.LanguageConfiguration
  export const language: languages.IMonarchLanguage & { keywords: string[] }
}
