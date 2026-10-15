import { describe, expect, spyOn, test } from "bun:test"

import { deleteFile, fetchBinary, fetchFile, putBinary } from "~/core/github/api"

describe("GitHub binary companions", () => {
  test("reads binary bytes and the blob identity through the Contents API", async () => {
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ content: "AAH/", sha: "blob-sha" })),
    )
    const result = await fetchBinary(
      "token",
      { owner: "owner", repo: "books", branch: "main", path: "receipts/photo.jpg" },
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect([...new Uint8Array(await result.value.blob.arrayBuffer())]).toEqual([0, 1, 255])
      expect(result.value.sha).toBe("blob-sha")
    }
    expect(String(fetch.mock.calls[0]?.[0])).toContain("/repos/owner/books/contents/receipts/photo.jpg")
    fetch.mockRestore()
  })

  test("reads Contents API blobs too large to include inline through their pinned blob SHA", async () => {
    const fetch = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ sha: "large-sha" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ content: "AAH/", encoding: "base64" })))
    const where = { owner: "owner", repo: "books", branch: "main", path: "receipts/large.bin" }
    const result = await fetchBinary("token", where)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect([...new Uint8Array(await result.value.blob.arrayBuffer())]).toEqual([0, 1, 255])
      expect(result.value.sha).toBe("large-sha")
    }
    expect(String(fetch.mock.calls[1]?.[0])).toContain("/repos/owner/books/git/blobs/large-sha")
    fetch.mockRestore()
  })

  test("reads large text through the Contents response SHA without losing its identity", async () => {
    const fetch = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ sha: "large-text-sha" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ content: "5pel5pys", encoding: "base64" })))
    const result = await fetchFile("token", { owner: "owner", repo: "books", branch: "main", path: "journal.journal" })
    expect(result).toEqual({ ok: true, value: { text: "日本", sha: "large-text-sha" } })
    fetch.mockRestore()
  })

  test("uploads the original bytes through the Contents API", async () => {
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ content: { sha: "blob-sha" } })),
    )
    const result = await putBinary(
      "token",
      { owner: "owner", repo: "books", branch: "main", path: "receipts/photo.jpg" },
      new Blob([Uint8Array.of(1, 2, 255)], { type: "image/jpeg" }),
      undefined,
      "Add receipt photo",
    )
    const [input, init] = fetch.mock.calls[0] ?? []
    const body = JSON.parse(String(init?.body)) as { content: string; branch: string; message: string }
    expect(result).toEqual({ ok: true, value: "blob-sha" })
    expect(String(input)).toContain("/repos/owner/books/contents/receipts/photo.jpg")
    expect(body).toEqual({ content: "AQL/", branch: "main", message: "Add receipt photo" })
    fetch.mockRestore()
  })

  test("deletes only the blob whose SHA was reviewed", async () => {
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ commit: { sha: "commit" } })))
    const result = await deleteFile(
      "token",
      { owner: "owner", repo: "books", branch: "main", path: "accounts.journal" },
      "expected-blob",
      "Delete accounts",
    )
    const [input, init] = fetch.mock.calls[0] ?? []
    const body = JSON.parse(String(init?.body)) as { sha: string; branch: string; message: string }
    expect(result).toEqual({ ok: true, value: undefined })
    expect(String(input)).toContain("/repos/owner/books/contents/accounts.journal")
    expect(init?.method).toBe("DELETE")
    expect(body).toEqual({ sha: "expected-blob", branch: "main", message: "Delete accounts" })
    fetch.mockRestore()
  })
})
