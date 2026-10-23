import { hledgerLanguage } from "@giduru/codemirror-lang-hledger"
import { StreamLanguage } from "@codemirror/language"
import { tags } from "@lezer/highlight"

export type SourceSyntax = "journal" | "rules"

const RULE_DIRECTIVES = new Set([
  "account1",
  "account2",
  "amount",
  "balance-type",
  "code",
  "comment",
  "currency",
  "date",
  "date-format",
  "decimal-mark",
  "description",
  "fields",
  "if",
  "include",
  "newest-first",
  "skip",
  "status",
  "year",
])

const tokenTable = {
  atom: tags.atom,
  comment: tags.comment,
  keyword: tags.keyword,
  meta: tags.meta,
  number: tags.number,
  operator: tags.operator,
  propertyName: tags.propertyName,
  string: tags.string,
  string2: tags.regexp,
  variableName: tags.variableName,
}

const RULES_LANGUAGE = StreamLanguage.define<null>({
  startState: () => null,
  token(stream) {
    const line = stream.string
    const indentation = line.match(/^\s*/)?.[0].length ?? 0
    const atFirstToken = stream.pos === indentation
    const content = line.slice(indentation)
    const comments = [";", "#"]

    if (atFirstToken && comments.some((marker) => content.startsWith(marker))) {
      stream.skipToEnd()
      return "comment"
    }
    if (stream.eatSpace()) return null
    if (comments.includes(stream.peek() ?? "")) {
      stream.skipToEnd()
      return "comment"
    }
    if (atFirstToken) {
      const word = /^[A-Za-z][\w-]*/.exec(line.slice(stream.pos))?.[0]
      if (word !== undefined && RULE_DIRECTIVES.has(word.toLowerCase())) {
        stream.match(word)
        return "keyword"
      }
    }
    if (stream.match(/(?:\/(?:\\.|[^/])*\/|\^[^;]*\$)/)) return "string2"
    if (stream.match(/%[\w-]+/)) return "variableName"
    if (stream.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/)) return "string"
    if (stream.match(/(?:[$€£¥]|[A-Z]{3})/)) return "atom"
    if (stream.match(/[+-]?(?:\d[\d,]*(?:\.\d+)?|\.\d+)/)) return "number"
    if (stream.match(/[*!]/)) return "meta"
    if (stream.match(/\([^)]*\)/)) return "meta"
    if (stream.match(/[|=<>]/)) return "operator"
    if (stream.match(/[\w-]+(?::[\w-]+)+/)) return "propertyName"
    stream.next()
    return null
  },
  tokenTable,
})

export const languageForSource = (mode: SourceSyntax) =>
  mode === "journal" ? hledgerLanguage : RULES_LANGUAGE

export const syntaxForSource = (path: string): SourceSyntax | undefined => {
  const lower = path.toLowerCase()
  return lower.endsWith(".journal") ? "journal" : lower.endsWith(".rules") ? "rules" : undefined
}
