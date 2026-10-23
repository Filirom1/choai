import { Err, Ok, type Result } from "~/core/lib/monad"

export type CsvError =
  | { readonly kind: "unexpected-quote"; readonly row: number }
  | { readonly kind: "unclosed-quote"; readonly row: number }

const SEPARATORS = [",", ";", "\t", "|"] as const

const separatorOf = (source: string): string => {
  const counts = new Map<string, number>(SEPARATORS.map((separator) => [separator, 0]))
  let quoted = false

  for (let index = source.startsWith("\uFEFF") ? 1 : 0; index < source.length; index += 1) {
    const character = source[index] ?? ""
    const next = source[index + 1] ?? ""
    if (character === '"' && quoted && next === '"') {
      index += 1
    } else if (character === '"') {
      quoted = !quoted
    } else if (!quoted && (character === "\r" || character === "\n")) {
      break
    } else if (!quoted && counts.has(character)) {
      counts.set(character, (counts.get(character) ?? 0) + 1)
    }
  }

  return SEPARATORS.reduce((best, separator) =>
    (counts.get(separator) ?? 0) > (counts.get(best) ?? 0) ? separator : best, ",")
}

export const parseCsv = (source: string): Result<readonly (readonly string[])[], CsvError> => {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ""
  const separator = separatorOf(source)
  let quoted = false
  let afterQuote = false
  let rowNumber = 1

  const finishCell = (): void => {
    row.push(cell)
    cell = ""
    afterQuote = false
  }
  const finishRow = (): void => {
    finishCell()
    rows.push(row)
    row = []
    rowNumber += 1
  }

  for (let index = source.startsWith("\uFEFF") ? 1 : 0; index < source.length; index += 1) {
    const character = source[index] ?? ""
    const next = source[index + 1] ?? ""
    if (quoted) {
      if (character === '"' && next === '"') {
        cell += '"'
        index += 1
      } else if (character === '"') {
        quoted = false
        afterQuote = true
      } else {
        cell += character
        if (character === "\n") rowNumber += 1
      }
    } else if (character === separator) {
      finishCell()
    } else if (character === "\r" || character === "\n") {
      if (character === "\r" && next === "\n") index += 1
      finishRow()
    } else if (character === '"' && cell === "" && !afterQuote) {
      quoted = true
    } else if (character === '"') {
      return Err({ kind: "unexpected-quote", row: rowNumber })
    } else if (afterQuote && character !== " " && character !== "\t") {
      return Err({ kind: "unexpected-quote", row: rowNumber })
    } else {
      cell += character
    }
  }

  if (quoted) return Err({ kind: "unclosed-quote", row: rowNumber })
  if (cell !== "" || row.length > 0 || afterQuote || source.length > 0 && !/[\r\n]$/.test(source)) finishRow()
  return Ok(rows)
}
