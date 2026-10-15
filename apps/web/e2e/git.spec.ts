import { readFile } from "node:fs/promises"
import { expect, test, type Page, type Route } from "@playwright/test"

import type { Choai } from "~/core/api/install"

declare global {
  interface Window {
    choai: Choai
  }
}

/**
 * Source control: what is waiting to be sent, sending it, and what was sent
 * before.
 *
 * GitHub is answered here rather than over the network, with a history of two
 * branches meeting at a merge, so the graph has a second lane to draw.
 */
const NOT_A_TOKEN = "not-a-real-token"

const JOURNAL = `2026-07-01 Opening
    assets:bank:checking  $1,000.00
    equity:opening
`

const asJson = (route: Route, body: unknown, status = 200): Promise<void> =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) })

const commit = (sha: string, parents: readonly string[], message: string, date: string) => ({
  sha,
  parents: parents.map((parent) => ({ sha: parent })),
  commit: { message, author: { name: "mrksye", date }, committer: { date } },
})

const HISTORY = [
  commit("m3", ["m2", "s1"], "Merge the phone's entries", "2026-07-04T00:00:00Z"),
  commit("m2", ["m1"], "Update books/main.journal", "2026-07-03T00:00:00Z"),
  commit("s1", ["m1"], "Groceries from the phone", "2026-07-02T00:00:00Z"),
  commit("m1", [], "Opening balances", "2026-07-01T00:00:00Z"),
]

const PATCH = "@@ -1,3 +1,3 @@\n 2026-07-01 Opening\n-    assets:bank:checking  $900.00\n+    assets:bank:checking  $1,000.00\n     equity:opening"

/** A second file in the same commit, as a declaration beside the entries using it would be. */
const ACCOUNTS_PATCH = "@@ -1,1 +1,2 @@\n account assets  ; type:A\n+account assets:bank:checking"

/** Every commit from `head` back, a page at a time, as GitHub walks them. */
const walked = (history: readonly ReturnType<typeof commit>[], head: string, page: number) => {
  const from = history.findIndex((each) => each.sha === head)
  return from === -1 ? [] : history.slice(from).slice((page - 1) * 100, page * 100)
}

interface Answered {
  message: string | undefined
  /** Every path asked of GitHub, in order, so a test can say what was not asked. */
  readonly asked: string[]
  /** The blob GitHub says its files are at, changed to stand for a send from elsewhere. */
  sha?: string
  text?: string
}

const answerGitHub = async (
  page: Page,
  answered: Answered,
  history: readonly ReturnType<typeof commit>[] = HISTORY,
  heads = [
    { name: "main", commit: { sha: "m3" } },
    { name: "phone", commit: { sha: "s1" } },
  ],
): Promise<void> => {
  await page.route("**/api.github.com/**", async (route) => {
    const url = new URL(route.request().url())
    const request = route.request()
    answered.asked.push(url.pathname + url.search)
    if (url.pathname === "/user") return asJson(route, { login: "mrksye" })
    if (url.pathname === "/repos/mrksye/books") return asJson(route, { default_branch: "main" })
    if (url.pathname.includes("/git/trees/")) return asJson(route, { tree: [{ path: "books/main.journal", type: "blob" }] })
    if (url.pathname.endsWith("/branches")) return asJson(route, heads)
    if (url.pathname.endsWith("/commits")) {
      return asJson(route, walked(history, url.searchParams.get("sha") ?? "", Number(url.searchParams.get("page") ?? 1)))
    }
    if (url.pathname.includes("/commits/")) {
      const found = history.find((each) => each.sha === url.pathname.split("/").at(-1))
      return asJson(route, {
        ...found,
        files: [
          { filename: "books/main.journal", status: "modified", additions: 1, deletions: 1, patch: PATCH },
          { filename: "books/accounts.journal", status: "modified", additions: 1, deletions: 0, patch: ACCOUNTS_PATCH },
        ],
      })
    }
    if (url.pathname.includes("/contents/") && request.method() === "PUT") {
      answered.message = (request.postDataJSON() as { message?: string }).message
      return asJson(route, { content: { sha: "after-push" } })
    }
    if (url.pathname.includes("/contents/")) {
      return asJson(route, {
        content: Buffer.from(answered.text ?? JOURNAL, "utf-8").toString("base64"),
        encoding: "base64",
        sha: answered.sha ?? "abc123",
      })
    }
    return asJson(route, {}, 404)
  })
}

const fill = async (page: Page, label: string, value: string): Promise<void> => {
  await page.getByLabel(label, { exact: true }).first().fill(value)
}

/**
 * Leaves the page on the connection it took the books through. Moving on is done
 * inside the app rather than by loading a page, because the book is written to
 * the device a moment after it opens, and a load before then arrives without it.
 */
const takeTheBooks = async (page: Page): Promise<void> => {
  await page.goto("/git#connection")
  await fill(page, "Personal access token", NOT_A_TOKEN)
  await fill(page, "Owner", "mrksye")
  await fill(page, "Repository", "books")
  await fill(page, "Path to the journal (its folder is loaded)", "books/main.journal")
  await page.getByRole("button", { name: "Save and check", exact: true }).click()
  await expect(page.getByText("Connected as mrksye")).toBeVisible()
  await page.getByRole("button", { name: "Take from GitHub as a new journal" }).click()
  await expect(page.getByText(/^Taken:/)).toBeVisible()
  await expect
    .poll(async () => {
      const open = await page.evaluate(() => window.choai.journal.summary({}))
      return open.ok ? open.value.transactions : 0
    })
    .toBe(1)
  await expect(page).toHaveURL(/\/remotes#connection$/)
}

test("with nothing connected, the screen is the connection, and the sidebar says so", async ({ page }) => {
  await page.goto("/git")
  await expect(page.getByLabel("Personal access token", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Connect to GitHub" })).toBeVisible()
})

test("an entry written here waits in the list, shows as a diff, and goes with the message given", async ({
  page,
}) => {
  const written: Answered = { message: undefined, asked: [] }
  await answerGitHub(page, written)
  await takeTheBooks(page)
  await page.getByRole("link", { name: "Back to the history" }).click()
  await expect(page.getByRole("button", { name: "mrksye/books" })).toBeVisible()
  await expect(page.getByText("Nothing is waiting to be sent.")).toBeVisible()

  const added = await page.evaluate(() =>
    window.choai.transaction.create({
      date: "2026-07-05",
      payee: "Grocer",
      postings: [{ account: "expenses:food", amount: "$32.80" }, { account: "assets:bank:checking" }],
    } as never),
  )
  expect(added.ok).toBe(true)

  // Written to transactions.journal, which the books taken did not have yet, so
  // main.journal waits beside it with the include that names it.
  await expect(page.getByRole("complementary").getByRole("button", { name: /main\.journal/ })).toBeVisible()
  const file = page.getByRole("complementary").getByRole("button", { name: /transactions\.journal/ })
  await expect(file).toBeVisible()
  await file.click()
  await expect(page.getByText("Since it was last sent")).toBeVisible()
  await expect(page.getByRole("cell", { name: "2026-07-05 Grocer" })).toBeVisible()

  // Taking would replace what is waiting, so it is held back until it has gone.
  await expect(page.getByRole("button", { name: "Take", exact: true })).toBeDisabled()

  await page.getByLabel("Message").fill("Groceries")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page.getByRole("complementary").getByText("Nothing is waiting to be sent.")).toBeVisible()
  expect(written.message).toBe("Groceries")
})

test("the history is drawn from every branch, and a commit opens to what it changed", async ({ page }) => {
  await answerGitHub(page, { message: undefined, asked: [] })
  await takeTheBooks(page)
  await page.getByRole("link", { name: "Back to the history" }).click()
  await expect(page.getByText("Merge the phone's entries")).toBeVisible()
  await expect(page.getByText("Groceries from the phone")).toBeVisible()
  await expect(page.getByText("phone", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Read again", exact: true })).toBeEnabled()
  await expect(page.getByText("Reading the history…")).toBeHidden()

  await page.getByRole("button", { name: /Update books\/main\.journal/ }).click({ force: true })
  // Every file it changed is open already, not only when there is one.
  await expect(page.getByText("2 files changed")).toBeVisible()
  await expect(page.getByRole("cell", { name: "assets:bank:checking  $900.00" })).toBeVisible()
  await expect(page.getByRole("cell", { name: "account assets:bank:checking", exact: true })).toBeVisible()
})

test("what was read is still shown when GitHub cannot be asked again", async ({ page }) => {
  await answerGitHub(page, { message: undefined, asked: [] })
  await takeTheBooks(page)
  await page.getByRole("link", { name: "Back to the history" }).click()
  await expect(page.getByText("Merge the phone's entries")).toBeVisible()

  await page.unroute("**/api.github.com/**")
  await page.route("**/api.github.com/**", (route) => route.abort())
  await page.getByRole("button", { name: "Read again" }).click()
  await expect(page.getByText("GitHub could not be asked again")).toBeVisible()
  await expect(page.getByText("Merge the phone's entries")).toBeVisible()
})

test("the graph is a hundred commits at a time, and the next hundred are read when asked for", async ({
  page,
}) => {
  const long = Array.from({ length: 150 }, (_, at) =>
    commit(`c${149 - at}`, at === 149 ? [] : [`c${148 - at}`], `Entry ${149 - at}`, new Date(Date.UTC(2026, 0, 1) + (149 - at) * 3_600_000).toISOString()),
  )
  const answered: Answered = { message: undefined, asked: [] }
  await answerGitHub(page, answered, long, [{ name: "main", commit: { sha: "c149" } }])
  await takeTheBooks(page)
  await page.getByRole("link", { name: "Back to the history" }).click()
  await expect(page.getByText("Entry 149", { exact: true })).toBeVisible()
  await expect(page.getByText("Entry 50", { exact: true })).toBeVisible()
  await expect(page.getByText("Entry 49", { exact: true })).toBeHidden()

  const older = page.getByRole("button", { name: "100 older" })
  await expect(older).toBeEnabled()
  await older.click({ force: true })
  await expect(page.getByText("Entry 0", { exact: true })).toBeVisible({ timeout: 15_000 })
  expect(answered.asked.filter((path) => path.includes("/commits?"))).toEqual([
    "/repos/mrksye/books/commits?sha=c149&per_page=100&page=1",
    "/repos/mrksye/books/commits?sha=c49&per_page=100&page=1",
  ])
  await expect(page.getByRole("button", { name: "100 older" })).toBeHidden()
})


/**
 * Opening the app asks GitHub whether its files are still what was last agreed
 * here. Where one has moved on — sent from another device — the rail marks the
 * source control button, and its list says so and leads to taking; taking
 * agrees again, and the mark goes.
 */
test("an unreadable destination copy opens the editor and can be corrected", async ({ page }) => {
  const changed = `${JOURNAL}\n2026-07-05 Grocer\n    expenses:food  $32.80\n    assets:bank:checking\n`
  const unreadable = `${JOURNAL}\n2026-07-05 Grocer\n    expenses:food  $32.80\n    assets:bank:checking  $1.00\n`
  let remoteText = JOURNAL
  let remoteSha = "abc123"
  await page.route("**/api.github.com/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/user") return asJson(route, { login: "mrksye" })
    if (url.pathname.includes("/git/trees/")) return asJson(route, { tree: [{ path: "books/main.journal", type: "blob" }] })
    if (url.pathname.includes("/contents/") && route.request().method() === "PUT") {
      return asJson(route, { content: { sha: "resolved-sha" } })
    }
    if (url.pathname.includes("/contents/")) {
      return asJson(route, {
        content: Buffer.from(remoteText, "utf-8").toString("base64"),
        encoding: "base64",
        sha: remoteSha,
      })
    }
    return asJson(route, {}, 404)
  })
  await takeTheBooks(page)

  remoteText = unreadable
  remoteSha = "phone-sha"
  await page.goto("/journal")
  await page.evaluate(() => window.dispatchEvent(new Event("focus")))
  await page.getByRole("button", { name: "Compare and sync" }).click()
  await expect(page.getByRole("heading", { name: "Compare copies" })).toBeVisible()
  await expect(page.getByText("Take destination", { exact: true })).toBeVisible()
  await expect(page.getByText("2026-07-05 Grocer").first()).toBeVisible()
  expect(await page.evaluate(() => window.choai.journal.text({ path: "main.journal" }))).toMatchObject({
    ok: true,
    value: { text: JOURNAL },
  })

  await page.getByRole("button", { name: "Take destination" }).click()
  await expect(page.getByText("The journal cannot be read with this text.")).toBeVisible()
  await expect(page.getByText("A transaction does not balance.")).toBeVisible()
  const editor = page.getByLabel("Text to keep")
  await expect(editor).toHaveValue(unreadable)
  await editor.fill(changed)
  await page.getByRole("button", { name: "Continue", exact: true }).click()
  await expect(page.getByText("The journal can be read.")).toBeVisible()
  await expect(page.getByText(/writes the edited/)).toBeVisible()
  await page.getByRole("button", { name: "Confirm and apply" }).click()
  await expect.poll(async () => page.evaluate(() => window.choai.journal.text({ path: "main.journal" }))).toMatchObject({
    ok: true,
    value: { text: changed },
  })
})

test("a destination-only journal file is discovered, previewed, and taken explicitly", async ({ page }) => {
  let discovered = false
  let treeReads = 0
  let transactionReads = 0
  const extra = `2026-07-06 Grocer\n    expenses:food  $12.00\n    assets:bank:checking\n`
  await page.route("**/api.github.com/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/user") return asJson(route, { login: "mrksye" })
    if (url.pathname.includes("/git/trees/")) {
      treeReads += 1
      return asJson(route, {
        tree: ["books/main.journal", ...(discovered ? ["books/transactions.journal"] : [])].map((path) => ({ path, type: "blob" })),
      })
    }
    if (url.pathname.includes("/contents/")) {
      const isExtra = url.pathname.endsWith("transactions.journal")
      if (isExtra) transactionReads += 1
      const text = isExtra ? extra : JOURNAL
      return asJson(route, { content: Buffer.from(text, "utf-8").toString("base64"), encoding: "base64", sha: isExtra ? "extra-sha" : "main-sha" })
    }
    return asJson(route, {}, 404)
  })
  await takeTheBooks(page)
  const previousTreeReads = treeReads
  discovered = true
  await page.goto("/journal")
  await page.evaluate(() => window.dispatchEvent(new Event("focus")))
  await expect.poll(async () => (await page.evaluate(() => window.choai?.journal.summary({})))?.ok).toBe(true)
  await expect.poll(() => treeReads).toBeGreaterThan(previousTreeReads)
  await expect.poll(() => transactionReads).toBeGreaterThan(0)
  const compare = page.getByRole("button", { name: "Compare and sync" })
  await expect(compare).toBeVisible()
  await compare.click({ force: true })
  await expect(page.getByRole("heading", { name: "transactions.journal" })).toBeVisible()
  await expect(page.getByText("Added at destination")).toBeVisible()
  await page.getByRole("button", { name: "Take destination" }).click()
  await expect(page.getByText("The journal can be read.")).toBeVisible()
  await page.getByRole("button", { name: "Confirm and apply" }).click()
  await expect.poll(async () => page.evaluate(() => window.choai.journal.text({ path: "transactions.journal" }))).toMatchObject({
    ok: true,
    value: { text: extra },
  })
})

test("an unknown destination file can only be exported or deferred", async ({ page }) => {
  const unknownBytes = Uint8Array.of(0, 255, 1, 128)
  await page.route("**/api.github.com/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/user") return asJson(route, { login: "mrksye" })
    if (url.pathname.includes("/git/trees/")) return asJson(route, {
      tree: ["books/main.journal", "books/archive.opaque"].map((path) => ({ path, type: "blob" })),
    })
    if (url.pathname.endsWith("/archive.opaque")) {
      return asJson(route, { content: Buffer.from(unknownBytes).toString("base64"), encoding: "base64", sha: "opaque-sha" })
    }
    if (url.pathname.includes("/contents/")) {
      return asJson(route, { content: Buffer.from(JOURNAL, "utf-8").toString("base64"), encoding: "base64", sha: "main-sha" })
    }
    return asJson(route, {}, 404)
  })
  await takeTheBooks(page)
  await page.goto("/journal")
  await page.evaluate(() => window.dispatchEvent(new Event("focus")))
  await expect.poll(async () => (await page.evaluate(() => window.choai?.journal.summary({})))?.ok).toBe(true)
  const compare = page.getByRole("button", { name: "Compare and sync" })
  await expect(compare).toBeVisible()
  await compare.click({ force: true })
  await expect(page.getByRole("heading", { name: "archive.opaque" })).toBeVisible()
  await expect(page.getByText(/This file type is unknown/)).toBeVisible()
  await expect(page.getByRole("button", { name: "Keep this copy" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Take destination" })).toHaveCount(0)
  const downloadReady = page.waitForEvent("download")
  await page.getByRole("button", { name: "Export destination copy" }).click()
  const download = await downloadReady
  expect(download.suggestedFilename()).toBe("archive.opaque")
  const localPath = await download.path()
  expect(localPath).not.toBeNull()
  if (localPath !== null) expect(new Uint8Array(await readFile(localPath))).toEqual(unknownBytes)
  expect(await page.evaluate(() => window.choai.journal.text({ path: "archive.opaque" }))).toMatchObject({ ok: false })
})

test("rules, statements and notes beside the journal are taken with it, not found afterwards", async ({ page }) => {
  const texts: Readonly<Record<string, string>> = {
    "README.md": "# Books\n\nNotes kept with the journal.\n",
    "import/bank.csv.rules": "skip 1\nfields date, description, amount\n",
    "import/staging/statement.csv": "date,description,amount\n2026-07-02,Grocer,-12.00\n",
  }
  const unknownBytes = Uint8Array.of(0, 255, 1, 128)
  await page.route("**/api.github.com/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/user") return asJson(route, { login: "mrksye" })
    if (url.pathname.includes("/git/trees/")) return asJson(route, {
      tree: ["books/main.journal", "books/archive.opaque", ...Object.keys(texts).map((path) => `books/${path}`)]
        .map((path) => ({ path, type: "blob" })),
    })
    if (url.pathname.endsWith("/archive.opaque")) {
      return asJson(route, { content: Buffer.from(unknownBytes).toString("base64"), encoding: "base64", sha: "opaque-sha" })
    }
    const text = Object.entries(texts).find(([path]) => url.pathname.endsWith(`/books/${path}`))?.[1] ?? JOURNAL
    if (url.pathname.includes("/contents/")) {
      return asJson(route, { content: Buffer.from(text, "utf-8").toString("base64"), encoding: "base64", sha: `sha-${text.length}` })
    }
    return asJson(route, {}, 404)
  })
  await takeTheBooks(page)
  for (const [path, text] of Object.entries(texts)) {
    expect(await page.evaluate((path) => window.choai.journal.text({ path }), path)).toMatchObject({ ok: true, value: { text } })
  }
  await page.goto("/journal")
  await page.evaluate(() => window.dispatchEvent(new Event("focus")))
  await expect.poll(async () => (await page.evaluate(() => window.choai?.journal.summary({})))?.ok).toBe(true)
  const compare = page.getByRole("button", { name: "Compare and sync" })
  await expect(compare).toBeVisible()
  await compare.click({ force: true })
  await expect(page.getByRole("heading", { name: "archive.opaque" })).toBeVisible()
  for (const path of Object.keys(texts)) await expect(page.getByRole("heading", { name: path })).toHaveCount(0)
})

test("an unfinished comparison and its choice return after reopening", async ({ page }) => {
  let remoteText = JOURNAL
  let remoteSha = "abc123"
  await page.route("**/api.github.com/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/user") return asJson(route, { login: "mrksye" })
    if (url.pathname.includes("/git/trees/")) return asJson(route, { tree: [{ path: "books/main.journal", type: "blob" }] })
    if (url.pathname.includes("/contents/")) {
      return asJson(route, {
        content: Buffer.from(remoteText, "utf-8").toString("base64"),
        encoding: "base64",
        sha: remoteSha,
      })
    }
    return asJson(route, {}, 404)
  })
  await takeTheBooks(page)

  remoteText = `${JOURNAL} ; revised remotely\n`
  remoteSha = "phone-sha"
  await page.goto("/journal")
  await page.getByRole("button", { name: "Compare and sync" }).click()
  await expect(page.getByRole("heading", { name: "Compare copies" })).toBeVisible()
  await page.getByRole("button", { name: "Keep this copy" }).click()
  await page.getByRole("button", { name: "Close and decide later" }).click()
  await expect(page.getByRole("heading", { name: "Compare copies" })).toBeHidden()

  await page.reload()
  await expect(page.getByRole("heading", { name: "Compare copies" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Keep this copy", exact: true })).toBeVisible()
})

test("a version changed after comparison is not overwritten", async ({ page }) => {
  let remoteText = JOURNAL
  let remoteSha = "abc123"
  const writes: { readonly sha?: string }[] = []
  await page.route("**/api.github.com/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/user") return asJson(route, { login: "mrksye" })
    if (url.pathname.includes("/git/trees/")) return asJson(route, { tree: [{ path: "books/main.journal", type: "blob" }] })
    if (url.pathname.includes("/contents/") && route.request().method() === "PUT") {
      writes.push((route.request().postDataJSON() as { readonly sha?: string }))
      return asJson(route, { content: { sha: "resolved-sha" } })
    }
    if (url.pathname.includes("/contents/")) {
      return asJson(route, {
        content: Buffer.from(remoteText, "utf-8").toString("base64"),
        encoding: "base64",
        sha: remoteSha,
      })
    }
    return asJson(route, {}, 404)
  })
  await takeTheBooks(page)

  remoteText = `${JOURNAL} ; revised remotely\n`
  remoteSha = "phone-sha"
  await page.goto("/journal")
  await page.getByRole("button", { name: "Compare and sync" }).click()
  await expect(page.getByRole("heading", { name: "Compare copies" })).toBeVisible()

  remoteText = `${JOURNAL} ; changed again\n`
  remoteSha = "new-phone-sha"
  await page.getByRole("button", { name: "Keep this copy" }).click()
  await expect(page.getByText("The journal can be read.")).toBeVisible()
  await page.getByRole("button", { name: "Confirm and apply" }).click()
  await expect(page.getByText("; changed again", { exact: false }).first()).toBeVisible()
  await expect(page.getByText(/changed after this comparison/)).toHaveCount(0)
  expect(writes).toEqual([])
})

test("changes on GitHub not yet taken mark the rail when the app opens, until they are taken", async ({ page }) => {
  const github: Answered = { message: undefined, asked: [] }
  await answerGitHub(page, github)
  await takeTheBooks(page)
  const backups = page.getByRole("button", { name: "Backups", exact: true })
  await page.waitForTimeout(500)
  await expect(backups.locator("[data-attention]")).toHaveCount(0)

  github.sha = "sent-from-the-phone"
  github.text = `${JOURNAL}; changed on the phone\n`
  const previousRequests = github.asked.length
  await page.reload()
  await expect.poll(async () => (await page.evaluate(() => window.choai?.journal.summary({})))?.ok).toBe(true)
  await page.evaluate(() => window.dispatchEvent(new Event("focus")))
  await expect.poll(() => github.asked.length).toBeGreaterThan(previousRequests)
  await expect(backups.locator("[data-attention]")).toHaveCount(1)

  await page.getByRole("button", { name: "Journal", exact: true }).click()
  await backups.click()
  await expect(page.getByRole("status")).toContainText("GitHub has changes this device has not taken yet")
  await page.getByRole("button", { name: "Take", exact: true }).click()
  await expect(backups.locator("[data-attention]")).toHaveCount(0)
  await expect(page.getByRole("status")).toBeHidden()
})
