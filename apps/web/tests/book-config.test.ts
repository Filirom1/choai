import { describe, expect, test } from "bun:test"

import { bookConfigFromFiles, DEFAULT_BOOK_CONFIG, BOOK_CONFIG_PATH, textOfBookConfig } from "~/core/journal/book-config"

const report = { id: "one", name: "Monthly spending", command: "balance expenses --monthly" }
const config = {
  documents: { tag: "receipt", folder: "papers/receipts" },
  reports: [report],
  invert: true,
}

describe("the configuration that travels with a book", () => {
  test("a book without a configuration uses defaults", () => {
    expect(bookConfigFromFiles({})).toEqual({ ok: true, value: DEFAULT_BOOK_CONFIG })
  })

  test("reads its settings and custom reports from the companion file", () => {
    const files = { [BOOK_CONFIG_PATH]: textOfBookConfig(config) }
    expect(bookConfigFromFiles(files)).toEqual({ ok: true, value: config })
  })

  test("reads older settings files with report inversion off", () => {
    const legacy = { documents: config.documents, reports: config.reports }
    const files = { [BOOK_CONFIG_PATH]: JSON.stringify(legacy) }
    expect(bookConfigFromFiles(files)).toEqual({ ok: true, value: { ...legacy, invert: false } })
  })

  test("refuses an invalid configuration instead of silently dropping fields", () => {
    const files = { [BOOK_CONFIG_PATH]: JSON.stringify({ ...config, private: true }) }
    expect(bookConfigFromFiles(files)).toEqual({ ok: false, error: { kind: "invalid-shape" } })
  })
})
