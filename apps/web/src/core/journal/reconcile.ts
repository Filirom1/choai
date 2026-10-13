import type { Posting, QueryTerms, Status, Transaction } from "~/core/hledger/wire"
import { dayAfter } from "~/core/reports/periods"
import { lineFor } from "./tagging"
import { namesAccounts, writtenTerm } from "./terms"

/**
 * Reconciling an account against a statement, with nothing hledger does not have.
 *
 * hledger already keeps both halves of it. A posting the statement shows is
 * marked cleared (`*`), which `status:*` then narrows to; and what the statement
 * says the account came to on its date is a balance assertion, which hledger
 * checks against every posting up to that date each time the journal is read.
 * So there is no reconciliation state here: what is reconciled is read off the
 * marks, and what was agreed with the bank is written as an assertion.
 *
 * The account is matched exactly, in the queries asked and in the postings
 * picked out of the answer alike — a cleared balance counted over subaccounts
 * the list does not show would leave nothing to tick and a figure that never
 * agrees.
 */

/** The one account a query names, when it names exactly one this journal has. */
export const reconciledAccount = (read: QueryTerms, accounts: readonly string[]): string | undefined => {
  const named = read.terms.filter((term) => namesAccounts(term) && !term.negated)
  const [only] = named
  if (named.length !== 1 || only === undefined) return undefined
  const account = only.value.replace(/^\^/, "").replace(/\$$/, "")
  return accounts.includes(account) ? account : undefined
}

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g

/** This account and none beneath it or beside it, as an hledger query term. */
export const exactly = (account: string): string =>
  writtenTerm({
    text: "",
    negated: false,
    prefix: "acct:",
    value: `^${account.replace(REGEX_SPECIAL, "\\$&")}$`,
    readable: true,
  })

/** Everything up to and including a statement's date: hledger's end is exclusive. */
export const through = (date: string): string => `date:..${dayAfter(date)}`

/** What the account came to on the statement's date, every posting counted. */
export const balanceQuery = (account: string, date: string): string => `${exactly(account)} ${through(date)}`

/** The same, counting only what has been marked cleared. */
export const clearedQuery = (account: string, date: string): string => `${balanceQuery(account, date)} status:*`

/** Its postings up to the date that are not yet cleared — unmarked and pending both. */
export const unclearedQuery = (account: string, date: string): string =>
  `${balanceQuery(account, date)} not:status:*`

/** The entries to go through: from wherever the query starts, to the statement's date. */
export const listingQuery = (account: string, from: string, date: string): string =>
  `${exactly(account)} date:${from}..${dayAfter(date)}`

/** A posting's status as hledger reads it: its own mark, or the entry's when it has none. */
export const statusOf = (transaction: Transaction, posting: Posting): Status =>
  posting.pstatus === "Unmarked" ? transaction.tstatus : posting.pstatus

/** One posting to the account being reconciled, and where it stands in its entry. */
export interface Line {
  readonly transaction: Transaction
  readonly posting: Posting
  readonly index: number
}

/** The account's own postings in these entries, dated within the statement. */
export const linesIn = (entries: readonly Transaction[], account: string, date: string): readonly Line[] =>
  entries.flatMap((transaction) =>
    transaction.tpostings.flatMap((posting, index) =>
      posting.paccount === account && (posting.pdate ?? transaction.tdate) <= date
        ? [{ transaction, posting, index }]
        : [],
    ),
  )

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

const ENTRY_MARK = /^(\S+)\s+[*!](?=\s|$)\s*/
const POSTING = /^(\s+)(?:([*!])\s*)?(.*)$/
const GAP = /( {4,})(?=\S)/

/**
 * The entry's first line with its mark taken off: `2026-01-31 * Shop` becomes
 * `2026-01-31 Shop`, and nothing else on it moves.
 */
const unmarkedEntry = (line: string): string => line.replace(ENTRY_MARK, "$1 ").trimEnd()

/**
 * A posting line with its own mark set.
 *
 * The figure stays where it was where it can: the two characters a mark takes
 * come out of the gap before the amount, and go back into it when the mark is
 * taken off, so a column of aligned amounts stays a column.
 */
const markedPosting = (line: string, status: Status): string => {
  const [, indent = "", mark, rest = ""] = POSTING.exec(line) ?? []
  const was = mark === undefined ? 0 : 2
  const now = markOf(status) === "" ? 0 : 2
  const shift = now - was
  const realigned =
    shift > 0 && GAP.test(rest)
      ? rest.replace(GAP, (gap) => gap.slice(shift))
      : shift < 0 && GAP.test(rest)
        ? rest.replace(GAP, (gap) => gap + " ".repeat(-shift))
        : rest
  return `${indent}${now === 0 ? "" : `${markOf(status)} `}${realigned}`
}

/** The posting lines of an entry, in the order hledger reports its postings. */
const postingLines = (lines: readonly string[], count: number): readonly number[] =>
  Array.from({ length: count }, (_, at) => lineFor(lines, { on: "posting", at })).flatMap((found) =>
    found === undefined ? [] : [found],
  )

/** Whether a line names the account hledger says that posting is to, behind any mark and brackets. */
const names = (line: string, account: string): boolean =>
  (POSTING.exec(line)?.[3] ?? "").replace(/^[([]/, "").startsWith(account)

/**
 * The entry's text with one posting given a status, everything else as written.
 *
 * A posting reads its entry's mark when it has none of its own, so where the
 * entry is marked, the mark that would change the most is not the posting's.
 * Unmarking one posting of a cleared entry takes the mark off the entry and
 * puts it on each of the other postings instead, so nothing but the one asked
 * about changes what hledger reads it as.
 *
 * Nothing at all where the text is not the entry hledger described: a posting
 * a rule added has no line of its own, and editing whatever line is in its
 * place would mark the wrong one.
 */
export const withPostingStatus = (
  entry: string,
  transaction: Transaction,
  index: number,
  wanted: Status,
): string | undefined => {
  const lines = entry.split("\n")
  const head = lineFor(lines, { on: "entry" })
  const postings = postingLines(lines, transaction.tpostings.length)
  const fits =
    head !== undefined &&
    postings.length === transaction.tpostings.length &&
    lineFor(lines, { on: "posting", at: transaction.tpostings.length }) === undefined &&
    transaction.tpostings.every((posting, at) => names(lines[postings[at] ?? -1] ?? "", posting.paccount))
  const target = postings[index]
  if (!fits || target === undefined) return undefined

  const entryStatus = transaction.tstatus
  const handOver = entryStatus !== "Unmarked" && wanted === "Unmarked"
  const own = entryStatus !== "Unmarked" && wanted === entryStatus ? "Unmarked" : wanted

  return lines
    .map((line, at) =>
      at === head && handOver
        ? unmarkedEntry(line)
        : at === target
          ? markedPosting(line, own)
          : handOver && postings.includes(at) && transaction.tpostings[postings.indexOf(at)]?.pstatus === "Unmarked"
            ? markedPosting(line, entryStatus)
            : line,
    )
    .join("\n")
}

/** The entry header with its transaction-level cleared or pending mark changed. */
export const withTransactionStatus = (entry: string, status: Status): string | undefined => {
  const [first, ...rest] = entry.split("\n")
  if (first === undefined) return undefined
  const match = /^(\S+)(\s+)(?:[*!]\s*)?(.*)$/.exec(first)
  if (match === null) return undefined
  const [, date, gap, description = ""] = match
  const mark = markOf(status)
  return [`${date}${gap}${mark === "" ? "" : `${mark} `}${description}`, ...rest].join("\n")
}

/**
 * An entry asserting what an account came to on a statement's date.
 *
 * One posting of nothing per commodity, each with what it should balance to:
 * an entry that moves no money and fails the whole journal the day the account
 * stops agreeing with the statement. Marked cleared, because it is the
 * statement's own figure.
 */
export const assertionEntry = (
  date: string,
  description: string,
  account: string,
  amounts: readonly string[],
): string =>
  [
    `${date} * ${description}`.trimEnd(),
    ...amounts.map((amount) => `    ${account}    0 = ${amount.trim()}`),
  ].join("\n")
