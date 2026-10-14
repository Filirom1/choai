import { Err, Ok, type Result } from "~/core/lib/monad"
import { decodedReports, type SavedReport } from "~/core/reports/custom"
import { DEFAULT_DOCUMENT_SETTINGS, validDocumentSettings, type DocumentSettings } from "./documents"

export const BOOK_CONFIG_PATH = "choai-settings.jsonl"

export interface BookConfig {
  readonly documents: DocumentSettings
  readonly reports: readonly SavedReport[]
}

export type BookConfigTrouble =
  | { readonly kind: "invalid-json"; readonly cause: unknown }
  | { readonly kind: "invalid-shape" }

export const DEFAULT_BOOK_CONFIG: BookConfig = {
  documents: DEFAULT_DOCUMENT_SETTINGS,
  reports: [],
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const hasOnly = (record: Record<string, unknown>, names: readonly string[]): boolean =>
  Object.keys(record).every((name) => names.includes(name)) && names.every((name) => Object.hasOwn(record, name))

export const bookConfigFromFiles = (
  files: Readonly<Record<string, string>>,
): Result<BookConfig, BookConfigTrouble> => {
  const written = files[BOOK_CONFIG_PATH]
  if (written === undefined) return Ok(DEFAULT_BOOK_CONFIG)

  let value: unknown
  try {
    value = JSON.parse(written) as unknown
  } catch (cause) {
    return Err({ kind: "invalid-json", cause })
  }

  if (!isRecord(value) || !hasOnly(value, ["documents", "reports"])) return Err({ kind: "invalid-shape" })
  const documents = value.documents
  if (!isRecord(documents) || !hasOnly(documents, ["tag", "folder"])) return Err({ kind: "invalid-shape" })
  if (typeof documents.tag !== "string" || typeof documents.folder !== "string") return Err({ kind: "invalid-shape" })

  const documentSettings = { tag: documents.tag, folder: documents.folder }
  const reports = decodedReports(value.reports)
  return validDocumentSettings(documentSettings) && reports.ok
    ? Ok({ documents: documentSettings, reports: reports.value })
    : Err({ kind: "invalid-shape" })
}

export const documentSettingsFromFiles = (files: Readonly<Record<string, string>>): DocumentSettings => {
  const config = bookConfigFromFiles(files)
  return config.ok ? config.value.documents : DEFAULT_DOCUMENT_SETTINGS
}

export const textOfBookConfig = (config: BookConfig): string => `${JSON.stringify(config)}\n`
