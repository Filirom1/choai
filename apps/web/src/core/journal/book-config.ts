import { Err, Ok, type Result } from "~/core/lib/monad"
import { decodedReports, type SavedReport } from "~/core/reports/custom"
import { DEFAULT_DOCUMENT_SETTINGS, validDocumentSettings, type DocumentSettings } from "./documents"

export const BOOK_CONFIG_PATH = "choai-settings.jsonl"

export interface ImportSettings {
  readonly csvFolder: string
  readonly rulesFolder: string
}

export interface BookConfig {
  readonly documents: DocumentSettings
  readonly reports: readonly SavedReport[]
  readonly invert: boolean
  readonly imports: ImportSettings
}

export type BookConfigTrouble =
  | { readonly kind: "invalid-json"; readonly cause: unknown }
  | { readonly kind: "invalid-shape" }

export const DEFAULT_IMPORT_SETTINGS: ImportSettings = { csvFolder: "", rulesFolder: "" }

export const validImportSettings = (settings: ImportSettings): boolean =>
  [settings.csvFolder, settings.rulesFolder].every((folder) =>
    folder === "" || (
      !folder.startsWith("/") &&
      !folder.includes("\\") &&
      !/[|,\n\r]/.test(folder) &&
      folder.split("/").every((part) => part !== "" && part !== "." && part !== "..")
    ),
  )

export const DEFAULT_BOOK_CONFIG: BookConfig = {
  documents: DEFAULT_DOCUMENT_SETTINGS,
  reports: [],
  invert: false,
  imports: DEFAULT_IMPORT_SETTINGS,
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const hasOnly = (record: Record<string, unknown>, names: readonly string[]): boolean =>
  Object.keys(record).every((name) => names.includes(name)) && names.every((name) => Object.hasOwn(record, name))

const hasOnlyWithOptional = (
  record: Record<string, unknown>,
  names: readonly string[],
  optional: readonly string[],
): boolean => Object.keys(record).every((name) => names.includes(name))
  && names.filter((name) => !optional.includes(name)).every((name) => Object.hasOwn(record, name))

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

  if (!isRecord(value) || !hasOnlyWithOptional(value, ["documents", "reports", "invert", "imports"], ["invert", "imports"])) return Err({ kind: "invalid-shape" })
  if (typeof value.invert !== "undefined" && typeof value.invert !== "boolean") return Err({ kind: "invalid-shape" })
  const documents = value.documents
  if (!isRecord(documents) || !hasOnly(documents, ["tag", "folder"])) return Err({ kind: "invalid-shape" })
  if (typeof documents.tag !== "string" || typeof documents.folder !== "string") return Err({ kind: "invalid-shape" })

  const documentSettings = { tag: documents.tag, folder: documents.folder }
  const reports = decodedReports(value.reports)
  const imports = value.imports === undefined ? DEFAULT_IMPORT_SETTINGS : value.imports
  if (!isRecord(imports) || !hasOnly(imports, ["csvFolder", "rulesFolder"])) return Err({ kind: "invalid-shape" })
  if (typeof imports.csvFolder !== "string" || typeof imports.rulesFolder !== "string") return Err({ kind: "invalid-shape" })
  const importSettings = { csvFolder: imports.csvFolder, rulesFolder: imports.rulesFolder }
  return validDocumentSettings(documentSettings) && validImportSettings(importSettings) && reports.ok
    ? Ok({ documents: documentSettings, reports: reports.value, invert: value.invert ?? false, imports: importSettings })
    : Err({ kind: "invalid-shape" })
}

export const documentSettingsFromFiles = (files: Readonly<Record<string, string>>): DocumentSettings => {
  const config = bookConfigFromFiles(files)
  return config.ok ? config.value.documents : DEFAULT_DOCUMENT_SETTINGS
}

export const textOfBookConfig = (config: BookConfig): string => `${JSON.stringify(config)}\n`
