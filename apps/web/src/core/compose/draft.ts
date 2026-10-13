/**
 * A transaction being written, and the journal text it becomes.
 *
 * Amounts stay as they were typed. `¥1,200` and `1200` are both things a person
 * writes, and hledger is what decides what they mean — turning them into numbers
 * here would mean deciding about currency symbols and digit groups ourselves,
 * and then deciding again, differently, when writing them back out.
 *
 * The journal's declared default commodity is the one thing added to them, and
 * only to a figure that names no commodity at all. `core/compose/commodity.ts` says
 * why that decides nothing.
 */

import type { DefaultCommodity, Status } from "~/core/hledger/wire"
import { asWritten } from "./commodity"

/** A name and a value, as hledger reads them out of a comment. */
export interface Tag {
  readonly name: string
  readonly value: string
}

export interface DraftPosting {
  /** The posting's own mark: `*` cleared, `!` pending. Absent when unmarked. */
  readonly status?: Status
  readonly account: string
  readonly amount: string
  readonly tags: readonly Tag[]
}

export interface Draft {
  readonly date: string
  /** The entry's mark, written after the date. Absent when unmarked. */
  readonly status?: Status
  /** The code hledger reads from parentheses after the mark, for a reference such as a cheque number. */
  readonly code?: string
  /** Who it was with. Written before the `|`, which is where hledger looks. */
  readonly payee: string
  /** What it was about. Written after the `|`. */
  readonly note: string
  readonly tags: readonly Tag[]
  readonly postings: readonly DraftPosting[]
}

export const emptyPosting = (): DraftPosting => ({ account: "", amount: "", tags: [] })

export const emptyDraft = (today: string): Draft => ({
  date: today,
  payee: "",
  note: "",
  tags: [],
  postings: [emptyPosting(), emptyPosting()],
})

/** Today, as hledger writes dates. */
export const todayISO = (): string => {
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, "0")
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * A posting with no figure is what tells hledger to work the last one out.
 *
 * Only a posting that names an account counts: an empty row is not a posting.
 */
export const hasBlankAmount = (draft: Draft): boolean =>
  draft.postings.some((posting) => posting.account.trim() !== "" && posting.amount.trim() === "")

/** Postings worth writing: the ones that name an account. */
const written = (draft: Draft): readonly DraftPosting[] =>
  draft.postings.filter((posting) => posting.account.trim() !== "")

/** Something a draft has to have before anyone can write it down. */
export type Missing = "date" | "payee" | "postings"

/**
 * Enough to write: a date, someone it was with, and two accounts.
 *
 * An amount is not among them anywhere. hledger works out the last one from the
 * rest, which is the whole reason a two-line entry only needs one figure.
 */
const NEEDS: readonly { readonly missing: Missing; readonly met: (draft: Draft) => boolean }[] = [
  { missing: "date", met: (draft) => draft.date.trim() !== "" },
  { missing: "payee", met: (draft) => draft.payee.trim() !== "" },
  { missing: "postings", met: (draft) => written(draft).length >= 2 },
]

/**
 * What this draft still needs.
 *
 * Which one it is rather than whether there is one, because a screen can then
 * say what is missing instead of only refusing, and something writing a draft
 * without a screen has somewhere to look.
 */
export const whatIsMissing = (draft: Draft): readonly Missing[] =>
  NEEDS.filter((need) => !need.met(draft)).map((need) => need.missing)

export const isWritable = (draft: Draft): boolean => whatIsMissing(draft).length === 0

/**
 * Payee and note joined the way hledger reads them apart.
 *
 * Everything before the first `|` is the payee and everything after it is the
 * note — a convention hledger adopted from Beancount. With no note there is no
 * separator, so an entry that only names who it was with stays plain.
 */
const describe = (draft: Draft): string =>
  draft.note.trim() === "" ? draft.payee.trim() : `${draft.payee.trim()} | ${draft.note.trim()}`

/**
 * A posting's own indent, and the indent a comment line carries under whatever
 * it belongs to — an entry's comment and a posting's alike.
 */
const INDENT = "    "

/** The one-character mark a status is written as, or nothing. */
const markOf = (status: Status): string => {
  switch (status) {
    case "Unmarked":
      return ""
    case "Pending":
      return "!"
    case "Cleared":
      return "*"
  }
}

/**
 * The header between the date and the payee: the mark, then the code, each set
 * off by a space. Nothing is written for either that is absent, so an entry
 * with neither reads `2026-08-16 Shop`, as it always did.
 */
const headerBetween = (draft: Draft): string => {
  const mark = markOf(draft.status ?? "Unmarked")
  const code = (draft.code ?? "").trim()
  const parts = [mark, code === "" ? "" : `(${code})`].filter((part) => part !== "")
  return parts.length === 0 ? " " : ` ${parts.join(" ")} `
}

/** A posting's mark, set off from the account by one space. Nothing when unmarked. */
const postingMark = (status: Status): string => (markOf(status) === "" ? "" : `${markOf(status)} `)

/** A tag as it reads in a comment. */
const shown = (tag: Tag): string => `${tag.name.trim()}:${tag.value.trim()}`

/**
 * A line with its tags written the way hledger writes them.
 *
 * The first goes behind the line itself after two spaces, and every one after
 * it takes a comment line of its own, indented. That is `renderCommentLines` in
 * hledger's `Hledger.Data.Posting`, followed here so that what this app appends
 * and what `hledger print` would have written are the same text — and an
 * indented comment line belongs to the line above it either way, so hledger
 * reads back the same tags it would have read off one long comment.
 */
const withTags = (line: string, tags: readonly Tag[]): readonly string[] => {
  const [first, ...rest] = tags.filter((tag) => tag.name.trim() !== "").map(shown)
  return [first === undefined ? line : `${line}  ; ${first}`, ...rest.map((tag) => `${INDENT}; ${tag}`)]
}

/**
 * The journal text this draft becomes.
 *
 * An amount left empty is written as an account on its own, which is how a
 * journal says "work this one out from the others".
 */
export const draftToJournal = (draft: Draft, declared?: DefaultCommodity): string =>
  [
    ...withTags(`${draft.date.trim()}${headerBetween(draft)}${describe(draft)}`, draft.tags),
    ...written(draft).flatMap((posting) => postingLines(posting, declared)),
  ].join("\n") + "\n"

const postingLines = (posting: DraftPosting, declared: DefaultCommodity | undefined): readonly string[] =>
  withTags(`${INDENT}${postingMark(posting.status ?? "Unmarked")}${posting.account.trim()}${amountPart(posting, declared)}`, posting.tags)

const amountPart = (posting: DraftPosting, declared: DefaultCommodity | undefined): string =>
  posting.amount.trim() === "" ? "" : `  ${asWritten(posting.amount, declared)}`

/**
 * Add entry text to the end of a journal.
 *
 * Only ever appended, and separated by a blank line. The file on the other side
 * is text somebody wrote by hand and keeps in version control; reformatting it
 * would spread a diff across the whole thing for the sake of one new entry.
 */
export const appendText = (journal: string, entry: string): string => {
  const before = journal.replace(/\s*$/, "")
  const written = `${entry.trim()}\n`
  return before === "" ? written : `${before}\n\n${written}`
}

/** Add the draft to the end of a journal. */
export const appendToJournal = (journal: string, draft: Draft, declared?: DefaultCommodity): string =>
  appendText(journal, draftToJournal(draft, declared))

/**
 * Whether the text is what the draft writes, once spacing is set aside.
 *
 * Compared against the text itself, so nothing the text holds can be dropped
 * without the comparison seeing it: a status mark, a second figure, a comment
 * after an amount, a date written another way all show as a difference.
 *
 * The one thing allowed to differ is how a comment's tags are laid out. hledger
 * reads `a:1, b:2` on one line the same as `a:1` and `b:2` on two, so both sides
 * have every comment's tags put into one canonical form before they are compared.
 */
export const isWrittenAs = (draft: Draft, text: string, declared?: DefaultCommodity): boolean =>
  canonical(draftToJournal(draft, declared)) === canonical(text)

/**
 * The text with spacing, and the layout of tags, set aside.
 *
 * Every comment line is split into its tags, and each tag written on a line of
 * its own, so one line of tags and several are the same text here. Anything that
 * is not a tag stays as it was, and so still counts as a difference.
 */
const canonical = (text: string): string =>
  text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap(canonicalLine)
    .join("\n")

/**
 * A line in canonical form. A header's own comment is set off from the header
 * and written as the comment lines it would be on their own, so the first tag
 * on the header and a tag on the next line compare the same.
 */
const canonicalLine = (line: string): readonly string[] => {
  const header = /^(\d{4}-\d{2}-\d{2} [^;]*?)\s*;(.*)$/.exec(line)
  if (header !== null) {
    return [canonicalText(header[1] ?? ""), ...commentTags(header[2] ?? "", INDENT)]
  }
  const comment = /^\s*;(.*)$/.exec(line)
  if (comment !== null) return commentTags(comment[1] ?? "", INDENT)
  return [canonicalText(line)]
}

const canonicalText = (text: string): string => text.trim().replace(/\s*\|\s*/, " | ").replace(/\s+/g, " ")

const commentTags = (comment: string, indent: string): readonly string[] => {
  const parts = comment.split(",").map((part) => part.trim()).filter((part) => part !== "")
  if (parts.length === 0) return [`${indent};`]
  return parts.map((part) => {
    const tag = /^\s*(?:.*\s)?([^\s:]*):(.*)$/.exec(part)
    return tag !== null && (tag[1] ?? "") !== ""
      ? `${indent};${tag[1] ?? ""}:${(tag[2] ?? "").trim()}`
      : `${indent};${part.replace(/\s+/g, " ")}`
  })
}

/**
 * The draft a text reads back as, if the form would write that same text.
 *
 * Reads what `draftToJournal` writes: a header, its tags on comment lines, and
 * postings with an optional figure and tags. Anything it does not recognise is
 * nothing, and so is a reading the form would write differently — both mean the
 * text stays text, because a form that took it would lose part of it.
 */
export const draftOfText = (text: string, declared?: DefaultCommodity): Draft | undefined => {
  const read = draftOfTextRaw(text)
  return read !== undefined && isWrittenAs(read, text, declared) ? read : undefined
}

/** What the text says, read as the form would hold it, before checking that the form would write it back. */
const draftOfTextRaw = (text: string): Draft | undefined => {
  const [header, ...body] = text.split("\n").filter((line) => line.trim() !== "")
  const head = header === undefined ? null : /^(\d{4}-\d{2}-\d{2}) (?:([*!]) )?(?:\(([^)]*)\) )?([^;]*?)\s*(?:;(.*))?$/.exec(header)
  const parsed = head === null ? undefined : parseBody(body)
  if (head === null || parsed === undefined) return undefined

  const [, date = "", mark, code = "", description = "", headerComment = ""] = head
  const [payee = "", ...note] = description.split("|")
  const draft: Draft = {
    date,
    status: statusOfMark(mark),
    code,
    payee: payee.trim(),
    note: note.join("|").trim(),
    tags: [...tagsOf(headerComment), ...parsed.entryTags],
    postings: parsed.postings,
  }
  return draft
}

type ParsedBody = { readonly entryTags: readonly Tag[]; readonly postings: readonly DraftPosting[] }

/**
 * A body of comment lines and postings, in the order `draftToJournal` writes them.
 *
 * A comment before the first posting belongs to the entry; one after a posting
 * belongs to that posting. A posting whose account starts with a status mark is
 * refused, because the form has nowhere to keep one.
 */
const parseBody = (lines: readonly string[]): ParsedBody | undefined => {
  const entryTags: Tag[] = []
  const postings: DraftPosting[] = []
  for (const line of lines) {
    const comment = /^\s+;(.*)$/.exec(line)
    if (comment !== null) {
      const tags = tagsOf(comment[1] ?? "")
      const last = postings[postings.length - 1]
      if (last === undefined) entryTags.push(...tags)
      else postings[postings.length - 1] = { ...last, tags: [...last.tags, ...tags] }
      continue
    }
    const posting = /^\s+(?:([*!]) )?([^\s*!;][^;]*?)(?:\s{2,}([^;]*?))?\s*(?:;(.*))?$/.exec(line)
    if (posting === null) return undefined
    const [, mark, account = "", amount = ""] = posting
    const figure = amount.trim()
    if (figure !== "" && !isOneFigure(figure)) return undefined
    postings.push({
      status: statusOfMark(mark),
      account,
      amount: figure,
      tags: tagsOf(posting[4] ?? ""),
    })
  }
  return { entryTags, postings }
}

/**
 * A figure hledger reads as one amount: a number, with at most one commodity
 * symbol set before or after it.
 *
 * Anything more — a second word after the figure, a figure with two symbols —
 * is not one amount, and hledger refuses it. A form that took it would have to
 * keep it as typed, so it stays text instead.
 */
const isOneFigure = (figure: string): boolean =>
  /^(?:[^\s\d.,+\-]+\s?)?[-+]?\d[\d.,\s]*(?:\s?[^\s\d.,+\-]+)?$/.test(figure) &&
  !(/\d[\d.,]*\s+\d/.test(figure))

/** The status a mark stands for. Nothing, or anything else hledger does not read here, is unmarked. */
const statusOfMark = (mark: string | undefined): Status => (mark === "*" ? "Cleared" : mark === "!" ? "Pending" : "Unmarked")

/**
 * The tags a comment holds, read as hledger reads them.
 *
 * A tag is a name, a colon and a value; the value runs to the next comma or the
 * end of the line and is trimmed, and the name is the last word before the
 * colon. So `source:x, projet:bcd` is two tags, not four words, and a comma is
 * never part of a value. This is `commentlinetagsp` in hledger's
 * `Hledger.Read.Common`, and it is followed here so that what is read off a
 * text is what hledger would hold for it.
 */
const tagsOf = (comment: string): readonly Tag[] =>
  comment
    .split(",")
    .map((part) => /^\s*(?:.*\s)?([^\s:]*):(.*)$/.exec(part))
    .filter((match): match is RegExpExecArray => match !== null && (match[1] ?? "") !== "")
    .map((match) => ({ name: match[1] ?? "", value: (match[2] ?? "").trim() }))

/** A change to one list of tags: a name added, a tag altered, or one taken out. */
export type TagEdit =
  | { readonly kind: "add"; readonly name: string }
  | { readonly kind: "change"; readonly index: number; readonly change: Partial<Tag> }
  | { readonly kind: "remove"; readonly index: number }

export const editedTags = (tags: readonly Tag[], edit: TagEdit): readonly Tag[] => {
  switch (edit.kind) {
    case "add":
      return [...tags, { name: edit.name, value: "" }]
    case "change":
      return replacedAt(tags, edit.index, edit.change)
    case "remove":
      return tags.filter((_, at) => at !== edit.index)
  }
}

/** A change to the postings: one added, one altered, or a tag on one of them changed. */
export type PostingEdit =
  | { readonly kind: "add" }
  | { readonly kind: "change"; readonly index: number; readonly change: Partial<DraftPosting> }
  | { readonly kind: "tag"; readonly index: number; readonly edit: TagEdit }

export const editedPostings = (postings: readonly DraftPosting[], edit: PostingEdit): readonly DraftPosting[] => {
  switch (edit.kind) {
    case "add":
      return [...postings, emptyPosting()]
    case "change":
      return replacedAt(postings, edit.index, edit.change)
    case "tag":
      return replacedAt(postings, edit.index, { tags: editedTags(postings[edit.index]?.tags ?? [], edit.edit) })
  }
}

/** Every change a form can make to a draft, as one value a screen can hand on. */
export type DraftEdit =
  | { readonly kind: "fields"; readonly change: Partial<Pick<Draft, "date" | "payee" | "note" | "code" | "status">> }
  | { readonly kind: "entryTag"; readonly edit: TagEdit }
  | { readonly kind: "posting"; readonly edit: PostingEdit }

export const applyEdit = (draft: Draft, edit: DraftEdit): Draft => {
  switch (edit.kind) {
    case "fields":
      return { ...draft, ...edit.change }
    case "entryTag":
      return { ...draft, tags: editedTags(draft.tags, edit.edit) }
    case "posting":
      return { ...draft, postings: editedPostings(draft.postings, edit.edit) }
  }
}

const replacedAt = <T,>(items: readonly T[], index: number, change: Partial<T>): T[] =>
  items.map((item, at) => (at === index ? { ...item, ...change } : item))
