import { expect, test, type Page } from "@playwright/test"

import type { Choai } from "~/core/api/install"

declare global {
  interface Window {
    choai: Choai
  }
}

const openTheDemo = async (page: Page): Promise<void> => {
  await page.goto("/")
  await page.evaluate(() => window.choai.ready)
  await page.getByRole("button", { name: "Try the demo" }).click()
  await expect
    .poll(async () => {
      const open = await page.evaluate(() => window.choai.journal.summary({}))
      return open.ok ? open.value.transactions : 0
    })
    .toBe(9)
}

/** Sixty more entries, so the journal runs to a second page. */
const sixtyMore = async (page: Page): Promise<void> => {
  const proposed = await page.evaluate(() =>
    window.choai.transaction.propose({
      transactions: Array.from({ length: 60 }, (_, index) => ({
        date: `2026-05-${String((index % 28) + 1).padStart(2, "0")}`,
        payee: `Coffee ${index + 1}`,
        postings: [{ account: "expenses:food", amount: "$3.00" }, { account: "assets:cash" }],
      })),
    }),
  )
  expect(proposed.ok).toBe(true)
  if (!proposed.ok) return
  const kept = await page.evaluate((id) => window.choai.proposal.apply({ id }), proposed.value.id)
  expect(kept.ok).toBe(true)
}

/**
 * Which page of the journal is open is in the address, as the query is: a
 * step of its own that going back undoes, kept across a reload, and dropped
 * when the query changes, since a page belongs to the answer it was a page of.
 */
test("the journal's page is in the address", async ({ page }) => {
  await openTheDemo(page)
  await sixtyMore(page)
  await page.goto("/journal#work")
  const range = page.getByText(/ of 69$/)

  await expect(range).toHaveText("1–50 of 69")
  await page.getByRole("button", { name: "Older" }).click()
  await expect(page).toHaveURL(/\/journal\?page=2#work$/)
  await expect(range).toHaveText("51–69 of 69")

  await page.reload()
  await expect(range).toHaveText("51–69 of 69")

  await page.goBack()
  await expect(page).toHaveURL(/\/journal#work$/)
  await expect(range).toHaveText("1–50 of 69")

  await page.goForward()
  await expect(range).toHaveText("51–69 of 69")
  await page.getByRole("searchbox").fill("desc:coffee")
  await expect(page).toHaveURL(/\/journal\?q=desc%3Acoffee#work$/)
  await expect(page.getByText(/ of 60$/)).toHaveText("1–50 of 60")
})

test("entry status marks are visible by default and metadata follows book settings", async ({ page }) => {
  await openTheDemo(page)
  await page.getByRole("button", { name: "Edit the text", exact: true }).first().click()
  await page.getByRole("button", { name: "transactions.journal", exact: true }).click()
  await expect(page.getByRole("textbox", { name: "transactions.journal", exact: true })).toBeVisible()
  await expect(page.locator(".journal-text-editor .tok-number").first()).toBeVisible()
  await expect(page.locator(".journal-text-editor")).toContainText("landlord")
  await expect(page.locator(".journal-text-editor")).toContainText("expenses:rent")

  const read = await page.evaluate(() => window.choai.journal.text({ path: "transactions.journal" }))
  expect(read.ok).toBe(true)
  if (!read.ok) return
  const changed = read.value.text.replace("2026-01-05 landlord", "2026-01-05 * (INV-42) landlord")
  expect(changed).not.toBe(read.value.text)
  await page.locator(".journal-text-editor .cm-content").fill(changed)
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled()
  await page.getByRole("button", { name: "Journal", exact: true }).first().click()

  const marked = page.getByRole("button", { name: /\* landlord/ })
  await expect(marked).toBeVisible()
  await expect(marked.getByText("*", { exact: true })).toBeVisible()
  await expect(marked).not.toContainText("INV-42")

  await page.getByRole("button", { name: "Settings", exact: true }).first().click()
  const code = page.getByRole("checkbox", { name: "Entry code", exact: true })
  await expect(code).not.toBeChecked()
  await code.check()
  await page.getByRole("button", { name: "Save book settings", exact: true }).click()
  await page.getByRole("button", { name: "Journal", exact: true }).first().click()
  await expect(page.getByRole("button", { name: /\(INV-42\).*landlord/ })).toBeVisible()
})
