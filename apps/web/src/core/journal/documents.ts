import type { Tag as DraftTag } from "~/core/compose/draft"
import type { Tag as JournalTag } from "~/core/hledger/wire"

export interface DocumentSettings {
  readonly tag: string
  readonly folder: string
}

export type DocumentSelection =
  | { readonly kind: "file"; readonly file: File }
  | { readonly kind: "existing"; readonly path: string }

export const DEFAULT_DOCUMENT_SETTINGS: DocumentSettings = {
  tag: "evidence",
  folder: "justificatifs",
}

export const validDocumentSettings = (settings: DocumentSettings): boolean =>
  /^[\w.-]+$/.test(settings.tag) &&
  settings.folder.length > 0 &&
  !settings.folder.startsWith("/") &&
  !settings.folder.includes("\\") &&
  !/[|,\n\r]/.test(settings.folder) &&
  settings.folder.split("/").every((part) => part !== "" && part !== "." && part !== "..")

export const safeDocumentPath = (path: string): boolean =>
  path !== "" &&
  !path.startsWith("/") &&
  !path.includes("\\") &&
  !/[|,\n\r]/.test(path) &&
  path.split("/").every((part) => part !== "" && part !== "." && part !== "..")

export const documentPathOn = (tags: readonly JournalTag[], name: string): string | undefined => {
  const value = tags.find(([tag]) => tag === name)?.[1]?.trim()
  return value !== undefined && safeDocumentPath(value) ? value : undefined
}

export const documentPathsInFiles = (
  files: Readonly<Record<string, string>>,
  name: string,
): readonly string[] => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const tag = new RegExp(`(?:^|[,;])\\s*${escaped}\\s*:\\s*([^,\\r\\n]*)`, "g")
  return [...new Set(Object.values(files).flatMap((text) =>
    [...text.matchAll(tag)].flatMap((match) => {
      const path = match[1]?.trim()
      return path !== undefined && safeDocumentPath(path) ? [path] : []
    }),
  ))]
}

export const tagForDocument = (name: string, path: string): DraftTag => ({ name, value: path })

export const safeDocumentName = (name: string): boolean => {
  const trimmed = name.trim()
  return trimmed !== "" &&
    trimmed !== "." &&
    trimmed !== ".." &&
    !trimmed.includes("/") &&
    !trimmed.includes("\\") &&
    !/[|,\n\r]/.test(trimmed)
}

export const pathForDocument = (file: File, settings: DocumentSettings): string => {
  const name = file.name.trim()
  if (safeDocumentName(name)) return `${settings.folder}/${name}`
  const extension = /\.([a-zA-Z0-9]{1,12})$/.exec(name)?.[1]?.toLowerCase()
  const fallback = file.type === "application/pdf" ? "pdf" : "bin"
  return `${settings.folder}/${crypto.randomUUID()}.${extension ?? fallback}`
}

const receiptSlug = (value: string): string =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")

/** A readable filename for the receipt, unique when the same name is already used. */
export const pathForReceipt = (
  file: File,
  settings: DocumentSettings,
  date?: string,
  issuer?: string,
  used: readonly string[] = [],
): string => {
  const extension = /\.([a-zA-Z0-9]{1,12})$/.exec(file.name)?.[1]?.toLowerCase() ?? "jpg"
  const day = date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "undated"
  const stem = `${day}-${receiptSlug(issuer ?? "") || "receipt"}`
  const candidate = (number: number): string =>
    `${settings.folder}/${stem}${number === 1 ? "" : `-${number}`}.${extension}`
  const next = (number: number): string => used.includes(candidate(number)) ? next(number + 1) : candidate(number)
  return next(1)
}
