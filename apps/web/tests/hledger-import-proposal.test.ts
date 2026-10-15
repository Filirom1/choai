import { describe, expect, test } from "bun:test"

import { Ok } from "~/core/lib/monad"
import { TRANSACTIONS } from "~/core/journal/layout"
import { filesOf, touches, type Item, type Proposal } from "~/core/journal/proposals"

const from = {
  "main.journal": "; Example books\ninclude transactions.journal\n",
  [TRANSACTIONS]: "2026-01-01 Opening\n    assets:cash  1 USD\n    equity:opening\n",
  "imports/csv/bank.csv": "date,description,amount\n",
  "imports/rules/bank.csv.rules": "fields date, description, amount\n",
  "imports/csv/.latest.bank.csv": "2026-01-01\n",
}

const imported = (text: string): Item => ({
  is: "hledger-import",
  csvPath: "imports/csv/bank.csv",
  rulesPath: "imports/rules/bank.csv.rules",
  checkpointPath: "imports/csv/.latest.bank.csv",
  checkpointText: "2026-01-02\n",
  transactionCount: text === "" ? 0 : 1,
  text,
  confidence: 1,
})

const proposal = (item: Item): Proposal => ({
  id: "one",
  bookId: "book",
  basedOn: {},
  items: [item],
  at: 0,
  reads: Ok({ transactions: 1, accounts: [], commodities: [] }),
})

describe("native hledger import proposals", () => {
  test("replace the checkpoint and append hledger's exact text in the same change", () => {
    const text = "2026-01-02 Market\n    assets:bank  -2 USD\n    expenses:food  2 USD\n"
    const changes = filesOf(proposal(imported(text)), from, "main.journal", undefined)

    expect(changes[TRANSACTIONS]).toBe(`${from[TRANSACTIONS]}\n${text}`)
    expect(changes["imports/csv/.latest.bank.csv"]).toBe("2026-01-02\n")
    expect(changes["main.journal"]).toContain("; choai-file: imports/csv/.latest.bank.csv")
    expect(touches([imported(text)], "main.journal", from)).toEqual([
      TRANSACTIONS,
      "imports/csv/bank.csv",
      "imports/rules/bank.csv.rules",
      "imports/csv/.latest.bank.csv",
      "main.journal",
    ])
  })

  test("a catch-up proposal advances only the checkpoint", () => {
    const changes = filesOf(proposal(imported("")), from, "main.journal", undefined)

    expect(changes[TRANSACTIONS]).toBe(from[TRANSACTIONS])
    expect(changes["imports/csv/.latest.bank.csv"]).toBe("2026-01-02\n")
    expect(changes["main.journal"]).toContain("; choai-file: imports/csv/.latest.bank.csv")
  })
})
