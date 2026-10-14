import { createSignal, type Accessor } from "solid-js"

import type { Transaction, Trouble } from "~/core/hledger/wire"
import { declaredCommodity, journal } from "~/core/journal/store"
import { spanOf, textAt, type Span } from "~/core/journal/lines"
import { None, Some, getOrUndefined, type Option } from "~/core/lib/monad"
import { commitEntry } from "./commit"
import type { DraftEdit } from "./draft"
import { asText, applySurfaceEdit, toForm, toText, type Surface } from "./surface"
import { dock } from "~/core/dock"
import { documents } from "~/core/journal/book-settings"
import { documentPathOn, type DocumentSelection } from "~/core/journal/documents"

/**
 * Editing an entry that is already written.
 *
 * The lines of the entry are the thing opened, never a form built from what
 * hledger parsed: a form would be written again from its parts, and what the
 * parts do not carry — a status mark, a comment on the third posting — would be
 * lost in the round trip. So the entry opens as the form that is the same entry,
 * and only where the form would write those lines back unchanged. Otherwise it
 * opens as the text, which is the lines themselves.
 *
 * What is saved is the file with those lines replaced, offered to hledger first.
 */

const [where, setWhere] = createSignal<Span | undefined>(undefined)
const [shown, setShown] = createSignal<Surface>(asText(""))
const [trouble, setTrouble] = createSignal<Option<Trouble>>(None)
const [saving, setSaving] = createSignal(false)
const [documentPath, setDocumentPath] = createSignal<string | undefined>(undefined)
const [originalDocumentPath, setOriginalDocumentPath] = createSignal<string | undefined>(undefined)
const [documentFile, setDocumentFile] = createSignal<File | undefined>(undefined)
const [documentRemoved, setDocumentRemoved] = createSignal(false)

export const editingDocumentPath: Accessor<string | undefined> = () => documentRemoved() ? undefined : documentPath()
export const editingDocumentFile: Accessor<File | undefined> = documentFile
export const chooseEditingDocument = (selection: DocumentSelection | undefined): void => {
  setDocumentFile(selection?.kind === "file" ? selection.file : undefined)
  setDocumentPath(selection?.kind === "existing" ? selection.path : undefined)
  setDocumentRemoved(selection === undefined && originalDocumentPath() !== undefined)
}

/** The entry being edited, if any: which file, and which lines of it. */
export const editing: Accessor<Span | undefined> = where

/** The entry as it is being edited: its form, or the text it is written as. */
export const editingShown: Accessor<Surface> = shown

export const entryTrouble: Accessor<Option<Trouble>> = trouble
export const entrySaving: Accessor<boolean> = saving

/**
 * Open the lines a transaction came from. Does nothing if its file is not open.
 *
 * The form is offered when the entry, as hledger parsed it, would be written
 * back as these same lines. The text is what the form cannot be trusted to keep.
 */
export const startEditingEntry = (transaction: Transaction): void => {
  const open = getOrUndefined(journal())
  if (open === undefined) return
  const span = spanOf(transaction.tsourcepos)
  const file = open.source.files[span.path]
  if (file === undefined) return
  const lines = textAt(file, span)
  dock.show("editing")
  setWhere(span)
  setShown(toForm(asText(lines), declaredCommodity()))
  const path = documentPathOn(transaction.ttags, documents().tag)
  setDocumentPath(path)
  setOriginalDocumentPath(path)
  setDocumentFile(undefined)
  setDocumentRemoved(false)
  setTrouble(None)
}

/**
 * Let the entry go, and give the space back if it was being used to show it.
 *
 * The panel is not the editor. It draws whatever the dock is lent to, and the
 * editor draws nothing without an entry — so letting go without handing the
 * space back leaves the panel open over the journal with nothing in it, and
 * saving, cancelling and removing all end that way.
 *
 * Only when the dock is still showing this. Something else taking the panel is
 * what calls this in the first place: a proposal arriving takes the space, and
 * closing what took it would put the reader back where they were rather than
 * where they were being sent.
 */
export const stopEditingEntry = (): void => {
  setWhere(undefined)
  setDocumentPath(undefined)
  setOriginalDocumentPath(undefined)
  setDocumentFile(undefined)
  setDocumentRemoved(false)
  setTrouble(None)
  if (dock.is("editing")) dock.close()
}

export const editEntry = (written: string): void => {
  setShown(asText(written))
}

/** Change the form of the entry being edited. Ignored while it is shown as text. */
export const editEntryDraft = (edit: DraftEdit): void => {
  setShown((was) => applySurfaceEdit(was, edit))
}

/** Show the entry being edited as the text it will be written as. */
export const showEditAsText = (): void => {
  setShown((was) => toText(was, declaredCommodity()))
}

/** Show the entry being edited as its form, if the text reads back as one. */
export const showEditAsForm = (): void => {
  setShown((was) => toForm(was, declaredCommodity()))
}

/**
 * Put the edited lines back.
 *
 * Removing an entry is the same act with nothing written in its place, so both
 * go through here and both are read by hledger before anything is kept.
 */
export const saveEntry = async (written: string): Promise<boolean> => {
  const span = where()
  if (span === undefined) return false

  setSaving(true)
  setTrouble(None)
  const removingEntry = written.trim() === ""
  const result = await commitEntry(
    span,
    written,
    removingEntry ? undefined : documentFile(),
    removingEntry ? undefined : documentPath(),
    !removingEntry && documentRemoved(),
  )
  setSaving(false)

  if (!result.ok) {
    setTrouble(Some(result.error))
    return false
  }
  stopEditingEntry()
  return true
}

export const removeEntry = (): Promise<boolean> => saveEntry("")
