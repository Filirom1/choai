import { describe, expect, spyOn, test } from "bun:test"

import { putBinary } from "~/core/github/api"

describe("GitHub binary companions", () => {
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
})
