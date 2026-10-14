import type { Trouble } from "~/core/hledger/wire"
import { replaceAt, type Span } from "~/core/journal/lines"
import {
  declaredCommodity,
  journal,
  rewriteFile,
  rewriteFileWithDocument,
  transactionsText,
  writeTransactions,
  writeTransactionsWithDocument,
  type OpenJournal,
} from "~/core/journal/store"
import { Err, getOrUndefined, Ok, type Result } from "~/core/lib/monad"
import { appendText, appendToJournal, draftToJournal, type Draft } from "./draft"
import { documents, pathForDocument, safeDocumentPath, tagForDocument, validDocumentSettings } from "~/core/journal/documents"
import { withoutTag, withTag } from "~/core/journal/tagging"

/**
 * Writing an entry down, apart from the panel that usually asks for it.
 *
 * A draft is a draft wherever it came from — boxes on a screen, a test, a bank
 * statement being read — and all of them should reach the same road. Both of
 * these answer with what hledger said rather than with whether it worked, so
 * the caller still has something to show for a refusal.
 */

/** Write one transaction at the end of the transactions. */
export const commitDraft = async (
  draft: Draft,
  file?: File,
  existingPath?: string,
): Promise<Result<OpenJournal, Trouble>> => {
  const text = transactionsText()
  if (text === undefined) return Err({ kind: "no-journal" })
  const entry = draftToJournal(draft, declaredCommodity())
  if (file !== undefined) {
    const prepared = entryWithDocument(entry, file)
    return prepared.ok
      ? writeTransactionsWithDocument(appendText(text, prepared.value.text), file, prepared.value.path)
      : prepared
  }
  if (existingPath !== undefined) {
    const linked = entryWithExistingDocument(entry, existingPath)
    return linked.ok ? writeTransactions(appendText(text, linked.value)) : linked
  }
  return writeTransactions(appendToJournal(text, draft, declaredCommodity()))
}

/** Write entry text as it stands at the end of the transactions, unchanged by any form. */
export const commitText = async (
  entry: string,
  file?: File,
  existingPath?: string,
): Promise<Result<OpenJournal, Trouble>> => {
  const text = transactionsText()
  if (text === undefined) return Err({ kind: "no-journal" })
  if (file !== undefined) {
    const prepared = entryWithDocument(entry, file)
    return prepared.ok
      ? writeTransactionsWithDocument(appendText(text, prepared.value.text), file, prepared.value.path)
      : prepared
  }
  if (existingPath !== undefined) {
    const linked = entryWithExistingDocument(entry, existingPath)
    return linked.ok ? writeTransactions(appendText(text, linked.value)) : linked
  }
  return writeTransactions(appendText(text, entry))
}

/** Put an entry's lines back, or take it out by writing nothing in their place. */
export const commitEntry = async (
  span: Span,
  written: string,
  document?: File,
  existingPath?: string,
  removeDocument: boolean = false,
): Promise<Result<OpenJournal, Trouble>> => {
  const open = getOrUndefined(journal())
  if (open === undefined) return Err({ kind: "no-journal" })
  const file = open.source.files[span.path]
  if (file === undefined) return Err({ kind: "file-missing", path: span.path })
  if (document !== undefined) {
    const prepared = entryWithDocument(written, document)
    return prepared.ok
      ? rewriteFileWithDocument(span.path, replaceAt(file, span, prepared.value.text), document, prepared.value.path)
      : prepared
  }
  if (existingPath !== undefined) {
    const linked = entryWithExistingDocument(written, existingPath)
    return linked.ok ? rewriteFile(span.path, replaceAt(file, span, linked.value)) : linked
  }
  const adjusted = removeDocument ? withoutTag(written, { on: "entry" }, documents().tag) ?? written : written
  return rewriteFile(span.path, replaceAt(file, span, adjusted))
}

const entryWithExistingDocument = (entry: string, path: string): Result<string, Trouble> => {
  const settings = documents()
  if (!validDocumentSettings(settings) || !safeDocumentPath(path)) return Err({ kind: "unsupported-file" })
  const text = withTag(entry, { on: "entry" }, tagForDocument(settings.tag, path))
  return text === undefined ? Err({ kind: "unsupported-file" }) : Ok(text)
}

const entryWithDocument = (
  entry: string,
  file: File,
): Result<{ readonly text: string; readonly path: string }, Trouble> => {
  const settings = documents()
  if (!validDocumentSettings(settings)) return Err({ kind: "unsupported-file" })
  const path = pathForDocument(file, settings)
  const text = withTag(entry, { on: "entry" }, tagForDocument(settings.tag, path))
  return text === undefined ? Err({ kind: "unsupported-file" }) : Ok({ text, path })
}
