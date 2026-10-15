import { describe, expect, test } from "bun:test"

import {
  appendMergeProposal,
  blockedSync,
  captureFile,
  diffSections,
  choiceText,
  diffText,
  sameVersions,
  type CapturedVersion,
} from "~/core/sync/conflict"

const text = (value: string, identity?: string): CapturedVersion => ({
  content: { kind: "text", text: value },
  ...(identity === undefined ? {} : { identity }),
})

const snapshot = (base: CapturedVersion, local: CapturedVersion, destination: CapturedVersion) =>
  captureFile({ bookId: "book", path: "transactions.journal", base, local, destination, cause: "diverged", capturedAt: 10 })

describe("sync conflict snapshots", () => {
  test("blocks only a direction that would discard the opposite side's pending changes", () => {
    expect(blockedSync("pull", ["local.journal"], [])).toEqual({ side: "local", paths: ["local.journal"] })
    expect(blockedSync("pull", [], ["remote.journal"])).toBeUndefined()
    expect(blockedSync("push", [], ["remote.journal"])).toEqual({ side: "destination", paths: ["remote.journal"] })
    expect(blockedSync("push", ["local.journal"], [])).toBeUndefined()
  })

  test("classifies additions, changes, identical edits and contradictory deletions", () => {
    expect(snapshot({}, text("local"), {}).state).toBe("added-local")
    expect(snapshot({}, text("local"), text("remote")).state).toBe("added-both")
    expect(snapshot({}, text("same"), text("same")).state).toBe("added-both-same")
    expect(snapshot(text("base"), text("base"), text("remote")).state).toBe("changed-destination")
    expect(snapshot(text("base"), text("same"), text("same")).state).toBe("changed-both-same")
    expect(snapshot(text("base"), {}, text("remote")).state).toBe("deleted-local-changed-destination")
    expect(snapshot(text("base"), {}, text("base")).state).toBe("deleted-local")
    expect(snapshot(text("base"), text("base"), {}).state).toBe("deleted-destination")
  })

  test("compares captured versions by content, role and concurrency identities", () => {
    const one = captureFile({
      bookId: "book",
      path: "transactions.journal",
      role: "accounting",
      base: text("base"),
      local: text("local", "one"),
      destination: text("remote"),
      cause: "diverged",
      capturedAt: 10,
    })
    const same = captureFile({
      bookId: "book",
      path: "transactions.journal",
      role: "accounting",
      base: text("base"),
      local: text("local", "one"),
      destination: text("remote"),
      cause: "diverged",
      capturedAt: 20,
    })
    const otherRole = captureFile({
      bookId: "book",
      path: "transactions.journal",
      role: "companion",
      base: text("base"),
      local: text("local", "one"),
      destination: text("remote"),
      cause: "diverged",
      capturedAt: 20,
    })
    expect(sameVersions(one, same)).toBe(true)
    expect(sameVersions(one, otherRole)).toBe(false)
    expect(sameVersions(
      snapshot(text("base"), text("local", "one"), text("remote")),
      snapshot(text("base"), text("local", "two"), text("remote")),
    )).toBe(false)
  })

  test("binary files compare only when both size and fingerprint are known", () => {
    const one = { content: { kind: "binary" as const, size: 8, fingerprint: "abc" } }
    const same = { content: { kind: "binary" as const, size: 8, fingerprint: "def" } }
    const other = { content: { kind: "binary" as const, size: 9, fingerprint: "abc" } }
    expect(snapshot(one, same, same).state).toBe("changed-both-same")
    expect(snapshot(one, same, other).state).toBe("changed-both")
    expect(snapshot({ content: { kind: "binary", size: 8 } }, same, same).state).toBe("changed-both-same")
  })
})

describe("text comparison and proposals", () => {
  test("keeps shared lines and marks removed and added lines", () => {
    expect(diffText("one\nold\nlast", "one\nnew\nlast")).toEqual([
      { kind: "same", text: "one" },
      { kind: "removed", text: "old" },
      { kind: "added", text: "new" },
      { kind: "same", text: "last" },
    ])
    expect(diffText("one", "one\ntwo")).toEqual([
      { kind: "same", text: "one" },
      { kind: "added", text: "two" },
    ])
    expect(diffText("a\nold one\nmiddle\nold two\nz", "a\nnew one\nmiddle\nnew two\nz")).toEqual([
      { kind: "same", text: "a" },
      { kind: "removed", text: "old one" },
      { kind: "added", text: "new one" },
      { kind: "same", text: "middle" },
      { kind: "removed", text: "old two" },
      { kind: "added", text: "new two" },
      { kind: "same", text: "z" },
    ])
  })

  test("folds long unchanged runs while keeping context around each change", () => {
    const lines = [
      { kind: "same" as const, text: "before-1" },
      { kind: "same" as const, text: "before-2" },
      { kind: "same" as const, text: "before-3" },
      { kind: "same" as const, text: "hidden-1" },
      { kind: "same" as const, text: "hidden-2" },
      { kind: "same" as const, text: "hidden-3" },
      { kind: "same" as const, text: "hidden-4" },
      { kind: "same" as const, text: "after-1" },
      { kind: "same" as const, text: "after-2" },
      { kind: "same" as const, text: "after-3" },
      { kind: "removed" as const, text: "old" },
    ]
    const sections = diffSections(lines)
    expect(sections).toEqual([
      { kind: "lines", lines: lines.slice(0, 3) },
      { kind: "folded", lines: lines.slice(3, 7) },
      { kind: "lines", lines: lines.slice(7, 10) },
      { kind: "lines", lines: lines.slice(10) },
    ])
    expect(sections.flatMap((section) => section.lines)).toEqual(lines)
    expect(diffSections(lines.slice(0, 7))).toEqual([{ kind: "lines", lines: lines.slice(0, 7) }])
  })

  test("offers only an append-only merge, destination first, and does not apply it", () => {
    const conflict = snapshot(text("base\n"), text("base\nlocal\n"), text("base\ndestination\n"))
    expect(appendMergeProposal(conflict)).toBe("base\n\ndestination\n\nlocal\n")
    expect(appendMergeProposal(snapshot(text("base\n"), text("rewritten\n"), text("base\ndestination\n")))).toBeUndefined()
    expect(appendMergeProposal(snapshot(text("base\n  \n"), text("base\n  \nlocal  \n"), text("base\n  \ndestination  \n"))))
      .toBe("base\n  \n\ndestination  \n\nlocal  \n")
    expect(choiceText(conflict, { take: "local" })).toBe("base\nlocal\n")
    expect(choiceText(conflict, { take: "destination" })).toBe("base\ndestination\n")
    expect(choiceText(conflict, { take: "manual", text: "reviewed" })).toBe("reviewed")
    expect(choiceText(conflict, { take: "later" })).toBeUndefined()
  })
})
