import { describe, expect, test } from "bun:test"

import type { Amount, BalanceReport, TrialBalance } from "~/core/hledger/wire"
import { invertedBalance, invertedMixed, invertedTrialBalance } from "~/core/reports/invert"
import { withInvertedReportCommand } from "~/core/reports/custom"

const amount = (decimalMantissa: number): Amount => ({
  acommodity: "$",
  aquantity: { decimalMantissa, decimalPlaces: 2 },
  astyle: {
    ascommodityside: "L",
    ascommodityspaced: false,
    asdecimalmark: ".",
    asdigitgroups: null,
    asprecision: 2,
  },
})

const report: BalanceReport = {
  prRows: [{ prrName: "Assets:Cash", prrTotal: [amount(125)] }],
  prTotals: { prrName: [], prrTotal: [amount(125)] },
}

const trial: TrialBalance = {
  report,
  debits: [amount(125)],
  credits: [amount(0)],
}

describe("report sign inversion", () => {
  test("adds hledger's native invert option to custom reports", () => {
    expect(withInvertedReportCommand("balance expenses --monthly", true)).toBe("balance --invert expenses --monthly")
    expect(withInvertedReportCommand("balance '^4' --pivot=payee", true)).toBe("balance --invert '^4' --pivot=payee")
    expect(withInvertedReportCommand("hledger bal expenses", true)).toBe("hledger bal --invert expenses")
    expect(withInvertedReportCommand("balance expenses --invert", true)).toBe("balance expenses --invert")
    expect(withInvertedReportCommand("accounts", true)).toBe("accounts")
    expect(withInvertedReportCommand("balance expenses", false)).toBe("balance expenses")
  })
  test("negates exact mantissas and leaves zero amounts alone", () => {
    expect(invertedMixed([amount(125), amount(-40), amount(0)])).toEqual([
      amount(-125),
      amount(40),
      amount(0),
    ])
  })

  test("inverts report rows and totals", () => {
    expect(invertedBalance(report)).toEqual({
      prRows: [{ prrName: "Assets:Cash", prrTotal: [amount(-125)] }],
      prTotals: { prrName: [], prrTotal: [amount(-125)] },
    })
  })

  test("keeps the trial balance columns aligned with the inverted signs", () => {
    expect(invertedTrialBalance(trial)).toEqual({
      report: invertedBalance(report),
      debits: [amount(0)],
      credits: [amount(125)],
    })
  })
})
