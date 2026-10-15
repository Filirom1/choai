import { describe, expect, spyOn, test } from "bun:test"

import { readDriveHistory } from "../src/core/google-drive/history"

const folder = "application/vnd.google-apps.folder"

describe("Google Drive history", () => {
  test("resolves the selected journal below its folder and orders revisions newest first", async () => {
    const fetch = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ files: [{ id: "nested", name: "books", mimeType: folder }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ files: [{ id: "journal", name: "main.journal", mimeType: "text/plain" }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ revisions: [
        { id: "older", modifiedTime: "2025-12-01T00:00:00Z" },
        { id: "newer", modifiedTime: "2026-01-01T00:00:00Z" },
      ] })))
    const result = await readDriveHistory("token", {
      provider: "google-drive",
      folderId: "root",
      folderName: "Books",
      path: "books/main.journal",
    })
    expect(result).toMatchObject({
      ok: true,
      value: {
        file: { id: "journal", name: "main.journal" },
        revisions: [{ id: "newer" }, { id: "older" }],
      },
    })
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      expect.stringContaining("/files?"),
      expect.stringContaining("/files?"),
      expect.stringContaining("/files/journal/revisions?"),
    ])
    fetch.mockRestore()
  })
})
