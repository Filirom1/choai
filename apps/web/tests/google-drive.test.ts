import { describe, expect, spyOn, test } from "bun:test"

import { createBinary, deleteRevision, getFileContent, getRevisionContent, listFilesInFolder, listRevisions, listSharedWithMe, listStarred, multipartBody, pinRevision, trashFile, updateBlob, updateFile } from "../src/core/google-drive/api"
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
    expect(url.searchParams.get("fields")).toContain("headRevisionId")
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

  test("uploads binary companions with their MIME type and bytes", async () => {
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      id: "photo-file",
      name: "receipt.jpg",
      mimeType: "image/jpeg",
    })))
    const result = await createBinary("token", "folder-id", "receipt.jpg", new Blob([Uint8Array.of(1, 2, 255)], { type: "image/jpeg" }))
    const [input, init] = fetch.mock.calls[0] ?? []
    const headers = new Headers(init?.headers)
    const body = init?.body
    expect(result.ok).toBe(true)
    expect(String(input)).toContain("/upload/drive/v3/files?uploadType=multipart")
    expect(headers.get("Content-Type")).toContain("multipart/related; boundary=")
    expect(body).toBeInstanceOf(Blob)
    const text = await (body as Blob).text()
    expect(text).toContain('"name":"receipt.jpg","mimeType":"image/jpeg","parents":["folder-id"]')
    expect(text).toContain("Content-Type: image/jpeg\r\n\r\n")
    fetch.mockRestore()
  })

  test("updates a binary companion through the upload endpoint", async () => {
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: "drive-file", version: "2" })))
    const result = await updateBlob("token", "drive-file", new Blob([Uint8Array.of(1, 2)], { type: "image/png" }))
    const [input, init] = fetch.mock.calls[0] ?? []
    expect(result.ok).toBe(true)
    expect(String(input)).toContain("/upload/drive/v3/files/drive-file?")
    expect(init?.method).toBe("PATCH")
    expect(new Headers(init?.headers).get("Content-Type")).toBe("image/png")
    expect(init?.body).toBeInstanceOf(Blob)
    fetch.mockRestore()
  })

  test("lists revisions and reads an older revision's text", async () => {
    const fetch = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ revisions: [{ id: "rev-1", modifiedTime: "2026-02-01T00:00:00Z" }] })))
      .mockResolvedValueOnce(new Response(Uint8Array.from([
        68, 97, 116, 101, 59, 68, 233, 98, 105, 116, 59, 76, 105, 98, 101, 108, 108, 233,
      ])))
    const revisions = await listRevisions("token", "drive-file")
    const content = await getRevisionContent("token", "drive-file", "rev-1")
    const [listUrl, listInit] = fetch.mock.calls[0] ?? []
    const [contentUrl, contentInit] = fetch.mock.calls[1] ?? []
    expect(revisions).toMatchObject({ ok: true, value: [{ id: "rev-1" }] })
    expect(content).toEqual({ ok: true, value: "Date;Débit;Libellé" })
    expect(String(listUrl)).toContain("/files/drive-file/revisions?")
    expect(new Headers(listInit?.headers).get("Authorization")).toBe("Bearer token")
    expect(String(contentUrl)).toContain("/files/drive-file/revisions/rev-1?alt=media")
    expect(new Headers(contentInit?.headers).get("Authorization")).toBe("Bearer token")
    fetch.mockRestore()
  })

  test("reads Windows-1252 CSV text from the original bytes", async () => {
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(new Response(Uint8Array.from([
      68, 97, 116, 101, 59, 68, 233, 98, 105, 116, 59, 76, 105, 98, 101, 108, 108, 233,
    ])))
    const content = await getFileContent("token", "drive-file")
    expect(content).toEqual({ ok: true, value: "Date;Débit;Libellé" })
    fetch.mockRestore()
  })

  test("deletes an older revision even when kept, but protects the current one", async () => {
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }))
    try {
      const result = await deleteRevision("token", "drive-file", { id: "older" }, "current")
      const [input, init] = fetch.mock.calls[0] ?? []
      expect(result).toEqual({ ok: true, value: undefined })
      expect(String(input)).toContain("/files/drive-file/revisions/older")
      expect(init?.method).toBe("DELETE")
      expect(new Headers(init?.headers).get("Authorization")).toContain("Bearer")
      expect(await deleteRevision("token", "drive-file", { id: "kept", keepForever: true }, "current")).toEqual({
        ok: true,
        value: undefined,
      })
      expect(await deleteRevision("token", "drive-file", { id: "current" }, "current")).toEqual({
        ok: false,
        error: { kind: "protected-revision" },
      })
      expect(fetch).toHaveBeenCalledTimes(2)
    } finally {
      fetch.mockRestore()
    }
  })

  test("pins a replaced revision and trashes deletions reversibly", async () => {
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: "revision" })))
    expect(await pinRevision("token", "drive-file", "revision")).toEqual({ ok: true, value: undefined })
    expect(await trashFile("token", "drive-file")).toMatchObject({ ok: true })
    const [revisionUrl, revisionInit] = fetch.mock.calls[0] ?? []
    const [trashUrl, trashInit] = fetch.mock.calls[1] ?? []
    expect(String(revisionUrl)).toContain("/files/drive-file/revisions/revision")
    expect(revisionInit?.method).toBe("PATCH")
    expect(JSON.parse(String(revisionInit?.body))).toEqual({ keepForever: true })
    expect(String(trashUrl)).toContain("/files/drive-file?")
    expect(trashInit?.method).toBe("PATCH")
    expect(JSON.parse(String(trashInit?.body))).toEqual({ trashed: true })
    fetch.mockRestore()
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

  test("detects changed identity or content but ignores metadata-only revisions", () => {
    expect(changedFromAgreement({ id: "other", name: "main.journal", mimeType: "text/plain", md5Checksum: "checksum-1", version: "1" }, agreed)).toBe(true)
    expect(changedFromAgreement({ id: "drive-file", name: "main.journal", mimeType: "text/plain", md5Checksum: "checksum-2", version: "1" }, agreed)).toBe(true)
    expect(changedFromAgreement({ id: "drive-file", name: "main.journal", mimeType: "text/plain", md5Checksum: "checksum-1", version: "2" }, agreed)).toBe(false)
  })

  test("falls back to Drive version when a checksum is unavailable", () => {
    const withoutChecksum = { ...agreed, md5Checksum: undefined }
    expect(changedFromAgreement({ id: "drive-file", name: "main.journal", mimeType: "text/plain", version: "1" }, withoutChecksum)).toBe(false)
    expect(changedFromAgreement({ id: "drive-file", name: "main.journal", mimeType: "text/plain", version: "2" }, withoutChecksum)).toBe(true)
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
