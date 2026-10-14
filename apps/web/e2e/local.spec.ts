import { expect, test, type Page } from "@playwright/test"

const original = "2026-01-01 Original\n    expenses:food  $2\n    assets:cash\n"
const external = "2026-01-02 From disk\n    expenses:food  $3\n    assets:cash\n"

/** Real browser directory handles exercise persistence without a native folder-picker dialog. */
const prepareFolder = async (page: Page): Promise<void> => {
  await page.addInitScript((text) => {
    Object.defineProperty(FileSystemHandle.prototype, "requestPermission", { configurable: true, value: async () => "granted" })
    Object.defineProperty(window, "showDirectoryPicker", { configurable: true, value: async () => {
      const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle("books", { create: true })
      const writable = await (await folder.getFileHandle("main.journal", { create: true })).createWritable()
      await writable.write(text)
      await writable.close()
      return folder
    } })
  }, original)
}

const replaceDisk = async (page: Page, text: string): Promise<void> => {
  await page.evaluate(async (text) => {
    const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle("books")
    const writable = await (await folder.getFileHandle("main.journal")).createWritable()
    await writable.write(text)
    await writable.close()
  }, text)
}

const diskText = (page: Page): Promise<string> => page.evaluate(async () => {
  const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle("books")
  return (await (await folder.getFileHandle("main.journal")).getFile()).text()
})

const edit = async (page: Page, text: string): Promise<void> => {
  await page.locator("textarea").fill(text)
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled()
}

test("the original folder persists, conflicts do not overwrite it, and discarding starts from disk", async ({ page }) => {
  await prepareFolder(page)
  await page.goto("/")
  await page.getByRole("button", { name: "Open a journal folder", exact: true }).click()
  await page.goto("/journal/source#work")
  await expect(page.locator("textarea")).toHaveValue(original)
  await expect(page.getByText("You are working on a local copy")).toBeVisible()
  await expect(page.getByRole("button", { name: "Save to original folder", exact: true })).toHaveCount(0)
  const saveDisk = page.getByRole("button", { name: "Save to original folder", exact: true })
  const discard = page.getByRole("button", { name: "Discard changes and reload from disk", exact: true })
  const localSync = async (): Promise<void> => { await page.goto("/remotes#local") }
  const source = async (): Promise<void> => { await page.goto("/journal/source#work") }
  await localSync()
  await expect(page.getByRole("heading", { name: "Sync and backups" })).toBeVisible()
  await expect(page.getByRole("button", { name: /Original folder/ })).toHaveAttribute("aria-pressed", "true")
  await source()
  const changed = original.replace("Original", "Browser")
  await edit(page, changed)
  expect(await diskText(page)).toBe(original)
  const saveNow = page.getByRole("button", { name: "Save now", exact: true })
  await saveNow.click()
  await expect(saveNow).toHaveClass(/bg-success/)
  await expect(saveNow.getByText("✓")).toBeVisible()
  expect(await diskText(page)).toBe(changed)
  await localSync()
  await expect(saveDisk).toBeDisabled()

  await page.reload()
  await source()
  await expect(page.locator("textarea")).toHaveValue(changed)
  await edit(page, original)
  await replaceDisk(page, external)
  await localSync()
  await saveDisk.click()
  await expect(page.getByRole("alert")).toContainText("has changed on disk")
  expect(await diskText(page)).toBe(external)

  page.once("dialog", (dialog) => dialog.dismiss())
  await discard.click()
  await source()
  await expect(page.locator("textarea")).toHaveValue(original)
  await page.locator("textarea").fill("unsaved browser text")
  await replaceDisk(page, "this is not a journal\n")
  page.once("dialog", (dialog) => dialog.accept())
  await localSync()
  await discard.click()
  await source()
  await expect(page.getByText("hledger could not read the journal.", { exact: false })).toBeVisible()
  await expect(page.locator("textarea")).toHaveValue("unsaved browser text")

  await replaceDisk(page, external)
  page.once("dialog", (dialog) => dialog.accept())
  await localSync()
  await discard.click()
  await source()
  await expect(page.locator("textarea")).toHaveValue(external)
  await localSync()
  await expect(saveDisk).toBeDisabled()
  expect(await diskText(page)).toBe(external)
  await page.reload()
  await source()
  await expect(page.locator("textarea")).toHaveValue(external)

  await replaceDisk(page, original)
  await localSync()
  await page.getByRole("button", { name: "Reload from folder", exact: true }).click()
  await expect(page.locator("textarea")).toHaveValue(original)
})
