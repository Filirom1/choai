import type { Tag as DraftTag } from "~/core/compose/draft"
import type { Transaction, Tag as JournalTag } from "~/core/hledger/wire"
import { Err, Ok, type Result } from "~/core/lib/monad"
import { replaceAt, spanOf, textAt, type Span } from "./lines"
import { withTag } from "./tagging"

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

export const documentPathWithName = (path: string, name: string): string | undefined =>
  safeDocumentName(name) ? `${path.slice(0, path.lastIndexOf("/") + 1)}${name.trim()}` : undefined

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

export type RenameDocumentTrouble =
  | { readonly kind: "file-missing"; readonly path: string }
  | { readonly kind: "entry-unwritable" }

interface EntryEdit {
  readonly span: Span
  readonly text: string
}

const sameSpan = (left: Span, right: Span): boolean =>
  left.path === right.path && left.from === right.from && left.to === right.to

/** Retarget every entry hledger says refers to this document, including the edited one. */
export const renameDocumentReferences = (
  files: Readonly<Record<string, string>>,
  transactions: readonly Transaction[],
  tagName: string,
  from: string,
  to: string,
  edited: EntryEdit,
): Result<Readonly<Record<string, string>>, RenameDocumentTrouble> => {
  const spans = transactions
    .filter((transaction) => transaction.ttags.some(([name, value]) => name === tagName && value.trim() === from))
    .map((transaction) => spanOf(transaction.tsourcepos))
    .reduce<readonly Span[]>(
      (found, span) => found.some((one) => sameSpan(one, span)) ? found : [...found, span],
      [edited.span],
    )

  const edits = spans.reduce<Result<readonly EntryEdit[], RenameDocumentTrouble>>((found, span) => {
    if (!found.ok) return found
    const file = files[span.path]
    if (file === undefined) return Err({ kind: "file-missing", path: span.path })
    const original = sameSpan(span, edited.span) ? edited.text : textAt(file, span)
    const text = withTag(original, { on: "entry" }, tagForDocument(tagName, to))
    return text === undefined
      ? Err({ kind: "entry-unwritable" })
      : Ok([...found.value, { span, text }])
  }, Ok([]))

  if (!edits.ok) return edits
  return Ok([...edits.value]
    .sort((left, right) => left.span.path.localeCompare(right.span.path) || right.span.from - left.span.from)
    .reduce(
      (current, edit) => ({
        ...current,
        [edit.span.path]: replaceAt(current[edit.span.path] ?? "", edit.span, edit.text),
      }),
      { ...files },
    ))
}
