import { expect, test, type Page } from "@playwright/test"

import type { Choai } from "~/core/api/install"

declare global {
  interface Window {
    choai: Choai
  }
}

const openTheDemo = async (page: Page): Promise<void> => {
  await page.goto("/")
  await page.getByRole("button", { name: "Try the demo" }).click()
  await expect.poll(async () => {
    const open = await page.evaluate(() => window.choai.journal.summary({}))
    return open.ok ? open.value.transactions : 0
  }).toBe(9)
}

test("native hledger import proposes transactions and .latest together", async ({ page }) => {
  await openTheDemo(page)
  const before = await page.evaluate(() => window.choai.journal.text({}))
  const result = await page.evaluate(async () => {
    const served = (path: string): Promise<unknown> => import(/* @vite-ignore */ `/src/core/${path}.ts`)
    const importer = (await served("statement/hledger-import")) as typeof import("~/core/statement/hledger-import")
    const proposals = (await served("journal/proposals")) as typeof import("~/core/journal/proposals")
    const csvPath = "imports/csv/statement.csv"
    const rulesPath = "imports/rules/statement.csv.rules"
    const files = {
      [csvPath]: "date,description,amount\n2026-04-04,Coffee,-4.50\n",
      [rulesPath]: [
        "fields date, description, amount",
        "date-format %Y-%m-%d",
        "account1 assets:bank:checking",
        "account2 expenses:food",
        "",
      ].join("\n"),
    }
    const kept = await importer.keepImportFiles(files)
    if (!kept.ok) return { at: "store-input" as const, error: kept.error }
    const first = await importer.readCsvWithRules(csvPath, rulesPath)
    if (!first.ok) return { at: "first-import" as const, error: first.error }
    const textBeforeAccepting = await window.choai.journal.text({})
    const latestWasNotPersisted = first.value.previousCheckpoint === undefined &&
      textBeforeAccepting.ok && !textBeforeAccepting.value.text.includes("Coffee")
    const made = await proposals.propose([{
      is: "hledger-import",
      csvPath,
      rulesPath,
      checkpointPath: first.value.checkpointPath,
      checkpointText: first.value.checkpoint,
      transactionCount: first.value.transactions.length,
      text: first.value.transactions.map(({ text }) => text).join(""),
      confidence: 1,
    }])
    if (!made.ok) return { at: "propose" as const, error: made.error }
    const accepted = await proposals.apply(made.value.id)
    if (!accepted.ok) return { at: "accept" as const, error: accepted.error }
    const savedCheckpoint = accepted.value.source.files[first.value.checkpointPath]
    const second = await importer.readCsvWithRules(csvPath, rulesPath)
    return {
      offered: proposals.textOf(made.value.items[0]!, undefined),
      count: accepted.value.summary.transactions,
      latestWasNotPersisted,
      savedCheckpoint,
      secondCount: second.ok ? second.value.transactions.length : -1,
      secondError: second.ok ? undefined : second.error,
    }
  })

  expect(result).toMatchObject({
    offered: expect.stringContaining("Coffee"),
    count: 10,
    latestWasNotPersisted: true,
    savedCheckpoint: "2026-04-04\n",
    secondCount: 0,
  })
  expect(await page.evaluate(() => window.choai.journal.text({}))).not.toEqual(before)
})
