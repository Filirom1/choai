import { describe, expect, test } from "bun:test"

import { normalizeRemote } from "../src/core/journal/remote"

describe("persisted remote places", () => {
  test("reads pre-provider repository records as GitHub", () => {
    expect(normalizeRemote({ owner: "ledger-owner", repo: "books", branch: "main", path: "main.journal" })).toEqual({
      provider: "github",
      owner: "ledger-owner",
      repo: "books",
      branch: "main",
      path: "main.journal",
    })
  })

  test("keeps a Google Drive place distinct from a repository", () => {
    expect(normalizeRemote({ provider: "google-drive", folderId: "folder", folderName: "Books", path: "main.journal" })).toEqual({
      provider: "google-drive",
      folderId: "folder",
      folderName: "Books",
      path: "main.journal",
    })
  })

  test("refuses malformed stored places", () => {
    expect(normalizeRemote(null)).toBeUndefined()
    expect(normalizeRemote({ provider: "github", owner: "owner" })).toBeUndefined()
    expect(normalizeRemote({ provider: "other", path: "main.journal" })).toBeUndefined()
  })
})
