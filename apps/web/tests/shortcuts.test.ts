import { describe, expect, test } from "bun:test"

import { actionFor } from "~/core/lib/shortcuts"

describe("save shortcut", () => {
  test("Ctrl+S asks to save the backup", () => {
    expect(actionFor({ ctrlKey: true, metaKey: false, key: "s", target: null } as KeyboardEvent)).toBe("save")
  })

  test("⌘S asks to save the backup", () => {
    expect(actionFor({ ctrlKey: false, metaKey: true, key: "s", target: null } as KeyboardEvent)).toBe("save")
  })
})
