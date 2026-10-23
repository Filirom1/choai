import { describe, expect, test } from "bun:test"

import { bookConfigFromFiles, DEFAULT_BOOK_CONFIG, BOOK_CONFIG_PATH, textOfBookConfig } from "~/core/journal/book-config"

const report = { id: "one", name: "Monthly spending", command: "balance expenses --monthly" }
const config = {
  documents: { tag: "receipt", folder: "papers/receipts" },
  reports: [report],
  invert: true,
  imports: { csvFolder: "imports/csv", rulesFolder: "imports/rules" },
  accountSort: "alphabetical" as const,
  entryDisplay: {
    date: true,
    payee: true,
    note: true,
    status: true,
    code: true,
    transactionComment: true,
    transactionTags: true,
    postingDate: true,
    postingComment: true,
    postingTags: true,
  },
}

describe("the configuration that travels with a book", () => {
  test("a book without a configuration uses defaults", () => {
    expect(bookConfigFromFiles({})).toEqual({ ok: true, value: DEFAULT_BOOK_CONFIG })
  })

  test("reads its settings and custom reports from the companion file", () => {
    const files = { [BOOK_CONFIG_PATH]: textOfBookConfig(config) }
    expect(bookConfigFromFiles(files)).toEqual({ ok: true, value: config })
  })

  test("reads older settings files with defaults for newer settings", () => {
    const legacy = { documents: config.documents, reports: config.reports }
    const files = { [BOOK_CONFIG_PATH]: JSON.stringify(legacy) }
    expect(bookConfigFromFiles(files)).toEqual({
      ok: true,
      value: {
        ...legacy,
        invert: false,
        imports: DEFAULT_BOOK_CONFIG.imports,
        accountSort: "chart",
        entryDisplay: DEFAULT_BOOK_CONFIG.entryDisplay,
      },
    })
  })

  test("fills new entry display fields when an older settings file has them missing", () => {
    const { date: _date, payee: _payee, note: _note, ...legacyDisplay } = config.entryDisplay
    const files = {
      [BOOK_CONFIG_PATH]: JSON.stringify({ ...config, entryDisplay: legacyDisplay }),
    }
    expect(bookConfigFromFiles(files)).toEqual({
      ok: true,
      value: {
        ...config,
        entryDisplay: {
          ...DEFAULT_BOOK_CONFIG.entryDisplay,
          ...legacyDisplay,
        },
      },
    })
  })

  test("refuses an invalid configuration instead of silently dropping fields", () => {
    const files = { [BOOK_CONFIG_PATH]: JSON.stringify({ ...config, private: true }) }
    expect(bookConfigFromFiles(files)).toEqual({ ok: false, error: { kind: "invalid-shape" } })
  })

  test("refuses an unknown account order", () => {
    const files = { [BOOK_CONFIG_PATH]: JSON.stringify({ ...config, accountSort: "recent" }) }
    expect(bookConfigFromFiles(files)).toEqual({ ok: false, error: { kind: "invalid-shape" } })
  })

  test("refuses invalid entry display settings", () => {
    const files = { [BOOK_CONFIG_PATH]: JSON.stringify({ ...config, entryDisplay: { ...config.entryDisplay, status: "yes" } }) }
    expect(bookConfigFromFiles(files)).toEqual({ ok: false, error: { kind: "invalid-shape" } })
  })
})
