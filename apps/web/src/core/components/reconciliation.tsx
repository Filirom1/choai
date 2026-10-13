import { For, Show, createResource, createSignal, type JSX } from "solid-js"

import { ask, type Reply } from "~/core/hledger/client"
import { formatAmount, formatMixed } from "~/core/hledger/amount"
import type { MixedAmount, Page, Status, Transaction, Trouble } from "~/core/hledger/wire"
import { assertBalance, markTransaction, type MarkTrouble } from "~/core/compose/reconciling"
import {
  balanceQuery,
  clearedQuery,
  linesIn,
  listingQuery,
  reconciledAccount,
  statusOf,
  unclearedQuery,
  type Line,
} from "~/core/journal/reconcile"
import { journal } from "~/core/journal/store"
import { useQuery } from "~/core/journal/query"
import { PAGE } from "~/core/journal/paging"
import { createReading } from "~/core/reports/reading"
import { rangeOf, withRange } from "~/core/reports/periods"
import { todayHere } from "~/core/reports/filters"
import { Ok, getOrUndefined, matchResource } from "~/core/lib/monad"
import { Button } from "~/core/components/ui/button"
import { TextField, TextFieldInput } from "~/core/components/ui/text-field"
import { TroubleNote } from "./trouble-note"
import { t } from "~/core/i18n"

/**
 * Going through an account against a bank statement.
 *
 * The account and the statement's date are the query's — the account the
 * explorer chose, the end of its dates — so the address says which
 * reconciliation is open and a date chosen here is a term written there. What
 * the statement says is work in hand and kept nowhere until it is written as an
 * assertion.
 *
 * Every figure is hledger's: what the account came to, what the cleared part
 * of it came to, how many postings are not cleared yet. Nothing here adds up.
 */
export function Reconciliation(): JSX.Element {
  const [query, setQuery] = useQuery()
  const reading = createReading(query)

  const account = (): string | undefined => {
    const open = getOrUndefined(journal())
    const read = reading()
    return open === undefined || read === undefined ? undefined : reconciledAccount(read, open.summary.accounts)
  }
  const range = () => {
    const read = reading()
    return read === undefined ? undefined : rangeOf(read)
  }
  const date = (): string => (range()?.to ?? "") || todayHere()
  const from = (): string => range()?.from ?? ""

  const toDate = (chosen: string): void => {
    const read = reading()
    if (read === undefined || chosen === "") return
    setQuery(withRange(read, { from: from(), to: chosen }))
  }

  return (
    <div class="flex flex-col gap-4">
      <div>
        <h2 class="text-base font-semibold">{t("reconcile.title")}</h2>
      </div>
      <Show
        when={account()}
        fallback={<p class="text-sm text-muted-foreground">{t("reconcile.chooseAccount")}</p>}
      >
        {(chosen) => (
          <>
            <div class="flex flex-wrap items-end gap-3">
              <span class="min-w-0 truncate font-mono text-sm" title={chosen()}>
                {chosen()}
              </span>
            </div>
            <Statement account={chosen()} date={date()} from={from()} onDate={toDate} />
          </>
        )}
      </Show>
    </div>
  )
}

/** What hledger says about the account on the statement's date. */
interface Figures {
  readonly entries: Page<Transaction>
  readonly balance: MixedAmount
  readonly cleared: MixedAmount
  readonly uncleared: number
}

const askFigures = async (
  account: string,
  date: string,
  from: string,
  limit: number,
): Promise<Reply<Figures>> => {
  const [entries, balance, cleared, uncleared] = await Promise.all([
    ask({ kind: "entries", query: listingQuery(account, from, date), limit, offset: 0 }),
    ask({ kind: "balance", query: balanceQuery(account, date) }),
    ask({ kind: "balance", query: clearedQuery(account, date) }),
    ask({ kind: "register", query: unclearedQuery(account, date), limit: 0, offset: 0 }),
  ])
  if (!entries.ok) return entries
  if (!balance.ok) return balance
  if (!cleared.ok) return cleared
  if (!uncleared.ok) return uncleared
  return Ok({
    entries: entries.value,
    balance: balance.value.prTotals.prrTotal,
    cleared: cleared.value.prTotals.prrTotal,
    uncleared: uncleared.value.total,
  })
}

/** What went wrong with the last thing written from here, and which thing it was. */
type Failed =
  | { readonly at: "mark"; readonly trouble: MarkTrouble }
  | { readonly at: "assert"; readonly trouble: Trouble }

function Statement(props: {
  readonly account: string
  readonly date: string
  readonly from: string
  readonly onDate: (date: string) => void
}): JSX.Element {
  const [limit, setLimit] = createSignal(PAGE)
  const [busy, setBusy] = createSignal(false)
  const [failed, setFailed] = createSignal<Failed | undefined>(undefined)
  const [typed, setTyped] = createSignal<string | undefined>(undefined)
  const [asserted, setAsserted] = createSignal(false)

  const [figures] = createResource(
    () => {
      const open = getOrUndefined(journal())
      return open === undefined
        ? undefined
        : { open, account: props.account, date: props.date, from: props.from, limit: limit() }
    },
    (asked) => askFigures(asked.account, asked.date, asked.from, asked.limit),
  )

  const mark = async (line: Line, next: Status): Promise<void> => {
    setBusy(true)
    setFailed(undefined)
    const marked = await markTransaction(line.transaction, next)
    setBusy(false)
    if (!marked.ok) setFailed({ at: "mark", trouble: marked.error })
  }

  const statementOf = (): string => typed() ?? ""

  const changeDate = (date: string): void => {
    setAsserted(false)
    setTyped(undefined)
    setLimit(PAGE)
    props.onDate(date)
  }

  const assert = async (): Promise<void> => {
    const amounts = statementOf()
      .split(";")
      .map((amount) => amount.trim())
      .filter((amount) => amount !== "")
    if (amounts.length === 0) return
    setBusy(true)
    setFailed(undefined)
    const written = await assertBalance(props.date, t("reconcile.description"), props.account, amounts)
    setBusy(false)
    if (!written.ok) {
      setFailed({ at: "assert", trouble: written.error })
      return
    }
    setTyped(undefined)
    setAsserted(true)
  }

  return (
    <>
      {matchResource(figures.latest, {
    Loading: () => <p class="text-sm text-muted-foreground">{t("journal.reading")}</p>,
    Err: (trouble) => <TroubleNote trouble={trouble} />,
    Ok: (found) => (
      <div class="flex flex-col gap-4">
        <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt class="text-muted-foreground">{t("reconcile.cleared")}</dt>
          <dd class="text-right font-mono tabular-nums">{formatMixed(found.cleared)}</dd>
          <dt class="text-muted-foreground">{t("reconcile.balance")}</dt>
          <dd class="text-right font-mono tabular-nums">{formatMixed(found.balance)}</dd>
        </dl>
        <Show when={found.uncleared > 0}>
          <p class="text-xs text-muted-foreground">{t("reconcile.uncleared", { count: found.uncleared })}</p>
        </Show>

        <div class="flex flex-col gap-2 border-t pt-4">
          <div class="flex flex-wrap items-end gap-3">
            <label class="flex items-center gap-2 text-sm text-muted-foreground">
              {t("reconcile.statementDate")}
              <input
                type="date"
                class="h-8 rounded-md border bg-transparent px-2 text-sm text-foreground"
                value={props.date}
                onChange={(event) => changeDate(event.currentTarget.value)}
              />
            </label>
          </div>
          <p class="text-xs text-muted-foreground">{t("reconcile.assertLead", { date: props.date })}</p>
          <p class="text-xs text-muted-foreground">{t("reconcile.humanCheck")}</p>
          <div class="flex flex-wrap items-center gap-2">
            <TextField class="min-w-40 flex-1">
              <TextFieldInput
                type="text"
                class="h-8 font-mono text-sm"
                aria-label={t("reconcile.statementBalance")}
                placeholder={amountsOf(found.cleared).join("; ")}
                value={statementOf()}
                onInput={(event) => {
                  setTyped(event.currentTarget.value)
                  setAsserted(false)
                }}
              />
            </TextField>
            <Button size="sm" disabled={busy() || statementOf().trim() === ""} onClick={() => void assert()}>
              {t("reconcile.assert")}
            </Button>
          </div>
          <Show when={asserted()}>
            <p class="text-xs text-muted-foreground">{t("reconcile.asserted")}</p>
          </Show>
          <Show when={failed()}>{(why) => <FailedNote failed={why()} />}</Show>
        </div>

        <div class="rounded-lg border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          <p>{t("reconcile.statusHelp")}</p>
          <dl class="mt-2 grid gap-1 sm:grid-cols-3">
            <div><dt class="font-mono text-foreground">*</dt><dd>{t("reconcile.statusCleared")}</dd></div>
            <div><dt class="font-mono text-foreground">!</dt><dd>{t("reconcile.statusPending")}</dd></div>
            <div><dt class="font-mono text-foreground">{" "}</dt><dd>{t("reconcile.statusUnmarked")}</dd></div>
          </dl>
        </div>
        <Lines lines={linesIn(found.entries.items, props.account, props.date)} busy={busy()} onMark={mark} />
        <Show when={found.entries.total > found.entries.items.length}>
          <Button variant="outline" size="sm" class="self-start" onClick={() => setLimit((was) => was + PAGE)}>
            {t("reconcile.more", { count: found.entries.total - found.entries.items.length })}
          </Button>
        </Show>

      </div>
    ),
      })}
    </>
  )
}

const nextStatus = (status: Status): Status => {
  switch (status) {
    case "Unmarked":
      return "Cleared"
    case "Cleared":
      return "Pending"
    case "Pending":
      return "Unmarked"
  }
}

const glyphOf = (status: Status): string => {
  switch (status) {
    case "Unmarked":
      return " "
    case "Pending":
      return "!"
    case "Cleared":
      return "*"
  }
}

const amountsOf = (mixed: MixedAmount): readonly string[] => (mixed.length === 0 ? ["0"] : mixed.map(formatAmount))

function FailedNote(props: { readonly failed: Failed }): JSX.Element {
  const failed = props.failed
  switch (failed.at) {
    case "assert":
      return <TroubleNote trouble={failed.trouble} />
    case "mark":
      return failed.trouble.kind === "hledger" ? (
        <TroubleNote trouble={failed.trouble.trouble} />
      ) : (
        <p class="text-sm text-muted-foreground">{t("reconcile.notInText")}</p>
      )
  }
}

/** The account's postings up to the statement's date, each ticked when cleared. */
function Lines(props: {
  readonly lines: readonly Line[]
  readonly busy: boolean
  readonly onMark: (line: Line, status: Status) => void
}): JSX.Element {
  return (
    <Show when={props.lines.length > 0} fallback={<p class="text-sm text-muted-foreground">{t("reconcile.nothing")}</p>}>
      <ul class="flex flex-col divide-y rounded-lg border">
        <For each={props.lines}>
          {(line) => {
            const status = (): Status => statusOf(line.transaction, line.posting)
            return (
              <li>
                <div class="flex items-center gap-3 px-3 py-2 text-sm hover:bg-muted/50">
                  <button
                    type="button"
                    class="flex h-8 w-12 shrink-0 items-center justify-center rounded-md border border-input bg-transparent px-1 font-mono text-sm ring-offset-background hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
                    disabled={props.busy}
                    title={t(`compose.status.${status()}`)}
                    aria-label={t("compose.statusLabel")}
                    onClick={() => props.onMark(line, nextStatus(status()))}
                  >
                    {glyphOf(status())}
                  </button>
                  <span class="shrink-0 font-mono text-xs text-muted-foreground">
                    {line.posting.pdate ?? line.transaction.tdate}
                  </span>
                  <span class="min-w-0 flex-1 truncate">{line.transaction.tdescription}</span>
                  <span class="shrink-0 font-mono tabular-nums">{formatMixed(line.posting.pamount)}</span>
                </div>
              </li>
            )
          }}
        </For>
      </ul>
    </Show>
  )
}
