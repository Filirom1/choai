import type { DefaultCommodity } from "~/core/hledger/wire"
import { applyEdit, draftOfText, draftToJournal, isWritable as isFormWritable, type Draft, type DraftEdit } from "./draft"

/**
 * An entry, shown either as its form or as the text it will be written as.
 *
 * Both are the same entry and the text is what gets written. The form is only
 * offered where it would write the text back unchanged: a status mark, a second
 * figure, or a comment that is not a tag is kept in the text rather than lost
 * to a form that cannot hold it.
 */
export type Surface =
  | { readonly shows: "form"; readonly draft: Draft }
  | { readonly shows: "text"; readonly text: string }

export const asForm = (draft: Draft): Surface => ({ shows: "form", draft })

export const asText = (text: string): Surface => ({ shows: "text", text })

/** The entry as the text it would be written as. A text already is one. */
export const toText = (surface: Surface, declared?: DefaultCommodity): Surface =>
  surface.shows === "text" ? surface : asText(draftToJournal(surface.draft, declared))

/** The form, if the text reads back as that same text. Otherwise the text, unchanged. */
export const toForm = (surface: Surface, declared?: DefaultCommodity): Surface => {
  if (surface.shows === "form") return surface
  const draft = draftOfText(surface.text, declared)
  return draft === undefined ? surface : asForm(draft)
}

/** Whether a text can be shown as a form without losing anything in it. */
export const canBeForm = (text: string, declared?: DefaultCommodity): boolean => draftOfText(text, declared) !== undefined

export const applySurfaceEdit = (surface: Surface, edit: DraftEdit): Surface =>
  surface.shows === "form" ? asForm(applyEdit(surface.draft, edit)) : surface

/** What gets written: the draft as the journal text it becomes, or the text as it stands. */
export const writtenOf = (surface: Surface, declared?: DefaultCommodity): string =>
  surface.shows === "form" ? draftToJournal(surface.draft, declared) : surface.text

/** Whether anything can be written from this surface. */
export const hasSomethingToWrite = (surface: Surface): boolean =>
  surface.shows === "text" ? surface.text.trim() !== "" : isFormWritable(surface.draft)
