import { createSignal, type Accessor } from "solid-js"

import type { Trouble } from "~/core/hledger/wire"
import { None, Some, type Option } from "~/core/lib/monad"
import { declaredCommodity } from "~/core/journal/store"
import type { DocumentSelection } from "~/core/journal/documents"
import { commitDraft, commitText } from "./commit"
import { emptyDraft, todayISO, type DraftEdit } from "./draft"
import {
  applySurfaceEdit,
  asForm,
  asText,
  hasSomethingToWrite,
  toForm,
  toText,
  type Surface,
} from "./surface"

/**
 * The entry being written, as a form or as the text it will be written as.
 *
 * Whether it is on screen belongs to `~/dock`.
 */

const [surface, setSurface] = createSignal<Surface>(asForm(emptyDraft(todayISO())))
const [trouble, setTrouble] = createSignal<Option<Trouble>>(None)
const [saving, setSaving] = createSignal(false)
const [documentFile, setDocumentFile] = createSignal<File | undefined>(undefined)
const [documentPath, setDocumentPath] = createSignal<string | undefined>(undefined)

export const entryDocumentFile: Accessor<File | undefined> = documentFile
export const entryDocumentPath: Accessor<string | undefined> = documentPath
export const chooseEntryDocument = (selection: DocumentSelection | undefined): void => {
  setDocumentFile(selection?.kind === "file" ? selection.file : undefined)
  setDocumentPath(selection?.kind === "existing" ? selection.path : undefined)
}

export const entryShown: Accessor<Surface> = surface
export const savingTrouble: Accessor<Option<Trouble>> = trouble
export { saving }

export const editDraft = (edit: DraftEdit): void => {
  setSurface((was) => applySurfaceEdit(was, edit))
}

/** Show the entry as the text it would be written as. */
export const showAsText = (): void => {
  setSurface((was) => toText(was, declaredCommodity()))
  setTrouble(None)
}

/** Show the entry as its form, if the text can be read back as one. */
export const showAsForm = (): void => {
  setSurface((was) => toForm(was, declaredCommodity()))
  setTrouble(None)
}

export const editText = (written: string): void => {
  setSurface(asText(written))
}

export const writable = (): boolean => hasSomethingToWrite(surface())

/**
 * Write the entry: the text if it is being adjusted, the form otherwise.
 *
 * The date stays behind afterwards: entries are usually written in runs, and
 * the run is usually one day's worth.
 */
export const save = async (): Promise<boolean> => {
  const current = surface()
  setSaving(true)
  setTrouble(None)
  const file = documentFile()
  const existingPath = documentPath()
  const result = current.shows === "text"
    ? await commitText(current.text, file, existingPath)
    : await commitDraft(current.draft, file, existingPath)
  setSaving(false)

  if (!result.ok) {
    setTrouble(Some(result.error))
    return false
  }
  const date = current.shows === "form" ? current.draft.date : todayISO()
  setSurface(asForm(emptyDraft(date)))
  setDocumentFile(undefined)
  setDocumentPath(undefined)
  return true
}

/** Start again with today's date, as if the panel had just been opened. */
export const clearDraft = (): void => {
  setSurface(asForm(emptyDraft(todayISO())))
  setDocumentFile(undefined)
  setDocumentPath(undefined)
  setTrouble(None)
}
