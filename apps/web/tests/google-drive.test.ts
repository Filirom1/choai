import { describe, expect, spyOn, test } from "bun:test"

import { listFilesInFolder, listSharedWithMe, listStarred, multipartBody, updateFile } from "../src/core/google-drive/api"
import { changedFromAgreement, type DriveAgreement } from "../src/core/google-drive/kept"
import { fileName, parentPath, relativePath, safePath } from "../src/core/google-drive/paths"

const agreed: DriveAgreement = {
  path: "main.journal",
  fileId: "drive-file",
  md5Checksum: "checksum-1",
  version: "1",
  baseText: "2026-01-01 Opening\n",
}

describe("Google Drive request bodies", () => {
  test("lists a folder using its OAuth token, without an API key", async () => {
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ files: [] })))
    const result = await listFilesInFolder("token", "folder-id")
    const [input, init] = fetch.mock.calls[0] ?? []
    const url = new URL(String(input))
    expect(result).toEqual({ ok: true, value: [] })
    expect(url.searchParams.get("q")).toBe("'folder-id' in parents and trashed = false")
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer token")
    expect(url.searchParams.has("key")).toBe(false)
    fetch.mockRestore()
  })

  test("lists items shared directly with the user", async () => {
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ files: [] })))
    const result = await listSharedWithMe("token")
    const [input, init] = fetch.mock.calls[0] ?? []
    const url = new URL(String(input))
    expect(result).toEqual({ ok: true, value: [] })
    expect(url.searchParams.get("q")).toBe("sharedWithMe = true and trashed = false")
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer token")
    fetch.mockRestore()
  })

  test("lists Drive's starred items", async () => {
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ files: [] })))
    const result = await listStarred("token")
    const [input, init] = fetch.mock.calls[0] ?? []
    const url = new URL(String(input))
    expect(result).toEqual({ ok: true, value: [] })
    expect(url.searchParams.get("q")).toBe("starred = true and trashed = false")
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer token")
    fetch.mockRestore()
  })

  test("builds a multipart upload with metadata and the journal text", () => {
    const body = multipartBody("boundary", { name: "main.journal", parents: ["folder"] }, "2026-01-01 Opening\n")
    expect(body).toContain("--boundary\r\nContent-Type: application/json; charset=UTF-8")
    expect(body).toContain('{"name":"main.journal","parents":["folder"]}')
    expect(body).toContain("Content-Type: text/plain; charset=UTF-8\r\n\r\n2026-01-01 Opening\n")
    expect(body.endsWith("\r\n--boundary--")).toBe(true)
  })

  test("updates the same Drive file through the upload endpoint", async () => {
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      id: "drive-file",
      name: "main.journal",
      mimeType: "text/plain",
      version: "2",
    })))
    const result = await updateFile("token", "drive-file", "new journal text\n")
    const [input, init] = fetch.mock.calls[0] ?? []
    expect(result.ok).toBe(true)
    expect(String(input)).toContain("/upload/drive/v3/files/drive-file?")
    expect(init?.method).toBe("PATCH")
    expect(new Headers(init?.headers).has("If-Match")).toBe(false)
    expect(init?.body).toBe("new journal text\n")
    fetch.mockRestore()
  })
})

describe("Drive agreement checks", () => {
  test("accepts an unchanged file", () => {
    expect(changedFromAgreement({ id: "drive-file", name: "main.journal", mimeType: "text/plain", md5Checksum: "checksum-1", version: "1" }, agreed)).toBe(false)
  })

  test("blocks changed identity, content, or revision", () => {
    expect(changedFromAgreement({ id: "other", name: "main.journal", mimeType: "text/plain", md5Checksum: "checksum-1", version: "1" }, agreed)).toBe(true)
    expect(changedFromAgreement({ id: "drive-file", name: "main.journal", mimeType: "text/plain", md5Checksum: "checksum-2", version: "1" }, agreed)).toBe(true)
    expect(changedFromAgreement({ id: "drive-file", name: "main.journal", mimeType: "text/plain", md5Checksum: "checksum-1", version: "2" }, agreed)).toBe(true)
  })
})

describe("Drive relative paths", () => {
  test("keeps safe nested names and refuses traversal", () => {
    expect(safePath("books/2026/main.journal")).toBe(true)
    expect(safePath("../outside.journal")).toBe(false)
    expect(safePath("books//main.journal")).toBe(false)
    expect(safePath("books\\main.journal")).toBe(false)
    expect(parentPath("books/2026/main.journal")).toBe("books/2026")
    expect(fileName("books/2026/main.journal")).toBe("main.journal")
    expect(relativePath("books/2026", "main.journal")).toBe("books/2026/main.journal")
  })
})
