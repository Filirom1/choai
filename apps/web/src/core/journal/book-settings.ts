import { createMemo, createRoot, type Accessor } from "solid-js"

import { Err, Ok, getOrUndefined, type Result } from "~/core/lib/monad"
import { createGate } from "~/core/lib/gate"
import { replaceReport, type DefinitionTrouble, type SavedReport } from "~/core/reports/custom"
import type { Trouble } from "~/core/hledger/wire"
import {
  BOOK_CONFIG_PATH,
  bookConfigFromFiles,
  textOfBookConfig,
  type BookConfig,
  type BookConfigTrouble,
} from "./book-config"
import {
  DEFAULT_DOCUMENT_SETTINGS,
  validDocumentSettings,
  type DocumentSettings,
} from "./documents"
import { journal, putFiles } from "./store"

export type BookSettingsTrouble =
  | { readonly kind: "no-book" }
  | { readonly kind: "book-changed" }
  | { readonly kind: "invalid-config"; readonly trouble: BookConfigTrouble }
  | { readonly kind: "invalid-documents" }
  | { readonly kind: "journal"; readonly trouble: Trouble }
  | { readonly kind: "storage"; readonly cause: unknown }

const writes = createRoot(() => createGate())

export const bookSettings = (): Result<BookConfig, BookSettingsTrouble> => {
  const open = getOrUndefined(journal())
  if (open === undefined) return Err({ kind: "no-book" })
  const config = bookConfigFromFiles(open.source.files)
  return config.ok ? config : Err({ kind: "invalid-config", trouble: config.error })
}

export const documents: Accessor<DocumentSettings> = createRoot(() =>
  createMemo(() => {
    const settings = bookSettings()
    return settings.ok ? settings.value.documents : DEFAULT_DOCUMENT_SETTINGS
  }),
)

const keep = async (
  update: (current: BookConfig) => BookConfig,
): Promise<Result<BookConfig, BookSettingsTrouble>> => {
  const selected = getOrUndefined(journal())
  if (selected === undefined) return Err({ kind: "no-book" })

  return writes.through(async (): Promise<Result<BookConfig, BookSettingsTrouble>> => {
    const current = getOrUndefined(journal())
    if (current === undefined) return Err({ kind: "no-book" })
    if (current.bookId !== selected.bookId) return Err({ kind: "book-changed" })

    const config = bookConfigFromFiles(current.source.files)
    if (!config.ok) return Err({ kind: "invalid-config", trouble: config.error })

    const next = update(config.value)
    if (!validDocumentSettings(next.documents)) return Err({ kind: "invalid-documents" })

    const written = await putFiles({
      [BOOK_CONFIG_PATH]: textOfBookConfig(next),
    })
    return written.ok ? Ok(next) : Err({ kind: "journal", trouble: written.error })
  }).catch((cause: unknown) => Err<BookSettingsTrouble, BookConfig>({ kind: "storage", cause }))
}

export const saveBookSettings = (
  settings: Pick<BookConfig, "documents" | "invert">,
): Promise<Result<BookConfig, BookSettingsTrouble>> =>
  keep((current) => ({ ...current, ...settings }))

const definitionTrouble = (trouble: BookSettingsTrouble): DefinitionTrouble =>
  trouble.kind === "invalid-config"
    ? { kind: "invalid-storage" }
    : { kind: "storage", cause: trouble }

export const savedReports = createRoot(() => createMemo(() => {
  const settings = bookSettings()
  if (settings.ok) return Ok(settings.value.reports)
  return settings.error.kind === "no-book"
    ? Ok([])
    : Err(definitionTrouble(settings.error))
}))

export const saveReport = async (report: SavedReport): Promise<Result<readonly SavedReport[], DefinitionTrouble>> => {
  const saved = await keep((current) => ({ ...current, reports: replaceReport(current.reports, report) }))
  return saved.ok ? Ok(saved.value.reports) : Err(definitionTrouble(saved.error))
}

export const removeReport = async (id: string): Promise<Result<readonly SavedReport[], DefinitionTrouble>> => {
  const saved = await keep((current) => ({
    ...current,
    reports: current.reports.filter((report) => report.id !== id),
  }))
  return saved.ok ? Ok(saved.value.reports) : Err(definitionTrouble(saved.error))
}
