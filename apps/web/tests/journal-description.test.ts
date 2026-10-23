import { expect, test } from "bun:test"

import { payeeAndNote } from "~/core/journal/description"

test("reads a payee and note from hledger's description", () => {
  expect(payeeAndNote("  Grocery shop | weekly food  ")).toEqual({
    payee: "Grocery shop",
    note: "weekly food",
  })
})

test("reads a description without a note as a payee alone", () => {
  expect(payeeAndNote("  Grocery shop  ")).toEqual({
    payee: "Grocery shop",
    note: "",
  })
})

test("keeps further separators in the note", () => {
  expect(payeeAndNote("Grocery shop | food | household")).toEqual({
    payee: "Grocery shop",
    note: "food | household",
  })
})
