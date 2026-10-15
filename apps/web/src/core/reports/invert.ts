import type { Amount, BalanceReport, MixedAmount, RegisterRow, TrialBalance } from "~/core/hledger/wire"

export const inverted = (amount: Amount): Amount =>
  amount.aquantity.decimalMantissa === 0
    ? amount
    : { ...amount, aquantity: { ...amount.aquantity, decimalMantissa: -amount.aquantity.decimalMantissa } }

export const invertedMixed = (amount: MixedAmount): MixedAmount => amount.map(inverted)

export const invertedBalance = (report: BalanceReport): BalanceReport => ({
  prRows: report.prRows.map((row) => ({ ...row, prrTotal: invertedMixed(row.prrTotal) })),
  prTotals: { ...report.prTotals, prrTotal: invertedMixed(report.prTotals.prrTotal) },
})

export const invertedTrialBalance = (trial: TrialBalance): TrialBalance => ({
  report: invertedBalance(trial.report),
  debits: trial.credits,
  credits: trial.debits,
})

export const invertedRegister = (row: RegisterRow): RegisterRow => {
  const [date, period, description, posting, running] = row
  return [
    date,
    period,
    description,
    { ...posting, pamount: invertedMixed(posting.pamount) },
    invertedMixed(running),
  ]
}
