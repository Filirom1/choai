import type { Status, Transaction, Trouble } from "~/core/hledger/wire"
import { spanOf, textAt } from "~/core/journal/lines"
import { assertionEntry, withTransactionStatus } from "~/core/journal/reconcile"
import { journal, type OpenJournal } from "~/core/journal/store"
import { Err, getOrUndefined, type Result } from "~/core/lib/monad"
import { commitEntry, commitText } from "./commit"

/**
 * The two writes a reconciliation makes, by the same road as any other entry.
 *
 * Both are offered to hledger before anything is kept: a mark cannot fail to
 * read, but an assertion that does not hold is exactly what hledger refuses,
 * and that refusal is the reconciliation saying it does not agree yet.
 */

/** Why a posting's mark could not be changed where hledger's own answer is not the reason. */
export type MarkTrouble =
  | { readonly kind: "hledger"; readonly trouble: Trouble }
  /** The entry's lines are not the entry hledger described, so there is no line to mark. */
  | { readonly kind: "not-in-text" }

/** Give an entry a transaction-level status, editing its header where it stands. */
export const markTransaction = async (
  transaction: Transaction,
  status: Status,
): Promise<Result<OpenJournal, MarkTrouble>> => {
  const open = getOrUndefined(journal())
  if (open === undefined) return Err({ kind: "hledger", trouble: { kind: "no-journal" } })
  const span = spanOf(transaction.tsourcepos)
  const file = open.source.files[span.path]
  if (file === undefined) return Err({ kind: "hledger", trouble: { kind: "file-missing", path: span.path } })

  const written = withTransactionStatus(textAt(file, span), status)
  if (written === undefined) return Err({ kind: "not-in-text" })

  const saved = await commitEntry(span, written)
  return saved.ok ? saved : Err({ kind: "hledger", trouble: saved.error })
}

/** Write what the statement says the account came to, as an assertion hledger will hold it to. */
export const assertBalance = (
  date: string,
  description: string,
  account: string,
  amounts: readonly string[],
): Promise<Result<OpenJournal, Trouble>> => commitText(assertionEntry(date, description, account, amounts))
