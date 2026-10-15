import { expect, test, type Page } from "@playwright/test"

import type { Choai } from "~/core/api/install"


declare global {
  interface Window {
    choai: Choai
  }
}

const original = "2026-01-01 Original\n    expenses:food  $2\n    assets:cash\n"
const external = "2026-01-02 From disk\n    expenses:food  $3\n    assets:cash\n"

/** Real browser directory handles exercise persistence without a native folder-picker dialog. */
const prepareFolder = async (page: Page): Promise<void> => {
  await page.addInitScript((text) => {
    let folderPermission: PermissionState = "granted"
    Object.defineProperty(window, "__setFolderPermission", { configurable: true, value: (permission: PermissionState) => { folderPermission = permission } })
    Object.defineProperty(FileSystemHandle.prototype, "queryPermission", { configurable: true, value: async () => folderPermission })
    Object.defineProperty(FileSystemHandle.prototype, "requestPermission", { configurable: true, value: async () => { folderPermission = "granted"; return folderPermission } })
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

test("the original-folder destination opens a journal folder directly", async ({ page }) => {
  await prepareFolder(page)
  await page.goto("/remotes#local")
  const originalFolder = page.getByRole("button", { name: "Original folder" })
  await expect(originalFolder).toBeEnabled()
  await originalFolder.click()
  await expect(page).toHaveURL(/\/journal#work$/)
  await expect.poll(async () => (await page.evaluate(() => window.choai.journal.summary({}))).ok).toBe(true)
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
  await expect(page).toHaveURL(/\/journal#work$/)
  await expect.poll(async () => (await page.evaluate(() => window.choai.journal.summary({}))).ok).toBe(true)
  const saveDisk = page.getByRole("button", { name: "Save to original folder", exact: true })
  const discard = page.getByRole("button", { name: "Discard changes and reload from disk", exact: true })
  const localSync = async (): Promise<void> => { await page.getByRole("button", { name: "Backups", exact: true }).first().click() }
  const source = async (): Promise<void> => { await page.getByRole("button", { name: "Edit the text", exact: true }).first().click() }
  await source()
  await expect(page.locator("textarea")).toHaveValue(original)
  await expect(saveDisk).toHaveCount(0)
  await localSync()
  await expect(page.getByRole("heading", { name: "Sync and backups" })).toBeVisible()
  await expect(page.getByText("Original folder", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "GitHub", exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Google Drive", exact: true })).toHaveCount(0)
  await source()
  const changed = original.replace("Original", "Browser")
  await edit(page, changed)
  expect(await diskText(page)).toBe(original)
  await localSync()
  await expect(saveDisk).toBeEnabled()
  const pendingFile = page.getByRole("button", { name: /main\.journal M/ })
  await expect(pendingFile).toBeVisible()
  await pendingFile.click()
  await expect(page).toHaveURL(/\/remotes#change=main\.journal$/)
  await expect(page.getByText("Since it was last saved to the folder")).toBeVisible()
  await expect(page.getByText("Browser")).toBeVisible()
  await page.getByRole("link", { name: "Back to synchronization" }).click()
  await expect(saveDisk).toBeEnabled()
  await saveDisk.click()
  await expect(page.getByRole("status")).toContainText("Folder synchronized")
  expect(await diskText(page)).toBe(changed)
  await expect(saveDisk).toBeDisabled()

  await page.reload()
  await expect.poll(async () => await page.evaluate(async () => (await window.choai?.journal.summary({}))?.ok ?? false)).toBe(true)
  await source()
  await expect(page.locator("textarea")).toHaveValue(changed)
  await edit(page, original)
  await replaceDisk(page, external)
  await page.evaluate(() => window.dispatchEvent(new Event("focus")))
  await expect(page.getByRole("alert")).toContainText("Changes are available from the other copy")
  await page.evaluate(() => (window as unknown as { __setFolderPermission: (permission: PermissionState) => void }).__setFolderPermission("prompt"))
  await page.evaluate(() => window.dispatchEvent(new Event("focus")))
  await expect(page.getByRole("alert")).toContainText("Check the backup for changes")
  await page.getByRole("button", { name: "Compare and sync", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Compare copies" })).toBeVisible()
  await expect(page.locator("pre").filter({ hasText: "2026-01-02 From disk" })).toBeVisible()
  await page.getByRole("button", { name: "Decide later", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Compare copies" })).toHaveCount(0)
  await localSync()
  await page.getByRole("button", { name: "Compare and sync", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Compare copies" })).toBeVisible()
  await expect(page.locator("pre").filter({ hasText: "2026-01-02 From disk" })).toBeVisible()
  await page.getByRole("button", { name: "Close and decide later", exact: true }).click()
  await localSync()
  await saveDisk.click()
  await expect(page.getByText(/has changed on disk/)).toBeVisible()
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
  await expect(page.getByText(/syntax error/)).toBeVisible()
  await source()
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
  await source()
  await expect(page.locator("textarea")).toHaveValue(original)
})
