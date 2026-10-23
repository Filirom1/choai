import { expect, test } from "bun:test"
import { ensureSyntaxTree } from "@codemirror/language"
import { EditorState } from "@codemirror/state"
import { classHighlighter, highlightTree } from "@lezer/highlight"

import { parseCsv } from "~/core/journal/csv"
import { languageForSource, syntaxForSource, type SourceSyntax } from "~/core/journal/source-syntax"

const highlightedTokens = (mode: SourceSyntax, text: string): readonly { text: string; classes: string }[] => {
  const state = EditorState.create({ doc: text, extensions: languageForSource(mode).extension })
  const tree = ensureSyntaxTree(state, state.doc.length, 1000)
  const tokens: { text: string; classes: string }[] = []
  if (tree !== null) {
    highlightTree(tree, classHighlighter, (from, to, classes) => {
      tokens.push({ text: text.slice(from, to), classes })
    })
  }
  return tokens
}

test("selects journal and CSV rules syntax from the final path extension", () => {
  expect(syntaxForSource("transactions.journal")).toBe("journal")
  expect(syntaxForSource("import/staging/00022882101.csv.rules")).toBe("rules")
  expect(syntaxForSource("IMPORT/Bank.CSV.RULES")).toBe("rules")
  expect(syntaxForSource("choai-settings.jsonl")).toBeUndefined()
})

test("highlights hledger journal dates, accounts, amounts, and comments", () => {
  const tokens = highlightedTokens("journal", [
    "2026-02-03 * Payee",
    "    assets:cash  $10.00",
    "    ; memo",
  ].join("\n"))

  expect(tokens).toContainEqual({ text: "2026-02-03", classes: "tok-meta" })
  expect(tokens).toContainEqual({ text: "assets:cash", classes: "tok-variableName" })
  expect(tokens).toContainEqual({ text: "10.00", classes: "tok-number" })
  expect(tokens).toContainEqual({ text: ";", classes: "tok-comment" })
  expect(tokens).toContainEqual({ text: " memo", classes: "tok-comment" })
})

test("highlights CSV rule directives, variables, and regular expressions", () => {
  const tokens = highlightedTokens("rules", [
    "fields date, description, amount",
    "if %description =~ /market/",
    "account1 assets:bank",
  ].join("\n"))

  expect(tokens).toContainEqual({ text: "fields", classes: "tok-keyword" })
  expect(tokens).toContainEqual({ text: "%description", classes: "tok-variableName" })
  expect(tokens).toContainEqual({ text: "/market/", classes: "tok-string2" })
  expect(tokens).toContainEqual({ text: "assets:bank", classes: "tok-propertyName" })
})

test("parses quoted cells, escaped quotes, and multiline values", () => {
  expect(parseCsv('\uFEFFname,note\r\n"Coffee, shop","said ""hello""\nand left"\r\n')).toEqual({
    ok: true,
    value: [
      ["name", "note"],
      ["Coffee, shop", 'said "hello"\nand left'],
    ],
  })
})

test("detects a semicolon separator from the first row without splitting decimal commas", () => {
  expect(parseCsv([
    "Date;Débit;Libellé;Solde",
    "10/08/2026;-4,88;FACT SGT26072280012234;3882,17",
    '11/08/2026;;"Virement; reçu";3887,05',
  ].join("\r\n"))).toEqual({
    ok: true,
    value: [
      ["Date", "Débit", "Libellé", "Solde"],
      ["10/08/2026", "-4,88", "FACT SGT26072280012234", "3882,17"],
      ["11/08/2026", "", "Virement; reçu", "3887,05"],
    ],
  })
})

test("reports invalid quoting instead of presenting a misleading table", () => {
  expect(parseCsv('name,note\n"Coffee')).toEqual({
    ok: false,
    error: { kind: "unclosed-quote", row: 2 },
  })
  expect(parseCsv('name,no"te')).toEqual({
    ok: false,
    error: { kind: "unexpected-quote", row: 1 },
  })
})
