import { describe, expect, test } from "bun:test"

import type { Posting, QueryTerm, Status, Transaction } from "~/core/hledger/wire"
import {
  assertionEntry,
  clearedQuery,
  exactly,
  linesIn,
  reconciledAccount,
  statusOf,
  withPostingStatus,
} from "~/core/journal/reconcile"
import { withTag } from "~/core/journal/tagging"

const posting = (paccount: string, pstatus: Status = "Unmarked", pdate: string | null = null): Posting => ({
  paccount,
  pamount: [],
  pcomment: "",
  pdate,
  pstatus,
  ptags: [],
})

const transaction = (tstatus: Status, postings: readonly Posting[], tdate = "2026-01-10"): Transaction => ({
  tindex: 1,
  tstatus,
  tcode: "",
  tsourcepos: [
    { sourceName: "/transactions.journal", sourceLine: 1, sourceColumn: 1 },
    { sourceName: "/transactions.journal", sourceLine: 4, sourceColumn: 1 },
  ],
  tdate,
  tdescription: "Shop",
  tcomment: "",
  ttags: [],
  tpostings: postings,
})

const term = (prefix: string, value: string, negated = false): QueryTerm => ({
  text: `${prefix}${value}`,
  negated,
  prefix,
  value,
  readable: true,
})

describe("which account is reconciled", () => {
  const accounts = ["assets:bank", "assets:bank:savings", "expenses:food"]

  test("is the one account the query names", () => {
    expect(reconciledAccount({ terms: [term("acct:", "assets:bank"), term("date:", "..2026-02-01")] }, accounts)).toBe(
      "assets:bank",
    )
  })

  test("is none where the query names two, or one the journal does not have", () => {
    expect(reconciledAccount({ terms: [term("acct:", "assets:bank"), term("", "expenses:food")] }, accounts)).toBe(
      undefined,
    )
    expect(reconciledAccount({ terms: [term("acct:", "bank")] }, accounts)).toBe(undefined)
  })
})

describe("the queries asked", () => {
  test("match the account and nothing beneath it", () => {
    expect(exactly("assets:bank")).toBe("acct:^assets:bank$")
    expect(exactly("assets:my bank")).toBe('acct:"^assets:my bank$"')
    expect(exactly("assets:bank (EUR)")).toBe('acct:"^assets:bank \\(EUR\\)$"')
  })

  test("run through the statement's date, hledger's end being exclusive", () => {
    expect(clearedQuery("assets:bank", "2026-01-31")).toBe("acct:^assets:bank$ date:..2026-02-01 status:*")
  })
})

describe("the lines gone through", () => {
  test("are the account's own postings, dated within the statement", () => {
    const entries = [
      transaction("Unmarked", [posting("assets:bank"), posting("expenses:food")]),
      transaction("Unmarked", [posting("assets:bank:savings"), posting("assets:bank", "Unmarked", "2026-02-03")]),
    ]
    expect(linesIn(entries, "assets:bank", "2026-01-31").map((line) => line.index)).toEqual([0])
  })

  test("read the entry's mark where a posting has none", () => {
    const entry = transaction("Cleared", [posting("assets:bank"), posting("expenses:food", "Pending")])
    expect(statusOf(entry, entry.tpostings[0]!)).toBe("Cleared")
    expect(statusOf(entry, entry.tpostings[1]!)).toBe("Pending")
  })
})

describe("marking a posting", () => {
  const text = ["2026-01-10 Shop", "    assets:bank        -12.00 EUR", "    expenses:food"].join("\n")
  const plain = transaction("Unmarked", [posting("assets:bank"), posting("expenses:food")])

  test("writes the mark before the account and keeps the amount where it was", () => {
    expect(withPostingStatus(text, plain, 0, "Cleared")).toBe(
      ["2026-01-10 Shop", "    * assets:bank      -12.00 EUR", "    expenses:food"].join("\n"),
    )
  })

  test("takes it off again the same way", () => {
    const marked = withPostingStatus(text, plain, 0, "Cleared") ?? ""
    const cleared = transaction("Unmarked", [posting("assets:bank", "Cleared"), posting("expenses:food")])
    expect(withPostingStatus(marked, cleared, 0, "Unmarked")).toBe(text)
  })

  test("hands a cleared entry's mark to the other postings when one is unmarked", () => {
    const entry = ["2026-01-10 * Shop", "    ; a comment", "    assets:bank    -12.00 EUR", "    expenses:food"].join("\n")
    const read = transaction("Cleared", [posting("assets:bank"), posting("expenses:food")])
    expect(withPostingStatus(entry, read, 0, "Unmarked")).toBe(
      ["2026-01-10 Shop", "    ; a comment", "    assets:bank    -12.00 EUR", "    * expenses:food"].join("\n"),
    )
  })

  test("leaves the posting to the entry's mark when that is already the one wanted", () => {
    const entry = ["2026-01-10 * Shop", "    ! assets:bank    -12.00 EUR", "    expenses:food"].join("\n")
    const read = transaction("Cleared", [posting("assets:bank", "Pending"), posting("expenses:food")])
    expect(withPostingStatus(entry, read, 0, "Cleared")).toBe(
      ["2026-01-10 * Shop", "    assets:bank      -12.00 EUR", "    expenses:food"].join("\n"),
    )
  })

  test("refuses where hledger reports a posting the text does not have", () => {
    const withRule = transaction("Unmarked", [posting("assets:bank"), posting("expenses:food"), posting("liabilities:tax")])
    expect(withPostingStatus(text, withRule, 0, "Cleared")).toBe(undefined)
  })
})

describe("the assertion written", () => {
  test("moves nothing and names what each commodity should come to", () => {
    expect(assertionEntry("2026-01-31", "Statement", "assets:bank", ["1,234.56 EUR", "$10"])).toBe(
      [
        "2026-01-31 * Statement",
        "    assets:bank    0 = 1,234.56 EUR",
        "    assets:bank    0 = $10",
      ].join("\n"),
    )
  })
})

describe("tagging a cleared posting", () => {
  test("finds the posting behind its mark rather than reading it as a comment", () => {
    const entry = ["2026-01-10 Shop", "    * assets:bank    -12.00 EUR", "    expenses:food"].join("\n")
    expect(withTag(entry, { on: "posting", at: 1 }, { name: "trip", value: "rome" })).toBe(
      [...entry.split("\n"), "    ; trip:rome"].join("\n"),
    )
  })
})
