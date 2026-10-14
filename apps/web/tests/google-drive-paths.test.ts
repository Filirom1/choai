import { describe, expect, test } from "bun:test"

import { fileName, parentPath } from "~/core/google-drive/paths"

describe("Google Drive paths", () => {
  test("keeps a top-level file at the selected folder root", () => {
    expect(parentPath("choai-settings.jsonl")).toBe("")
    expect(fileName("choai-settings.jsonl")).toBe("choai-settings.jsonl")
  })

  test("separates nested files into their parent folder", () => {
    expect(parentPath("justificatifs/recu.pdf")).toBe("justificatifs")
    expect(fileName("justificatifs/recu.pdf")).toBe("recu.pdf")
  })
})
